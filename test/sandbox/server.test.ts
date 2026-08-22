import {describe, expect, it} from 'vitest';
import {Sandbox} from './server.js';

describe('out-of-process sandbox core', () => {
    it('deduplicates a repeated reservation and releases the scope-owned delta', () => {
        const sandbox = new Sandbox();
        const request = {run_id: 'r', vertex_id: 'v', attempt_no: 1, tool: 'inventory.reserve', idempotency_key: 'order-1', input: {sku: 'SKU-1', quantity: 3}};
        expect(sandbox.execute(request).outcome).toBe('succeeded');
        expect(sandbox.execute(request).outcome).toBe('succeeded');
        expect((sandbox.snapshot().inventory as {open_holds: number}).open_holds).toBe(1);
        expect(sandbox.execute({...request, tool: 'inventory.release'}).outcome).toBe('succeeded');
        expect((sandbox.snapshot().inventory as {open_holds: number}).open_holds).toBe(0);
    });

    it('injects faults deterministically by seed, tool, and attempt', () => {
        const sandbox = new Sandbox();
        sandbox.reset({seed: 'scenario-7', faults: {'scenario-7:logistics.book:1': 'retryable-failure'}});
        const request = {run_id: 'r', vertex_id: 'v', attempt_no: 1, tool: 'logistics.book', idempotency_key: 'order-1', input: {order_id: 'order-1', carrier: 'fast', postcode: '3210'}};
        expect(sandbox.execute(request).outcome).toBe('retryable-failure');
        expect(sandbox.execute({...request, attempt_no: 2}).outcome).toBe('succeeded');

        sandbox.reset({seed: 'scenario-8', faults: {'scenario-7:logistics.book:1': 'permanent-failure'}});
        expect(sandbox.execute(request).outcome).toBe('succeeded');
    });
});
