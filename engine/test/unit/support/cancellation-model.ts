import {ancestorPlanners, backtrackFloor, decideRecovery, outstanding, shadowSet, unrecoveredFailures, type RecoveryPolicy} from '../../../src/recovery.js';
import {cancelBeforeReplan, cancelRequestDiscipline, oneAnswerPerFailure, type OracleResult} from '../../../src/harness/oracles.js';
import type {EventDraft, StoredEvent} from '../../../src/log/events.js';
import type {LockedScope} from '../../../src/log/store.js';
import {RecoveryLog} from './recovery-log.js';

/**
 * A small executable model of the Engine and the Coordinator acting on one run, and an explorer
 * that visits every order in which their steps can interleave.
 *
 * The Coordinator side mirrors migration 017 step for step: the fence a scoped failure sets, the
 * pickup of an Engine request through `request_scope_cancel` (deferred by a live lease, suspended
 * by an unresolved attempt, otherwise requested), each inverse call, the completion, the orphan
 * sweep for an expired try, and whatever a sibling still holding its lease goes on to do. The
 * Engine side is the real ladder — `outstanding` and `decideRecovery` — handed the locked scope
 * rows exactly as `appendUnderScopeLock` would hand them over, and its appends go through the same
 * refusals the database applies.
 *
 * The explorer is a depth-first search over every enabled step at every state, memoised on the
 * whole state, so every interleaving is visited and none twice. Each state is checked against the
 * safety oracles; each state with nothing left to do is handed to the caller for its liveness
 * expectations.
 */

export type DbState = 'open' | 'cancelling' | 'cancelled' | 'suspended' | 'pivot-inflight' | 'pivot-passed' | 'committed';
export type RequestOutcome = null | 'pending' | 'deferred' | 'requested' | 'duplicate' | 'suspended';

/** One scope row, as the database holds it. */
export interface DbScope {
    id: string;
    state: DbState;
    fenced: boolean;
    request: RequestOutcome;
    /** Sealed tries with an inverse, still to be reversed. */
    inverses: number;
    inversesDone: number;
    /** Index of the inverse call that fails, or null. */
    inverseFailsAt: number | null;
    /** A sibling member that was already claimed when the scope fenced. */
    lease: string | null;
    unresolved: boolean;
    expired: boolean;
    /** A pivot in flight that the model will resolve one way or the other. */
    pivot: string | null;
}

export interface ModelState {
    log: RecoveryLog;
    scopes: DbScope[];
    /** Set once any append the database would have refused was attempted. */
    refused: string | null;
}

export interface Step {
    label: string;
    apply(state: ModelState): void;
}

export interface Engine {
    /** What the Engine appends on one pass, or null when it has nothing to do. */
    decide(events: readonly StoredEvent[], locked: readonly LockedScope[]): EventDraft[] | null;
    /** Whether this Engine runs under the database's refusals (the legacy one predates them). */
    guarded: boolean;
    /** Whether the Coordinator cancels on a failure by itself (the legacy arrangement). */
    coordinatorSelfCancels: boolean;
}

export function clone(state: ModelState): ModelState {
    const log = new RecoveryLog();
    log.events.push(...state.log.events.map((event) => ({...event, payload: structuredClone(event.payload)})));
    return {log, scopes: state.scopes.map((scope) => ({...scope})), refused: state.refused};
}

function key(state: ModelState): string {
    return JSON.stringify([state.scopes, state.refused, state.log.events.map((event) => [event.event_type, event.vertex_id, event.scope_id, event.payload])]);
}

function lockedRows(state: ModelState): LockedScope[] {
    return state.scopes.map((scope) => ({
        scopeId: scope.id,
        state: scope.state,
        fenced: scope.fenced,
        hasSealedTry: scope.inverses - scope.inversesDone > 0,
        hasExpiredTry: scope.expired && scope.state === 'open',
    }));
}

