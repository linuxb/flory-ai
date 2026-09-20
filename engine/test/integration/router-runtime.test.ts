import {randomUUID} from 'node:crypto';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {Client} from 'pg';
import {engineDatabaseUrl} from '../../../db/config.js';
import {EventStore} from '../../src/store.js';
import {loadToolRegistry, type ToolViewDocument} from '../../src/tool-view.js';
import {WorkflowSubmitter} from '../../src/submission.js';
import {RuleTemplateStore, slotIdOf, type RuleTemplateDraft} from '../../src/rule-template.js';
import {RouterExecutor} from '../../src/router-executor.js';
import {linearize, slice, surface} from '../../src/projection.js';
import type {DiscoveryAuthorization, GatewayClient, ResolvedToolView} from '../../src/gateway-client.js';
import type {WorkflowSubmission} from '../../src/workflow.js';

const engine = new EventStore({connectionString: engineDatabaseUrl, actor: 'engine'});
const engineClient = new Client({connectionString: engineDatabaseUrl});
const digest = `sha256:${'f'.repeat(64)}`;

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
            log_fields: ['status', 'risk.score'],
        },
        {
            tool_id: 'record.track',
            tool_version: '1.0.0',
            input_schema: {type: 'object'},
            output_schema: {type: 'object'},
            route_id: 'route-track',
            adapter: {protocol: 'grpc'},
            txn: {effect_class: 'none', mode: 'plain', idempotent_retryable: true},
            compensation_style: 'none',
            footprint: [],
            writes: [],
            timeout_ms: 1000,
            retry_constraints: {max_attempts: 1, initial_backoff_ms: 0, multiplier_milli: 1000, max_backoff_ms: 0},
            owner: 'team',
            allowed_roles: ['operator'],
            log_fields: ['status'],
        },
    ],
};

const resolved: ResolvedToolView = {identity: {tool_view_ref: 'tool-views/r.json', tool_view_digest: digest}, document, registry: loadToolRegistry(document)};
const gateway = {
    async resolveToolView(_digest?: string, _authorization?: DiscoveryAuthorization): Promise<ResolvedToolView> {
        return resolved;
    },
} as unknown as GatewayClient;

const templates = new RuleTemplateStore(engine);
// The submitter resolves each router's rule at freeze and pins its digest, so it needs the same
// store the executor later resolves that pin from.
const submitter = new WorkflowSubmitter(engine, gateway, templates);
const routers = new RouterExecutor(engine, templates, submitter);

/** The coordinate the compiler stamps on the router it interposes ahead of `decide`. */
const DECIDE_SLOT = slotIdOf('returns', ['record.read'], 'decide');

function trackingTemplate(templateRef: string, slotId?: string): RuleTemplateDraft {
    return {
        templateRef,
        author: 'operator@example',
        ...(slotId ? {slotId} : {}),
        branches: [
            {
                condition: 'record.read.output.status == "shipped"',
                subDag: {vertices: [{id: 'track', kind: 'tool', tool: 'record.track', parents: []}], scopes: []},
            },
        ],
    };
}

async function startRun(): Promise<string> {
    const run = await engine.createRun();
    await engine.appendEvents(run, [{event_type: 'run/start', payload: {schema_version: 'v1'}}]);
    return run;
}

/**
 * Submits `lookup -> decide`, which normalization turns into `lookup -> decide#router -> decide`.
 *
 * The router binds by slot, never by rewriting its own event: the log is append-only, and the
 * database refuses an update to it even from the Engine.
 */
async function routedRun(): Promise<{run: string; routerId: string; lookupId: string}> {
    const run = await startRun();
    const vertices: WorkflowSubmission['vertices'] = [
        {id: 'lookup', kind: 'tool', tool: 'record.read'},
        {id: 'decide', kind: 'planner', parents: ['lookup']},
    ];
    const result = await submitter.submit(run, {submissionId: `sub-${randomUUID()}`, schemaVersion: 'v1', workflowType: 'returns', vertices});
    if (result.status !== 'accepted') throw new Error('expected an accepted submission');
    return {run, routerId: result.vertexIds.get('decide#router')!, lookupId: result.vertexIds.get('lookup')!};
}

