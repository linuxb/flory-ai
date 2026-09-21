import {assemble, linearize, slice, surface, type Surface} from './projection.js';
import {causalDescendants} from './store.js';
import type {EventDraft, StoredEvent} from './events.js';
import type {LlmPricing} from './llm-client.js';
import type {PlannerTurn, PlannerTurnRequest} from './planner-loop.js';
import type {ResolvedToolView} from './gateway-client.js';

/**
 * The recovery ladder's planning half: choosing where to resume, and discarding what is being
 * replaced.
 *
 * Design document 03 specifies five levels. What lives here is L1 and L2 — regenerating in place
 * at a legal boundary — together with the guards that decide when neither is available and the run
 * must escalate. L3 compensates and L4 suspends; both act on the world rather than on the plan, so
 * both belong to the Coordinator, and this module records the decision to escalate rather than
 * pretending to carry it out.
 *
 * Everything that decides is a pure function of the log. {@link RecoveryLoop} is the only part that
 * touches a database or a model, and it decides nothing: it appends what {@link selectBoundary}
 * concluded. That split exists because boundary selection *is* the policy — a harness cannot check
 * it by recomputing the answer without duplicating the policy and, likely, the author's
 * misunderstanding with it (03 §4.2). So the engine publishes its whole candidate set and the
 * harness checks it.
 */

/** Why a candidate boundary is ineligible. A closed vocabulary, per 03 §4.2. */
export type RejectionReason = 'open_bracket' | 'below_floor' | 'savepoint_precedes' | 'budget_exceeded' | 'failure_counter_exhausted';

/** One ancestor planner considered as a place to resume. */
export interface BoundaryCandidate {
    planner_vertex_id: string;
    planner_seq: number;
    /** Present only on a selectable candidate: a rejected one takes no part in the comparison. */
    cost?: number;
    currency?: string;
    terms?: {context_cost: number; rework_cost: number; compensation_cost?: number; risk_premium: number};
    rejected?: RejectionReason;
}

/** The ladder level one failure reached. */
export type RecoveryLevel = 'L1' | 'L2' | 'L3' | 'L4';

/** What the engine decided about one failure, before anything is appended. */
export interface BoundaryDecision {
    level: RecoveryLevel;
    reason: string;
    failedVertexId: string;
    /** Every ancestor planner, nearest first, priced or rejected. */
    candidates: BoundaryCandidate[];
    selected: string | null;
    selectedSeq: number | null;
    /** The closed set of vertices a replan discards. Empty when nothing is selected. */
    shadowed: string[];
    /** How many replans this failure episode has already used. */
    episode: number;
    estimatedCost: number | null;
    currency: string | null;
}

/** The knobs 03 leaves to policy rather than to derivation. */
export interface RecoveryPolicy {
    /** `N` in 03 §3: how many times one planner may be the boundary before it is dropped. */
    maxReplansPerPlanner: number;
    /** `E` in 03 §3: the protocol bound on one failure episode, from the S1 TLC lasso. */
    maxReplansPerEpisode: number;
    /** `≥ 1`, applied to compensation only. Policy, not price: it encodes risk aversion. */
    riskPremium: number;
    pricing: LlmPricing;
    /** Remaining model budget in `pricing.currency`; omitted means unbounded. */
    budgetRemaining?: number;
}

export const DEFAULT_RECOVERY_POLICY: Omit<RecoveryPolicy, 'pricing'> = {
    maxReplansPerPlanner: 2,
    maxReplansPerEpisode: 2,
    riskPremium: 2,
};

/**
 * Characters per token, used to turn an exactly-known prompt length into a token count.
 *
 * 03 §4.1 calls `context_cost` exact, and the part that is exact is the prompt: `linearize` is pure,
 * so its text is computed rather than guessed. Turning that text into tokens is not exact, because
 * no tokenizer is vendored here and pulling one in for a cost *comparison* would be a dependency
 * bought for two decimal places. The ratio is uniform across candidates, so it cannot change which
 * candidate is cheapest — only the absolute figure the log records, which is why the log records
 * the terms as well as the total.
 */
const CHARS_PER_TOKEN = 4;

