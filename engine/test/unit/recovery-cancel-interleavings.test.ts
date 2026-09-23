import {describe, expect, it} from 'vitest';
import {outstanding} from '../../src/recovery.js';
import {cancelRequestDiscipline} from '../../src/harness/oracles.js';
import type {StoredEvent} from '../../src/log/events.js';
import {explore, ladder, legacyLadder, type DbScope, type ModelState} from './support/cancellation-model.js';
import {id, POLICY, RecoveryLog} from './support/recovery-log.js';

/**
 * Every order in which the recovery ladder and the Coordinator can act on a failing run.
 *
 * The two used to decide independently when to act, and the defects were both orderings: the ladder
 * reading before a cancellation began, and reading in the middle of one. Testing a handful of
 * chosen orders is how those shipped, so this enumerates all of them. Each topology below is run
 * under every combination of the things that change a cancellation's course — a sibling still
 * holding its lease, an attempt whose outcome is unknown, an inverse call that fails, an orphan
 * sweep racing the Engine's request — and the explorer visits every interleaving of both parties'
 * steps from each starting point.
 *
 * Safety is checked at every visited state; liveness — every failure answered exactly once, with
 * the answer the topology calls for — at every state where neither party has anything left to do.
 * The same explorer run with the old ladder must find both old defects, or the oracles are not
 * proving anything.
 */

const P1 = id(1);
const P2 = id(2);
const HOLD = id(3);
const TOOL = id(4);
const SIB = id(5);
const EARLY = id(6);
const HOLD2 = id(7);
const PIVOT = id(8);
const ROUTER = id(9);
const S = id(90);
const S2 = id(91);

type Topology = 'single' | 'sibling-scope' | 'savepoint' | 'rule' | 'post-pivot' | 'pivot-inflight';

interface Config {
    topology: Topology;
    siblingLease: boolean;
    unresolved: boolean;
    inverseFailure: 'none' | 'first' | 'second';
    expiredTry: boolean;
}

function scope(id: string, overrides: Partial<DbScope> = {}): DbScope {
    return {id, state: 'open', fenced: false, request: null, inverses: 0, inversesDone: 0, inverseFailsAt: null, lease: null, unresolved: false, expired: false, pivot: null, ...overrides};
}

/** The failing scope's row, varied by the configuration. */
function failing(config: Config, inverses: number): DbScope {
    return scope(S, {
        fenced: true,
        inverses,
        inverseFailsAt: config.inverseFailure === 'first' ? 0 : config.inverseFailure === 'second' ? 1 : null,
        lease: config.siblingLease ? SIB : null,
        unresolved: config.unresolved,
        expired: config.expiredTry,
    });
}

/** TOOL fails inside S; the outcome is unknown when the configuration says an attempt is unresolved. */
function failTool(log: RecoveryLog, config: Config): void {
    if (config.siblingLease) log.push('vertex/started', {vertex_id: SIB, scope_id: S, payload: {attempt: 1}});
    log.fail(TOOL, S, config.unresolved ? 'unknown' : 'permanent-failure');
}

function planners(log: RecoveryLog): RecoveryLog {
    return log
        .start()
        .freeze('submitted', [{id: P1, role: 'planner'}])
        .succeed(P1)
        .freeze('submitted', [{id: P2, role: 'planner', parents: [P1]}])
        .succeed(P2);
}

const withSibling = (config: Config, parent: string) => (config.siblingLease ? [{id: SIB, role: 'tool', parents: [parent], scope: S}] : []);

