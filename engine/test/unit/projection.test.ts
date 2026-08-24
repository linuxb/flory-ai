import {describe, expect, it} from 'vitest';
import {assertEventDraft, type StoredEvent} from '../../src/events.js';
import {FoldRegistry, linearize, slice, surface} from '../../src/projection.js';

const run = '00000000-0000-4000-8000-000000000001';
function event(stream_seq: number, event_type: string, options: Partial<StoredEvent> = {}): StoredEvent {
    return {
        run_id: run,
        stream_seq,
        global_seq: stream_seq,
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

describe('pure projections', () => {
    it('fails closed for unknown events but accepts explicit ignorable extensions', () => {
        expect(() => assertEventDraft({event_type: 'extension/future', payload: {}})).toThrow('unknown non-ignorable');
        expect(() => assertEventDraft({event_type: 'extension/future', ignorable: true, payload: {}})).not.toThrow();
        expect(() => surface([event(1, 'extension/future')])).toThrow('unknown non-ignorable');
    });

    it('removes shadowed vertices and returns an ancestor slice', () => {
        const events = [
            event(1, 'vertex/created', {vertex_id: '00000000-0000-4000-8000-000000000010', payload: {role: 'planner'}}),
            event(2, 'vertex/created', {vertex_id: '00000000-0000-4000-8000-000000000011', parent_refs: ['00000000-0000-4000-8000-000000000010'], payload: {role: 'tool'}}),
            event(3, 'vertex/created', {vertex_id: '00000000-0000-4000-8000-000000000012', parent_refs: ['00000000-0000-4000-8000-000000000011'], payload: {role: 'planner'}}),
            event(4, 'subgraph/shadowed', {payload: {vertex_ids: ['00000000-0000-4000-8000-000000000011']}}),
        ];
        const active = surface(events);
        expect([...active.vertices.keys()]).toEqual(['00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000012']);
        expect(slice(active, '00000000-0000-4000-8000-000000000012').map((item) => item.vertex_id)).toEqual(['00000000-0000-4000-8000-000000000012']);
    });

    it('registers supplied reducers without acquiring business semantics and linearizes by vertex id', () => {
        const registry = new FoldRegistry();
        registry.register({ref: 'fold://test@v1', reduce: (events) => events.length});
        expect(registry.fold<number>('fold://test@v1', [event(1, 'run/start')])).toBe(1);
        expect(() => registry.register({ref: 'fold://test@v1', reduce: () => 0})).toThrow('already registered');
        expect(
            linearize([
                {vertex_id: 'z', parent_refs: [], created_seq: 1},
                {vertex_id: 'a', parent_refs: [], created_seq: 2},
            ]).map((item) => item.vertex_id),
        ).toEqual(['a', 'z']);
    });
});
