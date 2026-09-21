import {describe, expect, it} from 'vitest';
import {advanceConsoleDag, consoleDag, emptyConsoleDag} from '../../../console/server/src/projection.js';
import type {ConsoleDagModel, ConsoleDelta} from '../../../console/server/src/model.js';
import {surface} from '../../src/projection.js';
import type {StoredEvent} from '../../src/events.js';

const run = '00000000-0000-4000-8000-000000000001';
const lookup = '00000000-0000-4000-8000-000000000010';
const router = '00000000-0000-4000-8000-000000000011';
const planner = '00000000-0000-4000-8000-000000000012';
const reserve = '00000000-0000-4000-8000-000000000013';
const scope = '00000000-0000-4000-8000-0000000000a0';

function event(run_seq: number, event_type: string, options: Partial<StoredEvent> = {}): StoredEvent {
    return {
        run_id: run,
        run_seq,
        global_seq: run_seq,
        event_type,
        vertex_id: null,
        parent_refs: [],
        planner_id: null,
        scope_id: null,
        pin_version: null,
        ignorable: false,
        inherited: false,
        payload: {},
        created_at: `2026-01-01T00:00:0${run_seq}.000Z`,
        ...options,
    };
}

/** A freeze and the vertices it committed, which always arrive in one transaction. */
function freeze(seq: number, entries: Array<{author_id: string; vertex_id: string; role: string}>, source = 'submitted'): StoredEvent[] {
    return [event(seq - 1, 'subgraph/proposed', {payload: {source}}), event(seq, 'subgraph/frozen', {payload: {proposed_seq: seq - 1, vertices: entries}})];
}

function byId(model: ConsoleDagModel, vertexId: string) {
    return model.vertices.find((vertex) => vertex.vertex_id === vertexId)!;
}

