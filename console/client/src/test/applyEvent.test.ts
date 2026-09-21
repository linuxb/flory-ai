import {describe, expect, it} from 'vitest';
import {applyEvent, clientModel, type ClientModel} from '../stream/applyEvent.js';
import type {ConsoleScope, ConsoleStreamEvent} from '../engine.js';
import {model, SPEND, vertex} from './fixtures.js';

const scope: ConsoleScope = {
    scope_id: 's1',
    state: 'open',
    member_vertex_ids: ['b'],
    pivot_vertex_id: null,
    pivot_passed_seq: null,
    pivot_declaration_mismatch: false,
    opened_seq: 2,
    closed_seq: null,
};

function snapshot(atRunSeq = 1): ConsoleStreamEvent {
    return {type: 'topology_snapshot', at_run_seq: atRunSeq, ordinal: 0, model: model([vertex('a', {created_seq: 1})], {at_run_seq: atRunSeq})};
}

function applied(outcome: ReturnType<typeof applyEvent>): ClientModel {
    if (outcome.kind !== 'applied') throw new Error(`expected applied, got ${outcome.kind}`);
    return outcome.next;
}

describe('applying a stream event', () => {
    it('replaces the whole model on a snapshot', () => {
        const first = applied(applyEvent(null, snapshot(1)));
        const second = applied(applyEvent(first, {type: 'topology_snapshot', at_run_seq: 9, ordinal: 0, model: model([vertex('z', {created_seq: 9})], {at_run_seq: 9})}));
        // Replaced, not merged: the server's snapshot is the state, and merging would be folding.
        expect(second.model.vertices.map((entry) => entry.vertex_id)).toEqual(['z']);
        expect(second.model.at_run_seq).toBe(9);
    });

    it('inserts exactly the vertices and scopes an append carried', () => {
        const base = applied(applyEvent(null, snapshot(1)));
        const next = applied(
            applyEvent(base, {type: 'subgraph_appended', at_run_seq: 4, ordinal: 0, spend: SPEND, vertices: [vertex('b', {created_seq: 4, depth: 1, parent_refs: ['a']})], scopes: [scope]}),
        );
        expect(next.model.vertices.map((entry) => entry.vertex_id)).toEqual(['a', 'b']);
        expect(next.model.scopes.map((entry) => entry.scope_id)).toEqual(['s1']);
        // The watermark moves with the state it describes, in one construction.
        expect(next.model.at_run_seq).toBe(4);
    });

    it('takes the run rollup from the envelope rather than summing it', () => {
        // A client that may not recompute a rollup has no other way to keep one current, so the
        // envelope carries it. Without this the header shows whatever the first snapshot held and
        // is wrong for the rest of the run.
        const base = applied(applyEvent(null, snapshot(1)));
        const spent = {calls: 3, input_tokens: 900, output_tokens: 120, amount: null, currency: null};
        const next = applied(applyEvent(base, {type: 'vertex_patched', at_run_seq: 7, ordinal: 0, spend: spent, vertex: vertex('a', {status: 'succeeded'})}));
        expect(next.model.spend).toEqual(spent);
    });

    it('shadows exactly the ids named and no descendant', () => {
        const base = applied(applyEvent(null, snapshot(1)));
        const grown = applied(applyEvent(base, {type: 'subgraph_appended', at_run_seq: 4, ordinal: 0, spend: SPEND, vertices: [vertex('b', {created_seq: 4, parent_refs: ['a']})], scopes: []}));
        const next = applied(
            applyEvent(grown, {
                type: 'subgraph_shadowed',
                at_run_seq: 5,
                ordinal: 0,
                spend: SPEND,
                replan: {at_run_seq: 5, vertex_ids: ['a'], boundary_seq: null, boundary_vertex_id: null, reason: null},
            }),
        );
        expect(next.byId.get('a')).toMatchObject({is_shadowed: true, shadowed_at_seq: 5});
        // `b` descends from `a` and is untouched: walking edges to find descendants would be
        // shadow tracking in the browser, which is the one thing this file may not do.
        expect(next.byId.get('b')!.is_shadowed).toBe(false);
    });

    it('swaps in the replacement vertex a patch carried', () => {
        const base = applied(applyEvent(null, snapshot(1)));
        const patched = vertex('a', {created_seq: 1, status: 'succeeded', timing: {started_at: 't0', last_attempt_started_at: 't0', completed_at: 't1', duration_ms: 12, attempts: 1}});
        const next = applied(applyEvent(base, {type: 'vertex_patched', at_run_seq: 6, ordinal: 0, spend: SPEND, vertex: patched}));
        expect(next.byId.get('a')).toEqual(patched);
    });

    it('ignores what it has already seen, because a resume redelivers', () => {
        const base = applied(applyEvent(null, snapshot(5)));
        expect(applyEvent(base, {type: 'vertex_patched', at_run_seq: 5, ordinal: 0, spend: SPEND, vertex: vertex('a')})).toEqual({kind: 'ignored', reason: 'behind-watermark'});
        expect(applyEvent(base, {type: 'vertex_patched', at_run_seq: 3, ordinal: 0, spend: SPEND, vertex: vertex('a')})).toEqual({kind: 'ignored', reason: 'behind-watermark'});
    });

    it('applies every delta of one batch, which share a sequence and differ only in ordinal', () => {
        // One committed batch produces several deltas, all fenced at that batch's watermark and
        // told apart by their ordinal — which is what the cursor `<run_seq>.<ordinal>` says. A
        // client fencing on the sequence alone applies the first and silently drops the rest,
        // and then resyncs forever on the first patch naming a vertex it never received.
        const base = applied(applyEvent(null, snapshot(1)));
        const first = applied(applyEvent(base, {type: 'subgraph_appended', at_run_seq: 6, ordinal: 0, spend: SPEND, vertices: [vertex('b', {created_seq: 4, parent_refs: ['a']})], scopes: []}));
        const second = applied(applyEvent(first, {type: 'subgraph_appended', at_run_seq: 6, ordinal: 1, spend: SPEND, vertices: [vertex('c', {created_seq: 5, parent_refs: ['a']})], scopes: []}));
        expect(second.model.vertices.map((entry) => entry.vertex_id)).toEqual(['a', 'b', 'c']);
        // And the one genuinely redelivered by a resume is still refused.
        expect(applyEvent(second, {type: 'vertex_patched', at_run_seq: 6, ordinal: 1, spend: SPEND, vertex: vertex('a')})).toEqual({kind: 'ignored', reason: 'behind-watermark'});
    });

    it('resyncs rather than guessing, in every case it cannot answer', () => {
        const base = applied(applyEvent(null, snapshot(1)));
        // A delta with no snapshot before it.
        expect(applyEvent(null, {type: 'vertex_patched', at_run_seq: 2, ordinal: 0, spend: SPEND, vertex: vertex('a')})).toMatchObject({kind: 'resync', reason: 'delta-before-snapshot'});
        // A patch or a shadow for a vertex this client has never heard of. Creating it here would
        // be inventing state the server did not send.
        expect(applyEvent(base, {type: 'vertex_patched', at_run_seq: 2, ordinal: 0, spend: SPEND, vertex: vertex('ghost')})).toMatchObject({kind: 'resync', reason: 'unknown-vertex'});
        expect(
            applyEvent(base, {
                type: 'subgraph_shadowed',
                at_run_seq: 2,
                ordinal: 0,
                spend: SPEND,
                replan: {at_run_seq: 2, vertex_ids: ['ghost'], boundary_seq: null, boundary_vertex_id: null, reason: null},
            }),
        ).toMatchObject({kind: 'resync', reason: 'unknown-vertex'});
        // A type this build does not know: the server understands something this client does not.
        expect(applyEvent(base, {type: 'invented', at_run_seq: 2, ordinal: 0} as unknown as ConsoleStreamEvent)).toMatchObject({kind: 'resync', reason: 'unknown-event-type'});
    });

    it('reaches the same state whether it resumed or reconnected fresh', () => {
        const stream: ConsoleStreamEvent[] = [
            snapshot(1),
            {type: 'subgraph_appended', at_run_seq: 4, ordinal: 0, spend: SPEND, vertices: [vertex('b', {created_seq: 4, depth: 1, parent_refs: ['a']})], scopes: [scope]},
            {type: 'vertex_patched', at_run_seq: 5, ordinal: 0, spend: SPEND, vertex: vertex('b', {created_seq: 4, depth: 1, parent_refs: ['a'], status: 'started'})},
            {type: 'subgraph_appended', at_run_seq: 7, ordinal: 0, spend: SPEND, vertices: [vertex('c', {created_seq: 7, depth: 2, parent_refs: ['b']})], scopes: []},
            {type: 'vertex_patched', at_run_seq: 8, ordinal: 0, spend: SPEND, vertex: vertex('c', {created_seq: 7, depth: 2, parent_refs: ['b'], status: 'succeeded'})},
        ];
        const straight = stream.reduce<ClientModel | null>((current, event) => applied(applyEvent(current, event)), null)!;

        // A client killed at any point and handed a snapshot of where the run then stood, followed
        // by the rest of the stream, must land exactly where one that never disconnected did.
        for (let cut = 1; cut < stream.length; cut += 1) {
            const before = stream.slice(0, cut).reduce<ClientModel | null>((current, event) => applied(applyEvent(current, event)), null)!;
            const resnapshot: ConsoleStreamEvent = {type: 'topology_snapshot', at_run_seq: before.model.at_run_seq, ordinal: 0, model: before.model};
            const resumed = stream.slice(cut).reduce<ClientModel>(
                (current, event) => {
                    const outcome = applyEvent(current, event);
                    return outcome.kind === 'applied' ? outcome.next : current;
                },
                applied(applyEvent(null, resnapshot)),
            );
            expect(resumed.model).toEqual(straight.model);
        }
    });
});