/** Applies one Engine append the way the triggers would, refusing what the database refuses. */
function applyEngineAppend(state: ModelState, drafts: readonly EventDraft[], guarded: boolean): void {
    for (const draft of drafts) {
        if (draft.event_type === 'replan/cancel-requested') {
            for (const scopeId of draft.payload.scope_ids as string[]) {
                const scope = state.scopes.find((entry) => entry.id === scopeId);
                if (guarded && (!scope || scope.state !== 'open' || scope.request !== null)) {
                    state.refused ??= `request of ${scopeId} in state ${scope?.state}/${scope?.request}`;
                    return;
                }
                if (scope) [scope.request, scope.fenced] = ['pending', true];
            }
        }
        if (draft.event_type === 'subgraph/shadowed' && guarded) {
            const shadowed = new Set(draft.payload.vertex_ids as string[]);
            for (const created of state.log.events) {
                if (created.event_type !== 'vertex/created' || !created.scope_id || !shadowed.has(created.vertex_id!)) continue;
                const scope = state.scopes.find((entry) => entry.id === created.scope_id);
                if (scope && scope.state !== 'cancelled' && scope.state !== 'committed') {
                    state.refused ??= `shadow into ${scope.id} while ${scope.state}`;
                    return;
                }
                if (scope?.lease === created.vertex_id) {
                    state.refused ??= `shadow of leased ${created.vertex_id}`;
                    return;
                }
            }
        }
    }
    state.log.append(drafts);
}

/** `request_scope_cancel`'s decision under the lock, for either origin. */
function requestCancel(state: ModelState, scope: DbScope, origin: 'engine' | 'timeout'): void {
    if (scope.state === 'cancelling' || scope.state === 'cancelled') {
        if (scope.request === 'pending' || scope.request === 'deferred') scope.request = 'duplicate';
        return;
    }
    if (scope.state === 'suspended' && origin === 'engine') {
        if (scope.request === 'pending' || scope.request === 'deferred') scope.request = 'suspended';
        return;
    }
    if (scope.state !== 'open') {
        state.refused ??= `cancel of ${scope.id} in state ${scope.state}`;
        return;
    }
    if (scope.lease) {
        if (scope.request === 'pending' || scope.request === 'deferred') scope.request = 'deferred';
        return;
    }
    if (scope.unresolved) {
        state.log.suspend(scope.id);
        scope.state = 'suspended';
        if (scope.request === 'pending' || scope.request === 'deferred') scope.request = 'suspended';
        return;
    }
    state.log.cancelRequested(scope.id);
    scope.state = 'cancelling';
    if (scope.request === 'pending' || scope.request === 'deferred') scope.request = 'requested';
}

