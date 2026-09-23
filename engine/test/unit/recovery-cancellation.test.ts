import {describe, expect, it} from 'vitest';
import {cancelRequestEvent, decideRecovery, outstanding, replanHistory, scopeCancellations, selectBoundary} from '../../src/recovery.js';
import {assertEventDraft} from '../../src/log/events.js';
import type {LockedScope} from '../../src/log/store.js';
import {id, POLICY, RecoveryLog} from './support/recovery-log.js';

/**
 * The ladder's side of cancel-before-replan (03 §2.2, §2.4 rule 1): what it reads a scope's phase
 * to be, when it asks for a cancellation, when it waits for one, and what it records afterwards.
 */

const P1 = id(1);
const P2 = id(2);
const HOLD = id(3);
const TOOL = id(4);
const EARLY = id(5);
const OTHER = id(6);
const PIVOT = id(7);
const ROUTER = id(8);
const SCOPE = id(90);
const SIBLING_SCOPE = id(91);

/** P1 → P2 → {HOLD sealed, TOOL failed}, both in SCOPE. */
function failedInsideScope(): RecoveryLog {
    return new RecoveryLog()
        .start()
        .freeze('submitted', [{id: P1, role: 'planner'}])
        .succeed(P1)
        .freeze('submitted', [{id: P2, role: 'planner', parents: [P1]}])
        .succeed(P2)
        .freeze('submitted', [
            {id: HOLD, role: 'tool', parents: [P2], scope: SCOPE},
            {id: TOOL, role: 'tool', parents: [P2], scope: SCOPE},
        ])
        .open(SCOPE)
        .seal(HOLD, SCOPE)
        .fail(TOOL, SCOPE);
}

describe('reading a scope’s phase from the log', () => {
    it('follows the database: a failure fences, a request and a cancellation move it, only completion closes it', () => {
        const log = new RecoveryLog()
            .start()
            .freeze('submitted', [{id: P1, role: 'planner'}])
            .succeed(P1)
            .freeze('submitted', [{id: TOOL, role: 'tool', parents: [P1], scope: SCOPE}]);
        expect(scopeCancellations(log.events).get(SCOPE)?.phase).toBe('unmaterialized');
        log.open(SCOPE);
        expect(scopeCancellations(log.events).get(SCOPE)?.phase).toBe('open');
        log.fail(TOOL, SCOPE);
        expect(scopeCancellations(log.events).get(SCOPE)).toMatchObject({phase: 'fenced', fencedBy: TOOL});
        log.append([{event_type: 'replan/cancel-requested', payload: {failed_vertex_id: TOOL, scope_ids: [SCOPE], level: 'L1', reason: 'r', candidates: []}}]);
        expect(scopeCancellations(log.events).get(SCOPE)).toMatchObject({phase: 'cancel-requested', requestedFor: TOOL});
        log.cancelRequested(SCOPE);
        expect(scopeCancellations(log.events).get(SCOPE)?.phase).toBe('cancelling');
        log.cancelCompleted(SCOPE);
        expect(scopeCancellations(log.events).get(SCOPE)).toMatchObject({phase: 'cancelled', cancelledSeq: log.events.length});
    });

    it('does not fence after the pivot, and re-fences a pivot proven absent', () => {
        const passed = new RecoveryLog()
            .start()
            .freeze('submitted', [{id: P1, role: 'planner'}])
            .succeed(P1)
            .freeze('submitted', [
                {id: PIVOT, role: 'tool', parents: [P1], scope: SCOPE},
                {id: TOOL, role: 'tool', parents: [PIVOT], scope: SCOPE},
            ])
            .open(SCOPE)
            .pivotStarted(PIVOT, SCOPE)
            .pivotPassed(PIVOT, SCOPE)
            .fail(TOOL, SCOPE);
        // Forward recovery must not be stopped: the confirms still have to run.
        expect(scopeCancellations(passed.events).get(SCOPE)?.phase).toBe('pivot-passed');

        const absent = new RecoveryLog()
            .start()
            .freeze('submitted', [{id: P1, role: 'planner'}])
            .succeed(P1)
            .freeze('submitted', [{id: PIVOT, role: 'tool', parents: [P1], scope: SCOPE}])
            .open(SCOPE)
            .pivotStarted(PIVOT, SCOPE);
        expect(scopeCancellations(absent.events).get(SCOPE)?.phase).toBe('pivot-inflight');
        absent.push('vertex/failed', {vertex_id: PIVOT, scope_id: SCOPE, payload: {attempts: 1, outcome: 'confirmed-absent', error: 'absent'}});
        expect(scopeCancellations(absent.events).get(SCOPE)?.phase).toBe('fenced');
    });
});

