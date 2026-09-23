import {describe, expect, it} from 'vitest';
import {decideRecovery, openBracketScopes, outstanding} from '../../src/recovery.js';
import {id, POLICY, RecoveryLog} from './support/recovery-log.js';

/**
 * Regression for W7's ordering hole: the recovery ladder raced the scope cancellation that a
 * pre-pivot failure needs.
 *
 * The Coordinator used to cancel on its own, writing `vertex/failed`, then `txn/cancel {requested}`,
 * then the inverse calls, then `txn/cancel {completed}`, while the ladder read the log whenever it
 * happened to run. Reading before the request, it escalated and recorded the escalation as the
 * failure's answer, so the legal boundary the cancellation was about to create was never used.
 * Reading between `requested` and `completed`, it treated the bracket as closed and replanned
 * across a try whose inverse had not run.
 *
 * Now the ladder itself requests the cancellation and waits for it to complete.
 */

const P1 = id(1);
const P2 = id(2);
const HOLD = id(3);
const TOOL = id(4);
const SCOPE = id(90);

/**
 *   P1 → P2 → HOLD (sealed try in SCOPE)
 *            └→ TOOL (fails, in SCOPE, pre-pivot)
 */
function failedInsideScope(): RecoveryLog {
    return new RecoveryLog()
        .start()
        .freeze('submitted', [{id: P1, role: 'planner'}])
        .succeed(P1)
        .freeze('submitted', [{id: P2, role: 'planner', parents: [P1]}])
        .succeed(P2)
        .freeze('submitted', [
            {id: HOLD, role: 'tool', parents: [P2], scope: SCOPE, tool: 'inventory.hold'},
            {id: TOOL, role: 'tool', parents: [P2], scope: SCOPE, tool: 'carrier.book'},
        ])
        .open(SCOPE)
        .seal(HOLD, SCOPE)
        .fail(TOOL, SCOPE);
}

describe('W7 regression: the ladder no longer races the scope cancellation', () => {
    it('window 1 — right after the failure, it asks for the cancellation instead of escalating, and answers once it completes', () => {
        const log = failedInsideScope();

        const early = decideRecovery(log.events, TOOL, POLICY);
        expect(early.decision).toMatchObject({action: 'request', level: 'L1', intended: P2, requestScopes: [SCOPE]});
        const [requestSeq] = log.append(early.drafts);
        // A request answers nothing: the failure is still the ladder's to answer.
        expect(outstanding(log.events)).toEqual([TOOL]);
        // Asking twice would be a bug, and the database refuses it; the ladder waits instead.
        expect(decideRecovery(log.events, TOOL, POLICY).decision.action).toBe('wait');

        log.cancelRequested(SCOPE).cancelCompleted(SCOPE);

        const late = decideRecovery(log.events, TOOL, POLICY);
        expect(late.decision).toMatchObject({action: 'record', level: 'L1', selected: P2, cancelledScopes: [SCOPE], cancelRequestSeq: requestSeq});
        log.append(late.drafts);
        expect(outstanding(log.events)).toEqual([]);
    });

    it('window 2 — mid-cancellation, the bracket is still open and the ladder waits', () => {
        const log = failedInsideScope();
        log.append(decideRecovery(log.events, TOOL, POLICY).drafts);
        log.cancelRequested(SCOPE);

        // The hold has not been released: `completed` has not been written, and may never be —
        // a failed inverse suspends the scope instead.
        expect(openBracketScopes(log.events).has(SCOPE)).toBe(true);
        const {decision, drafts} = decideRecovery(log.events, TOOL, POLICY);
        expect(decision).toMatchObject({action: 'wait', selected: null, awaitedScopes: [SCOPE]});
        expect(drafts).toEqual([]);
    });

    it('window 2, other ending — the cancellation suspends, and the failure goes to a person with nothing replanned', () => {
        const log = failedInsideScope();
        log.append(decideRecovery(log.events, TOOL, POLICY).drafts);
        log.cancelRequested(SCOPE).suspend(SCOPE);

        const {decision, drafts} = decideRecovery(log.events, TOOL, POLICY);
        expect(decision).toMatchObject({action: 'record', level: 'L4', selected: null});
        expect(drafts.map((draft) => draft.event_type)).toEqual(['replan/boundary']);
    });
});
