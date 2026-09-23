import {assemble, linearize, slice, surface, type Surface} from './log/projection.js';
import {causalDescendants, type LockedScope, type ScopeLockedView} from './log/store.js';
import type {EventDraft, StoredEvent} from './log/events.js';
import type {LlmPricing} from './planner/llm-client.js';
import type {PlannerTurn, PlannerTurnRequest} from './planner/planner-loop.js';
import type {ResolvedToolView} from './gateway/gateway-client.js';

/**
 * The recovery ladder's planning half: choosing where to resume, discarding what is being replaced,
 * and asking for the cancellations a legal boundary needs first.
 *
 * Design document 03 specifies five levels. What lives here is L1 and L2 — regenerating in place
 * at a legal boundary — together with the guards that decide when neither is available and the run
 * must escalate. The ladder is also the only party that *initiates* a failure-driven cancellation:
 * it decides the replan, so it decides what has to be undone before it. The Coordinator executes a
 * cancellation, never starts one because something failed; it only still starts the orphan sweep's,
 * for a try whose deadline passed.
 *
 * Every decision is one of three things: record (a boundary, or an escalation), request (the
 * cancellations a boundary needs), or wait (for cancellations already under way). Waiting is what
 * the ladder used to lack, and its absence was two races: a read before a cancellation began
 * escalated a failure that a moment later had a legal boundary, and a read in the middle of one
 * replanned across a try whose inverse had not run yet.
 *
 * Everything that decides is a pure function of the log. {@link RecoveryLoop} is the only part that
 * touches a database or a model, and it decides nothing: it appends what {@link selectBoundary}
 * concluded, under the run's scope locks. That split exists because boundary selection *is* the
 * policy — a harness cannot check it by recomputing the answer without duplicating the policy and,
 * likely, the author's misunderstanding with it (03 §4.2). So the engine publishes its whole
 * candidate set, before a cancellation as well as after it, and the harness checks it.
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
    /** Scopes that must finish cancelling before this boundary is legal. Absent when none must. */
    requires_cancel?: string[];
}

/** The ladder level one failure reached. */
export type RecoveryLevel = 'L1' | 'L2' | 'L3' | 'L4';

/**
 * What the ladder does about a failure now.
 *
 * `record` appends a boundary (and its discard) or an escalation, and answers the failure.
 * `request` appends a cancellation request and answers nothing: the failure stays outstanding until
 * the cancellation resolves. `wait` appends nothing, because a cancellation is already under way.
 */
export type RecoveryAction = 'record' | 'request' | 'wait';

