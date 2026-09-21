import {randomUUID} from 'node:crypto';
import {afterAll, beforeEach, describe, expect, it} from 'vitest';
import {Client} from 'pg';
import {databaseUrl, engineDatabaseUrl} from '../../../db/config.js';
import {EventStore} from '../../src/log/store.js';
import {surface} from '../../src/log/projection.js';
import {DEFAULT_RECOVERY_POLICY, failureEvidence, outstanding, RecoveryLoop, replanEvents, selectBoundary, stalledPlanners, unrecoveredFailures, type RecoveryPolicy} from '../../src/recovery.js';
import {PlannerLoop} from '../../src/planner/planner-loop.js';
import {consoleDag} from '../../../console/server/src/projection/projection.js';
import type {LlmPricing} from '../../src/planner/llm-client.js';

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

/** Queue rows this suite created and, in two cases, deliberately left behind. */
const created: string[] = [];

afterAll(async () => {
    // The queue is shared across every run in this database, and the orchestrator claims from it
    // globally rather than per run. A leased row left here would be claimed by nothing and skipped
    // by everything for the life of the database, and a ready one would be picked up by the next
    // demo as a stray. Both are noise a later reader would spend real time on.
    //
    // Deleted by primary key, not by `run_id`, which has no index: the scan that costs makes a
    // concurrent `claim_ready_work` in another suite come back empty, and that suite then fails
    // on an assertion about exclusivity that has nothing to do with this one.
    await owner.query('DELETE FROM work_queue WHERE vertex_id = ANY($1::uuid[])', [created]);
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
    created.push(failing, sibling);
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

describe('a planner that answers unreadably', () => {
    /** A planner loop whose model returns whatever the test hands it, against the real store. */
    function loopReturning(...answers: string[]): {loop: PlannerLoop; prompts: string[]} {
        const prompts: string[] = [];
        const planner = {
            execute: async ({messages}: {messages: {role: string; content: string}[]}) => {
                prompts.push(messages.map((message) => message.content).join('\n'));
                return {content: answers[prompts.length - 1] ?? answers.at(-1)!};
            },
        };
        const submitter = {submit: async () => ({status: 'accepted' as const, proposedSeq: 1, frozenSeq: 2, vertexIds: new Map<string, string>()})};
        return {loop: new PlannerLoop(engine, planner as never, submitter as never, {projector_version: 'p@v1', harness_state_version: 'h@v1'}), prompts};
    }

    const toolView = {document: {tools: []}, identity: {tool_view_ref: 'ref', tool_view_digest: toolViewDigest}} as never;

    it('records the stall, and the ladder finds it although nothing failed', async () => {
        const runId = await engine.createRun();
        const plannerId = randomUUID();
        await engine.appendEvents(runId, [
            {event_type: 'run/start', payload: {}},
            plannerVertex(plannerId),
            {event_type: 'vertex/started', vertex_id: plannerId, payload: {attempt: 1}},
            {event_type: 'vertex/succeeded', vertex_id: plannerId, payload: {attempts: 1, result: {}}},
        ]);

        const {loop} = loopReturning('this is not a proposal');
        const turn = await loop.advance({runId, plannerVertexId: plannerId, taskInput: {}, workflowType: 'demo', goal: 'go'}, toolView);
        expect(turn.status).toBe('unreadable');

        const events = await engine.readStream(runId);
        // Nothing failed. The planner succeeded, the model answered, and the run is stuck anyway.
        expect(unrecoveredFailures(events)).toEqual([]);
        expect(stalledPlanners(events)).toEqual([plannerId]);
        expect(outstanding(events)).toEqual([plannerId]);
    });

    it('asks the same planner again, telling it what was wrong with the last answer', async () => {
        const runId = await engine.createRun();
        const plannerId = randomUUID();
        await engine.appendEvents(runId, [
            {event_type: 'run/start', payload: {}},
            plannerVertex(plannerId),
            {event_type: 'vertex/started', vertex_id: plannerId, payload: {attempt: 1}},
            {event_type: 'vertex/succeeded', vertex_id: plannerId, payload: {attempts: 1, result: {}}},
        ]);
        const {loop, prompts} = loopReturning('not a proposal', '{"vertices":[{"id":"next","kind":"planner"}]}');
        await loop.advance({runId, plannerVertexId: plannerId, taskInput: {}, workflowType: 'demo', goal: 'go'}, toolView);

        const recovery = new RecoveryLoop(engine, loop, POLICY);
        const outcome = await recovery.recoverOne({runId, taskInput: {}, workflowType: 'demo', goalFor: () => 'go'}, toolView);

        expect(outcome.status).toBe('replanned');
        if (outcome.status !== 'replanned') return;
        // Itself, at distance zero, discarding nothing: there is nothing below it to throw away.
        expect(outcome.decision.selected).toBe(plannerId);
        expect(outcome.decision.level).toBe('L1');
        expect(outcome.decision.shadowed).toEqual([]);
        expect(outcome.turn.status).toBe('frozen');
        // And the second prompt carried the refusal, so the model is not asked to guess twice.
        expect(prompts[1]).toContain('unreadable_answer');
        expect(prompts[1]).toContain('A previous attempt from here failed');

        // The stall is answered: the loop must not decide it again on the next pass.
        expect(stalledPlanners(await engine.readStream(runId))).toEqual([]);
    });
});
