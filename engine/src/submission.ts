import {checkSubDag, type CheckViolation} from './check-rules.js';
import type {EventDraft} from './events.js';
import type {DiscoveryAuthorization, GatewayClient, ResolvedToolView} from './gateway-client.js';
import type {EventStore} from './store.js';
import {compileVertexDrafts, lowerToProposal, normalizeWorkflow, submissionDigest, type WorkflowSubmission} from './workflow.js';

/** Which gate refused a submission. */
export type RejectionStage = 'resolution' | 'registry' | 'admission';

/** The outcome of one workflow submission. */
export type SubmissionResult =
    | {status: 'accepted'; proposedSeq: number; frozenSeq: number; vertexIds: Map<string, string>}
    | {status: 'rejected'; proposedSeq: number; rejectedSeq: number; stage: RejectionStage; violations: CheckViolation[]};

/** Rules the checker reports about the published catalogue rather than about this workflow. */
const REGISTRY_RULES = new Set(['R4', 'R6']);

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
    constructor(
        private readonly store: EventStore,
        private readonly gateway: GatewayClient,
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
                source: 'submitted',
                vertex_count: workflow.vertices.length,
                interposed_routers: interposed,
            },
        });

        const unresolvable = resolutionViolations(workflow, resolved);
        if (unresolvable.length) return this.reject(runId, proposedSeq, 'resolution', unresolvable);

        const result = checkSubDag(lowerToProposal(workflow), resolved.registry);
        if (!result.accepted) {
            // A malformed published contract makes every submission rejectable, so an author is told
            // which of the two it is rather than being blamed for the catalogue.
            const stage: RejectionStage = result.violations.every((violation) => REGISTRY_RULES.has(violation.rule)) ? 'registry' : 'admission';
            return this.reject(runId, proposedSeq, stage, result.violations);
        }

        const compiled = compileVertexDrafts(workflow, resolved);
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
        const sequences = await this.store.appendFrozenSubgraph(runId, frozen, compiled.drafts);
        return {status: 'accepted', proposedSeq, frozenSeq: sequences[0]!, vertexIds: compiled.vertexIds};
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
