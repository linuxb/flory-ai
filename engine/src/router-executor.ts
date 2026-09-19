import type {StoredEvent} from './events.js';
import type {RuleTemplateStore} from './rule-template.js';
import type {PublishedRuleTemplate} from './rule-template.js';
import type {EventStore} from './store.js';
import type {WorkflowSubmitter} from './submission.js';
import type {SubmittedVertex, WorkflowSubmission} from './workflow.js';
import {evaluateRouter, type RouterFacts, type RouterOutcome} from './router.js';

/** What the engine did with one router vertex. */
export interface RouterEvaluation {
    outcome: RouterOutcome;
    /** Author-id to vertex-id mapping of the emitted branch, when one was emitted and admitted. */
    emitted?: Map<string, string>;
}

/**
 * Evaluates router vertices.
 *
 * A router is executed by the Engine synchronously on parent completion and is never queued: it
 * calls nothing, so there is nothing for a worker to claim, and a queue row would let a lease
 * expiry fabricate a failure for a pure function.
 */
export class RouterExecutor {
    constructor(
        private readonly store: EventStore,
        private readonly templates: RuleTemplateStore,
        private readonly submitter: WorkflowSubmitter,
    ) {}

    /**
     * Runs one router to one of its four outcomes.
     *
     * The event trajectory is strict: `vertex/started` always precedes the terminal event, even
     * though nothing is called. The trace validator and the formal models depend on that
     * transition existing for every vertex role.
     */
    async evaluate(runId: string, routerVertexId: string): Promise<RouterEvaluation> {
        const events = await this.store.readStream(runId);
        const created = events.find((event) => event.event_type === 'vertex/created' && event.vertex_id === routerVertexId);
        if (!created) throw new Error(`run ${runId} has no vertex/created for router ${routerVertexId}`);

        const template = this.bind(created);
        const facts = summaryFacts(events, created.parent_refs);

        await this.store.appendEvents(runId, [{event_type: 'vertex/started', vertex_id: routerVertexId, payload: {attempt: 1, execution: 'router'}}]);

        const outcome = evaluateRouter(template, facts);
        if (outcome.kind === 'evaluation_error') {
            await this.store.appendEvents(runId, [{event_type: 'vertex/failed', vertex_id: routerVertexId, payload: {outcome: 'evaluation_error', reason: outcome.reason}}]);
            return {outcome};
        }
        if (outcome.kind === 'no_match') {
            await this.store.appendEvents(runId, [{event_type: 'vertex/succeeded', vertex_id: routerVertexId, payload: {matched_condition: null}}]);
            return {outcome};
        }

        const submission: WorkflowSubmission = {
            submissionId: `${routerVertexId}:branch-${outcome.branch}`,
            schemaVersion: 'v1',
            vertices: outcome.subDag.vertices.map(toSubmittedVertex),
            scopes: outcome.subDag.scopes.map((scope) => ({id: scope.id, members: [...scope.members]})),
            attachTo: [routerVertexId],
        };
        const result = await this.submitter.submit(runId, submission);
        if (result.status === 'rejected') {
            // Runtime scope and reservation checks may refuse a branch that was shape-valid at
            // freeze. Control does not fall through to the planner: the transaction outcome belongs
            // to the Coordinator, and a model must not be handed a deterministic policy failure.
            const rejected: RouterOutcome = {kind: 'proposal_rejected', violations: result.violations};
            await this.store.appendEvents(runId, [{event_type: 'vertex/failed', vertex_id: routerVertexId, payload: {outcome: 'proposal_rejected', violations: result.violations}}]);
            return {outcome: rejected};
        }

        await this.store.appendEvents(runId, [{event_type: 'vertex/succeeded', vertex_id: routerVertexId, payload: {matched_condition: outcome.condition, branch: outcome.branch}}]);
        return {outcome, emitted: result.vertexIds};
    }

    /**
     * Resolves the template this router decides with.
     *
     * `pin_version` is preferred over everything else because it is the only answer that is a
     * function of recorded history: freeze resolved the rule and wrote its content digest onto the
     * vertex, so a replay years later decides with the rule that was actually bound, not with
     * whatever the registry holds now. The reference and the slot remain as fallbacks for a vertex
     * frozen before pinning existed, and both read a mutable index.
     */
    private bind(created: StoredEvent): PublishedRuleTemplate | undefined {
        if (created.pin_version) return this.templates.resolve(created.pin_version);
        const payload = created.payload as {template_ref?: string; slot_id?: string};
        if (payload.template_ref) return this.templates.resolve(payload.template_ref);
        if (payload.slot_id) return this.templates.resolveSlot(payload.slot_id);
        return undefined;
    }
}

/** Restates a template's branch vertex as a submitted one. */
function toSubmittedVertex(vertex: {id: string; parents: string[]; kind: string; tool?: string; scopeId?: string}): SubmittedVertex {
    const base = {id: vertex.id, parents: [...vertex.parents], ...(vertex.scopeId ? {scope: vertex.scopeId} : {})};
    if (vertex.kind === 'tool') return {...base, kind: 'tool', tool: vertex.tool!};
    if (vertex.kind === 'router') return {...base, kind: 'router'};
    if (vertex.kind === 'planner') return {...base, kind: 'planner'};
    return {...base, kind: 'confirmation-barrier'};
}

/**
 * Collects the summary fields the router's upstream tools lifted into `vertex/succeeded`.
 *
 * Keyed by tool type, because that is what a condition names: a template is published before it is
 * bound to any graph, so it cannot refer to a vertex. Reading only these in-event fields is what
 * keeps a router's decision free of blob I/O.
 */
export function summaryFacts(events: readonly StoredEvent[], parentRefs: readonly string[]): RouterFacts {
    const parents = new Set(parentRefs);
    const toolOf = new Map<string, string>();
    for (const event of events) {
        if (event.event_type !== 'vertex/created' || !event.vertex_id || !parents.has(event.vertex_id)) continue;
        const tool = (event.payload as {tool?: string}).tool;
        if (tool) toolOf.set(event.vertex_id, tool);
    }
    const facts = new Map<string, Record<string, unknown>>();
    for (const event of events) {
        if (event.event_type !== 'vertex/succeeded' || !event.vertex_id) continue;
        const tool = toolOf.get(event.vertex_id);
        if (!tool) continue;
        const lifted = (event.payload as {log_fields?: Record<string, unknown>}).log_fields;
        if (lifted) facts.set(tool, lifted);
    }
    return facts;
}
