import {randomUUID} from 'node:crypto';
import {afterAll, beforeEach, describe, expect, it} from 'vitest';
import {Client} from 'pg';
import {databaseUrl, engineDatabaseUrl} from '../../../db/config.js';
import {EventStore} from '../../src/store.js';
import {surface} from '../../src/projection.js';
import {failureEvidence, replanEvents, selectBoundary, unrecoveredFailures, DEFAULT_RECOVERY_POLICY, type RecoveryPolicy} from '../../src/recovery.js';
import {consoleDag} from '../../../console/server/src/projection.js';
import type {LlmPricing} from '../../src/llm-client.js';

/**
 * What a replan does to a real database.
 *
 * The pure unit tests decide *what* to shadow; this decides whether shadowing it is safe. The
 * answer turned out to be "not without a trigger": `enqueue_vertex_work` puts a row in
 * `work_queue` for every tool vertex and, until migration 016, nothing ever took one out except
 * the executor that ran it. A replan would discard work on paper and the Coordinator would run it
 * minutes later — the surface would not show the vertex and the world would change anyway.
 */

const engine = new EventStore({connectionString: engineDatabaseUrl, actor: 'engine'});
const client = new Client({connectionString: engineDatabaseUrl});
// A second connection as the owner, only to put the queue into a state a Coordinator would
// otherwise create. `engine_role` holds SELECT on `work_queue` and nothing more — which is the
// point of the split, and is why the engine cannot fake a lease for itself.
const owner = new Client({connectionString: databaseUrl});
await client.connect();
await owner.connect();

const toolViewDigest = `sha256:${'0'.repeat(64)}`;
const PRICING: LlmPricing = {currency: 'CNY', cache_hit_input_per_million: 1, cache_miss_input_per_million: 4, output_per_million: 16, reference: 'test'};
const POLICY: RecoveryPolicy = {...DEFAULT_RECOVERY_POLICY, pricing: PRICING};

afterAll(async () => {
    await client.end();
    await owner.end();
    await engine.close();
});

function plannerVertex(vertexId: string, parents: string[] = []) {
    return {event_type: 'vertex/created', vertex_id: vertexId, parent_refs: parents, payload: {role: 'planner'}};
}

/** A read-only tool vertex, so the Coordinator is never involved and the queue row is ours. */
function toolVertex(vertexId: string, parents: string[]) {
    return {
        event_type: 'vertex/created',
        vertex_id: vertexId,
        parent_refs: parents,
        payload: {
            role: 'tool',
            tool: 'inventory.check',
            tool_version: '1.0.0',
            tool_view_digest: toolViewDigest,
            input: {sku: 'SKU-1'},
            retry_policy: {max_attempts: 1, initial_backoff_ms: 0, multiplier: 1, max_backoff_ms: 0},
            txn: {effect_class: 'none', mode: 'plain'},
        },
    };
}

let runId: string;
let planner: string;
let failing: string;
let sibling: string;

beforeEach(async () => {
    runId = await engine.createRun();
    planner = randomUUID();
    failing = randomUUID();
    sibling = randomUUID();
    await engine.appendEvents(runId, [
        {event_type: 'run/start', payload: {}},
        plannerVertex(planner),
        {event_type: 'vertex/started', vertex_id: planner, payload: {attempt: 1}},
        {event_type: 'vertex/succeeded', vertex_id: planner, payload: {attempts: 1, result: {}}},
        toolVertex(failing, [planner]),
        toolVertex(sibling, [planner]),
        {event_type: 'vertex/started', vertex_id: failing, payload: {attempt: 1}},
        {event_type: 'vertex/failed', vertex_id: failing, payload: {attempts: 1, outcome: 'permanent-failure', error: 'refused'}},
    ]);
});

async function queued(vertexIds: string[]): Promise<string[]> {
    const rows = await client.query<{vertex_id: string}>('SELECT vertex_id FROM work_queue WHERE vertex_id = ANY($1::uuid[]) ORDER BY vertex_id', [vertexIds]);
    return rows.rows.map((row) => row.vertex_id);
}