/** Output tokens a replanned turn is assumed to cost per vertex it must regenerate. */
const TOKENS_PER_REGENERATED_VERTEX = 120;

/* ------------------------------------------------------------------ pure log reading */

/**
 * The most recent `txn/pivot-passed`, below which no boundary may be selected.
 *
 * This is a planning-authority floor, not a world-state floor, and the difference is the whole
 * point (03 §2.1). Replanning undoes nothing external, so resuming below the floor would not undo
 * the irreversible act either. The hazard is subtler: a planner below the floor is handed a context
 * in which that act has not happened yet, so performing it is still a live premise, and it may
 * legally propose a second one. R3 bounds pivots within a single scope and cannot see that this
 * pivot already executed in another.
 */
export function backtrackFloor(events: readonly StoredEvent[]): number {
    return events.reduce((floor, event) => (event.event_type === 'txn/pivot-passed' ? Math.max(floor, event.run_seq) : floor), 0);
}

/** Scopes holding a `txn/try` that no `txn/confirm` or `txn/cancel` has answered. */
export function openBracketScopes(events: readonly StoredEvent[]): Set<string> {
    const open = new Set<string>();
    for (const event of events) {
        if (!event.scope_id) continue;
        if (event.event_type === 'txn/try') open.add(event.scope_id);
        if (event.event_type === 'txn/confirm' || event.event_type === 'txn/cancel') open.delete(event.scope_id);
    }
    return open;
}

/**
 * Whether a rule authored this vertex, rather than a model.
 *
 * Rule-authored work has no author with standing to propose a replacement: it came from an audited
 * business rule, and handing its failure to a planner invites exactly the action the rule exists to
 * prevent (03 §2.5).
 *
 * Read from the proposal that froze the vertex, because the engine records who made it — the
 * router executor stamps `source: 'router'` on its own proposals. Walking ancestry to find a
 * router instead gets this wrong, and a live run showed how: a router's branch may contain a
 * *planner*, and everything that planner goes on to propose is model-authored and perfectly
 * replannable. Ancestry cannot tell those apart, because the router is an ancestor of both.
 */
export function ruleAuthored(events: readonly StoredEvent[], vertexId: string): boolean {
    const proposalSource = new Map<number, string>();
    for (const event of events) {
        if (event.event_type === 'subgraph/proposed') proposalSource.set(event.run_seq, (event.payload.source as string | undefined) ?? 'submitted');
    }
    let currentSource = 'submitted';
    for (const event of events) {
        if (event.event_type === 'subgraph/frozen') currentSource = proposalSource.get(event.payload.proposed_seq as number) ?? 'submitted';
        if (event.event_type === 'vertex/created' && event.vertex_id === vertexId) return currentSource === 'router';
    }
    return false;
}

/** Succeeded ancestor planners of a vertex, nearest first. */
export function ancestorPlanners(events: readonly StoredEvent[], vertexId: string): {vertexId: string; seq: number; depth: number}[] {
    const created = new Map(events.filter((event) => event.event_type === 'vertex/created' && event.vertex_id).map((event) => [event.vertex_id!, event]));
    const succeeded = new Map(events.filter((event) => event.event_type === 'vertex/succeeded' && event.vertex_id).map((event) => [event.vertex_id!, event.run_seq]));
    const found: {vertexId: string; seq: number; depth: number}[] = [];
    const seen = new Set<string>([vertexId]);
    let frontier = created.get(vertexId)?.parent_refs ?? [];
    for (let depth = 1; frontier.length; depth += 1) {
        const next: string[] = [];
        for (const id of frontier) {
            if (seen.has(id)) continue;
            seen.add(id);
            const seq = succeeded.get(id);
            if (created.get(id)?.payload.role === 'planner' && seq !== undefined) found.push({vertexId: id, seq, depth});
            next.push(...(created.get(id)?.parent_refs ?? []));
        }
        frontier = next;
    }
    // Nearest first, and ties broken by the later planner: two planners at the same distance are
    // both legal, and the one that ran later reconstructs the least context.
    return found.sort((first, second) => first.depth - second.depth || second.seq - first.seq);
}