/** Completes the upstream read, lifting the summary fields a router decides on. */
async function completeLookup(run: string, lookupId: string, status: string): Promise<void> {
    await engine.appendEvents(run, [{event_type: 'vertex/started', vertex_id: lookupId, payload: {attempt: 1}}]);
    await engine.appendEvents(run, [{event_type: 'vertex/succeeded', vertex_id: lookupId, payload: {result: {}, log_fields: {status, 'risk.score': 12}}}]);
}

beforeAll(async () => {
    await engineClient.connect();
});

afterAll(async () => {
    for (;;) {
        const claimed = await engineClient.query<{vertex_id: string}>('SELECT vertex_id FROM claim_ready_read($1, $2)', ['router-drain', 30]);
        const vertexId = claimed.rows[0]?.vertex_id;
        if (!vertexId) break;
        await engineClient.query('SELECT complete_read($1, $2)', ['router-drain', vertexId]);
    }
    await engineClient.end();
    await engine.close();
});

describe('router runtime', () => {
    it('publishes a template into the configuration stream and resolves it by reference', async () => {
        const reference = `rule://track-${randomUUID()}@v1`;
        const result = await templates.publish(trackingTemplate(reference), resolved);
        expect(result.admitted).toBe(true);
        expect(templates.resolve(reference)?.templateRef).toBe(reference);

        const recorded = await engine.readBusinessStream('config:rule-templates');
        const entry = recorded.find((row) => (row.payload as {template_ref?: string}).template_ref === reference)!;
        expect(entry.event_type).toBe('rule_template/published');
        expect((entry.payload as {capability: {is_pure_read_only: boolean}}).capability.is_pure_read_only).toBe(true);
    });

    it('matches a branch, emits it, and attaches it to the router that decided', async () => {
        const reference = `rule://track-${randomUUID()}@v1`;
        await templates.publish(trackingTemplate(reference, DECIDE_SLOT), resolved);
        const {run, routerId, lookupId} = await routedRun();
        await completeLookup(run, lookupId, 'shipped');

        const evaluation = await routers.evaluate(run, routerId);
        expect(evaluation.outcome).toMatchObject({kind: 'matched', branch: 0});

        // The proposal records that a rule decided this, not a model.
        const proposed = await engineClient.query<{payload: {source: string}}>(
            `SELECT payload FROM run_event_log WHERE run_id = $1 AND event_type = 'subgraph/proposed' ORDER BY run_seq DESC LIMIT 1`,
            [run],
        );
        expect(proposed.rows[0]!.payload.source).toBe('router');

        // The emitted branch hangs off the router, so causal order records what decided it.
        const emitted = evaluation.emitted!.get('track')!;
        const created = await engineClient.query<{parent_refs: string[]}>(`SELECT parent_refs FROM run_event_log WHERE run_id = $1 AND vertex_id = $2 AND event_type = 'vertex/created'`, [
            run,
            emitted,
        ]);
        expect(created.rows[0]!.parent_refs).toEqual([routerId]);

        // vertex/started always precedes the terminal event, even though nothing was called.
        const trajectory = await engineClient.query<{event_type: string}>(`SELECT event_type FROM run_event_log WHERE run_id = $1 AND vertex_id = $2 ORDER BY run_seq`, [run, routerId]);
        expect(trajectory.rows.map((row) => row.event_type)).toEqual(['vertex/created', 'vertex/started', 'vertex/succeeded']);
    });

    it('falls through when no condition holds, emitting nothing', async () => {
        const reference = `rule://track-${randomUUID()}@v1`;
        await templates.publish(trackingTemplate(reference, DECIDE_SLOT), resolved);
        const {run, routerId, lookupId} = await routedRun();
        await completeLookup(run, lookupId, 'pending');

        const evaluation = await routers.evaluate(run, routerId);
        expect(evaluation.outcome).toEqual({kind: 'no_match'});
        expect(evaluation.emitted).toBeUndefined();

        const proposals = await engineClient.query<{count: string}>(`SELECT count(*) AS count FROM run_event_log WHERE run_id = $1 AND event_type = 'subgraph/proposed'`, [run]);
        // One proposal only: the submission itself. The router added none.
        expect(Number(proposals.rows[0]!.count)).toBe(1);
    });

    it('leaves a downstream planner the same context as a run with no rule bound', async () => {
        const reference = `rule://track-${randomUUID()}@v1`;
        await templates.publish(trackingTemplate(reference), resolved);

        const bound = await routedRun();
        await completeLookup(bound.run, bound.lookupId, 'pending');
        await routers.evaluate(bound.run, bound.routerId);

        const unbound = await routedRun();
        await completeLookup(unbound.run, unbound.lookupId, 'pending');
        await routers.evaluate(unbound.run, unbound.routerId);

        const contextOf = async (run: string): Promise<unknown> => {
            const events = await engine.readStream(run);
            const view = surface(events);
            const planner = [...view.vertices.values()].find((vertex) => vertex.role === 'planner')!;
            // Vertex ids differ between runs and linearize orders by them, so compare the
            // content the planner actually reads rather than the order two UUID sets happen to give.
            return linearize(slice(view, planner.vertex_id))
                .map((item) => `${item.role}:${item.tool ?? ''}:${item.condition ?? ''}`)
                .sort();
        };
        expect(await contextOf(bound.run)).toEqual(await contextOf(unbound.run));
    });

    it('records an evaluation error as a failure rather than guessing a branch', async () => {
        const reference = `rule://missing-${randomUUID()}@v1`;
        await templates.publish(
            {
                templateRef: reference,
                author: 'operator@example',
                slotId: DECIDE_SLOT,
                branches: [
                    {
                        condition: 'record.read.output.risk.score < 30',
                        subDag: {vertices: [{id: 'track', kind: 'tool', tool: 'record.track', parents: []}], scopes: []},
                    },
                ],
            },
            resolved,
        );
        const {run, routerId, lookupId} = await routedRun();
        // The upstream tool reports no risk score, so the rule cannot be decided.
        await engine.appendEvents(run, [{event_type: 'vertex/started', vertex_id: lookupId, payload: {attempt: 1}}]);
        await engine.appendEvents(run, [{event_type: 'vertex/succeeded', vertex_id: lookupId, payload: {result: {}, log_fields: {status: 'shipped'}}}]);

        const evaluation = await routers.evaluate(run, routerId);
        expect(evaluation.outcome).toMatchObject({kind: 'evaluation_error'});
        const trajectory = await engineClient.query<{event_type: string}>(`SELECT event_type FROM run_event_log WHERE run_id = $1 AND vertex_id = $2 ORDER BY run_seq`, [run, routerId]);
        expect(trajectory.rows.map((row) => row.event_type)).toEqual(['vertex/created', 'vertex/started', 'vertex/failed']);
    });
});

