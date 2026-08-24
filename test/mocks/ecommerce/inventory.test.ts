import {describe, expect, it} from 'vitest';
import type {StoredEvent} from '../../../engine/src/events.js';
import {FoldRegistry} from '../../../engine/src/projection.js';
import {mockInventoryConservation, mockInventoryPermutationInvariant, mockInventoryReducer, registerMockEcommerceReducers} from './inventory.js';

const run = '00000000-0000-4000-8000-000000000001';
function event(stream_seq: number, delta: number): StoredEvent {
    return {
        run_id: run,
        stream_seq,
        global_seq: stream_seq,
        event_type: 'vertex/succeeded',
        vertex_id: null,
        parent_refs: [],
        planner_id: null,
        scope_id: null,
        pin_version: null,
        ignorable: false,
        inherited: false,
        payload: {result: {inventory_delta: {sku: 'SKU-1', delta}}},
        created_at: '2026-01-01T00:00:00.000Z',
    };
}

describe('mock e-commerce inventory reducer', () => {
    it('registers only for sandbox validation and folds signed deltas independently of scheduling order', () => {
        const first = [event(1, 5), event(2, -2)];
        const second = [...first].reverse();
        const registry = new FoldRegistry();
        registerMockEcommerceReducers(registry);
        expect(registry.fold('fold://inventory@v1', first)).toEqual(mockInventoryReducer.reduce(first));
        expect(mockInventoryReducer.reduce(first).available).toEqual({'SKU-1': 3});
        expect(mockInventoryPermutationInvariant(first, second).passed).toBe(true);
        expect(mockInventoryConservation(first).passed).toBe(true);
    });
});