/** Every step either party could take next. */
export function enabledSteps(state: ModelState, engine: Engine): Step[] {
    const steps: Step[] = [];
    if (state.refused) return steps;
    for (const [index, scope] of state.scopes.entries()) {
        const at = (s: ModelState) => s.scopes[index]!;
        const pickable = engine.coordinatorSelfCancels ? scope.fenced && scope.state === 'open' && scope.request !== 'requested' : scope.request === 'pending' || scope.request === 'deferred';
        // A deferred pickup changes nothing, so it is not a step: the lease has to move first.
        if (pickable && !(scope.lease && scope.state === 'open')) {
            steps.push({
                label: `pickup ${scope.id.slice(-3)}`,
                apply: (s) => {
                    if (engine.coordinatorSelfCancels && at(s).request === null) at(s).request = 'pending';
                    requestCancel(s, at(s), 'engine');
                },
            });
        }
        if (scope.expired && scope.state === 'open' && !scope.lease) {
            steps.push({label: `sweep ${scope.id.slice(-3)}`, apply: (s) => requestCancel(s, at(s), 'timeout')});
        }
        if (scope.state === 'cancelling' && scope.inversesDone < scope.inverses) {
            steps.push({
                label: `inverse ${scope.id.slice(-3)}#${scope.inversesDone}`,
                apply: (s) => {
                    const target = at(s);
                    if (target.inverseFailsAt === target.inversesDone) {
                        s.log.suspend(target.id);
                        target.state = 'suspended';
                        return;
                    }
                    target.inversesDone += 1;
                },
            });
        }
        if (scope.state === 'cancelling' && scope.inversesDone === scope.inverses) {
            steps.push({
                label: `complete ${scope.id.slice(-3)}`,
                apply: (s) => {
                    s.log.cancelCompleted(at(s).id);
                    at(s).state = 'cancelled';
                },
            });
        }
        if (scope.lease) {
            const sibling = scope.lease;
            steps.push({
                label: `sibling seals ${scope.id.slice(-3)}`,
                apply: (s) => {
                    s.log.push('txn/try', {vertex_id: sibling, scope_id: at(s).id, payload: {idempotency_key: `try:${sibling}`, deadline_at: '2026-01-01T00:10:00.000Z'}});
                    s.log.push('vertex/succeeded', {vertex_id: sibling, scope_id: at(s).id, payload: {attempts: 1, result: {}}});
                    at(s).inverses += 1;
                    at(s).lease = null;
                },
            });
            steps.push({
                label: `sibling fails ${scope.id.slice(-3)}`,
                apply: (s) => {
                    s.log.push('vertex/failed', {vertex_id: sibling, scope_id: at(s).id, payload: {attempts: 3, outcome: 'permanent-failure', error: 'sibling refused'}});
                    if (at(s).state === 'open') at(s).fenced = true;
                    at(s).lease = null;
                },
            });
            steps.push({
                label: `sibling crashes ${scope.id.slice(-3)}`,
                apply: (s) => {
                    // The attempt was recorded and never resolved; its lease simply runs out.
                    at(s).unresolved = true;
                    at(s).lease = null;
                },
            });
        }
        if (scope.pivot && scope.state === 'pivot-inflight') {
            const pivot = scope.pivot;
            steps.push({
                label: `pivot passes ${scope.id.slice(-3)}`,
                apply: (s) => {
                    s.log.pivotPassed(pivot, at(s).id);
                    at(s).state = 'pivot-passed';
                },
            });
            steps.push({
                label: `pivot unknown ${scope.id.slice(-3)}`,
                apply: (s) => {
                    s.log.push('vertex/failed', {vertex_id: pivot, scope_id: at(s).id, payload: {attempts: 1, outcome: 'unknown', error: 'pivot outcome unknown'}});
                    s.log.suspend(at(s).id);
                    at(s).state = 'suspended';
                },
            });
        }
        if (scope.pivot && scope.state === 'pivot-passed') {
            steps.push({
                label: `commit ${scope.id.slice(-3)}`,
                apply: (s) => {
                    s.log.push('txn/scope', {scope_id: at(s).id, payload: {state: 'committed'}});
                    at(s).state = 'committed';
                },
            });
        }
    }
    const drafts = engine.decide(state.log.events, lockedRows(state));
    if (drafts?.length) steps.push({label: `engine ${drafts[0]!.event_type}`, apply: (s) => applyEngineAppend(s, drafts, engine.guarded)});
    return steps;
}

/** The real ladder as the loop drives it: the first outstanding failure that is not waiting acts. */
export function ladder(policy: RecoveryPolicy): Engine {
    return {
        guarded: true,
        coordinatorSelfCancels: false,
        decide(events, locked) {
            for (const failed of outstanding(events)) {
                const {decision, drafts} = decideRecovery(events, failed, policy, locked);
                // Deciding must never throw, and waiting must never write.
                if (decision.action === 'wait') {
                    if (drafts.length) throw new Error('a wait decision produced drafts');
                    continue;
                }
                return drafts;
            }
            return null;
        },
    };
}

/**
 * The ladder as it was before this change, reduced to what decided these runs: a bracket closed
 * by any `txn/cancel`, a candidate rejected while its subtree held an open bracket, an escalation
 * when none was left, and a Coordinator that cancelled on its own. It exists to prove the oracles
 * catch what they are meant to catch.
 */
