import {randomUUID} from 'node:crypto';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {Client} from 'pg';
import {coordinatorDatabaseUrl, engineDatabaseUrl} from '../../../db/config.js';
import {EventStore} from '../../src/store.js';
import {loadToolRegistry, type ToolViewDocument, type ToolViewTool} from '../../src/tool-view.js';
import {WorkflowSubmitter} from '../../src/submission.js';
import {RuleTemplateStore, slotIdOf, type RuleTemplateDraft} from '../../src/rule-template.js';
import {RouterExecutor} from '../../src/router-executor.js';
import {routerAdmission, routerInvisibility, rulePinSubstitution} from '../../src/harness/oracles.js';
import {surface} from '../../src/projection.js';
import type {StoredEvent} from '../../src/events.js';
import type {DiscoveryAuthorization, GatewayClient, ResolvedToolView} from '../../src/gateway-client.js';
import type {WorkflowSubmission} from '../../src/workflow.js';

/**
 * Scenario rows S15, S15b, S17 and S20 of the validation harness matrix (doc 06 section 6).
 *
 * Each row exists to kill one accident, and each is written so that removing the discipline it
 * names makes it fail: S15 and S15b that freeze admits branches rather than the runtime
 * discovering them, S17 that a fall-through router is invisible in a prompt, S20 that a rule is a
 * pin and substituting it is not a structural edit.
 */

const engine = new EventStore({connectionString: engineDatabaseUrl, actor: 'engine'});
// Only the Coordinator may write transaction events, so opening a scope needs its role.
const coordinator = new EventStore({connectionString: coordinatorDatabaseUrl, actor: 'coordinator'});
const engineClient = new Client({connectionString: engineDatabaseUrl});
const VERSIONS = {projector_version: 'projector@v1', harness_state_version: 'harness@v1'};

function contract(toolId: string, effectClass: 'none' | 'reversible', logFields: string[]): ToolViewTool {
    return {
        tool_id: toolId,
        tool_version: '1.0.0',
        input_schema: {type: 'object'},
        output_schema: {type: 'object'},
        route_id: `route-${toolId}`,
        adapter: {protocol: 'grpc'},
        txn: {effect_class: effectClass, mode: 'plain', idempotent_retryable: true},
        compensation_style: 'none',
        footprint: effectClass === 'none' ? [] : ['record'],
        writes: effectClass === 'none' ? [] : ['record'],
        timeout_ms: 1000,
        retry_constraints: {max_attempts: 1, initial_backoff_ms: 0, multiplier_milli: 1000, max_backoff_ms: 0},
        owner: 'team',
        allowed_roles: ['operator'],
        log_fields: logFields,
    };
}

/** The catalogue a template is published against. */
const document: ToolViewDocument = {
    tool_view_version: 'v2',
    tools: [contract('record.read', 'none', ['status']), contract('record.track', 'none', ['status']), contract('record.hold', 'reversible', [])],
};

/** The same catalogue as a role that may not track sees it: `record.track` is simply absent. */
const restricted: ToolViewDocument = {tool_view_version: 'v2', tools: [contract('record.read', 'none', ['status'])]};

function view(source: ToolViewDocument, name: string, digestFill: string): ResolvedToolView {
    return {identity: {tool_view_ref: `tool-views/${name}.json`, tool_view_digest: `sha256:${digestFill.repeat(64)}`}, document: source, registry: loadToolRegistry(source)};
}

const fullView = view(document, 'full', 'a');
const restrictedView = view(restricted, 'restricted', 'b');

function gatewayFor(resolved: ResolvedToolView): GatewayClient {
    return {
        async resolveToolView(_digest?: string, _authorization?: DiscoveryAuthorization): Promise<ResolvedToolView> {
            return resolved;
        },
    } as unknown as GatewayClient;
}

const templates = new RuleTemplateStore(engine);
const submitter = new WorkflowSubmitter(engine, gatewayFor(fullView), templates);
const restrictedSubmitter = new WorkflowSubmitter(engine, gatewayFor(restrictedView), templates);
const routers = new RouterExecutor(engine, templates, submitter);

/** A branch that tracks a shipped record: legal everywhere, for any role that may track. */
function trackingBranch(condition: string): RuleTemplateDraft['branches'][number] {
    return {condition, subDag: {vertices: [{id: 'track', kind: 'tool', tool: 'record.track', parents: []}], scopes: []}};
}

async function startRun(): Promise<string> {
    const run = await engine.createRun();
    await engine.appendEvents(run, [{event_type: 'run/start', payload: {schema_version: 'v1'}}]);
    return run;
}

