import {randomUUID} from 'node:crypto';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {Client} from 'pg';
import {coordinatorDatabaseUrl, engineDatabaseUrl} from '../../../db/config.js';
import {EventStore} from '../../src/store.js';
import {replayIdentity} from '../../src/harness/oracles.js';

const engineUrl = engineDatabaseUrl;
const coordinatorUrl = coordinatorDatabaseUrl;
const engine = new EventStore({connectionString: engineUrl, actor: 'engine'});
const coordinator = new EventStore({connectionString: coordinatorUrl, actor: 'coordinator'});
const plannerId = '00000000-0000-4000-8000-000000000101';
// Any tool vertex pins the frozen contract it was admitted against; these tests
// never resolve a live view, so one fixed digest stands in for it.
const toolViewDigest = `sha256:${'0'.repeat(64)}`;

async function plannerRun(): Promise<string> {
    const run = await engine.createRun();
    await engine.appendEvents(run, [
        {event_type: 'run/start', payload: {schema_version: 'v1'}},
        {event_type: 'vertex/created', vertex_id: plannerId, pin_version: 'model://planner@v1', payload: {role: 'planner'}},
    ]);
    await coordinator.appendEvents(run, [{event_type: 'vertex/succeeded', vertex_id: plannerId, payload: {result: {plan: 'ok'}}}]);
    return run;
}

beforeAll(async () => undefined);
afterAll(async () => {
    await engine.close();
    await coordinator.close();
});