/**
 * How many replans this failure episode has already used, and how many each planner has taken.
 *
 * An episode ends when a replan *worked*: when some frozen subgraph had every one of its vertices
 * reach a success. Anything weaker does not terminate, and a live run showed why — the first
 * reading counted any success as progress, and each replan's subtree did produce a passing tool
 * call or two before failing again, so the counter reset every time and the run replanned
 * indefinitely. Work that the next replan is about to discard is not progress.
 *
 * The bound exists because the per-planner counter alone cannot see two planners alternating — the
 * S1 TLC model found the lasso `P2 -> P1 -> P2` — so it is a protocol bound rather than a
 * heuristic (03 §3, 03 §6).
 */
export function replanHistory(events: readonly StoredEvent[]): {episode: number; perPlanner: Map<string, number>} {
    const succeeded = new Set(events.filter((event) => event.event_type === 'vertex/succeeded' && event.vertex_id).map((event) => event.vertex_id!));

    // The freeze each replan produced, and whether every vertex in it went on to succeed.
    const resolvedAt: number[] = [];
    for (const [index, event] of events.entries()) {
        if (event.event_type !== 'subgraph/frozen') continue;
        const created: string[] = [];
        for (const later of events.slice(index + 1)) {
            if (later.event_type !== 'vertex/created') break;
            if (later.vertex_id) created.push(later.vertex_id);
        }
        if (created.length && created.every((id) => succeeded.has(id))) resolvedAt.push(event.run_seq);
    }
    const lastResolved = resolvedAt.at(-1) ?? 0;

    let episode = 0;
    const perPlanner = new Map<string, number>();
    for (const event of events) {
        if (event.event_type !== 'replan/boundary') continue;
        const selected = event.payload.selected as string | null | undefined;
        if (event.run_seq > lastResolved) episode += 1;
        if (selected) perPlanner.set(selected, (perPlanner.get(selected) ?? 0) + 1);
    }
    return {episode, perPlanner};
}

/** Structured evidence of one failure, which is what a replanned planner is told. */
export interface FailureEvidence {
    failed_vertex_id: string;
    tool: string | null;
    error_class: string;
    error: string;
    attempts: number;
    discarded_vertices: number;
    cancelled_scopes: string[];
}

export function failureEvidence(events: readonly StoredEvent[], failedVertexId: string, discarded: readonly string[]): FailureEvidence {
    const created = events.find((event) => event.event_type === 'vertex/created' && event.vertex_id === failedVertexId);
    const failed = [...events].reverse().find((event) => event.event_type === 'vertex/failed' && event.vertex_id === failedVertexId);
    const payload = (failed?.payload ?? {}) as {attempts?: number; outcome?: string; error?: string};
    return {
        failed_vertex_id: failedVertexId,
        tool: typeof created?.payload.tool === 'string' ? created.payload.tool : null,
        error_class: payload.outcome ?? 'unknown',
        error: payload.error ?? '',
        attempts: payload.attempts ?? 0,
        discarded_vertices: discarded.length,
        cancelled_scopes: [],
    };
}

/* ------------------------------------------------------------------ the decision */

/**
 * Chooses where to resume planning after a failure, and publishes the whole comparison.
 *
 * Pure. Given the same log and policy it returns the same decision, which is what lets the harness
 * check the choice and lets a replan be replayed.
 */
