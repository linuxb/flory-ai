import {randomUUID} from 'node:crypto';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {Client} from 'pg';
import {coordinatorDatabaseUrl, engineDatabaseUrl} from '../../../db/config.js';
import {EventStore} from '../../src/store.js';

const engine = new EventStore({connectionString: engineDatabaseUrl, actor: 'engine'});
const coordinator = new EventStore({connectionString: coordinatorDatabaseUrl, actor: 'coordinator'});
const engineClient = new Client({connectionString: engineDatabaseUrl});
const coordinatorClient = new Client({connectionString: coordinatorDatabaseUrl});

const toolViewDigest = `sha256:${'0'.repeat(64)}`;

/** A read-only tool vertex: no scope, no bracket, nothing for a transaction coordinator to own. */
function readVertex(vertexId: string) {
    return {
        event_type: 'vertex/created',
        vertex_id: vertexId,
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

/** A side-effecting tool vertex, which R10 requires to belong to a scope. */
function writeVertex(vertexId: string, scopeId: string) {
    return {
        event_type: 'vertex/created',
        vertex_id: vertexId,
        scope_id: scopeId,
        payload: {
            role: 'tool',
            tool: 'inventory.reserve',
            tool_version: '1.0.0',
            tool_view_digest: toolViewDigest,
            input: {sku: 'SKU-1', quantity: 1},
            retry_policy: {max_attempts: 1, initial_backoff_ms: 0, multiplier: 1, max_backoff_ms: 0},
            txn: {effect_class: 'reversible', mode: 'tcc', idempotency_key: 'k1', try_timeout_s: 900, confirm_tool: 'inventory.confirm', cancel_tool: 'inventory.release'},
        },
    };
}

async function startRun(): Promise<string> {
    const run = await engine.createRun();
    await engine.appendEvents(run, [{event_type: 'run/start', payload: {schema_version: 'v1'}}]);
    return run;
}

beforeAll(async () => {
    await engineClient.connect();
    await coordinatorClient.connect();
});

// The work queue is global, so a suite that fills it drains it again: leaving
// claimable rows behind would let this suite's fixtures satisfy another's claims.
async function drainQueue(): Promise<void> {
    for (;;) {
        const claimed = await coordinatorClient.query<{vertex_id: string}>('SELECT vertex_id FROM claim_ready_work($1, $2)', ['drain', 30]);
        const vertexId = claimed.rows[0]?.vertex_id;
        if (!vertexId) break;
        await coordinatorClient.query('SELECT complete_work($1, $2)', ['drain', vertexId]);
    }
    for (;;) {
        const claimed = await engineClient.query<{vertex_id: string}>('SELECT vertex_id FROM claim_ready_read($1, $2)', ['drain', 30]);
        const vertexId = claimed.rows[0]?.vertex_id;
        if (!vertexId) break;
        await engineClient.query('SELECT complete_read($1, $2)', ['drain', vertexId]);
    }
}

afterAll(async () => {
    await drainQueue();
    await engineClient.end();
    await coordinatorClient.end();
    await engine.close();
    await coordinator.close();
});

describe('executor authority splits by effect class', () => {
    it('routes a read-only vertex to the Orchestrator and a scoped one to the Coordinator', async () => {
        const run = await startRun();
        const read = randomUUID();
        const write = randomUUID();
        const scope = randomUUID();
        await engine.appendEvents(run, [readVertex(read), writeVertex(write, scope)]);

        const classes = await engineClient.query<{vertex_id: string; executor_class: string}>('SELECT vertex_id, executor_class FROM work_queue WHERE vertex_id = ANY($1::uuid[])', [[read, write]]);
        const byVertex = Object.fromEntries(classes.rows.map((row) => [row.vertex_id, row.executor_class]));
        expect(byVertex[read]).toBe('orchestrator');
        expect(byVertex[write]).toBe('coordinator');
    });

    // Two pollers must never contend for one row, or the split would only hold by luck.
    it('never returns the same vertex to both claim functions', async () => {
        const run = await startRun();
        const read = randomUUID();
        const write = randomUUID();
        await engine.appendEvents(run, [readVertex(read), writeVertex(write, randomUUID())]);

        const claimedByEngine = await engineClient.query<{vertex_id: string}>('SELECT vertex_id FROM claim_ready_read($1, $2)', ['engine-worker', 30]);
        const claimedByCoordinator = await coordinatorClient.query<{vertex_id: string}>('SELECT vertex_id FROM claim_ready_work($1, $2)', ['coordinator-worker', 30]);
        const engineVertices = claimedByEngine.rows.map((row) => row.vertex_id);
        const coordinatorVertices = claimedByCoordinator.rows.map((row) => row.vertex_id);
        expect(engineVertices).not.toContain(write);
        expect(coordinatorVertices).not.toContain(read);
        expect(engineVertices.filter((vertex) => coordinatorVertices.includes(vertex))).toEqual([]);
    });

    it('refuses each claim function to the role that does not own it', async () => {
        await expect(coordinatorClient.query('SELECT * FROM claim_ready_read($1, $2)', ['coordinator-worker', 30])).rejects.toThrow(/only engine_role/);
        await expect(engineClient.query('SELECT * FROM claim_ready_work($1, $2)', ['engine-worker', 30])).rejects.toThrow(/only coordinator_role/);
    });

    it('lets the Orchestrator record the outcome of a read it executed', async () => {
        const run = await startRun();
        const read = randomUUID();
        await engine.appendEvents(run, [readVertex(read)]);
        await engine.appendEvents(run, [
            {event_type: 'vertex/started', vertex_id: read, payload: {attempt: 1}},
            {event_type: 'vertex/succeeded', vertex_id: read, payload: {attempts: 1, result: {available: 7}}},
        ]);
        const recorded = await engineClient.query<{event_type: string}>('SELECT event_type FROM event_log WHERE run_id = $1 AND vertex_id = $2 ORDER BY stream_seq', [run, read]);
        expect(recorded.rows.map((row) => row.event_type)).toEqual(['vertex/created', 'vertex/started', 'vertex/succeeded']);
    });

    // The guards in each service are advice. This is the boundary: bypassing the
    // in-process check still cannot write an execution event for a vertex the
    // writer does not own.
    it('refuses an execution event from the executor that does not own the vertex', async () => {
        const run = await startRun();
        const read = randomUUID();
        const write = randomUUID();
        await engine.appendEvents(run, [readVertex(read), writeVertex(write, randomUUID())]);

        await expect(engine.appendEvents(run, [{event_type: 'vertex/succeeded', vertex_id: write, payload: {attempts: 1, result: {}}}])).rejects.toThrow(
            /engine_role cannot append .* coordinator-executed/,
        );
        await expect(coordinator.appendEvents(run, [{event_type: 'vertex/succeeded', vertex_id: read, payload: {attempts: 1, result: {}}}])).rejects.toThrow(
            /coordinator_role cannot append .* orchestrator-executed/,
        );
    });

    it('refuses an execution event for a vertex that was never created', async () => {
        const run = await startRun();
        await expect(engine.appendEvents(run, [{event_type: 'vertex/started', vertex_id: randomUUID(), payload: {attempt: 1}}])).rejects.toThrow(/before its vertex\/created/);
    });

    it('leaves the Coordinator owning every txn event regardless of executor class', async () => {
        const run = await startRun();
        const scope = randomUUID();
        await expect(engine.appendEvents(run, [{event_type: 'txn/scope', scope_id: scope, payload: {state: 'open'}}])).rejects.toThrow(/engine_role cannot append event type/);
    });
});
