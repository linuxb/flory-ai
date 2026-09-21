import {describe, expect, it} from 'vitest';
import {
    ancestorPlanners,
    outstanding,
    backtrackFloor,
    DEFAULT_RECOVERY_POLICY,
    failureEvidence,
    openBracketScopes,
    replanEvents,
    replanHistory,
    ruleAuthored,
    selectBoundary,
    shadowSet,
    stalledPlanners,
    unrecoveredFailures,
    type RecoveryPolicy,
} from '../../src/recovery.js';
import {assertEventDraft} from '../../src/events.js';
import type {StoredEvent} from '../../src/events.js';
import type {LlmPricing} from '../../src/llm-client.js';

const run = '00000000-0000-4000-8000-0000000000ff';
/** Readable ids that are still UUIDs, because the IDL now checks the format. */
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const P1 = id(1);
const P2 = id(2);
const TOOL = id(3);
const SIBLING = id(4);
const GRANDCHILD = id(5);
const ROUTER = id(6);
const BRANCH = id(7);
const SCOPE = id(90);

const PRICING: LlmPricing = {
    currency: 'CNY',
    cache_hit_input_per_million: 1,
    cache_miss_input_per_million: 4,
    output_per_million: 16,
    reference: 'test',
};
const POLICY: RecoveryPolicy = {...DEFAULT_RECOVERY_POLICY, pricing: PRICING};

let sequence = 0;
function event(event_type: string, options: Partial<StoredEvent> = {}): StoredEvent {
    sequence += 1;
    return {
        run_id: run,
        run_seq: sequence,
        global_seq: sequence,
        event_type,
        vertex_id: null,
        parent_refs: [],
        planner_id: null,
        scope_id: null,
        pin_version: null,
        ignorable: false,
        inherited: false,
        payload: {},
        created_at: '2026-01-01T00:00:00.000Z',
        ...options,
    };
}

/**
 * One freeze, and the vertices it created.
 *
 * The proposal is not decoration: who authored a vertex is read from the `source` its proposal
 * recorded, so a fixture that skipped the proposal would be testing a different engine.
 */
function frozen(source: 'submitted' | 'router', ...created: StoredEvent[]): StoredEvent[] {
    const proposed = event('subgraph/proposed', {payload: {source}});
    return [proposed, event('subgraph/frozen', {payload: {proposed_seq: proposed.run_seq, vertices: []}}), ...created];
}

function vertex(vertexId: string, role: string, parents: string[], tool = 'mock.tool'): StoredEvent {
    return event('vertex/created', {vertex_id: vertexId, parent_refs: parents, payload: {role, ...(role === 'tool' ? {tool} : {})}});
}

/** A vertex that ran and succeeded. */
function ran(vertexId: string): StoredEvent[] {
    return [event('vertex/started', {vertex_id: vertexId, payload: {attempt: 1}}), event('vertex/succeeded', {vertex_id: vertexId, payload: {attempts: 1, result: {}}})];
}

function failed(vertexId: string, error = 'refused'): StoredEvent {
    return event('vertex/failed', {vertex_id: vertexId, payload: {attempts: 3, outcome: 'permanent-failure', error}});
}

/**
 * The shape every test below varies: two nested planners, then a tool that fails.
 *
 *   P1 (planner) → P2 (planner) → TOOL (failed)
 *                              └→ SIBLING → GRANDCHILD
 */
function baseRun(): StoredEvent[] {
    sequence = 0;
    return [
        event('run/start', {payload: {}}),
        ...frozen('submitted', vertex(P1, 'planner', [])),
        ...ran(P1),
        ...frozen('submitted', vertex(P2, 'planner', [P1])),
        ...ran(P2),
        ...frozen('submitted', vertex(TOOL, 'tool', [P2], 'first.tool'), vertex(SIBLING, 'tool', [P2], 'second.tool'), vertex(GRANDCHILD, 'tool', [SIBLING], 'third.tool')),
        event('vertex/started', {vertex_id: TOOL, payload: {attempt: 3}}),
        failed(TOOL, 'the counterparty refused'),
    ];
}