describe('freeze-time admission', () => {
    it('stamps the placement it derived and the rule it pinned onto the router vertex', async () => {
        const reference = `rule://track-${randomUUID()}@v1`;
        const published = await templates.publish(trackingTemplate(reference, DECIDE_SLOT), resolved);
        if (!published.admitted) throw new Error('expected an admitted template');
        const {run, routerId} = await routedRun();

        const created = await engineClient.query<{payload: {placement?: string}; pin_version: string | null}>(
            `SELECT payload, pin_version FROM run_event_log WHERE run_id = $1 AND vertex_id = $2 AND event_type = 'vertex/created'`,
            [run, routerId],
        );
        // Placement is derived from the run's own scope state, never declared by the author.
        expect(created.rows[0]!.payload.placement).toBe('at_savepoint');
        // The rule is a pin like any other external contract, so a fork substitutes it by column.
        expect(created.rows[0]!.pin_version).toBe(published.template.digest);
    });

    it('decides with the rule frozen onto it, not the one the slot holds later', async () => {
        const first = `rule://track-${randomUUID()}@v1`;
        await templates.publish(trackingTemplate(first, DECIDE_SLOT), resolved);
        const {run, routerId, lookupId} = await routedRun();

        // The slot is rebound after the freeze. A router that resolved by slot at evaluation time
        // would silently decide with this rule instead, and two replays could disagree.
        const second = `rule://track-${randomUUID()}@v1`;
        await templates.publish(
            {
                templateRef: second,
                author: 'operator@example',
                slotId: DECIDE_SLOT,
                branches: [{condition: 'record.read.output.status == "pending"', subDag: {vertices: [{id: 'track', kind: 'tool', tool: 'record.track', parents: []}], scopes: []}}],
            },
            resolved,
        );

        await completeLookup(run, lookupId, 'shipped');
        const evaluation = await routers.evaluate(run, routerId);
        // The pinned rule matches on "shipped"; the rule now bound to the slot does not.
        expect(evaluation.outcome).toMatchObject({kind: 'matched', condition: 'record.read.output.status == "shipped"'});
    });
});