export function selectBoundary(events: readonly StoredEvent[], failedVertexId: string, policy: RecoveryPolicy): BoundaryDecision {
    const {episode, perPlanner} = replanHistory(events);
    const base = {failedVertexId, candidates: [] as BoundaryCandidate[], selected: null, selectedSeq: null, shadowed: [] as string[], episode, estimatedCost: null, currency: null};

    // Work a rule authored is not a plan, and no planner has standing to author a replacement for
    // it. The ladder skips L1 and L2 outright rather than finding them illegal (03 §2.5).
    if (ruleAuthored(events, failedVertexId)) {
        return {...base, level: 'L4', reason: 'a rule authored this work, and no planner has the authority to propose a replacement for it'};
    }
    if (episode >= policy.maxReplansPerEpisode) {
        return {...base, level: 'L3', reason: `this failure episode has already used ${episode} replans, the protocol bound`};
    }

    const floor = backtrackFloor(events);
    const openScopes = openBracketScopes(events);
    const view = surface(events);
    const candidates: BoundaryCandidate[] = [];
    let best: {candidate: BoundaryCandidate; depth: number} | null = null;

    for (const planner of ancestorPlanners(events, failedVertexId)) {
        const rejected = rejectionFor(planner, {events, floor, openScopes, perPlanner, policy});
        if (rejected) {
            candidates.push({planner_vertex_id: planner.vertexId, planner_seq: planner.seq, rejected});
            continue;
        }
        const priced = price(events, view, planner, policy);
        candidates.push(priced);
        if (policy.budgetRemaining !== undefined && priced.cost! > policy.budgetRemaining) {
            candidates[candidates.length - 1] = {planner_vertex_id: planner.vertexId, planner_seq: planner.seq, rejected: 'budget_exceeded'};
            continue;
        }
        if (!best || priced.cost! < best.candidate.cost!) best = {candidate: priced, depth: planner.depth};
    }

    if (!best) {
        // Nothing is selectable. Whether the world can be returned to a savepoint decides which
        // level this is, and cancelling is the Coordinator's to do, not this module's.
        const cancellable = openScopes.size > 0 && floor === 0;
        return {
            ...base,
            candidates,
            level: cancellable ? 'L3' : 'L4',
            reason: candidates.length
                ? `no ancestor planner is a legal replan boundary: ${candidates.map((entry) => `${entry.planner_vertex_id.slice(0, 8)} ${entry.rejected}`).join(', ')}`
                : 'the failed vertex has no ancestor planner',
        };
    }

    const shadowed = shadowSet(events, best.candidate.planner_vertex_id);
    return {
        ...base,
        candidates,
        // L1 and L2 differ only in how far back the boundary landed (03 §2.1): resuming at the
        // nearest ancestor planner is greedy, and anything further back replans a larger scope.
        level: best.depth === nearestDepth(events, failedVertexId) ? 'L1' : 'L2',
        reason: `resuming at the cheapest legal boundary of ${candidates.filter((entry) => !entry.rejected).length}`,
        selected: best.candidate.planner_vertex_id,
        selectedSeq: best.candidate.planner_seq,
        shadowed,
        estimatedCost: best.candidate.cost ?? null,
        currency: policy.pricing.currency,
    };
}

/** The distance of the nearest ancestor planner, whether or not it is legal. */
function nearestDepth(events: readonly StoredEvent[], failedVertexId: string): number {
    return ancestorPlanners(events, failedVertexId)[0]?.depth ?? -1;
}

function rejectionFor(
    planner: {vertexId: string; seq: number},
    context: {events: readonly StoredEvent[]; floor: number; openScopes: Set<string>; perPlanner: Map<string, number>; policy: RecoveryPolicy},
): RejectionReason | null {
    // (ii) the floor condition. Checked first because it is absolute: no amount of cancelling makes
    // a boundary below the floor legal, and searching further back only moves away from it.
    if (planner.seq < context.floor) return 'below_floor';
    // (i) the bracket condition. A boundary inside an open bracket would resume planning across an
    // active try, and compensation precedes backtracking (03 §2.4 rule 1).
    if (descendsIntoOpenScope(context.events, planner.vertexId, context.openScopes)) return 'open_bracket';
    if ((context.perPlanner.get(planner.vertexId) ?? 0) >= context.policy.maxReplansPerPlanner) return 'failure_counter_exhausted';
    return null;
}

/** Whether any vertex below this planner belongs to a scope whose bracket is still open. */
function descendsIntoOpenScope(events: readonly StoredEvent[], plannerVertexId: string, openScopes: Set<string>): boolean {
    if (!openScopes.size) return false;
    const below = causalDescendants(events, plannerVertexId);
    return events.some((event) => event.event_type === 'vertex/created' && event.vertex_id && below.has(event.vertex_id) && event.scope_id !== null && openScopes.has(event.scope_id));
}

