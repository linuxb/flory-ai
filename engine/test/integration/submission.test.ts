import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {Client} from 'pg';
import {engineDatabaseUrl} from '../../../db/config.js';
import {EventStore} from '../../src/store.js';
import {loadToolRegistry} from '../../src/tool-view.js';
import {WorkflowSubmitter} from '../../src/submission.js';
import type {WorkflowSubmission} from '../../src/workflow.js';
import type {DiscoveryAuthorization, GatewayClient, ResolvedToolView} from '../../src/gateway-client.js';
import type {ToolViewDocument} from '../../src/tool-view.js';

const engine = new EventStore({connectionString: engineDatabaseUrl, actor: 'engine'});
const engineClient = new Client({connectionString: engineDatabaseUrl});
const digest = `sha256:${'b'.repeat(64)}`;

/** A read tool and an irreversible one, which is enough to exercise both admission outcomes. */
const document: ToolViewDocument = {
    tool_view_version: 'v2',
    tools: [
        {
            tool_id: 'record.read',
            tool_version: '1.0.0',
            input_schema: {type: 'object'},
            output_schema: {type: 'object'},
            route_id: 'route-read',
            adapter: {protocol: 'grpc'},
            txn: {effect_class: 'none', mode: 'plain', idempotent_retryable: true},
            compensation_style: 'none',
            footprint: [],
            writes: [],
            timeout_ms: 1000,
            retry_constraints: {max_attempts: 2, initial_backoff_ms: 50, multiplier_milli: 2000, max_backoff_ms: 500},
            owner: 'team',
            allowed_roles: ['operator'],
        },
        {
            tool_id: 'record.settle',
            tool_version: '1.0.0',
            input_schema: {type: 'object'},
            output_schema: {type: 'object'},
            route_id: 'route-settle',
            adapter: {protocol: 'grpc'},
            txn: {effect_class: 'irreversible', mode: 'plain', idempotent_retryable: true},
            compensation_style: 'none',
            footprint: ['ledger'],
            writes: ['ledger'],
            timeout_ms: 1000,
            retry_constraints: {max_attempts: 2, initial_backoff_ms: 50, multiplier_milli: 2000, max_backoff_ms: 500},
            owner: 'team',
            allowed_roles: ['operator'],
        },
    ],
};

/** Discovery is already proven elsewhere; this suite is about what happens after it returns. */
const gateway = {
    async resolveToolView(_digest?: string, _authorization?: DiscoveryAuthorization): Promise<ResolvedToolView> {
        return {identity: {tool_view_ref: 'tool-views/test.json', tool_view_digest: digest}, document, registry: loadToolRegistry(document)};
    },
} as unknown as GatewayClient;

const submitter = new WorkflowSubmitter(engine, gateway);

function submission(id: string, vertices: WorkflowSubmission['vertices'], scopes?: WorkflowSubmission['scopes']): WorkflowSubmission {
    return {submissionId: id, schemaVersion: 'v1', vertices, ...(scopes ? {scopes} : {})};
}

async function startRun(): Promise<string> {
    const run = await engine.createRun();
    await engine.appendEvents(run, [{event_type: 'run/start', payload: {schema_version: 'v1'}}]);
    return run;
}

async function eventTypes(run: string): Promise<string[]> {
    const rows = await engineClient.query<{event_type: string}>('SELECT event_type FROM run_event_log WHERE run_id = $1 ORDER BY run_seq', [run]);
    return rows.rows.map((row) => row.event_type);
}

beforeAll(async () => {
    await engineClient.connect();
});

// The work queue is global, so a suite that fills it drains it again.
async function drainQueue(): Promise<void> {
    for (;;) {
        const claimed = await engineClient.query<{vertex_id: string}>('SELECT vertex_id FROM claim_ready_read($1, $2)', ['submission-drain', 30]);
        const vertexId = claimed.rows[0]?.vertex_id;
        if (!vertexId) break;
        await engineClient.query('SELECT complete_read($1, $2)', ['submission-drain', vertexId]);
    }
}

afterAll(async () => {
    await drainQueue();
    await engineClient.end();
    await engine.close();
});