/** The same failure, but in a branch a rule authored. */
function routedRun(): StoredEvent[] {
    sequence = 0;
    return [
        event('run/start', {payload: {}}),
        ...frozen('submitted', vertex(P1, 'planner', [])),
        ...ran(P1),
        ...frozen('submitted', vertex(ROUTER, 'router', [P1])),
        event('vertex/started', {vertex_id: ROUTER, payload: {attempt: 1}}),
        // The router's own proposal. This is the one event that makes the branch rule-authored,
        // and reading it is the difference between refusing to replan a rule's work and refusing
        // to replan everything downstream of any router.
        ...frozen('router', vertex(BRANCH, 'tool', [ROUTER], 'first.tool')),
        event('vertex/succeeded', {vertex_id: ROUTER, payload: {attempts: 1, result: {}, matched_condition: 'always'}}),
        failed(BRANCH),
    ];
}

describe('reading the log for recovery', () => {
    it('finds only failures no replan has answered', () => {
        const events = baseRun();
        expect(unrecoveredFailures(events)).toEqual([TOOL]);
        // Once a replan has discarded it, the same failure must not be picked up again — otherwise
        // the loop replans the same vertex forever without ever reaching a counter.
        const answered = [...events, event('subgraph/shadowed', {payload: {vertex_ids: [TOOL], reason: 'replanned'}})];
        expect(unrecoveredFailures(answered)).toEqual([]);
    });

    it('treats an escalation as an answer, so it is decided once', () => {
        // An escalation discards nothing, so no shadow will ever answer it. A live run appended
        // eight identical L4 boundaries because the driver kept re-deciding the same failure on
        // every pass — the ladder had already said this needs a human, and said it again.
        const events = [...routedRun(), event('replan/boundary', {payload: {level: 'L4', reason: 'a rule authored it', failed_vertex_id: BRANCH, candidates: [], selected: null}})];
        expect(unrecoveredFailures(events)).toEqual([]);
    });

    it('does not treat a failure that later succeeded as outstanding', () => {
        // L0 already handled it. Reporting it would make the ladder replan work that is done.
        const events = [...baseRun(), event('vertex/started', {vertex_id: TOOL, payload: {attempt: 4}}), event('vertex/succeeded', {vertex_id: TOOL, payload: {attempts: 4, result: {}}})];
        expect(unrecoveredFailures(events)).toEqual([]);
    });

    it('orders ancestor planners nearest first', () => {
        expect(ancestorPlanners(baseRun(), TOOL).map((entry) => entry.vertexId)).toEqual([P2, P1]);
    });

    it('reads the backtrack floor from the last pivot that passed', () => {
        const events = baseRun();
        expect(backtrackFloor(events)).toBe(0);
        expect(backtrackFloor([...events, event('txn/pivot-passed', {scope_id: SCOPE, payload: {}})])).toBeGreaterThan(0);
    });

    it('counts a bracket open until it is confirmed or cancelled', () => {
        const tried = [...baseRun(), event('txn/try', {scope_id: SCOPE, vertex_id: TOOL, payload: {}})];
        expect([...openBracketScopes(tried)]).toEqual([SCOPE]);
        expect([...openBracketScopes([...tried, event('txn/cancel', {scope_id: SCOPE, payload: {}})])]).toEqual([]);
    });
});