describe('the console fold', () => {
    it('refuses a stream it does not understand, and tolerates one marked ignorable', () => {
        expect(() => consoleDag([event(1, 'extension/future')])).toThrow('unknown non-ignorable event');
        expect(() => consoleDag([event(1, 'extension/future', {ignorable: true})])).not.toThrow();
    });

    it('retains a shadowed vertex that the planner surface deletes', () => {
        const events = [
            event(1, 'run/start'),
            ...freeze(3, [{author_id: 'lookup', vertex_id: lookup, role: 'tool'}]),
            event(4, 'vertex/created', {vertex_id: lookup, payload: {role: 'tool', tool: 'record.read'}}),
            event(5, 'subgraph/shadowed', {payload: {vertex_ids: [lookup], reason: 'replanned'}}),
        ];

        // The same log, read two ways. The disagreement is the whole reason both projections exist:
        // a prompt must not mention discarded work, and an operator is looking for it.
        expect(surface(events).vertices.has(lookup)).toBe(false);
        const model = consoleDag(events);
        expect(byId(model, lookup)).toMatchObject({is_shadowed: true, shadowed_at_seq: 5});
        expect(model.replans).toEqual([{at_run_seq: 5, vertex_ids: [lookup], boundary_seq: null, boundary_vertex_id: null, reason: 'replanned'}]);
    });

    it('shadows exactly the named vertices, never their descendants', () => {
        // The surface does not walk `parent_refs` either. The two must agree about membership and
        // disagree only about retention; shadowing more would draw a graph that never existed.
        const events = [
            ...freeze(2, [{author_id: 'lookup', vertex_id: lookup, role: 'tool'}]),
            event(3, 'vertex/created', {vertex_id: lookup, payload: {role: 'tool', tool: 'record.read'}}),
            event(4, 'vertex/created', {vertex_id: planner, parent_refs: [lookup], payload: {role: 'planner'}}),
            event(5, 'subgraph/shadowed', {payload: {vertex_ids: [lookup]}}),
        ];
        const model = consoleDag(events);
        expect(byId(model, lookup).is_shadowed).toBe(true);
        expect(byId(model, planner).is_shadowed).toBe(false);
    });

    it('derives timing from the recorded timestamps, across a retry', () => {
        const events = [
            ...freeze(2, [{author_id: 'lookup', vertex_id: lookup, role: 'tool'}]),
            event(3, 'vertex/created', {vertex_id: lookup, payload: {role: 'tool', tool: 'record.read'}}),
            event(4, 'vertex/started', {vertex_id: lookup}),
            event(5, 'vertex/retried', {vertex_id: lookup}),
            event(6, 'vertex/started', {vertex_id: lookup}),
            event(7, 'vertex/succeeded', {vertex_id: lookup, payload: {result: {}, log_fields: {status: 'ready'}}}),
        ];
        const timing = byId(consoleDag(events), lookup).timing;
        // started_at is the first attempt and duration spans them all; the last attempt is separate
        // so an operator can see the retry rather than only its total.
        expect(timing.started_at).toBe('2026-01-01T00:00:04.000Z');
        expect(timing.last_attempt_started_at).toBe('2026-01-01T00:00:06.000Z');
        expect(timing.duration_ms).toBe(3000);
        expect(byId(consoleDag(events), lookup).log_fields).toEqual({status: 'ready'});
    });

    it('leaves timing open while a vertex is still running', () => {
        const events = [
            ...freeze(2, [{author_id: 'lookup', vertex_id: lookup, role: 'tool'}]),
            event(3, 'vertex/created', {vertex_id: lookup, payload: {role: 'tool', tool: 'record.read'}}),
            event(4, 'vertex/started', {vertex_id: lookup}),
        ];
        expect(byId(consoleDag(events), lookup).timing).toMatchObject({completed_at: null, duration_ms: null});
    });

    it('derives the pivot from the effect class and reports a declaration that disagrees', () => {
        const events = [
            ...freeze(2, [{author_id: 'capture', vertex_id: reserve, role: 'tool'}]),
            event(3, 'vertex/created', {vertex_id: reserve, scope_id: scope, payload: {role: 'tool', tool: 'payment.capture', txn: {effect_class: 'irreversible'}}}),
            event(4, 'txn/scope', {scope_id: scope, payload: {state: 'open', pivot_vertex: planner}}),
        ];
        const model = consoleDag(events);
        expect(byId(model, reserve).txn).toMatchObject({is_pivot: true, effect_class: 'irreversible', scope_id: scope});
        // The declaration named a different vertex. Recorded as a disagreement, never adopted.
        expect(model.scopes[0]).toMatchObject({pivot_vertex_id: reserve, pivot_declaration_mismatch: true});
    });

    it('builds a scope from the column even when no txn/scope event named it', () => {
        // The transaction projection tables skip a counterfactual's inherited rows, so the column
        // is the only source that is right for every run.
        const events = [
            ...freeze(2, [{author_id: 'reserve', vertex_id: reserve, role: 'tool'}]),
            event(3, 'vertex/created', {vertex_id: reserve, scope_id: scope, payload: {role: 'tool', tool: 'inventory.reserve', txn: {effect_class: 'reversible'}}}),
        ];
        expect(consoleDag(events).scopes[0]).toMatchObject({scope_id: scope, member_vertex_ids: [reserve], state: 'open'});
    });

    it('tracks a bracket from sealed to confirmed', () => {
        const events = [
            ...freeze(2, [{author_id: 'reserve', vertex_id: reserve, role: 'tool'}]),
            event(3, 'vertex/created', {vertex_id: reserve, scope_id: scope, payload: {role: 'tool', tool: 'inventory.reserve', txn: {effect_class: 'reversible'}}}),
            event(4, 'txn/try', {vertex_id: reserve, scope_id: scope, payload: {idempotency_key: 'inventory.reserve:ORDER-1'}}),
            event(5, 'txn/confirm', {vertex_id: reserve, scope_id: scope, payload: {idempotency_key: 'inventory.reserve:ORDER-1'}}),
        ];
        expect(byId(consoleDag(events), reserve).bracket).toMatchObject({state: 'confirmed', idempotency_key: 'inventory.reserve:ORDER-1'});
    });

    it('reports every router outcome the executor can record', () => {
        const base = [
            ...freeze(2, [{author_id: 'decide#router', vertex_id: router, role: 'router'}]),
            event(3, 'vertex/created', {vertex_id: router, payload: {role: 'router', origin: 'interposed'}}),
        ];
        const outcomeOf = (terminal: StoredEvent) => byId(consoleDag([...base, terminal]), router).router_outcome;

        expect(outcomeOf(event(4, 'vertex/succeeded', {vertex_id: router, payload: {matched_condition: 'a.output.b == 1', branch: 0}}))).toEqual({
            kind: 'matched',
            matched_condition: 'a.output.b == 1',
            branch: 0,
        });
        expect(outcomeOf(event(4, 'vertex/succeeded', {vertex_id: router, payload: {matched_condition: null}}))).toEqual({kind: 'fell_through'});
        expect(outcomeOf(event(4, 'vertex/failed', {vertex_id: router, payload: {outcome: 'evaluation_error', reason: 'no field'}}))).toEqual({kind: 'evaluation_error', reason: 'no field'});
        expect(outcomeOf(event(4, 'vertex/failed', {vertex_id: router, payload: {outcome: 'proposal_rejected', violations: [{rule: 'R12'}]}}))).toMatchObject({kind: 'proposal_rejected'});
        expect(byId(consoleDag(base), router).router_outcome).toEqual({kind: 'pending'});
    });

    it('says whether a rule or a planner decided a vertex exists', () => {
        const events = [
            ...freeze(2, [{author_id: 'decide', vertex_id: planner, role: 'planner'}]),
            event(3, 'vertex/created', {vertex_id: planner, payload: {role: 'planner'}}),
            ...freeze(5, [{author_id: 'negotiate', vertex_id: lookup, role: 'planner'}], 'router'),
            event(6, 'vertex/created', {vertex_id: lookup, parent_refs: [router], payload: {role: 'planner'}}),
        ];
        const model = consoleDag(events);
        expect(byId(model, planner).decided_by).toBe('planner');
        // The branch a rule emitted must not read as a model's choice; that distinction is the
        // entire point of a deterministic router.
        expect(byId(model, lookup).decided_by).toBe('router');
    });

    it('accumulates model spend and attaches each call to its planner', () => {
        const events = [
            ...freeze(2, [{author_id: 'decide', vertex_id: planner, role: 'planner'}]),
            event(3, 'vertex/created', {vertex_id: planner, payload: {role: 'planner'}}),
            event(4, 'budget/charged', {
                vertex_id: planner,
                payload: {category: 'llm', response_model: 'deepseek-chat', duration_ms: 900, usage: {input_tokens: 2000, output_tokens: 100}, estimated_cost: {amount: 0.002, currency: 'USD'}},
            }),
        ];
        const model = consoleDag(events);
        expect(byId(model, planner).cost).toMatchObject({model: 'deepseek-chat', input_tokens: 2000, amount: 0.002});
        expect(model.spend).toMatchObject({calls: 1, input_tokens: 2000, output_tokens: 100, amount: 0.002, currency: 'USD'});
    });

    it('labels a vertex with the name its author chose', () => {
        const events = [...freeze(2, [{author_id: 'lookup', vertex_id: lookup, role: 'tool'}]), event(3, 'vertex/created', {vertex_id: lookup, payload: {role: 'tool', tool: 'record.read'}})];
        expect(byId(consoleDag(events), lookup).label).toBe('lookup');
    });

    it('records a refusal, which is otherwise invisible: a rejected proposal freezes nothing', () => {
        const events = [
            event(1, 'subgraph/proposed', {payload: {source: 'submitted'}}),
            event(2, 'subgraph/rejected', {payload: {proposed_seq: 1, stage: 'admission', violations: [{rule: 'R12', message: 'fresh scope'}]}}),
        ];
        const model = consoleDag(events);
        expect(model.vertices).toEqual([]);
        expect(model.proposals[0]).toMatchObject({outcome: 'rejected', stage: 'admission'});
    });

    it('marks a counterfactual as one, rather than handing the client a sequence number', () => {
        expect(consoleDag([event(1, 'run/start')]).kind).toBe('production');
        expect(consoleDag([event(1, 'run/start'), event(2, 'run/end-seed', {payload: {source_run_id: run, eval_up_to_seq: 1}})]).kind).toBe('counterfactual');
    });
});