describe('replanning against a real log', () => {
    it('removes the discarded work from the queue as it shadows it', async () => {
        // The sibling never ran and is still claimable; that is exactly the row a replan must
        // remove, because the plan that asked for it has been abandoned.
        expect(await queued([sibling])).toEqual([sibling]);

        const events = await engine.readStream(runId);
        const decision = selectBoundary(events, failing, POLICY);
        expect(decision.selected).toBe(planner);
        await engine.appendEvents(runId, replanEvents(decision, failureEvidence(events, failing, decision.shadowed)));

        expect(await queued([failing, sibling])).toEqual([]);
    });

    it('refuses to shadow work a worker is holding', async () => {
        // Deleting a leased row races the worker that holds it: the lease is how the queue and the
        // executor agree on ownership, and a call already in flight would land with nothing
        // recording that it did. Cancel-before-replan exists precisely so this state is not
        // reached, so refusing is the honest answer rather than half-performing the shadow.
        await owner.query("UPDATE work_queue SET claimed_by = 'someone', lease_until = now() + interval '5 minutes' WHERE vertex_id = $1", [sibling]);

        const events = await engine.readStream(runId);
        const decision = selectBoundary(events, failing, POLICY);
        await expect(engine.appendEvents(runId, replanEvents(decision, failureEvidence(events, failing, decision.shadowed)))).rejects.toThrow(/leased/);

        // And nothing landed: the boundary is not in the log either, because the two events are
        // appended together and the refusal rolled the whole append back.
        const after = await engine.readStream(runId);
        expect(after.some((event) => event.event_type === 'replan/boundary')).toBe(false);
    });

    it('leaves the two projections disagreeing about retention and agreeing about membership', async () => {
        const events = await engine.readStream(runId);
        const decision = selectBoundary(events, failing, POLICY);
        await engine.appendEvents(runId, replanEvents(decision, failureEvidence(events, failing, decision.shadowed)));
        const after = await engine.readStream(runId);

        // The planner's surface must not offer discarded work back to a model.
        const view = surface(after);
        expect(view.vertices.has(failing)).toBe(false);
        expect(view.vertices.has(sibling)).toBe(false);
        expect(view.vertices.has(planner)).toBe(true);

        // The operator's projection keeps both, flagged, with the boundary that discarded them.
        const model = consoleDag(after);
        expect(model.vertices.find((vertex) => vertex.vertex_id === failing)).toMatchObject({is_shadowed: true});
        expect(model.vertices.find((vertex) => vertex.vertex_id === sibling)).toMatchObject({is_shadowed: true});
        expect(model.replans).toHaveLength(1);
        expect(model.replans[0]).toMatchObject({boundary_vertex_id: planner, vertex_ids: expect.arrayContaining([failing, sibling])});
    });

    it('stops reporting a failure once a replan has answered it', async () => {
        const events = await engine.readStream(runId);
        expect(unrecoveredFailures(events)).toEqual([failing]);
        const decision = selectBoundary(events, failing, POLICY);
        await engine.appendEvents(runId, replanEvents(decision, failureEvidence(events, failing, decision.shadowed)));
        expect(unrecoveredFailures(await engine.readStream(runId))).toEqual([]);
    });

    it('records an escalation without discarding anything', async () => {
        // Force L4 by exhausting the episode: two replans already recorded, no progress since.
        await engine.appendEvents(runId, [
            {event_type: 'replan/boundary', vertex_id: planner, payload: {level: 'L1', reason: 'a', failed_vertex_id: failing, candidates: [], selected: planner}},
            {event_type: 'replan/boundary', vertex_id: planner, payload: {level: 'L1', reason: 'b', failed_vertex_id: failing, candidates: [], selected: planner}},
        ]);
        const events = await engine.readStream(runId);
        const decision = selectBoundary(events, failing, POLICY);
        expect(decision.selected).toBeNull();
        await engine.appendEvents(runId, replanEvents(decision, failureEvidence(events, failing, [])));

        // The abandoned work is still queued, because nothing was abandoned: an escalation hands
        // the run to a human or to the Coordinator with its state intact.
        expect(await queued([sibling])).toEqual([sibling]);
    });
});
