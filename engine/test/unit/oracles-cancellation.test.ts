import {describe, expect, it} from 'vitest';
import {cancelBeforeReplan, cancelRequestDiscipline, noDeterministicReplan, oneAnswerPerFailure} from '../../src/harness/oracles.js';
import {decideRecovery} from '../../src/recovery.js';
import {id, POLICY, RecoveryLog} from './support/recovery-log.js';

/**
 * The cancellation oracles must pass the ladder's own logs and fail each log shape the old ladder
 * produced. An oracle that no log can fail proves nothing, so every one is shown failing here.
 */

const P1 = id(1);
const P2 = id(2);
const HOLD = id(3);
const TOOL = id(4);
const ROUTER = id(8);
const SCOPE = id(90);

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

/** What the ladder writes when it asks, the Coordinator cancels, and the ladder answers. */
function ladderLog(): RecoveryLog {
    const log = failedInsideScope();
    log.append(decideRecovery(log.events, TOOL, POLICY).drafts);
    log.cancelRequested(SCOPE).cancelCompleted(SCOPE);
    log.append(decideRecovery(log.events, TOOL, POLICY).drafts);
    return log;
}

const boundary = (log: RecoveryLog, payload: Record<string, unknown>): void => {
    log.push('replan/boundary', {vertex_id: (payload.selected as string | null) ?? null, payload: {level: 'L1', reason: 'r', failed_vertex_id: TOOL, candidates: [], ...payload}});
};
const shadow = (log: RecoveryLog, vertexIds: string[]): void => {
    log.push('subgraph/shadowed', {payload: {vertex_ids: vertexIds, reason: 'r'}});
};

describe('cancellation oracles', () => {
    it('pass the log the ladder writes', () => {
        const log = ladderLog();
        expect(cancelBeforeReplan(log.events)).toMatchObject({passed: true});
        expect(cancelRequestDiscipline(log.events, {final: true})).toMatchObject({passed: true});
        expect(oneAnswerPerFailure(log.events)).toMatchObject({passed: true});
    });

    it('O2.cancel_before_replan fails a replan across a cancellation that was only requested (old window 2)', () => {
        const log = failedInsideScope().cancelRequested(SCOPE);
        boundary(log, {selected: P2});
        shadow(log, [HOLD, TOOL]);
        expect(cancelBeforeReplan(log.events)).toMatchObject({passed: false});
    });

    it('O2.cancel_before_replan fails an escalation recorded while the failure’s scope could still cancel (old window 1)', () => {
        const log = failedInsideScope();
        boundary(log, {level: 'L3', selected: null});
        log.cancelRequested(SCOPE).cancelCompleted(SCOPE);
        expect(cancelBeforeReplan(log.events)).toMatchObject({passed: false, detail: expect.stringContaining('unreleased')});
    });

    it('O2.cancel_before_replan fails a boundary citing a cancellation that had not completed', () => {
        const log = failedInsideScope().cancelRequested(SCOPE);
        boundary(log, {selected: null, level: 'L4', cancelled_scopes: [SCOPE]});
        expect(cancelBeforeReplan(log.events)).toMatchObject({passed: false, detail: expect.stringContaining('cites')});
    });

    it('O2.cancel_request_discipline fails a second request, and an answer before the scope resolved', () => {
        const twice = failedInsideScope();
        const first = decideRecovery(twice.events, TOOL, POLICY).drafts;
        twice.append(first);
        twice.append(first);
        expect(cancelRequestDiscipline(twice.events)).toMatchObject({passed: false, detail: expect.stringContaining('twice')});

        const early = failedInsideScope();
        early.append(decideRecovery(early.events, TOOL, POLICY).drafts);
        early.cancelRequested(SCOPE);
        boundary(early, {selected: null, level: 'L4'});
        expect(cancelRequestDiscipline(early.events)).toMatchObject({passed: false, detail: expect.stringContaining('before scope')});
    });

    it('O2.cancel_request_discipline fails a request of a scope already cancelling, and an unresolved request at the end', () => {
        const late = failedInsideScope().cancelRequested(SCOPE);
        late.append([{event_type: 'replan/cancel-requested', payload: {failed_vertex_id: TOOL, scope_ids: [SCOPE], level: 'L1', reason: 'r', candidates: []}}]);
        expect(cancelRequestDiscipline(late.events)).toMatchObject({passed: false, detail: expect.stringContaining('no longer')});

        const unresolved = failedInsideScope();
        unresolved.append(decideRecovery(unresolved.events, TOOL, POLICY).drafts);
        expect(cancelRequestDiscipline(unresolved.events)).toMatchObject({passed: true});
        expect(cancelRequestDiscipline(unresolved.events, {final: true})).toMatchObject({passed: false, detail: expect.stringContaining('never resolved')});
    });

    it('O2.one_answer_per_failure fails a failure decided twice', () => {
        const log = failedInsideScope();
        boundary(log, {level: 'L3', selected: null});
        boundary(log, {selected: P2});
        expect(oneAnswerPerFailure(log.events)).toMatchObject({passed: false});
    });

    it('O2.no_deterministic_replan allows a rule-authored failure its cancellation and its escalation, and nothing more', () => {
        const log = new RecoveryLog()
            .start()
            .freeze('submitted', [{id: P1, role: 'planner'}])
            .succeed(P1)
            .freeze('submitted', [{id: ROUTER, role: 'router', parents: [P1]}]);
        log.push('vertex/started', {vertex_id: ROUTER, payload: {attempt: 1}});
        log.freeze('router', [{id: TOOL, role: 'tool', parents: [ROUTER], scope: SCOPE}]);
        log.push('vertex/succeeded', {vertex_id: ROUTER, payload: {attempts: 1, result: {}}});
        log.open(SCOPE).fail(TOOL, SCOPE);
        log.append(decideRecovery(log.events, TOOL, POLICY).drafts);
        log.cancelRequested(SCOPE).cancelCompleted(SCOPE);
        log.append(decideRecovery(log.events, TOOL, POLICY).drafts);
        expect(log.events.at(-1)!.payload).toMatchObject({level: 'L4', selected: null});
        expect(noDeterministicReplan(log.events)).toMatchObject({passed: true});
        expect(cancelBeforeReplan(log.events)).toMatchObject({passed: true});

        boundary(log, {selected: P1});
        expect(noDeterministicReplan(log.events)).toMatchObject({passed: false});
    });
});