describe('folding incrementally equals folding at once', () => {
    /** A run that exercises every branch of the fold. */
    const events: StoredEvent[] = [
        event(1, 'run/start'),
        ...freeze(3, [
            {author_id: 'lookup', vertex_id: lookup, role: 'tool'},
            {author_id: 'decide#router', vertex_id: router, role: 'router'},
            {author_id: 'decide', vertex_id: planner, role: 'planner'},
        ]),
        event(4, 'vertex/created', {vertex_id: lookup, payload: {role: 'tool', tool: 'record.read'}}),
        event(5, 'vertex/created', {vertex_id: router, parent_refs: [lookup], payload: {role: 'router', origin: 'interposed'}}),
        event(6, 'vertex/created', {vertex_id: planner, parent_refs: [router], payload: {role: 'planner'}}),
        event(7, 'vertex/started', {vertex_id: lookup}),
        event(8, 'vertex/succeeded', {vertex_id: lookup, payload: {result: {}, log_fields: {status: 'shipped'}}}),
        event(9, 'vertex/started', {vertex_id: router}),
        event(10, 'vertex/succeeded', {vertex_id: router, payload: {matched_condition: 'record.read.output.status == "shipped"', branch: 0}}),
        event(11, 'vertex/started', {vertex_id: planner}),
        event(12, 'budget/charged', {vertex_id: planner, payload: {category: 'llm', response_model: 'm', duration_ms: 10, usage: {input_tokens: 1, output_tokens: 2}}}),
        event(13, 'vertex/succeeded', {vertex_id: planner, payload: {result: {}}}),
        ...freeze(15, [{author_id: 'reserve', vertex_id: reserve, role: 'tool'}]),
        event(16, 'vertex/created', {vertex_id: reserve, scope_id: scope, parent_refs: [planner], payload: {role: 'tool', tool: 'inventory.reserve', txn: {effect_class: 'reversible'}}}),
        event(17, 'txn/scope', {scope_id: scope, payload: {state: 'open'}}),
        event(18, 'txn/try', {vertex_id: reserve, scope_id: scope, payload: {idempotency_key: 'k'}}),
        event(19, 'txn/pivot-passed', {vertex_id: reserve, scope_id: scope}),
        event(20, 'txn/confirm', {vertex_id: reserve, scope_id: scope, payload: {idempotency_key: 'k'}}),
        event(21, 'txn/scope', {scope_id: scope, payload: {state: 'committed'}}),
    ];

    it('reaches the same model however the stream is split', () => {
        // This is the reconnect guarantee, asserted at the projection layer: a client that resumed
        // mid-run and one that connected fresh must hold the same model. Proving it here, over
        // every split point, is why the snapshot and the deltas come from one code path.
        const whole = consoleDag(events);
        for (let split = 0; split <= events.length; split += 1) {
            const partial = advanceConsoleDag(emptyConsoleDag(run), events.slice(0, split)).model;
            const resumed = advanceConsoleDag(partial, events.slice(split)).model;
            expect(resumed).toEqual(whole);
        }
    });

    it('never emits a cursor below the watermark, however a batch is cut', () => {
        // The failure this guards against was found by the first real run, not by a unit test.
        // A freeze's own `run_seq` sits below the `vertex/created` rows it committed with, so an
        // append fenced at the freeze runs backwards as soon as a reader splits the two — which a
        // poll boundary or a read limit does, since atomicity only stops a partial commit being
        // visible. A subscriber fences on the cursor, discards the append as already seen, and
        // loses every vertex in it; the next patch then names a vertex it never received and it
        // resyncs forever.
        //
        // Asserted over every cut, because which cut is the fatal one is exactly what the
        // original reasoning got wrong.
        for (let split = 1; split < events.length; split += 1) {
            let model = emptyConsoleDag(run);
            let cursor = {seq: 0, ordinal: -1};
            for (const batch of [events.slice(0, split), events.slice(split)]) {
                const step = advanceConsoleDag(model, batch);
                model = step.model;
                for (const delta of step.deltas) {
                    expect(delta.at_run_seq > cursor.seq || (delta.at_run_seq === cursor.seq && delta.ordinal > cursor.ordinal)).toBe(true);
                    // And the cursor never runs past the model it describes, or a subscriber
                    // would fence out state the server has not sent yet.
                    expect(delta.at_run_seq).toBeLessThanOrEqual(model.at_run_seq);
                    cursor = {seq: delta.at_run_seq, ordinal: delta.ordinal};
                }
            }
        }
    });

    it('emits deltas that rebuild the same model as a snapshot would', () => {
        // Deliberately a test-local applier: a production one on the server would be the second
        // folder this design exists to prevent.
        const applyDelta = (model: ConsoleDagModel, delta: ConsoleDelta): ConsoleDagModel => {
            if (delta.type === 'subgraph_appended') {
                const scopes = [...model.scopes.filter((scope) => !delta.scopes.some((added) => added.scope_id === scope.scope_id)), ...delta.scopes];
                return {...model, vertices: [...model.vertices, ...delta.vertices], scopes};
            }
            if (delta.type === 'subgraph_shadowed') {
                return {
                    ...model,
                    vertices: model.vertices.map((vertex) => (delta.replan.vertex_ids.includes(vertex.vertex_id) ? {...vertex, is_shadowed: true, shadowed_at_seq: delta.replan.at_run_seq} : vertex)),
                };
            }
            return {...model, vertices: model.vertices.map((vertex) => (vertex.vertex_id === delta.vertex.vertex_id ? delta.vertex : vertex))};
        };

        let applied = emptyConsoleDag(run);
        let folded = emptyConsoleDag(run);
        for (const single of events) {
            const step = advanceConsoleDag(folded, [single]);
            folded = step.model;
            for (const delta of step.deltas) applied = applyDelta(applied, delta);
        }
        const sortedIds = (model: ConsoleDagModel) => model.vertices.map((vertex) => vertex.vertex_id).sort();
        expect(sortedIds(applied)).toEqual(sortedIds(consoleDag(events)));
        for (const vertex of consoleDag(events).vertices) {
            expect(applied.vertices.find((candidate) => candidate.vertex_id === vertex.vertex_id)).toEqual(vertex);
        }
    });

    it('folds to the same boundary the surface does', () => {
        for (let boundary = 1; boundary <= events.length; boundary += 1) {
            expect(consoleDag(events, boundary).at_run_seq).toBe(surface(events, boundary).at_run_seq);
        }
    });
});
