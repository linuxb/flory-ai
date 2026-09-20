import {checkFreezeAdmission, checkScopeAdmission, checkSubDag, derivePlacement, type CheckViolation, type RouterPlacement, type ScopeSnapshot} from './check-rules.js';
import type {EventDraft} from './events.js';
import type {DiscoveryAuthorization, GatewayClient, ResolvedToolView} from './gateway-client.js';
import type {PublishedRuleTemplate} from './rule-template.js';
import type {EventStore} from './store.js';
import {compileVertexDrafts, lowerToProposal, normalizeWorkflow, routerSlotIds, submissionDigest, type RouterBinding, type WorkflowSubmission} from './workflow.js';

/** Which gate refused a submission. */
export type RejectionStage = 'resolution' | 'registry' | 'admission';

/** The outcome of one workflow submission. */
export type SubmissionResult =
    | {status: 'accepted'; proposedSeq: number; frozenSeq: number; vertexIds: Map<string, string>}
    | {status: 'rejected'; proposedSeq: number; rejectedSeq: number; stage: RejectionStage; violations: CheckViolation[]};

/** Rules the checker reports about the published catalogue rather than about this workflow. */
const REGISTRY_RULES = new Set(['R4', 'R6']);

/**
 * The subset of the rule-template store that freeze needs.
 *
 * Narrowed to two lookups so the submission path depends on resolution rather than on the store
 * that happens to provide it, which is what lets a replay resolve from recorded history instead.
 */
export interface TemplateResolver {
    resolve(reference: string): PublishedRuleTemplate | undefined;
    resolveSlot(slotId: string): PublishedRuleTemplate | undefined;
}

/**
 * Turns a submitted workflow into frozen executable structure.
 *
 * The invariant this class exists to hold is that **every `subgraph/proposed` is followed by either
 * a `subgraph/frozen` or a `subgraph/rejected`**. `checkSubDag` throws rather than reports on three
 * ordinary authoring mistakes — an unpublished tool, a cycle, and an unknown parent — so each is
 * caught before admission and recorded as a rejection. A proposal with no terminal event is a state
 * no reader can render and no operator can act on.
 */
export class WorkflowSubmitter {
    /**
     * `templates` is optional, and its absence is meaningful rather than lenient: with no resolver
     * no router can bind a rule, every router is an unbound pass-through, and there are no branches
     * for freeze to admit. A configuration with rules always supplies one.
     */
    constructor(
        private readonly store: EventStore,
        private readonly gateway: GatewayClient,
        private readonly templates?: TemplateResolver,
    ) {}

    /**
     * Normalizes, admits, and freezes one submission into an existing run.
     *
     * The run is a parameter rather than something created here: replanning and router-emitted
     * branches freeze into a run that already exists, so freeze has to be run-agnostic.
     */
    async submit(runId: string, submission: WorkflowSubmission, authorization?: DiscoveryAuthorization): Promise<SubmissionResult> {
        const {workflow, interposed} = normalizeWorkflow(submission);
        const resolved = await this.gateway.resolveToolView(undefined, authorization);

        const proposedSeq = await this.appendOne(runId, {
            event_type: 'subgraph/proposed',
            payload: {
                tool_view_ref: resolved.identity.tool_view_ref,
                tool_view_digest: resolved.identity.tool_view_digest,
                submission_id: submission.submissionId,
                submission_digest: submissionDigest(submission),
                source: submission.source ?? 'submitted',
                vertex_count: workflow.vertices.length,
                interposed_routers: interposed,
            },
        });

        const unresolvable = resolutionViolations(workflow, resolved);
        if (unresolvable.length) return this.reject(runId, proposedSeq, 'resolution', unresolvable);

        // Everything that reads scope state happens inside one locked transaction, and a clean
        // decision's freeze commits with it. Admission and placement must see the same scopes as
        // each other and as the append: a read taken before the lock could describe a scope this
        // very freeze then queues work under while a sweeper is fencing it.
        let refusal: {stage: RejectionStage; violations: CheckViolation[]} | undefined;
        let vertexIds = new Map<string, string>();
        const sequences = await this.store.freezeUnderScopeLock(runId, (context) => {
            const runtime = checkScopeAdmission(context.scopes);
            if (!runtime.accepted) {
                refusal = {stage: 'admission', violations: runtime.violations};
                return {admitted: false};
            }

            const result = checkSubDag(lowerToProposal(workflow), resolved.registry, context.scopes);
            if (!result.accepted) {
                // A malformed published contract makes every submission rejectable, so an author is
                // told which of the two it is rather than being blamed for the catalogue.
                const stage: RejectionStage = result.violations.every((violation) => REGISTRY_RULES.has(violation.rule)) ? 'registry' : 'admission';
                refusal = {stage, violations: result.violations};
                return {admitted: false};
            }

            // Freeze-time admission of the branches a router may later emit. This is the whole point
            // of publishing rules ahead of time: a branch that is illegal where this router sits is
            // refused now, before any tool runs, rather than when the condition that selects it
            // happens to hold.
            const bound = this.bindRouters(workflow, derivePlacement(context.scopes));
            const branchViolations = admissionViolations(bound, resolved, context.scopes, context.isCounterfactual);
            if (branchViolations.length) {
                refusal = {stage: 'admission', violations: branchViolations};
                return {admitted: false};
            }

            const compiled = compileVertexDrafts(workflow, resolved, new Map([...bound].map(([authorId, router]) => [authorId, router.binding])));
            vertexIds = compiled.vertexIds;
            const frozen: EventDraft = {
                event_type: 'subgraph/frozen',
                payload: {
                    proposed_seq: proposedSeq,
                    tool_view_ref: resolved.identity.tool_view_ref,
                    tool_view_digest: resolved.identity.tool_view_digest,
                    // The author id has nowhere to live on a vertex payload, which is closed, so the
                    // mapping is recorded here. It is also the delta a console renders a new branch from.
                    vertices: workflow.vertices.map((vertex) => ({author_id: vertex.id, vertex_id: compiled.vertexIds.get(vertex.id)!, role: vertex.kind})),
                    scopes: [...compiled.scopeIds].map(([authorId, scopeId]) => ({author_id: authorId, scope_id: scopeId})),
                },
            };
            return {admitted: true, events: [frozen, ...compiled.drafts]};
        });
        if (refusal) return this.reject(runId, proposedSeq, refusal.stage, refusal.violations);
        return {status: 'accepted', proposedSeq, frozenSeq: sequences![0]!, vertexIds};
    }