describe('a planner whose answer produced no work', () => {
    /** The planner answered, the engine could not read it as a proposal, and nothing was frozen. */
    function stalledRun(): StoredEvent[] {
        sequence = 0;
        return [
            event('run/start', {payload: {}}),
            ...frozen('submitted', vertex(P1, 'planner', [])),
            ...ran(P1),
            ...frozen('submitted', vertex(P2, 'planner', [P1])),
            ...ran(P2),
            event('subgraph/unreadable', {
                vertex_id: P2,
                payload: {planner_vertex_id: P2, reason: 'quote names a parent outside this answer', answer_digest: `sha256:${'a'.repeat(64)}`, answer_length: 412},
            }),
        ];
    }

    it('is stuck in a way no failure describes, and the ladder still sees it', () => {
        // The planner's call succeeded, so there is no `vertex/failed` anywhere and the run has
        // nothing outstanding by the ordinary reading. It is still stuck: nothing downstream can
        // become ready, and no executor will call a succeeded planner again.
        const events = stalledRun();
        expect(unrecoveredFailures(events)).toEqual([]);
        expect(stalledPlanners(events)).toEqual([P2]);
        expect(outstanding(events)).toEqual([P2]);
    });

    it('resumes at the planner itself, discarding nothing', () => {
        const decision = selectBoundary(stalledRun(), P2, POLICY);
        expect(decision.level).toBe('L1');
        // Itself, at distance zero: it is the nearest planner with the authority to answer again,
        // and there is nothing below it to throw away.
        expect(decision.selected).toBe(P2);
        expect(decision.shadowed).toEqual([]);
    });

    it('tells that planner why its last answer was refused', () => {
        const events = stalledRun();
        expect(failureEvidence(events, P2, [])).toMatchObject({
            failed_vertex_id: P2,
            error_class: 'unreadable_answer',
            error: 'quote names a parent outside this answer',
            attempts: 1,
            discarded_vertices: 0,
        });
    });

    it('stops reporting the stall once a freeze gave that planner a child', () => {
        // Either a replan answered it or the driver asked again and got a readable answer. Both
        // end the stall, and neither appends anything that says so directly.
        const events = [...stalledRun(), ...frozen('submitted', vertex(TOOL, 'tool', [P2], 'first.tool'))];
        expect(stalledPlanners(events)).toEqual([]);
    });

    it('stops reporting the stall once a replan has answered it', () => {
        const events = [...stalledRun(), event('replan/boundary', {vertex_id: P2, payload: {level: 'L1', reason: 'unreadable', failed_vertex_id: P2, candidates: [], selected: P2}})];
        expect(stalledPlanners(events)).toEqual([]);
    });

    it('gives up on a planner that keeps answering unreadably', () => {
        // The per-planner counter is what stops an endless re-ask. After N turns the planner is
        // dropped and the ladder looks further back, which is L2.
        const events = [
            ...stalledRun(),
            event('replan/boundary', {vertex_id: P2, payload: {level: 'L1', reason: 'a', failed_vertex_id: P2, candidates: [], selected: P2}}),
            event('replan/boundary', {vertex_id: P2, payload: {level: 'L1', reason: 'b', failed_vertex_id: P2, candidates: [], selected: P2}}),
            event('subgraph/unreadable', {vertex_id: P2, payload: {planner_vertex_id: P2, reason: 'again', answer_digest: `sha256:${'b'.repeat(64)}`, answer_length: 9}}),
        ];
        const decision = selectBoundary(events, P2, {...POLICY, maxReplansPerEpisode: 9});
        expect(decision.candidates.find((entry) => entry.planner_vertex_id === P2)!.rejected).toBe('failure_counter_exhausted');
        expect(decision.selected).toBe(P1);
        expect(decision.level).toBe('L2');
    });
});