/** What the engine decided about one failure, before anything is appended. */
export interface BoundaryDecision {
    action: RecoveryAction;
    level: RecoveryLevel;
    reason: string;
    failedVertexId: string;
    /** Every ancestor planner, nearest first, priced or rejected. */
    candidates: BoundaryCandidate[];
    /** Set only when this decision replans now: a request or a wait replans nothing yet. */
    selected: string | null;
    selectedSeq: number | null;
    /** The boundary a request or a wait is working toward, once its cancellations resolve. */
    intended: string | null;
    /** The closed set of vertices a replan discards. Empty when nothing is selected. */
    shadowed: string[];
    /** Scopes this decision asks to cancel. Non-empty exactly when `action` is `request`. */
    requestScopes: string[];
    /** Scopes this decision is waiting on. Non-empty exactly when `action` is `wait`. */
    awaitedScopes: string[];
    /** Scopes cancelled for this failure since it happened, not already reported by a boundary. */
    cancelledScopes: string[];
    /** The request this failure's cancellations came from, if the ladder made one. */
    cancelRequestSeq: number | null;
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

/**
 * Where one transaction scope stands, as far as a replan is concerned.
 *
 * `unmaterialized` is a scope named on frozen vertices that the Coordinator has never opened: it
 * handed out no work, so there is nothing in it to undo. `fenced` is an open scope a failure (or a
 * pivot proven absent) has stopped; `cancel-requested` is one the ladder has asked to cancel;
 * `cancelling` is one whose inverses are running. Only `cancelled` and `committed` are closed.
 */
export type ScopePhase = 'unmaterialized' | 'open' | 'fenced' | 'cancel-requested' | 'cancelling' | 'cancelled' | 'suspended' | 'pivot-inflight' | 'pivot-passed' | 'committed';

/** One scope's phase and the facts about it a recovery decision reads. */
export interface ScopeCancellation {
    scopeId: string;
    phase: ScopePhase;
    members: string[];
    /** `run_seq` of the first `vertex/created` in this scope: where its savepoint sits. */
    firstMemberSeq: number;
    /** Sealed tries that no confirm and no completed cancellation has closed. */
    openTries: number;
    fencedBy?: string;
    requestSeq?: number;
    requestedFor?: string;
    cancelledSeq?: number;
    suspendedSeq?: number;
}

/** Phases that can be cancelled, or are being: the ones a replan must wait out. */
const CANCELLABLE: ReadonlySet<ScopePhase> = new Set(['open', 'fenced', 'cancel-requested', 'cancelling']);
/** Phases no cancellation can close: a boundary that discards their work is not legal. */
const UNRECOVERABLE: ReadonlySet<ScopePhase> = new Set(['suspended', 'pivot-inflight', 'pivot-passed']);
/** Phases that refuse every freeze in the run (R12) until they settle, so a replan now is wasted. */
const TRANSIENT: ReadonlySet<ScopePhase> = new Set(['fenced', 'cancel-requested', 'cancelling', 'pivot-inflight', 'pivot-passed']);

/**
 * Folds the log into each scope's phase, mirroring exactly what the database's triggers do.
 *
 * Only `txn/cancel {completed}` closes a scope. `requested` means the inverses have not run, and a
 * reader that closed the bracket there replanned across a try that was still holding its
 * reservation — and would have done so even when the cancellation went on to fail and suspend.
 */
export function scopeCancellations(events: readonly StoredEvent[]): Map<string, ScopeCancellation> {
    const scopes = new Map<string, ScopeCancellation>();
    const tries = new Map<string, Set<string>>();
    const scopeAt = (scopeId: string, seq: number): ScopeCancellation => {
        let scope = scopes.get(scopeId);
        if (!scope) {
            scope = {scopeId, phase: 'unmaterialized', members: [], firstMemberSeq: seq, openTries: 0};
            scopes.set(scopeId, scope);
            tries.set(scopeId, new Set());
        }
        return scope;
    };
    const materialize = (scope: ScopeCancellation): void => {
        if (scope.phase === 'unmaterialized') scope.phase = 'open';
    };

    for (const event of events) {
        if (event.event_type === 'replan/cancel-requested') {
            for (const scopeId of (event.payload.scope_ids as string[] | undefined) ?? []) {
                const scope = scopeAt(scopeId, event.run_seq);
                if (scope.phase === 'open' || scope.phase === 'fenced') scope.phase = 'cancel-requested';
                scope.requestSeq = event.run_seq;
                scope.requestedFor = event.payload.failed_vertex_id as string;
            }
            continue;
        }
        if (!event.scope_id) continue;
        const scope = scopeAt(event.scope_id, event.run_seq);
        switch (event.event_type) {
            case 'vertex/created':
                if (event.vertex_id) scope.members.push(event.vertex_id);
                scope.firstMemberSeq = Math.min(scope.firstMemberSeq, event.run_seq);
                break;
            case 'txn/scope': {
                const state = event.payload.state as string | undefined;
                if (state === 'open') materialize(scope);
                else if (state === 'suspended') [scope.phase, scope.suspendedSeq] = ['suspended', event.run_seq];
                else if (state === 'committed') scope.phase = 'committed';
                else if (state === 'cancelled') [scope.phase, scope.cancelledSeq] = ['cancelled', event.run_seq];
                break;
            }
            case 'txn/try':
                materialize(scope);
                tries.get(scope.scopeId)!.add(String(event.payload.idempotency_key ?? event.vertex_id));
                break;
            case 'txn/confirm':
                tries.get(scope.scopeId)!.delete(String(event.payload.idempotency_key ?? event.vertex_id));
                break;
            case 'vertex/started':
                if (event.payload.phase === 'pivot') scope.phase = 'pivot-inflight';
                break;
            case 'txn/pivot-passed':
                scope.phase = 'pivot-passed';
                break;
            case 'vertex/failed':
                // The same condition as the database's fence: an open scope, or a pivot the status
                // query proved never happened, which reopens its scope already fenced.
                if (scope.phase === 'open' || (scope.phase === 'pivot-inflight' && event.payload.outcome === 'confirmed-absent')) {
                    scope.phase = 'fenced';
                    scope.fencedBy = event.vertex_id ?? undefined;
                }
                break;
            case 'txn/cancel':
                if (event.payload.phase === 'completed') {
                    [scope.phase, scope.cancelledSeq] = ['cancelled', event.run_seq];
                    tries.get(scope.scopeId)!.clear();
                } else {
                    scope.phase = 'cancelling';
                }
                break;
        }
    }
    for (const scope of scopes.values()) scope.openTries = scope.phase === 'committed' ? 0 : tries.get(scope.scopeId)!.size;
    return scopes;
}

/** Scopes holding a `txn/try` that no `txn/confirm` or completed `txn/cancel` has answered. */
export function openBracketScopes(events: readonly StoredEvent[]): Set<string> {
    const open = new Set<string>();
    for (const scope of scopeCancellations(events).values()) if (scope.openTries > 0 && scope.phase !== 'cancelled') open.add(scope.scopeId);
    return open;
}

/**
 * Whether the log and the locked scope rows describe the same scopes.
 *
 * They can differ for one reason: a pivot proven absent reopens its scope in its own transaction,
 * before the `vertex/failed` that the log will carry. A decision made in that gap would be made on
 * a state the log does not yet show, so the ladder waits it out rather than guess.
 */
function disagreeingScopes(scopes: Map<string, ScopeCancellation>, locked: readonly LockedScope[]): string[] {
    const coarse = (phase: ScopePhase): string => (phase === 'cancel-requested' ? 'fenced' : phase);
    const disagree: string[] = [];
    for (const row of locked) {
        const stored = row.state === 'open' && row.fenced ? 'fenced' : row.state;
        const folded = scopes.get(row.scopeId);
        if (!folded || coarse(folded.phase) !== stored) disagree.push(row.scopeId);
    }
    return disagree;
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

/**
 * Succeeded planners this vertex could resume at, nearest first.
 *
 * A vertex that is itself a succeeded planner is its own nearest candidate, at distance zero. That
 * is not a special case bolted on: the nearest planner with the authority to propose something
 * different really is that planner, and there is nothing below it to discard. It is how a stalled
 * planner — one whose answer produced no work at all — re-enters the ladder.
 */
export function ancestorPlanners(events: readonly StoredEvent[], vertexId: string): {vertexId: string; seq: number; depth: number}[] {
    const created = new Map(events.filter((event) => event.event_type === 'vertex/created' && event.vertex_id).map((event) => [event.vertex_id!, event]));
    const succeeded = new Map(events.filter((event) => event.event_type === 'vertex/succeeded' && event.vertex_id).map((event) => [event.vertex_id!, event.run_seq]));
    const found: {vertexId: string; seq: number; depth: number}[] = [];
    const ownSeq = succeeded.get(vertexId);
    if (created.get(vertexId)?.payload.role === 'planner' && ownSeq !== undefined) found.push({vertexId, seq: ownSeq, depth: 0});
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
 * heuristic (03 §3, 03 §6). A cancellation request is not a replan and counts toward neither.
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

export function failureEvidence(events: readonly StoredEvent[], failedVertexId: string, discarded: readonly string[], cancelledScopes: readonly string[] = []): FailureEvidence {
    const created = events.find((event) => event.event_type === 'vertex/created' && event.vertex_id === failedVertexId);
    const failed = [...events].reverse().find((event) => event.event_type === 'vertex/failed' && event.vertex_id === failedVertexId);
    // A stalled planner has no failure to read, because nothing failed: the call succeeded and the
    // answer was not a proposal. Its evidence is the parse refusal the engine recorded.
    const unreadable = [...events].reverse().find((event) => event.event_type === 'subgraph/unreadable' && event.payload.planner_vertex_id === failedVertexId);
    const payload = (failed?.payload ?? {}) as {attempts?: number; outcome?: string; error?: string};
    if (!failed && unreadable) {
        return {
            failed_vertex_id: failedVertexId,
            tool: null,
            error_class: 'unreadable_answer',
            error: String(unreadable.payload.reason ?? ''),
            attempts: events.filter((event) => event.event_type === 'subgraph/unreadable' && event.payload.planner_vertex_id === failedVertexId).length,
            discarded_vertices: discarded.length,
            cancelled_scopes: [...cancelledScopes],
        };
    }
    return {
        failed_vertex_id: failedVertexId,
        tool: typeof created?.payload.tool === 'string' ? created.payload.tool : null,
        error_class: payload.outcome ?? 'unknown',
        error: payload.error ?? '',
        attempts: payload.attempts ?? 0,
        discarded_vertices: discarded.length,
        cancelled_scopes: [...cancelledScopes],
    };
}

/* ------------------------------------------------------------------ the decision */

/** Everything one decision reads, computed once. */
interface DecisionContext {
    events: readonly StoredEvent[];
    failedVertexId: string;
    policy: RecoveryPolicy;
    scopes: Map<string, ScopeCancellation>;
    floor: number;
    perPlanner: Map<string, number>;
    /** `run_seq` of the failure (or the refusal) being answered. */
    failedAt: number;
    ownScope: ScopeCancellation | undefined;
    reported: Set<string>;
    locked: readonly LockedScope[] | undefined;
}

/**
 * Chooses where to resume planning after a failure, and publishes the whole comparison.
 *
 * Pure. Given the same log, policy and locked rows it returns the same decision, which is what lets
 * the harness check the choice and lets a replan be replayed. `locked` is what the database holds
 * under the lock the decision is taken in; without it the decision reads the log alone, as a
 * harness does.
 */
export function selectBoundary(events: readonly StoredEvent[], failedVertexId: string, policy: RecoveryPolicy, locked?: readonly LockedScope[]): BoundaryDecision {
    const {episode, perPlanner} = replanHistory(events);
    const scopes = scopeCancellations(events);
    const context: DecisionContext = {
        events,
        failedVertexId,
        policy,
        scopes,
        floor: backtrackFloor(events),
        perPlanner,
        failedAt: failureSeq(events, failedVertexId),
        ownScope: scopeOf(events, failedVertexId, scopes),
        reported: reportedCancellations(events),
        locked,
    };
    const base: BoundaryDecision = {
        action: 'record',
        level: 'L4',
        reason: '',
        failedVertexId,
        candidates: [],
        selected: null,
        selectedSeq: null,
        intended: null,
        shadowed: [],
        requestScopes: [],
        awaitedScopes: [],
        cancelledScopes: [],
        cancelRequestSeq: cancelRequestFor(events, failedVertexId),
        episode,
        estimatedCost: null,
        currency: null,
    };

    if (locked) {
        const disagree = disagreeingScopes(scopes, locked);
        if (disagree.length) return {...base, action: 'wait', awaitedScopes: disagree, reason: `the log does not yet show what the scope rows hold for ${abbreviate(disagree)}`};
    }

    // Work a rule authored is not a plan, and no planner has standing to author a replacement for
    // it. The ladder skips L1 and L2 outright rather than finding them illegal (03 §2.5).
    if (ruleAuthored(events, failedVertexId)) {
        return terminal(context, base, 'L4', 'a rule authored this work, and no planner has the authority to propose a replacement for it');
    }
    if (episode >= policy.maxReplansPerEpisode) {
        return terminal(context, base, 'L3', `this failure episode has already used ${episode} replans, the protocol bound`);
    }
    // A suspended scope refuses every freeze in the run and only a person can release it, so no
    // replan here could ever be admitted.
    const suspended = [...scopes.values()].filter((scope) => scope.phase === 'suspended').map((scope) => scope.scopeId);
    if (suspended.length) {
        return terminal(context, base, 'L4', `scope ${abbreviate(suspended)} is suspended, so no replan in this run can be admitted`);
    }

    const view = surface(events);
    const candidates: BoundaryCandidate[] = [];
    let best: {candidate: BoundaryCandidate; depth: number} | null = null;

    for (const planner of ancestorPlanners(events, failedVertexId)) {
        const verdict = verdictFor(planner, context);
        if ('rejected' in verdict) {
            candidates.push({planner_vertex_id: planner.vertexId, planner_seq: planner.seq, rejected: verdict.rejected});
            continue;
        }
        const priced = {...price(events, view, planner, policy), ...(verdict.requiresCancel.length ? {requires_cancel: verdict.requiresCancel} : {})};
        if (policy.budgetRemaining !== undefined && priced.cost! > policy.budgetRemaining) {
            candidates.push({planner_vertex_id: planner.vertexId, planner_seq: planner.seq, rejected: 'budget_exceeded'});
            continue;
        }
        candidates.push(priced);
        if (!best || priced.cost! < best.candidate.cost!) best = {candidate: priced, depth: planner.depth};
    }

    if (!best) {
        const own = context.ownScope;
        return terminal(
            {...context},
            {...base, candidates},
            own?.phase === 'cancelled' || (own && CANCELLABLE.has(own.phase)) ? 'L3' : 'L4',
            candidates.length
                ? `no ancestor planner is a legal replan boundary: ${candidates.map((entry) => `${entry.planner_vertex_id.slice(0, 8)} ${entry.rejected}`).join(', ')}`
                : 'the failed vertex has no ancestor planner',
        );
    }

    // L1 and L2 differ only in how far back the boundary landed (03 §2.1): resuming at the nearest
    // ancestor planner is greedy, and anything further back replans a larger scope.
    const level = best.depth === nearestDepth(events, failedVertexId) ? 'L1' : 'L2';
    const boundary = best.candidate.planner_vertex_id;
    const required = best.candidate.requires_cancel ?? [];
    const toRequest = required.filter((scopeId) => {
        const phase = scopes.get(scopeId)!.phase;
        return phase === 'open' || phase === 'fenced';
    });
    if (toRequest.length) {
        return {
            ...base,
            candidates,
            action: 'request',
            level,
            intended: boundary,
            requestScopes: toRequest,
            reason: `cancelling ${abbreviate(toRequest)} before resuming at ${boundary.slice(0, 8)} (03 §2.4 rule 1)`,
        };
    }
    const inFlight = [...new Set([...required, ...unresolvedRequests(context)])].sort();
    if (inFlight.length) {
        return {
            ...base,
            candidates,
            action: 'wait',
            level,
            intended: boundary,
            awaitedScopes: inFlight,
            reason: `waiting for ${abbreviate(inFlight)} to finish cancelling before resuming at ${boundary.slice(0, 8)}`,
        };
    }
    // Nothing this replan discards needs cancelling, but another scope in the run refuses every
    // freeze until it settles (R12). A boundary recorded now would have its freeze rejected and
    // burn an episode on a replan that never had a chance.
    const blocking = runBlocks(context);
    if (blocking.length) {
        return {
            ...base,
            candidates,
            action: 'wait',
            level,
            intended: boundary,
            awaitedScopes: blocking,
            reason: `waiting for ${abbreviate(blocking)} to settle: the run admits no freeze until it does`,
        };
    }

    const shadowed = shadowSet(events, boundary);
    return {
        ...base,
        candidates,
        action: 'record',
        level,
        reason: `resuming at the cheapest legal boundary of ${candidates.filter((entry) => !entry.rejected).length}`,
        selected: boundary,
        selectedSeq: best.candidate.planner_seq,
        intended: boundary,
        shadowed,
        cancelledScopes: cancelledFor(
            context,
            touchedScopes(events, boundary, scopes).map((scope) => scope.scopeId),
        ),
        estimatedCost: best.candidate.cost ?? null,
        currency: policy.pricing.currency,
    };
}

/**
 * The end of the ladder for a failure no planner will answer.
 *
 * A fenced scope is never left behind: the failure's own scope is asked to cancel first, and the
 * escalation is recorded only once that cancellation has resolved — completed, or suspended by the
 * Coordinator because an attempt's outcome is unknown. For work a rule authored this is 03 §2.5's
 * "cancel to the savepoint, then L4".
 */
function terminal(context: DecisionContext, base: BoundaryDecision, level: RecoveryLevel, reason: string): BoundaryDecision {
    const own = context.ownScope;
    if (own && (own.phase === 'open' || own.phase === 'fenced')) {
        return {...base, action: 'request', level: 'L3', requestScopes: [own.scopeId], reason: `cancelling ${abbreviate([own.scopeId])} before escalating: ${reason}`};
    }
    // Every scope asked about for this failure has to resolve first, not only its own: a request can
    // name several, and one suspending says nothing about the others, whose inverses may still be
    // running. Answering now would hand a person a run with a cancellation still in flight.
    const awaited = unresolvedRequests(context);
    if (own && (own.phase === 'cancel-requested' || own.phase === 'cancelling' || own.phase === 'pivot-inflight')) awaited.push(own.scopeId);
    if (awaited.length) {
        const scopes = [...new Set(awaited)].sort();
        return {...base, action: 'wait', level, awaitedScopes: scopes, reason: `waiting for ${abbreviate(scopes)} to settle before escalating: ${reason}`};
    }
    return {...base, action: 'record', level, reason, cancelledScopes: cancelledFor(context, own ? [own.scopeId] : [])};
}

/** The distance of the nearest ancestor planner, whether or not it is legal. */
function nearestDepth(events: readonly StoredEvent[], failedVertexId: string): number {
    return ancestorPlanners(events, failedVertexId)[0]?.depth ?? -1;
}

/**
 * Whether one ancestor planner is a legal boundary, and what must be cancelled first if it is.
 *
 * `open_bracket` now means a bracket no cancellation can close — a scope past or at its pivot, or
 * suspended for a person. A scope that is merely open is not a reason to reject: it is a
 * cancellation to request (03 §2.2 step 1). `savepoint_precedes` is the case where that
 * cancellation would undo work above the planner, because the scope was opened before it.
 */
function verdictFor(planner: {vertexId: string; seq: number}, context: DecisionContext): {rejected: RejectionReason} | {requiresCancel: string[]} {
    // (ii) the floor condition. Checked first because it is absolute: no amount of cancelling makes
    // a boundary below the floor legal, and searching further back only moves away from it.
    if (planner.seq < context.floor) return {rejected: 'below_floor'};
    const touched = touchedScopes(context.events, planner.vertexId, context.scopes);
    // (i) the bracket condition. A boundary inside a bracket nothing can close would resume
    // planning across an active try, and compensation precedes backtracking (03 §2.4 rule 1).
    if (touched.some((scope) => UNRECOVERABLE.has(scope.phase))) return {rejected: 'open_bracket'};
    const cancel = touched.filter((scope) => CANCELLABLE.has(scope.phase));
    // A scope already cancelled for this failure counts too. Resuming below its savepoint after the
    // fact is the same mistake made later: the planner would be handed a context in which work its
    // ancestor authored still stands, when the cancellation has just undone it.
    const undone = touched.filter((scope) => scope.phase === 'cancelled' && (scope.cancelledSeq ?? 0) > context.failedAt);
    if ([...cancel, ...undone].some((scope) => scope.firstMemberSeq < planner.seq)) return {rejected: 'savepoint_precedes'};
    if ((context.perPlanner.get(planner.vertexId) ?? 0) >= context.policy.maxReplansPerPlanner) return {rejected: 'failure_counter_exhausted'};
    return {requiresCancel: cancel.map((scope) => scope.scopeId).sort()};
}

/** The materialized scopes holding any vertex a replan at this boundary would discard. */
function touchedScopes(events: readonly StoredEvent[], boundaryVertexId: string, scopes: Map<string, ScopeCancellation>): ScopeCancellation[] {
    const discarded = new Set(shadowSet(events, boundaryVertexId));
    const touched: ScopeCancellation[] = [];
    for (const scope of scopes.values()) {
        if (scope.phase !== 'unmaterialized' && scope.members.some((member) => discarded.has(member))) touched.push(scope);
    }
    return touched.sort((first, second) => first.firstMemberSeq - second.firstMemberSeq || first.scopeId.localeCompare(second.scopeId));
}

/** Scopes requested for this failure whose cancellation has neither completed nor suspended. */
function unresolvedRequests(context: DecisionContext): string[] {
    const pending: string[] = [];
    for (const scope of context.scopes.values()) {
        if (scope.requestedFor === context.failedVertexId && (scope.phase === 'cancel-requested' || scope.phase === 'cancelling')) pending.push(scope.scopeId);
    }
    return pending;
}

/** Scopes that refuse every freeze in the run until they settle. */
function runBlocks(context: DecisionContext): string[] {
    const blocking = new Set<string>();
    for (const scope of context.scopes.values()) if (TRANSIENT.has(scope.phase)) blocking.add(scope.scopeId);
    // An expired sealed try is the orphan sweep's to cancel; only the locked rows can see the clock.
    for (const row of context.locked ?? []) if (row.state === 'open' && row.hasExpiredTry) blocking.add(row.scopeId);
    return [...blocking].sort();
}

/** Scopes cancelled for this failure since it happened, less those a boundary already reported. */
function cancelledFor(context: DecisionContext, relevant: readonly string[]): string[] {
    const cancelled = new Set<string>();
    for (const scope of context.scopes.values()) {
        if (scope.phase !== 'cancelled' || (scope.cancelledSeq ?? 0) <= context.failedAt || context.reported.has(scope.scopeId)) continue;
        if (scope.requestedFor === context.failedVertexId || relevant.includes(scope.scopeId)) cancelled.add(scope.scopeId);
    }
    return [...cancelled].sort();
}

function failureSeq(events: readonly StoredEvent[], failedVertexId: string): number {
    let seq = 0;
    for (const event of events) {
        if ((event.event_type === 'vertex/failed' && event.vertex_id === failedVertexId) || (event.event_type === 'subgraph/unreadable' && event.payload.planner_vertex_id === failedVertexId)) {
            seq = event.run_seq;
        }
    }
    return seq;
}

function scopeOf(events: readonly StoredEvent[], vertexId: string, scopes: Map<string, ScopeCancellation>): ScopeCancellation | undefined {
    const created = events.find((event) => event.event_type === 'vertex/created' && event.vertex_id === vertexId);
    return created?.scope_id ? scopes.get(created.scope_id) : undefined;
}

function cancelRequestFor(events: readonly StoredEvent[], failedVertexId: string): number | null {
    let seq: number | null = null;
    for (const event of events) if (event.event_type === 'replan/cancel-requested' && event.payload.failed_vertex_id === failedVertexId) seq = event.run_seq;
    return seq;
}

function reportedCancellations(events: readonly StoredEvent[]): Set<string> {
    const reported = new Set<string>();
    for (const event of events) {
        if (event.event_type === 'replan/boundary') for (const id of (event.payload.cancelled_scopes as string[] | undefined) ?? []) reported.add(id);
    }
    return reported;
}

function abbreviate(scopeIds: readonly string[]): string {
    return scopeIds.map((id) => id.slice(0, 8)).join(', ');
}

/**
 * Prices one candidate in currency, per 03 §4.1.
 *
 * `compensation_cost` is omitted rather than reported as zero, and the distinction is load-bearing:
 * zero would claim the term was priced and came to nothing. In fact no tool contract carries a
 * price — not a call price and not a cancel price — so the term has no source. A candidate that
 * needs a cancellation now reaches this function, so the omission can bias a comparison toward
 * one: two candidates that need the same scopes cancelled compare correctly, and ones that need
 * different scopes do not. Pricing it is a gateway contract change (W7), recorded on the candidate
 * as `requires_cancel` so the comparison is at least visible.
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

/** The two events one recorded decision appends before the planner is called again. */
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
                ...(decision.cancelRequestSeq !== null ? {cancel_request_seq: decision.cancelRequestSeq} : {}),
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

/**
 * The request a `request` decision appends, carrying the comparison as it stood before anything
 * was cancelled — the boundary recorded afterwards carries it as it stands after, so the log shows
 * both, which is what makes a cancellation's effect on the candidate set checkable.
 */
export function cancelRequestEvent(decision: BoundaryDecision): EventDraft {
    if (decision.action !== 'request' || !decision.requestScopes.length) throw new Error('only a request decision appends a cancellation request');
    return {
        event_type: 'replan/cancel-requested',
        payload: {
            failed_vertex_id: decision.failedVertexId,
            scope_ids: [...decision.requestScopes].sort(),
            level: decision.level === 'L4' ? 'L3' : decision.level,
            reason: decision.reason,
            intended_boundary_vertex_id: decision.intended,
            candidates: decision.candidates,
        },
    };
}

/**
 * One failure's decision and exactly what it appends: the boundary and its discard, the request,
 * or nothing.
 */
export function decideRecovery(events: readonly StoredEvent[], failedVertexId: string, policy: RecoveryPolicy, locked?: readonly LockedScope[]): {decision: BoundaryDecision; drafts: EventDraft[]} {
    const decision = selectBoundary(events, failedVertexId, policy, locked);
    if (decision.action === 'wait') return {decision, drafts: []};
    if (decision.action === 'request') return {decision, drafts: [cancelRequestEvent(decision)]};
    return {decision, drafts: replanEvents(decision, failureEvidence(events, failedVertexId, decision.shadowed, decision.cancelledScopes))};
}

/* ------------------------------------------------------------------ the loop */

/** What one recovery attempt did. */
export type RecoveryResult =
    | {status: 'replanned'; decision: BoundaryDecision; evidence: FailureEvidence; turn: PlannerTurn}
    /** The ladder escalated and recorded why; nothing is left for this module to do. */
    | {status: 'escalated'; decision: BoundaryDecision}
    /** The ladder asked the Coordinator to cancel scopes; the failure stays outstanding. */
    | {status: 'cancel_requested'; decision: BoundaryDecision; requestSeq: number}
    /** Every outstanding failure is waiting on a cancellation already under way. */
    | {status: 'awaiting_cancellation'; decisions: BoundaryDecision[]}
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
 * The decision and its append happen inside one transaction holding the run's scope rows, so the
 * scopes cannot move between what the ladder read and what it wrote. The order of appends is the
 * order 03 §2.3 states, and it is not arbitrary: `replan/boundary` carries the reasoning and
 * `subgraph/shadowed` carries the consequence, so a log read forwards never shows work disappear
 * before the reason for it. The database enforces the other half — shadowing a vertex whose work
 * is leased, or whose scope has not finished cancelling, is refused rather than raced.
 */
export class RecoveryLoop {
    constructor(
        private readonly store: {appendUnderScopeLock(runId: string, decide: (view: ScopeLockedView) => EventDraft[] | null): Promise<number[] | null>},
        private readonly planner: {advance(request: PlannerTurnRequest, view: ResolvedToolView): Promise<PlannerTurn>},
        private readonly policy: RecoveryPolicy,
    ) {}

    /**
     * Acts on the oldest outstanding failure that is not waiting — a failure or a stall — or
     * reports that everything is waiting, or that nothing is outstanding.
     *
     * A failure waiting on a cancellation does not block the others behind it: each is decided in
     * turn and the first that can act does.
     */
    async recoverOne(request: RecoveryRequest, view: ResolvedToolView): Promise<RecoveryResult> {
        let acted: {decision: BoundaryDecision; events: readonly StoredEvent[]} | null = null;
        let waiting: BoundaryDecision[] = [];
        const sequences = await this.store.appendUnderScopeLock(request.runId, ({events, scopes}) => {
            acted = null;
            waiting = [];
            for (const failed of outstanding(events)) {
                const {decision, drafts} = decideRecovery(events, failed, this.policy, scopes);
                if (decision.action === 'wait') {
                    waiting.push(decision);
                    continue;
                }
                acted = {decision, events};
                return drafts;
            }
            return null;
        });
        if (!acted) return waiting.length ? {status: 'awaiting_cancellation', decisions: waiting} : {status: 'idle'};
        const {decision, events} = acted as {decision: BoundaryDecision; events: readonly StoredEvent[]};
        if (decision.action === 'request') return {status: 'cancel_requested', decision, requestSeq: sequences![0]!};
        if (!decision.selected) return {status: 'escalated', decision};

        // The planner is called only after the decision has committed: a model call made while
        // holding the run's scope rows would hold every claim and every cancellation in the run.
        const evidence = failureEvidence(events, decision.failedVertexId, decision.shadowed, decision.cancelledScopes);
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
 * either: L0 already handled it. A cancellation request answers nothing.
 */
export function outstanding(events: readonly StoredEvent[]): string[] {
    // Failures first. A stall is the run having nothing left to do; a failure is work that has
    // already been attempted, and answering it may well be what unsticks the planner.
    return [...unrecoveredFailures(events), ...stalledPlanners(events)];
}

/**
 * Planners whose turn produced no work, and which no replan has answered since.
 *
 * This is the other way a run stops, and for a while the ladder could not see it at all. The
 * planner's *call* succeeded — the model answered — so nothing failed, no vertex is outstanding,
 * and the planner has already succeeded in the log, so no executor will ever call it again.
 * Nothing downstream can become ready, and the run just stops.
 *
 * Detected from the recorded refusal rather than from the absence of children, deliberately. A
 * reader between a planner's `vertex/succeeded` and the freeze that follows it sees a childless
 * succeeded planner too, and would call a perfectly healthy run stalled.
 */
export function stalledPlanners(events: readonly StoredEvent[]): string[] {
    const answered = new Set<string>();
    for (const event of events) {
        if (event.event_type === 'replan/boundary') {
            const failed = event.payload.failed_vertex_id;
            if (typeof failed === 'string') answered.add(failed);
        }
    }
    const stalled: string[] = [];
    for (const event of events) {
        if (event.event_type !== 'subgraph/unreadable') continue;
        const planner = event.payload.planner_vertex_id;
        if (typeof planner !== 'string' || answered.has(planner) || stalled.includes(planner)) continue;
        // A later freeze that gave this planner a child means the stall is over: either a replan
        // answered it or the driver called it again and it answered readably this time.
        const recovered = events.some((later) => later.run_seq > event.run_seq && later.event_type === 'vertex/created' && later.parent_refs.includes(planner));
        if (!recovered) stalled.push(planner);
    }
    return stalled;
}

export function unrecoveredFailures(events: readonly StoredEvent[]): string[] {
    const shadowed = new Set<string>();
    for (const event of events) {
        if (event.event_type === 'subgraph/shadowed') {
            for (const id of (event.payload.vertex_ids as string[] | undefined) ?? []) shadowed.add(id);
        }
        // An escalation discards nothing, so a shadow will never answer it. It is still an
        // answer — the ladder has said this needs a human — and treating it as outstanding makes
        // the driver re-decide it on every pass. A live run appended eight identical L4
        // boundaries before the loop ran out of other work to do. The ladder records one only
        // once any cancellation the failure needed has resolved, so it is a final answer.
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
