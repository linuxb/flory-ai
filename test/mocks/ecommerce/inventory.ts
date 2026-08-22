import type {StoredEvent} from '../../../engine/src/events.js';
import {type FoldReducer, FoldRegistry} from '../../../engine/src/projection.js';
import {foldPermutationInvariant, type OracleResult} from '../../../engine/src/harness/oracles.js';

/** The in-process sandbox's inventory view, used only to validate signed-delta behavior. */
export interface MockInventoryView {
    reducer_ref: 'fold://inventory@v1';
    deltas: Record<string, number>;
    available: Record<string, number>;
}

/** Reduces mock e-commerce events without I/O, time, or external configuration. */
export const mockInventoryReducer: FoldReducer<MockInventoryView> = {
    ref: 'fold://inventory@v1',
    reduce(events: readonly StoredEvent[]): MockInventoryView {
        const deltas: Record<string, number> = {};
        for (const event of events) {
            if (event.event_type !== 'vertex/succeeded') continue;
            const result = event.payload.result;
            if (!result || typeof result !== 'object' || Array.isArray(result)) continue;
            const delta = (result as Record<string, unknown>).inventory_delta;
            if (!delta || typeof delta !== 'object' || Array.isArray(delta)) continue;
            const sku = (delta as Record<string, unknown>).sku;
            const amount = (delta as Record<string, unknown>).delta;
            if (typeof sku !== 'string' || typeof amount !== 'number') throw new Error('inventory_delta requires string sku and numeric delta');
            deltas[sku] = (deltas[sku] ?? 0) + amount;
        }
        return {reducer_ref: 'fold://inventory@v1', deltas, available: {...deltas}};
    },
};

/** Registers only the sandbox's mock reducers with a framework registry. */
export function registerMockEcommerceReducers(registry: FoldRegistry): void {
    registry.register(mockInventoryReducer);
}

/** Checks that the mock ledger view never reports negative availability. */
export function mockInventoryConservation(events: StoredEvent[]): OracleResult {
    const view = mockInventoryReducer.reduce(events);
    const negative = Object.entries(view.available).find(([, value]) => value < 0);
    return negative ? {name: 'O1.inventory_conservation', passed: false, detail: `${negative[0]} is negative`} : {name: 'O1.inventory_conservation', passed: true};
}

/** Applies the framework's permutation oracle to the sandbox inventory reducer. */
export function mockInventoryPermutationInvariant(first: StoredEvent[], second: StoredEvent[]): OracleResult {
    return foldPermutationInvariant(first, second, mockInventoryReducer);
}