export function legacyLadder(): Engine {
    const openBrackets = (events: readonly StoredEvent[]): Set<string> => {
        const open = new Set<string>();
        for (const event of events) {
            if (!event.scope_id) continue;
            if (event.event_type === 'txn/try') open.add(event.scope_id);
            if (event.event_type === 'txn/confirm' || event.event_type === 'txn/cancel') open.delete(event.scope_id);
        }
        return open;
    };
    return {
        guarded: false,
        coordinatorSelfCancels: true,
        decide(events) {
            const failed = unrecoveredFailures(events)[0];
            if (!failed) return null;
            const open = openBrackets(events);
            const scopeOf = new Map(events.filter((event) => event.event_type === 'vertex/created').map((event) => [event.vertex_id!, event.scope_id]));
            const floor = backtrackFloor(events);
            for (const planner of ancestorPlanners(events, failed)) {
                const discarded = shadowSet(events, planner.vertexId);
                if (planner.seq < floor || discarded.some((id) => open.has(scopeOf.get(id) ?? ''))) continue;
                return [
                    {
                        event_type: 'replan/boundary',
                        vertex_id: planner.vertexId,
                        payload: {level: 'L1', reason: 'legacy', failed_vertex_id: failed, candidates: [], selected: planner.vertexId, episode: 1},
                    },
                    {event_type: 'subgraph/shadowed', payload: {vertex_ids: discarded, reason: 'legacy'}},
                ];
            }
            return [{event_type: 'replan/boundary', payload: {level: 'L3', reason: 'legacy', failed_vertex_id: failed, candidates: [], selected: null, episode: 1}}];
        },
    };
}

/** Safety, checked at every visited state. */
export function safetyViolations(state: ModelState): OracleResult[] {
    const events = state.log.events;
    const results: OracleResult[] = [cancelBeforeReplan(events), cancelRequestDiscipline(events), oneAnswerPerFailure(events)];
    if (state.refused) results.push({name: 'db.refused', passed: false, detail: state.refused});
    const pivoted = new Set<string>();
    for (const event of events) {
        if (event.event_type === 'txn/pivot-passed' && event.scope_id) pivoted.add(event.scope_id);
        if (event.event_type === 'txn/cancel' && event.scope_id && pivoted.has(event.scope_id)) results.push({name: 'I3.no_cancel_after_pivot', passed: false, detail: `run_seq ${event.run_seq}`});
    }
    // Waiting and asking spend nothing: the only boundaries are answers, one per failure at most.
    // (Each failure's own count is O2.one_answer_per_failure above.)
    const failures = new Set(events.filter((event) => event.event_type === 'vertex/failed').map((event) => event.vertex_id));
    const boundaries = events.filter((event) => event.event_type === 'replan/boundary');
    if (boundaries.length > failures.size) results.push({name: 'episode.not_spent_waiting', passed: false, detail: `${boundaries.length} boundaries for ${failures.size} failures`});
    for (const [ordinal, boundary] of boundaries.entries()) {
        if (boundary.payload.episode !== ordinal + 1)
            results.push({name: 'episode.not_spent_waiting', passed: false, detail: `boundary at run_seq ${boundary.run_seq} has episode ${String(boundary.payload.episode)}`});
    }
    for (const scope of state.scopes) {
        const requested = events.filter((event) => event.event_type === 'txn/cancel' && event.scope_id === scope.id && event.payload.phase === 'requested').length;
        const completed = events.filter((event) => event.event_type === 'txn/cancel' && event.scope_id === scope.id && event.payload.phase === 'completed').length;
        if (requested > 1 || completed > 1) results.push({name: 'one_cancellation_per_scope', passed: false, detail: `${scope.id}: ${requested} requested, ${completed} completed`});
    }
    return results.filter((result) => !result.passed);
}

export interface Exploration {
    states: number;
    terminals: ModelState[];
    violations: {path: string[]; results: OracleResult[]}[];
    labels: Set<string>;
}

/** Visits every interleaving from `initial`, checking safety everywhere. */
export function explore(initial: ModelState, engine: Engine): Exploration {
    const seen = new Set<string>();
    const result: Exploration = {states: 0, terminals: [], violations: [], labels: new Set()};
    const visit = (state: ModelState, path: string[]): void => {
        const id = key(state);
        if (seen.has(id)) return;
        seen.add(id);
        result.states += 1;
        const bad = safetyViolations(state);
        if (bad.length) {
            // A violating state is not explored further: everything after it inherits the defect.
            result.violations.push({path, results: bad});
            return;
        }
        const steps = enabledSteps(state, engine);
        if (!steps.length) {
            result.terminals.push(state);
            return;
        }
        for (const step of steps) {
            result.labels.add(step.label.startsWith('engine') ? step.label : step.label.split(' ')[0]!);
            const next = clone(state);
            step.apply(next);
            visit(next, [...path, step.label]);
        }
    };
    visit(initial, []);
    return result;
}