    /**
     * Resolves the template every router in this submission binds, by pinned reference first and
     * then by slot coordinate, and records where each one sits.
     */
    private bindRouters(workflow: WorkflowSubmission, placement: RouterPlacement): Map<string, BoundRouter> {
        const slots = routerSlotIds(workflow);
        const bound = new Map<string, BoundRouter>();
        for (const vertex of workflow.vertices) {
            if (vertex.kind !== 'router') continue;
            const slotId = slots.get(vertex.id);
            const template = vertex.templateRef ? this.templates?.resolve(vertex.templateRef) : slotId ? this.templates?.resolveSlot(slotId) : undefined;
            bound.set(vertex.id, {template, binding: {placement, ...(template ? {pinVersion: template.digest} : {})}});
        }
        return bound;
    }

    private async reject(runId: string, proposedSeq: number, stage: RejectionStage, violations: CheckViolation[]): Promise<SubmissionResult> {
        const rejectedSeq = await this.appendOne(runId, {
            event_type: 'subgraph/rejected',
            payload: {proposed_seq: proposedSeq, stage, violations},
        });
        return {status: 'rejected', proposedSeq, rejectedSeq, stage, violations};
    }

    private async appendOne(runId: string, draft: EventDraft): Promise<number> {
        const sequences = await this.store.appendEvents(runId, [draft]);
        return sequences[0]!;
    }
}

/**
 * Reports the authoring mistakes the checker would throw on.
 *
 * Structural closure and acyclicity are checked by `normalizeWorkflow`, which runs first, so what
 * remains here is tool resolvability against this run's role-scoped view.
 */
function resolutionViolations(workflow: WorkflowSubmission, resolved: ResolvedToolView): CheckViolation[] {
    const violations: CheckViolation[] = [];
    for (const vertex of workflow.vertices) {
        if (vertex.kind !== 'tool') continue;
        if (!resolved.registry.has(vertex.tool)) {
            violations.push({rule: 'R13', message: `${vertex.id} names ${vertex.tool}, absent from this run's role-scoped tool view`, vertices: [vertex.id]});
        }
    }
    return violations;
}

/** One router of a submission, with whatever rule it resolved and what freeze decided about it. */
interface BoundRouter {
    template?: PublishedRuleTemplate;
    binding: RouterBinding;
}

/**
 * Admits the branches of every bound router at the placement its own router sits at.
 *
 * An unbound router contributes nothing: it falls through, and there is no branch to judge. A bound
 * one is judged in full, so a rule whose *non-matching* branch is illegal here is refused at freeze
 * rather than lying dormant until its condition holds.
 */
function admissionViolations(bound: ReadonlyMap<string, BoundRouter>, resolved: ResolvedToolView, scopes: readonly ScopeSnapshot[], isCounterfactual: boolean): CheckViolation[] {
    const violations: CheckViolation[] = [];
    for (const [authorId, router] of bound) {
        if (!router.template) continue;
        const outcome = checkFreezeAdmission(router.template.branches, {placement: router.binding.placement, isReadOnlyContext: isCounterfactual, roleToolView: resolved.registry}, scopes);
        for (const violation of outcome.violations) {
            violations.push({...violation, message: `${authorId} pins ${router.template.templateRef}: ${violation.message}`});
        }
    }
    return violations;
}