describe('choosing a replan boundary', () => {
    it('resumes at the nearest legal planner and discards everything below it', () => {
        const decision = selectBoundary(baseRun(), TOOL, POLICY);
        expect(decision.level).toBe('L1');
        expect(decision.selected).toBe(P2);
        // The closed set, and only the closed set: the boundary itself stays, because it is the
        // author being asked again and the replan attaches to it.
        expect(decision.shadowed.sort()).toEqual([TOOL, SIBLING, GRANDCHILD].sort());
        expect(decision.shadowed).not.toContain(P2);
    });

    it('prices every legal candidate and none of the rejected ones', () => {
        const decision = selectBoundary(baseRun(), TOOL, POLICY);
        expect(decision.candidates.map((entry) => entry.planner_vertex_id)).toEqual([P2, P1]);
        for (const candidate of decision.candidates) {
            // Exactly one of the two, never both: a rejected candidate took no part in the
            // comparison, so pricing it would suggest it had (03 §4.2).
            expect(Boolean(candidate.rejected) !== (candidate.cost !== undefined)).toBe(true);
        }
        // Compensation is absent rather than zero. Zero would claim the term was priced; in fact
        // no tool contract carries a cancel price, and a candidate needing one is rejected first.
        expect(decision.candidates[0]!.terms).not.toHaveProperty('compensation_cost');
        expect(decision.estimatedCost).toBe(decision.candidates.find((entry) => entry.planner_vertex_id === decision.selected)!.cost);
    });

    it('refuses every boundary below the backtrack floor', () => {
        // A pivot passed after both planners succeeded. Neither may be resumed at, and the reason
        // is planning authority rather than world state: a planner below the floor is handed a
        // context where the irreversible action has not happened, so proposing it again is legal.
        const events = [...baseRun(), event('txn/pivot-passed', {scope_id: SCOPE, payload: {}})];
        const decision = selectBoundary(events, TOOL, POLICY);
        expect(decision.candidates.map((entry) => entry.rejected)).toEqual(['below_floor', 'below_floor']);
        expect(decision.selected).toBeNull();
        expect(decision.level).toBe('L4');
    });

    it('refuses a boundary whose subtree still holds an open bracket', () => {
        // Compensation precedes backtracking (03 §2.4 rule 1). P2's subtree has a sealed try, so
        // resuming there would plan across an active one; P1 is above it and no better, because
        // the open scope is below P1 too.
        const events = [...baseRun(), event('txn/try', {scope_id: SCOPE, vertex_id: TOOL, payload: {}})];
        const scoped = events.map((entry) => (entry.event_type === 'vertex/created' && entry.vertex_id === TOOL ? {...entry, scope_id: SCOPE} : entry));
        const decision = selectBoundary(scoped, TOOL, POLICY);
        expect(decision.candidates.every((entry) => entry.rejected === 'open_bracket')).toBe(true);
        // Cancellable, because no pivot has passed — which is L3's precondition, not L4's.
        expect(decision.level).toBe('L3');
    });

    it('escalates past a planner that has already been the boundary too often', () => {
        const events = [
            ...baseRun(),
            event('replan/boundary', {vertex_id: P2, payload: {level: 'L1', reason: 'first', failed_vertex_id: TOOL, candidates: [], selected: P2}}),
            event('replan/boundary', {vertex_id: P2, payload: {level: 'L1', reason: 'second', failed_vertex_id: TOOL, candidates: [], selected: P2}}),
        ];
        // The episode cap would also stop this, so raise it to isolate the per-planner counter.
        const decision = selectBoundary(events, TOOL, {...POLICY, maxReplansPerEpisode: 9});
        expect(decision.candidates.find((entry) => entry.planner_vertex_id === P2)!.rejected).toBe('failure_counter_exhausted');
        // P1 is still legal, and using it is what makes this L2 rather than L1.
        expect(decision.selected).toBe(P1);
        expect(decision.level).toBe('L2');
    });

    it('stops a failure episode at the protocol bound, whichever planners it alternated between', () => {
        // The per-planner counter cannot see `P2 -> P1 -> P2`, which is the shortest lasso the S1
        // TLC model found. The episode cap is what closes it, and it is a protocol bound rather
        // than a budget heuristic (03 §3).
        const events = [
            ...baseRun(),
            event('replan/boundary', {vertex_id: P2, payload: {level: 'L1', reason: 'a', failed_vertex_id: TOOL, candidates: [], selected: P2}}),
            event('replan/boundary', {vertex_id: P1, payload: {level: 'L2', reason: 'b', failed_vertex_id: TOOL, candidates: [], selected: P1}}),
        ];
        const decision = selectBoundary(events, TOOL, POLICY);
        expect(decision.level).toBe('L3');
        expect(decision.selected).toBeNull();
        expect(replanHistory(events).episode).toBe(2);
    });

    it('does not count work a later replan discards as the episode ending', () => {
        // The reading a live run falsified. Each replan's subtree produced a passing tool call
        // before failing again, so a counter that reset on any success never fired and the run
        // replanned indefinitely. An episode ends when a replan *worked* — when some frozen
        // subgraph had every vertex in it succeed — and a partial success is not that.
        sequence = 0;
        const partial = id(10);
        const stillFailing = id(11);
        const events = [
            event('run/start', {payload: {}}),
            ...frozen('submitted', vertex(P1, 'planner', [])),
            ...ran(P1),
            ...frozen('submitted', vertex(TOOL, 'tool', [P1], 'first.tool')),
            failed(TOOL),
            event('replan/boundary', {vertex_id: P1, payload: {level: 'L1', reason: 'a', failed_vertex_id: TOOL, candidates: [], selected: P1}}),
            event('subgraph/shadowed', {payload: {vertex_ids: [TOOL], reason: 'a'}}),
            // The replanned subtree: one vertex passes, the other does not. The freeze is not
            // resolved, so the episode is still open.
            ...frozen('submitted', vertex(partial, 'tool', [P1], 'second.tool'), vertex(stillFailing, 'tool', [P1], 'third.tool')),
            ...ran(partial),
            failed(stillFailing),
            event('replan/boundary', {vertex_id: P1, payload: {level: 'L1', reason: 'b', failed_vertex_id: stillFailing, candidates: [], selected: P1}}),
        ];
        expect(replanHistory(events).episode).toBe(2);
        expect(selectBoundary(events, stillFailing, POLICY).level).toBe('L3');
    });

    it('rejects a candidate the remaining budget cannot pay for', () => {
        const decision = selectBoundary(baseRun(), TOOL, {...POLICY, budgetRemaining: 0});
        expect(decision.candidates.every((entry) => entry.rejected === 'budget_exceeded')).toBe(true);
        expect(decision.selected).toBeNull();
    });
});