function initial(config: Config): ModelState {
    const log = new RecoveryLog();
    switch (config.topology) {
        case 'single':
            planners(log).freeze('submitted', [{id: HOLD, role: 'tool', parents: [P2], scope: S}, {id: TOOL, role: 'tool', parents: [P2], scope: S}, ...withSibling(config, P2)]);
            log.open(S).seal(HOLD, S);
            failTool(log, config);
            return {log, scopes: [failing(config, 1)], refused: null};
        case 'sibling-scope':
            planners(log).freeze('submitted', [
                {id: HOLD2, role: 'tool', parents: [P2], scope: S2},
                {id: HOLD, role: 'tool', parents: [P2], scope: S},
                {id: TOOL, role: 'tool', parents: [P2], scope: S},
                ...withSibling(config, P2),
            ]);
            log.open(S2).seal(HOLD2, S2).open(S).seal(HOLD, S);
            failTool(log, config);
            return {log, scopes: [scope(S2, {inverses: 1}), failing(config, 1)], refused: null};
        case 'savepoint':
            // S was opened by work P1 froze; P2 froze into it afterwards.
            log.start()
                .freeze('submitted', [{id: P1, role: 'planner'}])
                .succeed(P1);
            log.freeze('submitted', [
                {id: EARLY, role: 'tool', parents: [P1], scope: S},
                {id: P2, role: 'planner', parents: [P1]},
            ]);
            log.open(S).seal(EARLY, S).succeed(P2);
            log.freeze('submitted', [{id: TOOL, role: 'tool', parents: [P2], scope: S}, ...withSibling(config, P2)]);
            failTool(log, config);
            return {log, scopes: [failing(config, 1)], refused: null};
        case 'rule':
            log.start()
                .freeze('submitted', [{id: P1, role: 'planner'}])
                .succeed(P1)
                .freeze('submitted', [{id: ROUTER, role: 'router', parents: [P1]}]);
            log.push('vertex/started', {vertex_id: ROUTER, payload: {attempt: 1}});
            log.freeze('router', [{id: HOLD, role: 'tool', parents: [ROUTER], scope: S}, {id: TOOL, role: 'tool', parents: [ROUTER], scope: S}, ...withSibling(config, ROUTER)]);
            log.push('vertex/succeeded', {vertex_id: ROUTER, payload: {attempts: 1, result: {}}});
            log.open(S).seal(HOLD, S);
            failTool(log, config);
            return {log, scopes: [failing(config, 1)], refused: null};
        case 'post-pivot':
            planners(log).freeze('submitted', [
                {id: PIVOT, role: 'tool', parents: [P2], scope: S},
                {id: TOOL, role: 'tool', parents: [PIVOT], scope: S},
            ]);
            log.open(S).pivotStarted(PIVOT, S).pivotPassed(PIVOT, S).fail(TOOL, S);
            return {log, scopes: [scope(S, {state: 'pivot-passed', pivot: PIVOT})], refused: null};
        case 'pivot-inflight':
            planners(log).freeze('submitted', [
                {id: PIVOT, role: 'tool', parents: [P2], scope: S2},
                {id: HOLD, role: 'tool', parents: [P2], scope: S},
                {id: TOOL, role: 'tool', parents: [P2], scope: S},
                ...withSibling(config, P2),
            ]);
            log.open(S2).pivotStarted(PIVOT, S2).open(S).seal(HOLD, S);
            failTool(log, config);
            return {log, scopes: [scope(S2, {state: 'pivot-inflight', pivot: PIVOT}), failing(config, 1)], refused: null};
    }
}

function configurations(): Config[] {
    const all: Config[] = [];
    for (const topology of ['single', 'sibling-scope', 'savepoint', 'rule', 'post-pivot', 'pivot-inflight'] as const) {
        for (const siblingLease of [false, true]) {
            for (const unresolved of [false, true]) {
                for (const inverseFailure of ['none', 'first', 'second'] as const) {
                    for (const expiredTry of [false, true]) {
                        // After the pivot none of these can arise: the scope neither fences nor cancels.
                        if (topology === 'post-pivot' && (siblingLease || unresolved || inverseFailure !== 'none' || expiredTry)) continue;
                        all.push({topology, siblingLease, unresolved, inverseFailure, expiredTry});
                    }
                }
            }
        }
    }
    return all;
}

const boundaries = (events: readonly StoredEvent[]) => events.filter((event) => event.event_type === 'replan/boundary');
const answerFor = (events: readonly StoredEvent[], failed: string) => boundaries(events).find((event) => event.payload.failed_vertex_id === failed);
const count = (events: readonly StoredEvent[], type: string) => events.filter((event) => event.event_type === type).length;