describe('PostgreSQL event store', () => {
    it('allocates contiguous sequences and rolls an invalid append back', async () => {
        const run = await engine.createRun();
        const scopeId = randomUUID();
        await engine.appendEvents(run, [{event_type: 'run/start', payload: {schema_version: 'v1'}}]);
        await expect(coordinator.appendEvents(run, [{event_type: 'txn/try', scope_id: scopeId, vertex_id: randomUUID(), payload: {}}])).rejects.toThrow();
        await engine.appendEvents(run, [{event_type: 'run/end', payload: {status: 'success'}}]);
        expect((await engine.readStream(run)).map((event) => event.stream_seq)).toEqual([1, 2]);
    });

    it('enforces event ownership and synchronous transaction projections', async () => {
        const scopeId = randomUUID();
        const tryVertex = randomUUID();
        const run = await engine.createRun();
        await expect(engine.appendEvents(run, [{event_type: 'txn/scope', scope_id: scopeId, payload: {state: 'open'}}])).rejects.toThrow('engine_role');
        await coordinator.appendEvents(run, [
            {event_type: 'txn/scope', scope_id: scopeId, payload: {state: 'open', required_try_vertices: [tryVertex]}},
            {event_type: 'txn/try', scope_id: scopeId, vertex_id: tryVertex, payload: {idempotency_key: `key-${run}`, deadline_at: new Date(Date.now() + 60_000).toISOString()}},
        ]);
        const pivotVertex = randomUUID();
        const client = new Client({connectionString: coordinatorUrl});
        await client.connect();
        expect((await client.query<{admit_pivot: boolean}>('SELECT admit_pivot($1, $2, $3)', [run, scopeId, pivotVertex])).rows[0]?.admit_pivot).toBe(true);
        await client.end();
        await coordinator.appendEvents(run, [{event_type: 'txn/pivot-passed', scope_id: scopeId, vertex_id: pivotVertex, payload: {}}]);
        await expect(coordinator.appendEvents(run, [{event_type: 'txn/cancel', scope_id: scopeId, payload: {idempotency_key: `scope-${run}`, phase: 'requested'}}])).rejects.toThrow('cannot cancel');
    });

    it('leases one ready vertex to only one concurrent worker', async () => {
        const run = await engine.createRun();
        const vertexId = randomUUID();
        await engine.appendEvents(run, [
            {event_type: 'run/start', payload: {schema_version: 'v1'}},
            {
                event_type: 'vertex/created',
                vertex_id: vertexId,
                payload: {
                    role: 'tool',
                    tool: 'inventory.check',
                    tool_version: '1.0.0',
                    tool_view_digest: toolViewDigest,
                    input: {sku: 'SKU-1'},
                    retry_policy: {max_attempts: 2, initial_backoff_ms: 0, multiplier: 2, max_backoff_ms: 0},
                    txn: {effect_class: 'none', mode: 'plain'},
                },
            },
        ]);
        const first = new Client({connectionString: coordinatorUrl});
        const second = new Client({connectionString: coordinatorUrl});
        await Promise.all([first.connect(), second.connect()]);
        const claims = await Promise.all([
            first.query<{vertex_id: string}>('SELECT vertex_id FROM claim_ready_work($1, $2)', ['worker-a', 30]),
            second.query<{vertex_id: string}>('SELECT vertex_id FROM claim_ready_work($1, $2)', ['worker-b', 30]),
        ]);
        expect(claims.flatMap((claim) => claim.rows.map((row) => row.vertex_id))).toEqual([vertexId]);
        const winner = claims[0].rowCount === 1 ? 'worker-a' : 'worker-b';
        await (winner === 'worker-a' ? first : second).query('SELECT complete_work($1, $2)', [winner, vertexId]);
        await Promise.all([first.end(), second.end()]);
    });

    it('forks lazily, numbers own events above eval_up_to_seq, and reproduces a no-substitution surface after merge', async () => {
        const run = await plannerRun();
        const result = await engine.fork({
            source_run_id: run,
            at_vertex_id: plannerId,
            substitutions: [],
            eval_up_to_seq: 3,
            fold_mode: 'recorded',
            evaluator_pin: 'eval://identity@v1',
            projector_version: 'projector@v1',
            harness_state_version: 'harness@v1',
        });
        expect(result.end_seed_seq).toBe(4);
        expect(result.seed_event_count).toBe(2);
        expect(await engine.mergeIndependentEvents(result.child_run_id)).toEqual([3]);
        expect(await engine.mergeIndependentEvents(result.child_run_id)).toEqual([]);
        const source = await engine.readStream(run);
        const child = await engine.readStream(result.child_run_id);
        expect(replayIdentity(source, child).passed).toBe(true);
        expect(child.map((event) => event.stream_seq)).toEqual([1, 2, 3, 4]);
        expect(child.every((event) => (event.event_type === 'run/end-seed' ? !event.inherited : event.inherited))).toBe(true);
    });

    it('substitutes pins only in the child and invalidates the causal descendants of the divergence vertex', async () => {
        const run = await plannerRun();
        const toolVertex = randomUUID();
        const independentVertex = randomUUID();
        await engine.appendEvents(run, [
            {
                event_type: 'vertex/created',
                vertex_id: toolVertex,
                parent_refs: [plannerId],
                pin_version: 'tool://inventory.check@v1',
                payload: {
                    role: 'tool',
                    tool: 'inventory.check',
                    tool_version: '1.0.0',
                    tool_view_digest: toolViewDigest,
                    input: {sku: 'SKU-1'},
                    retry_policy: {max_attempts: 1, initial_backoff_ms: 0, multiplier: 1, max_backoff_ms: 0},
                    txn: {effect_class: 'none', mode: 'plain'},
                },
            },
            {event_type: 'vertex/created', vertex_id: independentVertex, payload: {role: 'planner'}},
        ]);
        await coordinator.appendEvents(run, [
            {event_type: 'vertex/succeeded', vertex_id: toolVertex, payload: {result: {stock: 3}}},
            {event_type: 'vertex/succeeded', vertex_id: independentVertex, payload: {result: {}}},
        ]);
        const result = await engine.fork({
            source_run_id: run,
            at_vertex_id: plannerId,
            substitutions: [{stream_seq: 2, pin_version: 'model://planner@v2'}],
            eval_up_to_seq: 7,
            fold_mode: 'recorded',
            evaluator_pin: 'eval://identity@v1',
            projector_version: 'projector@v1',
            harness_state_version: 'harness@v1',
        });
        expect((await engine.readStream(run)).find((event) => event.stream_seq === 2)?.pin_version).toBe('model://planner@v1');
        expect(result.end_seed_seq).toBe(8);
        expect(await engine.mergeIndependentEvents(result.child_run_id)).toEqual([5, 7]);
        const child = await engine.readStream(result.child_run_id);
        expect(child.find((event) => event.stream_seq === 2)?.pin_version).toBe('model://planner@v2');
        expect(child.map((event) => event.stream_seq)).toEqual([1, 2, 5, 7, 8]);
        expect(child.some((event) => event.vertex_id === toolVertex)).toBe(false);
        expect(child.some((event) => event.event_type === 'vertex/succeeded' && event.vertex_id === plannerId)).toBe(false);
    });

    it('prevents fork-authored mutation of inherited brackets, wherever the inherited copy sits', async () => {
        const run = await plannerRun();
        const openScope = randomUUID();
        const key = `inherited-${run}`;
        await coordinator.appendEvents(run, [
            {event_type: 'txn/scope', scope_id: openScope, payload: {state: 'open'}},
            {event_type: 'txn/try', scope_id: openScope, vertex_id: randomUUID(), payload: {idempotency_key: key, deadline_at: new Date(Date.now() + 60_000).toISOString()}},
        ]);
        const result = await engine.fork({
            source_run_id: run,
            at_vertex_id: plannerId,
            substitutions: [],
            eval_up_to_seq: 5,
            fold_mode: 'recorded',
            evaluator_pin: 'eval://identity@v1',
            projector_version: 'projector@v1',
            harness_state_version: 'harness@v1',
        });
        expect(await engine.mergeIndependentEvents(result.child_run_id)).toEqual([3, 4, 5]);
        await expect(coordinator.appendEvents(result.child_run_id, [{event_type: 'txn/cancel', scope_id: openScope, payload: {idempotency_key: `scope-${key}`, phase: 'requested'}}])).rejects.toThrow(
            'inherited transaction bracket',
        );
    });

    it('forks at any vertex: inside an open bracket and below the pivot floor', async () => {
        const openRun = await plannerRun();
        const openScope = randomUUID();
        const laterPlanner = randomUUID();
        await coordinator.appendEvents(openRun, [
            {event_type: 'txn/scope', scope_id: openScope, payload: {state: 'open'}},
            {event_type: 'txn/try', scope_id: openScope, vertex_id: randomUUID(), payload: {idempotency_key: `open-${openRun}`, deadline_at: new Date(Date.now() + 60_000).toISOString()}},
        ]);
        await engine.appendEvents(openRun, [{event_type: 'vertex/created', vertex_id: laterPlanner, payload: {role: 'planner'}}]);
        await coordinator.appendEvents(openRun, [{event_type: 'vertex/succeeded', vertex_id: laterPlanner, payload: {result: {}}}]);
        const midBracket = await engine.fork({
            source_run_id: openRun,
            at_vertex_id: laterPlanner,
            substitutions: [],
            eval_up_to_seq: 7,
            fold_mode: 'recorded',
            evaluator_pin: 'eval://identity@v1',
            projector_version: 'projector@v1',
            harness_state_version: 'harness@v1',
        });
        expect(midBracket.end_seed_seq).toBe(8);

        const pivotRun = await plannerRun();
        const pivotScope = randomUUID();
        const pivotVertex = randomUUID();
        await coordinator.appendEvents(pivotRun, [{event_type: 'txn/scope', scope_id: pivotScope, payload: {state: 'open'}}]);
        const client = new Client({connectionString: coordinatorUrl});
        await client.connect();
        expect((await client.query<{admit_pivot: boolean}>('SELECT admit_pivot($1, $2, $3)', [pivotRun, pivotScope, pivotVertex])).rows[0]?.admit_pivot).toBe(true);
        await client.end();
        await coordinator.appendEvents(pivotRun, [{event_type: 'txn/pivot-passed', scope_id: pivotScope, vertex_id: pivotVertex, payload: {}}]);
        const belowFloor = await engine.fork({
            source_run_id: pivotRun,
            at_vertex_id: plannerId,
            substitutions: [],
            eval_up_to_seq: 3,
            fold_mode: 'recorded',
            evaluator_pin: 'eval://identity@v1',
            projector_version: 'projector@v1',
            harness_state_version: 'harness@v1',
        });
        expect(belowFloor.end_seed_seq).toBe(4);
    });
});