/**
 * Prices one candidate in currency, per 03 §4.1.
 *
 * `compensation_cost` is omitted rather than reported as zero, and the distinction is load-bearing:
 * zero would claim the term was priced and came to nothing. In fact no tool contract carries a
 * price — not a call price and not a cancel price — so the term has no source. It also cannot
 * matter here: a candidate with an open bracket between it and the failure is rejected as
 * `open_bracket` before it is ever priced, so every candidate that reaches this function has
 * nothing to compensate. When cancellation lands the term needs a real price, which is a gateway
 * contract change rather than an engine one.
 */
function price(events: readonly StoredEvent[], view: Surface, planner: {vertexId: string; seq: number}, policy: RecoveryPolicy): BoundaryCandidate {
    const context = assemble(linearize(slice(view, planner.vertexId)), {projector_version: 'recovery-preflight', harness_state_version: 'recovery-preflight'}).text;
    const contextTokens = Math.ceil(context.length / CHARS_PER_TOKEN);
    const discarded = shadowSet(events, planner.vertexId);
    const contextCost = (contextTokens * policy.pricing.cache_miss_input_per_million) / 1_000_000;
    const reworkCost = (discarded.length * TOKENS_PER_REGENERATED_VERTEX * policy.pricing.output_per_million) / 1_000_000;
    return {
        planner_vertex_id: planner.vertexId,
        planner_seq: planner.seq,
        cost: Number((contextCost + reworkCost).toFixed(12)),
        currency: policy.pricing.currency,
        terms: {context_cost: Number(contextCost.toFixed(12)), rework_cost: Number(reworkCost.toFixed(12)), risk_premium: policy.riskPremium},
    };
}

/**
 * The closed set of vertices a replan at this boundary discards.
 *
 * Complete and explicit, never a subtree root, and never including the boundary itself — the
 * boundary planner is the author being asked again, so shadowing it would remove the vertex the
 * replan attaches to. Already-shadowed vertices are excluded so a second replan's event describes
 * what *it* discarded.
 */
export function shadowSet(events: readonly StoredEvent[], boundaryVertexId: string): string[] {
    const alreadyHidden = new Set<string>();
    for (const event of events) {
        if (event.event_type !== 'subgraph/shadowed') continue;
        for (const id of (event.payload.vertex_ids as string[] | undefined) ?? []) alreadyHidden.add(id);
    }
    const created = new Map(events.filter((event) => event.event_type === 'vertex/created' && event.vertex_id).map((event) => [event.vertex_id!, event.run_seq]));
    return [...causalDescendants(events, boundaryVertexId)]
        .filter((id) => !alreadyHidden.has(id))
        .sort((first, second) => (created.get(first) ?? 0) - (created.get(second) ?? 0) || first.localeCompare(second));
}

/** The two events one replan appends before the planner is called again. */
export function replanEvents(decision: BoundaryDecision, evidence: FailureEvidence): EventDraft[] {
    // Ordered as 03 §2.3 orders them: the decision is recorded before the discard it authorises, so
    // a log read forwards never shows work vanishing with no reason in front of it.
    return [
        {
            event_type: 'replan/boundary',
            ...(decision.selected ? {vertex_id: decision.selected} : {}),
            payload: {
                level: decision.level,
                reason: decision.reason,
                failed_vertex_id: decision.failedVertexId,
                episode: decision.episode + 1,
                candidates: decision.candidates,
                selected: decision.selected,
                cancelled_scopes: evidence.cancelled_scopes,
                ...(decision.selectedSeq !== null ? {boundary_seq: decision.selectedSeq, boundary_vertex_id: decision.selected!} : {}),
                ...(decision.estimatedCost !== null ? {estimated_cost: decision.estimatedCost, currency: decision.currency!} : {}),
            },
        },
        ...(decision.selected
            ? [
                  {
                      event_type: 'subgraph/shadowed',
                      payload: {
                          vertex_ids: decision.shadowed,
                          reason: decision.reason,
                          boundary_seq: decision.selectedSeq!,
                          boundary_vertex_id: decision.selected,
                          failed_vertex_id: decision.failedVertexId,
                      },
                  },
              ]
            : []),
    ];
}

/* ------------------------------------------------------------------ the loop */