describe('asking for a cancellation, and waiting for it', () => {
    it('publishes the comparison before the cancellation, and again after it without the requirement', () => {
        const log = failedInsideScope();
        const request = decideRecovery(log.events, TOOL, POLICY);
        expect(request.drafts).toHaveLength(1);
        const draft = request.drafts[0]!;
        expect(() => assertEventDraft(draft)).not.toThrow();
        expect(draft).toMatchObject({event_type: 'replan/cancel-requested', payload: {failed_vertex_id: TOOL, scope_ids: [SCOPE], level: 'L1', intended_boundary_vertex_id: P2}});
        const before = (draft.payload.candidates as {planner_vertex_id: string; requires_cancel?: string[]}[]).find((entry) => entry.planner_vertex_id === P2)!;
        expect(before.requires_cancel).toEqual([SCOPE]);

        log.append(request.drafts);
        log.cancelRequested(SCOPE).cancelCompleted(SCOPE);
        const recorded = decideRecovery(log.events, TOOL, POLICY);
        const boundary = recorded.drafts[0]!;
        expect(() => assertEventDraft(boundary)).not.toThrow();
        const after = (boundary.payload.candidates as {planner_vertex_id: string; requires_cancel?: string[]}[]).find((entry) => entry.planner_vertex_id === P2)!;
        expect(after.requires_cancel).toBeUndefined();
        expect(boundary.payload).toMatchObject({selected: P2, cancelled_scopes: [SCOPE], cancel_request_seq: log.events.findIndex((event) => event.event_type === 'replan/cancel-requested') + 1});
    });

    it('does not spend an episode on asking or on waiting', () => {
        const log = failedInsideScope();
        log.append(decideRecovery(log.events, TOOL, POLICY).drafts);
        log.cancelRequested(SCOPE);
        decideRecovery(log.events, TOOL, POLICY);
        expect(replanHistory(log.events).episode).toBe(0);
        log.cancelCompleted(SCOPE);
        const {drafts} = decideRecovery(log.events, TOOL, POLICY);
        expect(drafts[0]!.payload.episode).toBe(1);
    });

    it('waits for a cancellation the orphan sweep started, exactly as for its own', () => {
        const log = failedInsideScope().cancelRequested(SCOPE);
        expect(decideRecovery(log.events, TOOL, POLICY).decision).toMatchObject({action: 'wait', awaitedScopes: [SCOPE]});
        log.cancelCompleted(SCOPE);
        expect(decideRecovery(log.events, TOOL, POLICY).decision).toMatchObject({action: 'record', selected: P2, cancelledScopes: [SCOPE], cancelRequestSeq: null});
    });

    it('cancels every scope the discard set touches, a healthy sibling scope included', () => {
        const log = new RecoveryLog()
            .start()
            .freeze('submitted', [{id: P1, role: 'planner'}])
            .succeed(P1)
            .freeze('submitted', [{id: P2, role: 'planner', parents: [P1]}])
            .succeed(P2)
            .freeze('submitted', [
                {id: HOLD, role: 'tool', parents: [P2], scope: SIBLING_SCOPE},
                {id: TOOL, role: 'tool', parents: [P2], scope: SCOPE},
            ])
            .open(SIBLING_SCOPE)
            .seal(HOLD, SIBLING_SCOPE)
            .open(SCOPE)
            .fail(TOOL, SCOPE);
        expect(decideRecovery(log.events, TOOL, POLICY).decision).toMatchObject({action: 'request', requestScopes: [SCOPE, SIBLING_SCOPE].sort()});
    });

    it('does not escalate while another scope it asked about is still cancelling', () => {
        // Found by the interleaving model: one request named two scopes, the failure's own scope
        // suspended at pickup, and the ladder escalated at once — with the sibling scope's inverses
        // still running. The escalation waits for every scope it asked about.
        const log = new RecoveryLog()
            .start()
            .freeze('submitted', [{id: P1, role: 'planner'}])
            .succeed(P1)
            .freeze('submitted', [{id: P2, role: 'planner', parents: [P1]}])
            .succeed(P2)
            .freeze('submitted', [
                {id: HOLD, role: 'tool', parents: [P2], scope: SIBLING_SCOPE},
                {id: TOOL, role: 'tool', parents: [P2], scope: SCOPE},
            ])
            .open(SIBLING_SCOPE)
            .seal(HOLD, SIBLING_SCOPE)
            .open(SCOPE)
            .fail(TOOL, SCOPE, 'unknown');
        log.append(decideRecovery(log.events, TOOL, POLICY).drafts);
        log.cancelRequested(SIBLING_SCOPE).suspend(SCOPE);
        expect(decideRecovery(log.events, TOOL, POLICY).decision).toMatchObject({action: 'wait', awaitedScopes: [SIBLING_SCOPE]});
        log.cancelCompleted(SIBLING_SCOPE);
        expect(decideRecovery(log.events, TOOL, POLICY).decision).toMatchObject({action: 'record', level: 'L4', selected: null, cancelledScopes: [SIBLING_SCOPE]});
    });

    it('refuses a boundary whose cancellation would undo work above it, and resumes further back (S3b)', () => {
        // SCOPE was opened by work P1 froze, before P2 existed. Cancelling it to resume at P2 would
        // undo EARLY, which P2 never authored — the savepoint precedes P2. P1 is above it.
        const log = new RecoveryLog()
            .start()
            .freeze('submitted', [{id: P1, role: 'planner'}])
            .succeed(P1)
            .freeze('submitted', [
                {id: EARLY, role: 'tool', parents: [P1], scope: SCOPE},
                {id: P2, role: 'planner', parents: [P1]},
            ])
            .open(SCOPE)
            .seal(EARLY, SCOPE)
            .succeed(P2)
            .freeze('submitted', [{id: TOOL, role: 'tool', parents: [P2], scope: SCOPE}])
            .fail(TOOL, SCOPE);
        const {decision, drafts} = decideRecovery(log.events, TOOL, POLICY);
        expect(decision.candidates.find((entry) => entry.planner_vertex_id === P2)!.rejected).toBe('savepoint_precedes');
        expect(decision).toMatchObject({action: 'request', level: 'L2', intended: P1, requestScopes: [SCOPE]});

        // Once SCOPE is cancelled P2 needs nothing cancelled any more, and it is still not legal:
        // the cancellation undid EARLY, which P2's context would otherwise show as standing.
        log.append(drafts);
        log.cancelRequested(SCOPE).cancelCompleted(SCOPE);
        const after = decideRecovery(log.events, TOOL, POLICY).decision;
        expect(after.candidates.find((entry) => entry.planner_vertex_id === P2)!.rejected).toBe('savepoint_precedes');
        expect(after).toMatchObject({action: 'record', level: 'L2', selected: P1, cancelledScopes: [SCOPE]});
    });

    it('treats a scope no cancellation can close as an open bracket', () => {
        const log = new RecoveryLog()
            .start()
            .freeze('submitted', [{id: P1, role: 'planner'}])
            .succeed(P1)
            .freeze('submitted', [{id: P2, role: 'planner', parents: [P1]}])
            .succeed(P2)
            .freeze('submitted', [
                {id: PIVOT, role: 'tool', parents: [P2], scope: SIBLING_SCOPE},
                {id: TOOL, role: 'tool', parents: [P2]},
            ])
            .open(SIBLING_SCOPE)
            .pivotStarted(PIVOT, SIBLING_SCOPE)
            .fail(TOOL);
        const {decision} = decideRecovery(log.events, TOOL, POLICY);
        expect(decision.candidates.map((entry) => entry.rejected)).toEqual(['open_bracket', 'open_bracket']);
    });

    it('waits while another scope in the run refuses every freeze', () => {
        // The failure is unscoped and nothing it discards needs cancelling, but OTHER's scope is
        // fenced by its own failure. A replan recorded now would be refused by R12 at freeze and
        // would have spent an episode for nothing.
        const log = new RecoveryLog()
            .start()
            .freeze('submitted', [{id: P1, role: 'planner'}])
            .succeed(P1)
            .freeze('submitted', [
                {id: P2, role: 'planner', parents: [P1]},
                {id: OTHER, role: 'tool', parents: [P1], scope: SCOPE},
            ])
            .succeed(P2)
            .open(SCOPE)
            .fail(OTHER, SCOPE)
            .freeze('submitted', [{id: TOOL, role: 'tool', parents: [P2]}])
            .fail(TOOL);
        expect(outstanding(log.events)).toEqual([OTHER, TOOL]);
        expect(decideRecovery(log.events, TOOL, POLICY).decision).toMatchObject({action: 'wait', awaitedScopes: [SCOPE]});
        // OTHER is not blocked: it asks for its own scope.
        expect(decideRecovery(log.events, OTHER, POLICY).decision).toMatchObject({action: 'request', requestScopes: [SCOPE]});
    });

    it('waits when the locked scope rows show a state the log does not yet carry', () => {
        // A pivot proven absent reopens its scope, fenced, in its own transaction before the
        // `vertex/failed` that says so. The ladder does not decide on a state it cannot read.
        const log = failedInsideScope();
        const locked: LockedScope[] = [{scopeId: SCOPE, state: 'cancelling', fenced: true, hasSealedTry: true, hasExpiredTry: false}];
        expect(selectBoundary(log.events, TOOL, POLICY, locked)).toMatchObject({action: 'wait', awaitedScopes: [SCOPE]});
        const agreeing: LockedScope[] = [{scopeId: SCOPE, state: 'open', fenced: true, hasSealedTry: true, hasExpiredTry: false}];
        expect(selectBoundary(log.events, TOOL, POLICY, agreeing).action).toBe('request');
    });

    it('waits for the orphan sweep when a try has expired elsewhere in the run', () => {
        const log = new RecoveryLog()
            .start()
            .freeze('submitted', [{id: P1, role: 'planner'}])
            .succeed(P1)
            .freeze('submitted', [{id: TOOL, role: 'tool', parents: [P1]}])
            .fail(TOOL);
        const locked: LockedScope[] = [{scopeId: SCOPE, state: 'open', fenced: false, hasSealedTry: true, hasExpiredTry: true}];
        // SCOPE has a row but no events here, so the log and the row disagree first; give it one.
        log.push('txn/scope', {scope_id: SCOPE, payload: {state: 'open'}});
        expect(selectBoundary(log.events, TOOL, POLICY, locked)).toMatchObject({action: 'wait', awaitedScopes: [SCOPE]});
    });
});

