import {describe, expect, it} from 'vitest';
import type {StoredEvent} from '../../src/events.js';
import {causalDescendants, computeForkSlice} from '../../src/store.js';

const PLANNER = '00000000-0000-4000-8000-000000000001';
const TOOL = '00000000-0000-4000-8000-000000000002';
const GRANDCHILD = '00000000-0000-4000-8000-000000000003';
const SIBLING = '00000000-0000-4000-8000-000000000004';

function event(streamSeq: number, eventType: string, options: Partial<StoredEvent> = {}): StoredEvent {
    return {
        run_id: 'run-1',
        stream_seq: streamSeq,
        global_seq: streamSeq,
        event_type: eventType,
        vertex_id: null,
        parent_refs: [],
        planner_id: null,
        scope_id: null,
        pin_version: null,
        ignorable: false,
        inherited: false,
        payload: {},
        created_at: '2026-08-24T00:00:00.000Z',
        ...options,
    };
}

const stream: StoredEvent[] = [
    event(1, 'run/start'),
    event(2, 'vertex/created', {vertex_id: PLANNER, pin_version: 'model://planner@v1'}),
    event(3, 'vertex/succeeded', {vertex_id: PLANNER}),
    event(4, 'vertex/created', {vertex_id: TOOL, parent_refs: [PLANNER], pin_version: 'tool://check@v1'}),
    event(5, 'vertex/created', {vertex_id: SIBLING}),
    event(6, 'vertex/succeeded', {vertex_id: TOOL}),
    event(7, 'vertex/created', {vertex_id: GRANDCHILD, parent_refs: [TOOL]}),
    event(8, 'vertex/succeeded', {vertex_id: SIBLING}),
];

describe('causalDescendants', () => {
    it('derives the transitive descendant closure from parent_refs', () => {
        expect(causalDescendants(stream, PLANNER)).toEqual(new Set([TOOL, GRANDCHILD]));
        expect(causalDescendants(stream, SIBLING)).toEqual(new Set());
    });
});

describe('computeForkSlice', () => {
    it('invalidates nothing for a no-substitution fork so everything merges', () => {
        const slice = computeForkSlice(stream, PLANNER, [], 8);
        expect(slice.invalidated).toEqual([]);
        expect(slice.seed.map((item) => item.stream_seq)).toEqual([1, 2]);
        expect(slice.deferred.map((item) => item.stream_seq)).toEqual([3, 4, 5, 6, 7, 8]);
    });

    it('invalidates causal descendants and the divergence execution chain under a substitution', () => {
        const slice = computeForkSlice(stream, PLANNER, [{stream_seq: 2, pin_version: 'model://planner@v2'}], 8);
        expect(slice.invalidated.map((item) => item.stream_seq)).toEqual([3, 4, 6, 7]);
        expect(slice.seed.map((item) => item.stream_seq)).toEqual([1, 2]);
        expect(slice.deferred.map((item) => item.stream_seq)).toEqual([5, 8]);
    });

    it('invalidates the divergence planner model charge under a model substitution', () => {
        const charged = [...stream, event(9, 'budget/charged', {vertex_id: PLANNER})];
        const slice = computeForkSlice(charged, PLANNER, [{stream_seq: 2, pin_version: 'model://planner@v2'}], 9);
        expect(slice.invalidated.map((item) => item.stream_seq)).toContain(9);
    });

    it('diverges at a tool-caller vertex and keeps its causal ancestors in the seed', () => {
        const slice = computeForkSlice(stream, TOOL, [{stream_seq: 4, pin_version: 'tool://check@v2'}], 8);
        expect(slice.seed.map((item) => item.stream_seq)).toEqual([1, 2, 3, 4]);
        expect(slice.invalidated.map((item) => item.stream_seq)).toEqual([6, 7]);
        expect(slice.deferred.map((item) => item.stream_seq)).toEqual([5, 8]);
    });

    it('bounds the slice at eval_up_to_seq', () => {
        const slice = computeForkSlice(stream, PLANNER, [], 5);
        expect(slice.deferred.map((item) => item.stream_seq)).toEqual([3, 4, 5]);
    });

    it('rejects a divergence vertex outside the evaluation window', () => {
        expect(() => computeForkSlice(stream, GRANDCHILD, [], 5)).toThrow('not created within eval_up_to_seq');
    });

    it('rejects a substitution that does not name a pinned event of the divergence vertex', () => {
        expect(() => computeForkSlice(stream, PLANNER, [{stream_seq: 4, pin_version: 'tool://check@v2'}], 8)).toThrow('divergence vertex');
        expect(() => computeForkSlice(stream, PLANNER, [{stream_seq: 3, pin_version: 'model://planner@v2'}], 8)).toThrow('pinned');
    });
});