/** What one recovery attempt did. */
export type RecoveryResult =
    | {status: 'replanned'; decision: BoundaryDecision; evidence: FailureEvidence; turn: PlannerTurn}
    /** The ladder reached a level this module does not execute; the decision is in the log. */
    | {status: 'escalated'; decision: BoundaryDecision}
    /** Nothing to recover: no failure is outstanding. */
    | {status: 'idle'};

/** Everything a replanned turn needs that the log cannot supply. */
export interface RecoveryRequest {
    runId: string;
    taskInput: Record<string, unknown>;
    workflowType: string;
    /** Names the decision being asked for again, exactly as a first-attempt turn does. */
    goalFor(plannerVertexId: string): string;
}

/**
 * Detects an unrecovered failure, records the ladder's decision, and replans.
 *
 * The order of appends is the order 03 §2.3 states, and it is not arbitrary: `replan/boundary`
 * carries the reasoning and `subgraph/shadowed` carries the consequence, so a log read forwards
 * never shows work disappear before the reason for it. The database enforces the other half —
 * shadowing a vertex whose work is leased is refused rather than raced.
 */
export class RecoveryLoop {
    constructor(
        private readonly store: {readStream(runId: string): Promise<StoredEvent[]>; appendEvents(runId: string, events: EventDraft[]): Promise<number[]>},
        private readonly planner: {advance(request: PlannerTurnRequest, view: ResolvedToolView): Promise<PlannerTurn>},
        private readonly policy: RecoveryPolicy,
    ) {}

    /** Recovers the oldest unrecovered failure, or reports that there is none. */
    async recoverOne(request: RecoveryRequest, view: ResolvedToolView): Promise<RecoveryResult> {
        const events = await this.store.readStream(request.runId);
        const failed = unrecoveredFailures(events)[0];
        if (!failed) return {status: 'idle'};

        const decision = selectBoundary(events, failed, this.policy);
        const evidence = failureEvidence(events, failed, decision.shadowed);
        await this.store.appendEvents(request.runId, replanEvents(decision, evidence));
        if (!decision.selected) return {status: 'escalated', decision};

        const turn = await this.planner.advance(
            {
                runId: request.runId,
                plannerVertexId: decision.selected,
                taskInput: request.taskInput,
                workflowType: request.workflowType,
                goal: request.goalFor(decision.selected),
                evidence: {...evidence},
                attempt: decision.episode + 1,
            },
            view,
        );
        return {status: 'replanned', decision, evidence, turn};
    }
}

/**
 * Failed vertices no replan has answered yet, in the order they failed.
 *
 * A vertex is answered when a later `subgraph/shadowed` discarded it — which is the same event the
 * surface reads, so the recovery loop and the planner's view of the graph cannot disagree about
 * what is still outstanding. A failure that was retried and then succeeded is not outstanding
 * either: L0 already handled it.
 */
export function unrecoveredFailures(events: readonly StoredEvent[]): string[] {
    const shadowed = new Set<string>();
    for (const event of events) {
        if (event.event_type === 'subgraph/shadowed') {
            for (const id of (event.payload.vertex_ids as string[] | undefined) ?? []) shadowed.add(id);
        }
        // An escalation discards nothing, so a shadow will never answer it. It is still an
        // answer — the ladder has said this needs compensation or a human — and treating it as
        // outstanding makes the driver re-decide it on every pass. A live run appended eight
        // identical L4 boundaries before the loop ran out of other work to do.
        if (event.event_type === 'replan/boundary' && event.payload.selected === null) {
            const failed = event.payload.failed_vertex_id;
            if (typeof failed === 'string') shadowed.add(failed);
        }
    }
    const outcome = new Map<string, string>();
    for (const event of events) {
        if (!event.vertex_id) continue;
        if (event.event_type === 'vertex/failed' || event.event_type === 'vertex/succeeded' || event.event_type === 'vertex/retried') outcome.set(event.vertex_id, event.event_type);
    }
    return events
        .filter((event) => event.event_type === 'vertex/failed' && event.vertex_id && !shadowed.has(event.vertex_id) && outcome.get(event.vertex_id) === 'vertex/failed')
        .map((event) => event.vertex_id!);
}