describe('escalating only once the failure’s scope is released', () => {
    it('cancels a rule-authored branch’s scope, then records L4 with no planner (03 §2.5)', () => {
        const log = new RecoveryLog()
            .start()
            .freeze('submitted', [{id: P1, role: 'planner'}])
            .succeed(P1)
            .freeze('submitted', [{id: ROUTER, role: 'router', parents: [P1]}])
            .freeze('router', [{id: TOOL, role: 'tool', parents: [ROUTER], scope: SCOPE}])
            .succeed(ROUTER)
            .open(SCOPE)
            .fail(TOOL, SCOPE);
        const request = decideRecovery(log.events, TOOL, POLICY);
        expect(request.decision).toMatchObject({action: 'request', level: 'L3', requestScopes: [SCOPE], intended: null});
        expect(request.drafts[0]!.payload).toMatchObject({level: 'L3', intended_boundary_vertex_id: null});
        log.append(request.drafts);
        log.cancelRequested(SCOPE).cancelCompleted(SCOPE);
        const recorded = decideRecovery(log.events, TOOL, POLICY);
        expect(recorded.decision).toMatchObject({action: 'record', level: 'L4', selected: null, cancelledScopes: [SCOPE]});
        expect(recorded.drafts.map((draft) => draft.event_type)).toEqual(['replan/boundary']);
    });

    it('cancels at the episode bound, then records L3', () => {
        const log = failedInsideScope();
        log.push('replan/boundary', {vertex_id: P2, payload: {level: 'L1', reason: 'a', failed_vertex_id: TOOL, candidates: [], selected: P2}});
        log.push('replan/boundary', {vertex_id: P1, payload: {level: 'L2', reason: 'b', failed_vertex_id: TOOL, candidates: [], selected: P1}});
        expect(decideRecovery(log.events, TOOL, POLICY).decision).toMatchObject({action: 'request', level: 'L3', requestScopes: [SCOPE]});
    });

    it('records L4 straight away after the pivot, asking for nothing', () => {
        const log = new RecoveryLog()
            .start()
            .freeze('submitted', [{id: P1, role: 'planner'}])
            .succeed(P1)
            .freeze('submitted', [
                {id: PIVOT, role: 'tool', parents: [P1], scope: SCOPE},
                {id: TOOL, role: 'tool', parents: [PIVOT], scope: SCOPE},
            ])
            .open(SCOPE)
            .pivotStarted(PIVOT, SCOPE)
            .pivotPassed(PIVOT, SCOPE)
            .fail(TOOL, SCOPE);
        const {decision, drafts} = decideRecovery(log.events, TOOL, POLICY);
        expect(decision).toMatchObject({action: 'record', level: 'L4', selected: null, requestScopes: []});
        expect(drafts.map((draft) => draft.event_type)).toEqual(['replan/boundary']);
    });

    it('refuses to build a request out of anything but a request decision', () => {
        const log = failedInsideScope().cancelRequested(SCOPE);
        expect(() => cancelRequestEvent(selectBoundary(log.events, TOOL, POLICY))).toThrow('only a request decision');
    });
});
