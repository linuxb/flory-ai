import {describe, expect, it} from 'vitest';
import {FaultSchedule} from '../mocks/ecommerce/faults.js';
import {Sandbox} from './server.js';

describe('the deterministic test world', () => {
    // The ledger property is about the actor rather than about any transport, so it is asserted directly on the world
    // the tool services act on.
    it('deduplicates a repeated reservation and releases only the delta that reservation held', () => {
        const sandbox = new Sandbox();
        const inventory = sandbox.commerce.inventory;
        inventory.reserve('order-1', 'SKU-1', 3);
        inventory.reserve('order-1', 'SKU-1', 3);
        expect((sandbox.snapshot().inventory as {open_holds: number}).open_holds).toBe(1);
        expect(inventory.check('SKU-1')).toBe(97);
        inventory.release('order-1');
        expect((sandbox.snapshot().inventory as {open_holds: number}).open_holds).toBe(0);
        expect(inventory.check('SKU-1')).toBe(100);
    });

    it('starts each run from clean ledgers', () => {
        const sandbox = new Sandbox();
        sandbox.commerce.inventory.reserve('order-1', 'SKU-1', 3);
        sandbox.reset();
        expect((sandbox.snapshot().inventory as {open_holds: number}).open_holds).toBe(0);
    });
});

describe('fault injection', () => {
    // Keyed by seed, tool, and attempt, so a scenario can fail one attempt of one tool and no other.
    it('is deterministic in all three key components', () => {
        const faults = new FaultSchedule();
        faults.reset('scenario-7', {'scenario-7:logistics.book:1': 'retryable-failure'});
        expect(faults.injected('logistics.book', 1)).toBe('retryable-failure');
        expect(faults.injected('logistics.book', 2)).toBeUndefined();
        expect(faults.injected('payment.capture', 1)).toBeUndefined();
    });

    it('ignores a schedule written against another seed', () => {
        const faults = new FaultSchedule();
        faults.reset('scenario-8', {'scenario-7:logistics.book:1': 'permanent-failure'});
        expect(faults.injected('logistics.book', 1)).toBeUndefined();
    });
});
