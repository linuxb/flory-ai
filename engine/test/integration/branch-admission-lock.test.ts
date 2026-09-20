import {randomUUID} from 'node:crypto';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {Client} from 'pg';
import {coordinatorDatabaseUrl, engineDatabaseUrl} from '../../../db/config.js';
import {EventStore} from '../../src/store.js';
import {loadToolRegistry, type ToolViewDocument} from '../../src/tool-view.js';
import {WorkflowSubmitter} from '../../src/submission.js';
import type {DiscoveryAuthorization, GatewayClient, ResolvedToolView} from '../../src/gateway-client.js';
import type {WorkflowSubmission} from '../../src/workflow.js';

/**
 * Branch admission holds the run's scope rows while it decides and while it freezes.
 *
 * Structural admission judges shape, which does not change between a read and an append. Scope
 * state does: a sweeper can fence a scope in that gap, and the vertices a freeze writes would then
 * queue work under a cancellation already in progress. These rows check the runtime half — that a
 * scope which can no longer run work refuses the freeze that would give it some, and that the
 * refusal is narrow enough to leave a healthy scope alone.
 */

const engine = new EventStore({connectionString: engineDatabaseUrl, actor: 'engine'});
// Only the Coordinator may write transaction events, so staging a scope state needs its role.
const coordinator = new EventStore({connectionString: coordinatorDatabaseUrl, actor: 'coordinator'});
const engineClient = new Client({connectionString: engineDatabaseUrl});

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
            retry_constraints: {max_attempts: 1, initial_backoff_ms: 0, multiplier_milli: 1000, max_backoff_ms: 0},
            owner: 'team',
            allowed_roles: ['operator'],
        },
    ],
};

const gateway = {
    async resolveToolView(_digest?: string, _authorization?: DiscoveryAuthorization): Promise<ResolvedToolView> {
        return {identity: {tool_view_ref: 'tool-views/lock.json', tool_view_digest: `sha256:${'c'.repeat(64)}`}, document, registry: loadToolRegistry(document)};
    },
} as unknown as GatewayClient;

const submitter = new WorkflowSubmitter(engine, gateway);

function submission(): WorkflowSubmission {
    return {submissionId: `sub-${randomUUID()}`, schemaVersion: 'v1', vertices: [{id: 'lookup', kind: 'tool', tool: 'record.read'}]};
}

async function startRun(): Promise<string> {
    const run = await engine.createRun();
    await engine.appendEvents(run, [{event_type: 'run/start', payload: {schema_version: 'v1'}}]);
    return run;
}

async function openScope(run: string): Promise<string> {
    const scopeId = randomUUID();
    await coordinator.appendEvents(run, [{event_type: 'txn/scope', scope_id: scopeId, payload: {state: 'open'}}]);
    return scopeId;
}

/**
 * Closes a scope this suite opened.
 *
 * The sweeper polls every `cancelling` scope and every expired sealed try in the whole database, so
 * a staged scope left unclosed becomes a recovery candidate inside some unrelated suite's run.
 */
async function closeScope(run: string, scopeId: string, alreadyFenced = false): Promise<void> {
    const key = `scope:${scopeId}:cleanup`;
    if (!alreadyFenced) await coordinator.appendEvents(run, [{event_type: 'txn/cancel', scope_id: scopeId, payload: {phase: 'requested', idempotency_key: key}}]);
    await coordinator.appendEvents(run, [{event_type: 'txn/cancel', scope_id: scopeId, payload: {phase: 'completed', idempotency_key: key}}]);
}

/** The work queue is global, so a suite that fills it drains it again. */
async function drainQueue(): Promise<void> {
    for (;;) {
        const claimed = await engineClient.query<{vertex_id: string}>('SELECT vertex_id FROM claim_ready_read($1, $2)', ['branch-admission-drain', 30]);
        const vertexId = claimed.rows[0]?.vertex_id;
        if (!vertexId) break;
        await engineClient.query('SELECT complete_read($1, $2)', ['branch-admission-drain', vertexId]);
    }
}

async function createdVertexCount(run: string): Promise<number> {
    const rows = await engineClient.query<{count: string}>("SELECT count(*) AS count FROM run_event_log WHERE run_id = $1 AND event_type = 'vertex/created'", [run]);
    return Number(rows.rows[0]!.count);
}

beforeAll(async () => {
    await engineClient.connect();
});

afterAll(async () => {
    await engineClient.end();
    await engine.close();
    await coordinator.close();
});

describe('branch admission under the scope lock', () => {
    it('refuses a freeze into a scope that is already fencing', async () => {
        const run = await startRun();
        const scopeId = await openScope(run);
        const key = `scope:${scopeId}:cleanup`;
        await coordinator.appendEvents(run, [{event_type: 'txn/cancel', scope_id: scopeId, payload: {phase: 'requested', idempotency_key: key}}]);

        const result = await submitter.submit(run, submission());

        expect(result.status).toBe('rejected');
        if (result.status !== 'rejected') throw new Error('unreachable');
        expect(result.stage).toBe('admission');
        expect(result.violations.some((violation) => violation.rule === 'R12' && violation.message.includes('cancelling'))).toBe(true);
        // The refusal and the absence of queued work are one fact: the freeze never committed.
        expect(await createdVertexCount(run)).toBe(0);

        await closeScope(run, scopeId, true);
    });

    it('refuses a freeze into a scope whose sealed try is already past its deadline', async () => {
        const run = await startRun();
        const scopeId = await openScope(run);
        // A sealed try past its deadline is a cancellation candidate, so admitting work beneath it
        // would be racing the sweep that is about to fence it.
        await coordinator.appendEvents(run, [
            {
                event_type: 'txn/try',
                vertex_id: randomUUID(),
                scope_id: scopeId,
                payload: {idempotency_key: `${scopeId}:reserve`, deadline_at: new Date(Date.now() - 60_000).toISOString()},
            },
        ]);

        const result = await submitter.submit(run, submission());

        expect(result.status).toBe('rejected');
        if (result.status !== 'rejected') throw new Error('unreachable');
        expect(result.violations.some((violation) => violation.rule === 'R12' && violation.message.includes('past its deadline'))).toBe(true);
        expect(await createdVertexCount(run)).toBe(0);

        await closeScope(run, scopeId);
    });

    it('admits a freeze into a healthy open scope, so the guard is a state check and not a blanket refusal', async () => {
        const run = await startRun();
        const scopeId = await openScope(run);

        const result = await submitter.submit(run, submission());

        expect(result.status).toBe('accepted');
        expect(await createdVertexCount(run)).toBe(1);

        await closeScope(run, scopeId);
        await drainQueue();
    });
});