/** What every quiet state must show, whatever the topology. */
function assertQuiescent(state: ModelState, config: Config): void {
    const events = state.log.events;
    const label = JSON.stringify(config);
    // Every failure answered: nothing is left outstanding, and nothing is waiting forever.
    expect(outstanding(events), label).toEqual([]);
    expect(cancelRequestDiscipline(events, {final: true}), label).toMatchObject({passed: true});
    // A scope the ladder stopped is never left stopped.
    for (const row of state.scopes) expect(row.fenced && row.state === 'open', `${label} ${row.id} left fenced`).toBe(false);

    const suspended = state.scopes.some((row) => row.state === 'suspended');
    const answer = answerFor(events, TOOL)!;
    const request = events.find((event) => event.event_type === 'replan/cancel-requested');
    switch (config.topology) {
        case 'single':
            if (suspended) expect(answer.payload, label).toMatchObject({level: 'L4', selected: null});
            else expect(answer.payload, label).toMatchObject({level: 'L1', selected: P2, cancelled_scopes: [S]});
            break;
        case 'sibling-scope':
            if (suspended) expect(answer.payload, label).toMatchObject({level: 'L4', selected: null});
            else expect(answer.payload, label).toMatchObject({level: 'L1', selected: P2, cancelled_scopes: [S, S2].sort()});
            break;
        case 'savepoint': {
            if (suspended) {
                expect(answer.payload, label).toMatchObject({level: 'L4', selected: null});
                break;
            }
            expect(answer.payload, label).toMatchObject({level: 'L2', selected: P1, cancelled_scopes: [S]});
            const atP2 = (answer.payload.candidates as {planner_vertex_id: string; rejected?: string}[]).find((entry) => entry.planner_vertex_id === P2);
            expect(atP2?.rejected, label).toBe('savepoint_precedes');
            break;
        }
        case 'rule':
            // No planner, ever: the ladder cancels the rule's scope and hands the run to a person.
            expect(answer.payload, label).toMatchObject({level: 'L4', selected: null});
            expect(
                boundaries(events).every((event) => event.payload.selected === null),
                label,
            ).toBe(true);
            if (!suspended) expect(answer.payload.cancelled_scopes, label).toEqual([S]);
            break;
        case 'post-pivot':
            expect(answer.payload, label).toMatchObject({level: 'L4', selected: null});
            expect(count(events, 'replan/cancel-requested'), label).toBe(0);
            expect(count(events, 'txn/cancel'), label).toBe(0);
            break;
        case 'pivot-inflight':
            // The discard set holds an in-flight pivot, which nothing can cancel: no replan.
            expect(
                boundaries(events).every((event) => event.payload.selected === null),
                label,
            ).toBe(true);
            break;
    }
    // Where a request preceded a replan, the log shows the comparison both ways.
    if (request && answer.payload.selected) {
        const before = (request.payload.candidates as {planner_vertex_id: string; requires_cancel?: string[]}[]).find(
            (entry) => entry.planner_vertex_id === request.payload.intended_boundary_vertex_id,
        );
        const after = (answer.payload.candidates as {planner_vertex_id: string; requires_cancel?: string[]}[]).find((entry) => entry.planner_vertex_id === answer.payload.selected);
        expect(before?.requires_cancel?.length, label).toBeGreaterThan(0);
        expect(after?.requires_cancel, label).toBeUndefined();
    }
}

describe('every interleaving of the ladder and the Coordinator', () => {
    const configs = configurations();

    it.each(
        configs.map((config) => [`${config.topology} lease=${config.siblingLease} unresolved=${config.unresolved} inverse=${config.inverseFailure} expired=${config.expiredTry}`, config] as const),
    )('%s', (_name, config) => {
        const result = explore(initial(config), ladder(POLICY));
        expect(result.violations.slice(0, 3), JSON.stringify(result.violations.slice(0, 3), null, 1)).toEqual([]);
        expect(result.terminals.length).toBeGreaterThan(0);
        for (const terminal of result.terminals) assertQuiescent(terminal, config);
    });

    it('explores enough to mean something', () => {
        // A floor rather than an exact figure: the count moves whenever a step is added, and what
        // matters is that the search is not trivially small and that every kind of step was taken.
        let states = 0;
        const labels = new Set<string>();
        for (const config of configs) {
            const result = explore(initial(config), ladder(POLICY));
            states += result.states;
            for (const label of result.labels) labels.add(label);
        }
        expect(states).toBeGreaterThan(2_000);
        for (const step of ['pickup', 'sweep', 'inverse', 'complete', 'sibling', 'pivot', 'commit', 'engine replan/cancel-requested', 'engine replan/boundary']) {
            expect(
                [...labels].some((label) => label.startsWith(step)),
                step,
            ).toBe(true);
        }
    });
});

describe('the same exploration against the old ladder', () => {
    it('finds both old defects, so the oracles can fail', () => {
        const config: Config = {topology: 'single', siblingLease: false, unresolved: false, inverseFailure: 'none', expiredTry: false};
        const result = explore(initial(config), legacyLadder());
        const details = result.violations.flatMap((violation) => violation.results.map((entry) => `${entry.name}: ${entry.detail}`));
        // Window 1: escalating on a scope a cancellation was about to release.
        expect(
            details.some((detail) => detail.includes('unreleased')),
            details.join('\n'),
        ).toBe(true);
        // Window 2: replanning across a cancellation that had only been requested.
        expect(
            details.some((detail) => detail.includes('had not closed')),
            details.join('\n'),
        ).toBe(true);
    });
});