describe('workflow submission', () => {
    it('freezes an accepted workflow and enqueues its executable vertices', async () => {
        const run = await startRun();
        const result = await submitter.submit(
            run,
            submission('sub-accept', [
                {id: 'lookup', kind: 'tool', tool: 'record.read', input: {id: '1'}},
                {id: 'follow_up', kind: 'tool', tool: 'record.read', parents: ['lookup']},
            ]),
        );

        expect(result.status).toBe('accepted');
        expect(await eventTypes(run)).toEqual(['run/start', 'subgraph/proposed', 'subgraph/frozen', 'vertex/created', 'vertex/created']);

        // The freeze and its vertices share one transaction, so their sequences are contiguous.
        const sequences = await engineClient.query<{run_seq: string; event_type: string}>(
            "SELECT run_seq, event_type FROM run_event_log WHERE run_id = $1 AND event_type IN ('subgraph/frozen', 'vertex/created') ORDER BY run_seq",
            [run],
        );
        const positions = sequences.rows.map((row) => Number(row.run_seq));
        expect(positions).toEqual([positions[0], positions[0]! + 1, positions[0]! + 2]);
    });

    it('routes a read vertex to the Orchestrator, which is what proves the scope and effect-class lowering', async () => {
        const run = await startRun();
        const result = await submitter.submit(run, submission('sub-route', [{id: 'lookup', kind: 'tool', tool: 'record.read'}]));
        if (result.status !== 'accepted') throw new Error('expected an accepted submission');

        const vertexId = result.vertexIds.get('lookup')!;
        const queued = await engineClient.query<{executor_class: string}>('SELECT executor_class FROM work_queue WHERE vertex_id = $1', [vertexId]);
        expect(queued.rows[0]?.executor_class).toBe('orchestrator');
    });

    it('respects the lowered edges: a child is claimable only once its parent has succeeded', async () => {
        // The queue is global and claims are ordered by readiness, so this test has to own it:
        // rows an earlier test left behind would be handed back first.
        await drainQueue();
        const run = await startRun();
        const result = await submitter.submit(
            run,
            submission('sub-edges', [
                {id: 'first', kind: 'tool', tool: 'record.read'},
                {id: 'second', kind: 'tool', tool: 'record.read', parents: ['first']},
            ]),
        );
        if (result.status !== 'accepted') throw new Error('expected an accepted submission');
        const first = result.vertexIds.get('first')!;
        const second = result.vertexIds.get('second')!;

        // parent_refs is a column, so nothing but a claim can prove it was lowered correctly.
        const before = await engineClient.query<{vertex_id: string}>('SELECT vertex_id FROM claim_ready_read($1, $2)', ['submission-edges', 30]);
        expect(before.rows[0]?.vertex_id).toBe(first);

        await engine.appendEvents(run, [{event_type: 'vertex/started', vertex_id: first, payload: {attempt: 1}}]);
        await engine.appendEvents(run, [{event_type: 'vertex/succeeded', vertex_id: first, payload: {result: {}}}]);
        await engineClient.query('SELECT complete_read($1, $2)', ['submission-edges', first]);

        const after = await engineClient.query<{vertex_id: string}>('SELECT vertex_id FROM claim_ready_read($1, $2)', ['submission-edges', 30]);
        expect(after.rows[0]?.vertex_id).toBe(second);
        await engineClient.query('SELECT complete_read($1, $2)', ['submission-edges', second]);
    });

    it('rejects an inadmissible workflow without freezing or queueing anything', async () => {
        const run = await startRun();
        const result = await submitter.submit(run, submission('sub-reject', [{id: 'settle', kind: 'tool', tool: 'record.settle'}]));

        expect(result.status).toBe('rejected');
        if (result.status !== 'rejected') throw new Error('unreachable');
        expect(result.stage).toBe('admission');
        // R10: a side-effecting vertex must belong to a scope. The author id is what is reported,
        // because rejection happens before any UUID is allocated.
        expect(result.violations.map((violation) => violation.rule)).toContain('R10');
        expect(result.violations.flatMap((violation) => violation.vertices)).toContain('settle');

        expect(await eventTypes(run)).toEqual(['run/start', 'subgraph/proposed', 'subgraph/rejected']);
        const queued = await engineClient.query<{count: string}>('SELECT count(*) AS count FROM work_queue q JOIN run_event_log e ON e.vertex_id = q.vertex_id WHERE e.run_id = $1', [run]);
        expect(Number(queued.rows[0]!.count)).toBe(0);
    });

    it('turns a tool the view does not publish into a rejection rather than an exception', async () => {
        const run = await startRun();
        const result = await submitter.submit(run, submission('sub-unknown', [{id: 'ghost', kind: 'tool', tool: 'record.missing'}]));

        expect(result.status).toBe('rejected');
        if (result.status !== 'rejected') throw new Error('unreachable');
        expect(result.stage).toBe('resolution');
        expect(await eventTypes(run)).toEqual(['run/start', 'subgraph/proposed', 'subgraph/rejected']);
    });

    it('records the author-id mapping a console needs, and interposes a router ahead of a planner', async () => {
        const run = await startRun();
        const result = await submitter.submit(
            run,
            submission('sub-console', [
                {id: 'lookup', kind: 'tool', tool: 'record.read'},
                {id: 'decide', kind: 'planner', parents: ['lookup']},
            ]),
        );
        if (result.status !== 'accepted') throw new Error('expected an accepted submission');

        const frozen = await engineClient.query<{payload: {vertices: Array<{author_id: string; vertex_id: string; role: string}>}}>(
            "SELECT payload FROM run_event_log WHERE run_id = $1 AND event_type = 'subgraph/frozen'",
            [run],
        );
        const mapping = frozen.rows[0]!.payload.vertices;
        expect(mapping.map((entry) => entry.author_id).sort()).toEqual(['decide', 'decide#router', 'lookup']);

        const created = await engineClient.query<{vertex_id: string}>("SELECT vertex_id FROM run_event_log WHERE run_id = $1 AND event_type = 'vertex/created'", [run]);
        expect(new Set(created.rows.map((row) => row.vertex_id))).toEqual(new Set(mapping.map((entry) => entry.vertex_id)));

        // A router is never queued: it performs no call, so there is nothing for a worker to claim.
        const routerId = mapping.find((entry) => entry.role === 'router')!.vertex_id;
        const queued = await engineClient.query<{count: string}>('SELECT count(*) AS count FROM work_queue WHERE vertex_id = $1', [routerId]);
        expect(Number(queued.rows[0]!.count)).toBe(0);
    });

    it('always gives a proposal a terminal event, whichever way it goes', async () => {
        const run = await startRun();
        await submitter.submit(run, submission('sub-a', [{id: 'lookup', kind: 'tool', tool: 'record.read'}]));
        await submitter.submit(run, submission('sub-b', [{id: 'settle', kind: 'tool', tool: 'record.settle'}]));

        const types = await eventTypes(run);
        const proposals = types.filter((type) => type === 'subgraph/proposed').length;
        const terminals = types.filter((type) => type === 'subgraph/frozen' || type === 'subgraph/rejected').length;
        expect(proposals).toBe(2);
        expect(terminals).toBe(2);
    });
});