/** Submits `lookup -> decide`, which normalization turns into `lookup -> decide#router -> decide`. */
function workflow(workflowType: string): WorkflowSubmission {
    return {
        submissionId: `sub-${randomUUID()}`,
        schemaVersion: 'v1',
        workflowType,
        vertices: [
            {id: 'lookup', kind: 'tool', tool: 'record.read'},
            {id: 'decide', kind: 'planner', parents: ['lookup']},
        ],
    };
}

async function completeLookup(run: string, lookupId: string, status: string): Promise<void> {
    await engine.appendEvents(run, [{event_type: 'vertex/started', vertex_id: lookupId, payload: {attempt: 1}}]);
    await engine.appendEvents(run, [{event_type: 'vertex/succeeded', vertex_id: lookupId, payload: {result: {}, log_fields: {status}}}]);
}

/** Runs `lookup -> router -> planner` through freeze and returns the identifiers it allocated. */
async function routedRun(workflowType: string): Promise<{run: string; routerId: string; lookupId: string; plannerId: string}> {
    const run = await startRun();
    const result = await submitter.submit(run, workflow(workflowType));
    if (result.status !== 'accepted') throw new Error(`expected an accepted submission, got ${JSON.stringify(result.violations)}`);
    return {run, routerId: result.vertexIds.get('decide#router')!, lookupId: result.vertexIds.get('lookup')!, plannerId: result.vertexIds.get('decide')!};
}

beforeAll(async () => {
    await engineClient.connect();
});

afterAll(async () => {
    for (;;) {
        const claimed = await engineClient.query<{vertex_id: string}>('SELECT vertex_id FROM claim_ready_read($1, $2)', ['scenario-drain', 30]);
        const vertexId = claimed.rows[0]?.vertex_id;
        if (!vertexId) break;
        await engineClient.query('SELECT complete_read($1, $2)', ['scenario-drain', vertexId]);
    }
    await engineClient.end();
    await coordinator.close();
    await engine.close();
});

describe("S15 — a branch naming a tool this run's role may not call", () => {
    it('is refused at freeze, before the proposing planner freezes and before any tool runs', async () => {
        const type = `returns-s15-${randomUUID().slice(0, 8)}`;
        await templates.publish(
            {
                templateRef: `rule://track-${randomUUID()}@v1`,
                author: 'operator@example',
                slotId: slotIdOf(type, ['record.read'], 'decide'),
                branches: [trackingBranch('record.read.output.status == "shipped"')],
            },
            fullView,
        );

        // The template was admitted against the full catalogue; this run resolves a view without
        // record.track, which is what R13 is asked about.
        const run = await startRun();
        const result = await restrictedSubmitter.submit(run, workflow(type));

        expect(result.status).toBe('rejected');
        if (result.status !== 'rejected') throw new Error('unreachable');
        expect(result.stage).toBe('admission');
        expect(result.violations.some((violation) => violation.rule === 'R13' && violation.message.includes('record.track'))).toBe(true);
        expect(routerAdmission(await engine.readStream(run))).toMatchObject({passed: true});
    });
});

describe('S15b — exhaustive admission across every branch', () => {
    it('refuses a rule whose non-matching branch opens a fresh scope inside an active one', async () => {
        const type = `returns-s15b-${randomUUID().slice(0, 8)}`;
        const publication = await templates.publish(
            {
                templateRef: `rule://hold-${randomUUID()}@v1`,
                author: 'operator@example',
                slotId: slotIdOf(type, ['record.read'], 'decide'),
                branches: [
                    // Legal here, and the only branch this run's facts could ever select.
                    trackingBranch('record.read.output.status == "shipped"'),
                    // Legal at a savepoint, illegal inside an active scope, never selected.
                    {
                        condition: 'record.read.output.status == "held"',
                        subDag: {vertices: [{id: 'hold', kind: 'tool', tool: 'record.hold', parents: [], scopeId: 'hold-scope'}], scopes: [{id: 'hold-scope', members: ['hold']}]},
                    },
                ],
            },
            fullView,
        );
        expect(publication.admitted).toBe(true);

        const run = await startRun();
        await coordinator.appendEvents(run, [{event_type: 'txn/scope', scope_id: randomUUID(), payload: {state: 'open'}}]);
        const result = await submitter.submit(run, workflow(type));

        // Checking only the branch that would match is the defect this row exists to kill: the
        // illegal branch would otherwise surface on the day its condition first holds.
        expect(result.status).toBe('rejected');
        if (result.status !== 'rejected') throw new Error('unreachable');
        expect(result.violations.some((violation) => violation.rule === 'R12' && violation.message.includes('fresh scope'))).toBe(true);

        const events = await engine.readStream(run);
        expect(routerAdmission(events)).toMatchObject({passed: true});
        expect(events.some((event) => event.event_type === 'vertex/created')).toBe(false);
    });
});

