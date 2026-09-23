import {randomUUID} from 'node:crypto';
import {afterAll, describe, expect, it} from 'vitest';
import {Client} from 'pg';
import {coordinatorDatabaseUrl, databaseUrl, engineDatabaseUrl} from '../../../db/config.js';
import {EventStore} from '../../src/log/store.js';
import {loadToolRegistry, type ToolViewDocument} from '../../src/gateway/tool-view.js';
import {WorkflowSubmitter} from '../../src/admission/submission.js';
import type {DiscoveryAuthorization, GatewayClient, ResolvedToolView} from '../../src/gateway/gateway-client.js';

/**
 * A replan that reserves for an order again, after that order's reservation was cancelled, is a
 * new operation and is frozen under the next generation of the order's key.
 *
 * A live run found the alternative: the replan froze its reserve under the cancelled reserve's key,
 * `txn_bracket` is keyed by it, and the Coordinator could never record the new try — while the tool
 * reserved again on every retry. The freeze now reads what is already bracketed under each business
 * key, inside the same locked transaction, and moves on past a key whose every generation was
 * cancelled.
 */

const engine = new EventStore({connectionString: engineDatabaseUrl, actor: 'engine'});
const coordinator = new EventStore({connectionString: coordinatorDatabaseUrl, actor: 'coordinator'});
const owner = new Client({connectionString: databaseUrl});
await owner.connect();

const document: ToolViewDocument = {
    tool_view_version: 'v2',
    tools: [
        {
            tool_id: 'record.reserve',
            tool_version: '1.0.0',
            input_schema: {type: 'object'},
            output_schema: {type: 'object'},
            route_id: 'route-reserve',
            adapter: {protocol: 'grpc'},
            txn: {
                effect_class: 'reversible',
                mode: 'tcc',
                idempotent_retryable: true,
                idempotency_key_path: '$.order_id',
                try_timeout_s: 60,
                confirm_tool: 'record.confirm',
                cancel_tool: 'record.release',
            },
            compensation_style: 'delta',
            footprint: ['record'],
            writes: ['record'],
            timeout_ms: 1000,
            retry_constraints: {max_attempts: 1, initial_backoff_ms: 0, multiplier_milli: 1000, max_backoff_ms: 0},
            owner: 'team',
            allowed_roles: ['operator'],
        },
        ...['record.confirm', 'record.release'].map((toolId) => ({
            tool_id: toolId,
            tool_version: '1.0.0',
            input_schema: {type: 'object'},
            output_schema: {type: 'object'},
            route_id: 'route-reserve',
            adapter: {protocol: 'grpc' as const},
            txn: {effect_class: 'bufferable' as const, mode: 'plain' as const, idempotent_retryable: true},
            compensation_style: 'none' as const,
            footprint: [],
            writes: [],
            timeout_ms: 1000,
            retry_constraints: {max_attempts: 1, initial_backoff_ms: 0, multiplier_milli: 1000, max_backoff_ms: 0},
            owner: 'team',
            allowed_roles: ['operator'],
        })),
    ],
};

const gateway = {
    async resolveToolView(_digest?: string, _authorization?: DiscoveryAuthorization): Promise<ResolvedToolView> {
        return {identity: {tool_view_ref: 'tool-views/generation.json', tool_view_digest: `sha256:${'d'.repeat(64)}`}, document, registry: loadToolRegistry(document)};
    },
} as unknown as GatewayClient;

const submitter = new WorkflowSubmitter(engine, gateway);
const queued: string[] = [];

afterAll(async () => {
    await owner.query('DELETE FROM work_queue WHERE vertex_id = ANY($1::uuid[])', [queued]);
    await owner.end();
    await engine.close();
    await coordinator.close();
});

async function startRun(): Promise<string> {
    const run = await engine.createRun();
    await engine.appendEvents(run, [{event_type: 'run/start', payload: {schema_version: 'v1'}}]);
    return run;
}

/** A scope holding one sealed try under `key`, as the Coordinator records it. */
async function sealedUnder(run: string, key: string): Promise<string> {
    const scopeId = randomUUID();
    await coordinator.appendEvents(run, [
        {event_type: 'txn/scope', scope_id: scopeId, payload: {state: 'open'}},
        {event_type: 'txn/try', vertex_id: randomUUID(), scope_id: scopeId, payload: {idempotency_key: key, deadline_at: new Date(Date.now() + 600_000).toISOString()}},
    ]);
    return scopeId;
}

/** The whole authorized cancellation: the Engine asks, the Coordinator runs it to completion. */
async function cancel(run: string, scopeId: string): Promise<void> {
    await engine.appendEvents(run, [{event_type: 'replan/cancel-requested', payload: {failed_vertex_id: randomUUID(), scope_ids: [scopeId], level: 'L1', reason: 'suite', candidates: []}}]);
    await coordinator.appendEvents(run, [{event_type: 'txn/cancel', scope_id: scopeId, payload: {idempotency_key: `scope:${scopeId}:cancel`, phase: 'requested'}}]);
    await coordinator.appendEvents(run, [{event_type: 'txn/cancel', scope_id: scopeId, payload: {idempotency_key: `scope:${scopeId}:cancel`, phase: 'completed'}}]);
}

/** Freezes one reserve for `orderId` and returns the key it was frozen under. */
async function reserveKey(run: string, orderId: string): Promise<string> {
    const result = await submitter.submit(run, {
        submissionId: `sub-${randomUUID()}`,
        schemaVersion: 'v1',
        vertices: [{id: 'hold', kind: 'tool', tool: 'record.reserve', scope: 's', input: {order_id: orderId}}],
        scopes: [{id: 's', members: ['hold']}],
    });
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') throw new Error('unreachable');
    const vertexId = result.vertexIds.get('hold')!;
    queued.push(vertexId);
    const events = await engine.readStream(run);
    const created = events.find((event) => event.event_type === 'vertex/created' && event.vertex_id === vertexId)!;
    return (created.payload as {txn: {idempotency_key: string}}).txn.idempotency_key;
}

describe('freezing a reserve for an order whose reservation was cancelled', () => {
    it('uses the business key when nothing is bracketed under it', async () => {
        const orderId = `ORDER-${randomUUID()}`;
        expect(await reserveKey(await startRun(), orderId)).toBe(`record.reserve:${orderId}`);
    });

    it('moves on to the next generation once every earlier one was cancelled', async () => {
        const orderId = `ORDER-${randomUUID()}`;
        const run = await startRun();
        await cancel(run, await sealedUnder(run, `record.reserve:${orderId}`));
        expect(await reserveKey(run, orderId)).toBe(`record.reserve:${orderId}#2`);

        // And again, after the second generation is cancelled in turn.
        await cancel(run, await sealedUnder(run, `record.reserve:${orderId}#2`));
        expect(await reserveKey(run, orderId)).toBe(`record.reserve:${orderId}#3`);
    });

    it('does so across runs, because a key names the operation and not the run', async () => {
        const orderId = `ORDER-${randomUUID()}`;
        const earlier = await startRun();
        await cancel(earlier, await sealedUnder(earlier, `record.reserve:${orderId}`));
        expect(await reserveKey(await startRun(), orderId)).toBe(`record.reserve:${orderId}#2`);
    });

    it('keeps the key of a live reservation, so the duplicate is refused rather than renamed', async () => {
        const orderId = `ORDER-${randomUUID()}`;
        const run = await startRun();
        const scopeId = await sealedUnder(run, `record.reserve:${orderId}`);
        expect(await reserveKey(await startRun(), orderId)).toBe(`record.reserve:${orderId}`);
        await cancel(run, scopeId);
    });
});