describe('work a rule authored', () => {
    it('is recognised however deep the failure sits under the router', () => {
        expect(ruleAuthored(routedRun(), BRANCH)).toBe(true);
        expect(ruleAuthored(baseRun(), TOOL)).toBe(false);
    });

    it('does not extend to what a planner inside that branch went on to propose', () => {
        // The case a live run found, and the reason authorship is read rather than inferred. A
        // rule may emit a *planner*; everything that planner proposes is a model's work and is
        // perfectly replannable, by that planner. Walking ancestry cannot tell the two apart,
        // because the router is an ancestor of both, and the run stalled at L4 on work no rule
        // had ever seen.
        const routedPlanner = id(8);
        const itsWork = id(9);
        sequence = 0;
        const events = [
            event('run/start', {payload: {}}),
            ...frozen('submitted', vertex(P1, 'planner', [])),
            ...ran(P1),
            ...frozen('submitted', vertex(ROUTER, 'router', [P1])),
            event('vertex/started', {vertex_id: ROUTER, payload: {attempt: 1}}),
            ...frozen('router', vertex(routedPlanner, 'planner', [ROUTER])),
            event('vertex/succeeded', {vertex_id: ROUTER, payload: {attempts: 1, result: {}, matched_condition: 'always'}}),
            ...ran(routedPlanner),
            ...frozen('submitted', vertex(itsWork, 'tool', [routedPlanner], 'first.tool')),
            failed(itsWork),
        ];
        expect(ruleAuthored(events, routedPlanner)).toBe(true);
        expect(ruleAuthored(events, itsWork)).toBe(false);
        const decision = selectBoundary(events, itsWork, POLICY);
        expect(decision.level).toBe('L1');
        expect(decision.selected).toBe(routedPlanner);
    });

    it('never reaches a planner, whatever the boundary would have been', () => {
        // The ladder skips L1 and L2 outright (03 §2.5). A rule's branch has no author with the
        // standing to propose a replacement, and asking a model to invent one is exactly the
        // action the rule exists to prevent — note that P1 is a perfectly legal boundary here.
        const decision = selectBoundary(routedRun(), BRANCH, POLICY);
        expect(decision.level).toBe('L4');
        expect(decision.selected).toBeNull();
        expect(decision.candidates).toEqual([]);
        expect(decision.reason).toContain('a rule authored this work');
    });
});

describe('the events one replan appends', () => {
    it('records the decision before the discard it authorises', () => {
        const events = baseRun();
        const decision = selectBoundary(events, TOOL, POLICY);
        const drafts = replanEvents(decision, failureEvidence(events, TOOL, decision.shadowed));
        expect(drafts.map((draft) => draft.event_type)).toEqual(['replan/boundary', 'subgraph/shadowed']);
        // Both validate against the shared schema, which is what makes the payloads a contract
        // rather than a convention this one writer happens to follow.
        for (const draft of drafts) expect(() => assertEventDraft(draft)).not.toThrow();
        expect(drafts[1]!.payload).toMatchObject({boundary_vertex_id: P2, failed_vertex_id: TOOL});
    });

    it('appends no discard when nothing was selected', () => {
        const decision = selectBoundary(routedRun(), BRANCH, POLICY);
        const drafts = replanEvents(decision, failureEvidence(routedRun(), BRANCH, []));
        // An escalation records why it escalated and shadows nothing: the work is still there, and
        // the human or the Coordinator that picks it up needs to see it.
        expect(drafts.map((draft) => draft.event_type)).toEqual(['replan/boundary']);
        expect(drafts[0]!.payload).toMatchObject({level: 'L4', selected: null});
        expect(() => assertEventDraft(drafts[0]!)).not.toThrow();
    });

    it('carries evidence a planner can act on without being shown the discarded work', () => {
        const events = baseRun();
        const evidence = failureEvidence(events, TOOL, shadowSet(events, P2));
        expect(evidence).toMatchObject({failed_vertex_id: TOOL, tool: 'first.tool', error_class: 'permanent-failure', attempts: 3, discarded_vertices: 3});
    });

    it('does not discard the same vertex twice', () => {
        // A second replan's event must describe what *it* discarded. Re-listing the first
        // replan's vertices would make the console draw two replans over the same work and would
        // tell the database to dequeue rows that are already gone.
        const events = baseRun();
        const first = shadowSet(events, P2);
        const after = [...events, event('subgraph/shadowed', {payload: {vertex_ids: first, reason: 'first replan'}})];
        expect(shadowSet(after, P2)).toEqual([]);
    });
});