describe('S17 — prompt invisibility of a fall-through router', () => {
    it('reaches the downstream planner with the same prompt bound or unbound', async () => {
        const boundType = `returns-s17-bound-${randomUUID().slice(0, 8)}`;
        await templates.publish(
            {
                templateRef: `rule://track-${randomUUID()}@v1`,
                author: 'operator@example',
                slotId: slotIdOf(boundType, ['record.read'], 'decide'),
                branches: [trackingBranch('record.read.output.status == "shipped"')],
            },
            fullView,
        );

        // Same scenario, same facts. One slot holds a rule whose condition is false here; the other
        // holds nothing at all. Interposition is mandatory, so both graphs contain the router.
        const bound = await routedRun(boundType);
        const unbound = await routedRun(`returns-s17-unbound-${randomUUID().slice(0, 8)}`);
        for (const variant of [bound, unbound]) {
            await completeLookup(variant.run, variant.lookupId, 'pending');
            await routers.evaluate(variant.run, variant.routerId);
        }

        const result = routerInvisibility(
            {events: await engine.readStream(bound.run), plannerVertexId: bound.plannerId},
            {events: await engine.readStream(unbound.run), plannerVertexId: unbound.plannerId},
            VERSIONS,
        );
        expect(result).toMatchObject({passed: true});
    });
});

describe('S20 — rule-template counterfactual', () => {
    it('substitutes which rule a router binds without changing the graph', async () => {
        const type = `returns-s20-${randomUUID().slice(0, 8)}`;
        const slotId = slotIdOf(type, ['record.read'], 'decide');
        const v2 = await templates.publish(
            {templateRef: `rule://route-${randomUUID()}@v2`, author: 'operator@example', slotId, branches: [trackingBranch('record.read.output.status == "shipped"')]},
            fullView,
        );
        // v3 decides the same facts differently: same condition, a different action.
        const v3 = await templates.publish(
            {
                templateRef: `rule://route-${randomUUID()}@v3`,
                author: 'operator@example',
                branches: [{condition: 'record.read.output.status == "shipped"', subDag: {vertices: [{id: 're-read', kind: 'tool', tool: 'record.read', parents: []}], scopes: []}}],
            },
            fullView,
        );
        if (!v2.admitted || !v3.admitted) throw new Error('expected both templates to be admitted');

        const {run, routerId, lookupId} = await routedRun(type);
        await completeLookup(run, lookupId, 'shipped');
        const original = await routers.evaluate(run, routerId);
        expect(original.outcome).toMatchObject({kind: 'matched'});
        expect([...original.emitted!.keys()]).toEqual(['track']);

        const sourceEvents = await engine.readStream(run);
        const routerCreated = sourceEvents.find((event) => event.event_type === 'vertex/created' && event.vertex_id === routerId)!;
        expect(routerCreated.pin_version).toBe(v2.template.digest);

        // One substitution, at the router, of the rule it binds. Nothing structural is edited.
        const fork = await engine.fork({
            source_run_id: run,
            at_vertex_id: routerId,
            substitutions: [{run_seq: routerCreated.run_seq, pin_version: v3.template.digest}],
            eval_up_to_seq: sourceEvents.at(-1)!.run_seq,
            fold_mode: 'recorded',
            evaluator_pin: 'eval://identity@v1',
            projector_version: VERSIONS.projector_version,
            harness_state_version: VERSIONS.harness_state_version,
        });

        // The lookup succeeded after the router was created but is not caused by it, so it is an
        // independent event the fork merges lazily rather than inheriting in its seed.
        await engine.mergeIndependentEvents(fork.child_run_id);
        const seed = await engine.readStream(fork.child_run_id);
        const prefix = sourceEvents.filter((event) => event.run_seq <= routerCreated.run_seq);
        expect(rulePinSubstitution(prefix, seed)).toMatchObject({passed: true});
        expect(pinOf(seed, routerId)).toBe(v3.template.digest);
        // The source is untouched: a counterfactual is an offline branch, not an edit.
        expect(pinOf(sourceEvents, routerId)).toBe(v2.template.digest);

        // The fork decides with the substituted rule, so the counterfactual is answerable.
        const counterfactual = await routers.evaluate(fork.child_run_id, routerId);
        expect(counterfactual.outcome).toMatchObject({kind: 'matched'});
        expect([...counterfactual.emitted!.keys()]).toEqual(['re-read']);
        expect(surface(seed).vertices.get(routerId)!.role).toBe('router');
    });
});

/** Returns the pin a run froze onto one vertex. */
function pinOf(events: StoredEvent[], vertexId: string): string | null {
    return events.find((event) => event.event_type === 'vertex/created' && event.vertex_id === vertexId)!.pin_version;
}
