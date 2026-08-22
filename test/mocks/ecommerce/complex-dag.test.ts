import {describe, expect, it} from 'vitest';
import {checkSubDag, type SubDagProposal} from '../../../engine/src/check-rules.js';
import {createComplexCommerceDag, createMockCommerceRegistry, MockCommerceWorld} from './services.js';

describe('complex e-commerce DAG validation', () => {
    it('admits and executes a multi-service, two-pivot DAG with explicit scope boundaries', () => {
        const registry = createMockCommerceRegistry();
        expect(checkSubDag(createComplexCommerceDag(), registry)).toEqual({accepted: true, violations: []});

        const world = new MockCommerceWorld();
        expect(world.inventory.check('SKU-1')).toBe(100);
        expect(world.logistics.quote('fast-co', '3210')).toBe(74);
        world.inventory.reserve('ORDER-1:reserve', 'SKU-1', 3);
        world.payment.authorize('ORDER-1', 1200);
        world.payment.capture('ORDER-1');
        world.inventory.confirm('ORDER-1:reserve');
        world.channel.draft('LISTING-1', 'SKU-1', 499);
        world.logistics.book('ORDER-1', 'fast-co', '3210');
        world.channel.publish('LISTING-1');

        expect(world.inventory.check('SKU-1')).toBe(97);
        expect(world.inventory.openHoldCount()).toBe(0);
        expect(world.payment.charges.get('ORDER-1')).toBe(1200);
        expect(world.logistics.bookings.size).toBe(1);
        expect(world.channel.published.has('LISTING-1')).toBe(true);
    });

    it('rejects a conflicting parallel branch and admits the same work behind a pre-pivot barrier', () => {
        const registry = createMockCommerceRegistry();
        const withoutBarrier: SubDagProposal = {
            scopes: [{id: 's', members: ['reserve', 'confirm', 'capture']}],
            vertices: [
                {id: 'reserve', kind: 'tool', tool: 'inventory.reserve', scopeId: 's', parents: []},
                {id: 'confirm', kind: 'tool', tool: 'inventory.confirm', scopeId: 's', parents: []},
                {id: 'capture', kind: 'tool', tool: 'payment.capture', scopeId: 's', parents: ['reserve']},
            ],
        };
        expect(checkSubDag(withoutBarrier, registry).violations.map((violation) => violation.rule)).toContain('R9');

        const withBarrier: SubDagProposal = {
            scopes: [{id: 's', members: ['reserve', 'confirm', 'capture']}],
            vertices: [
                {id: 'reserve', kind: 'tool', tool: 'inventory.reserve', scopeId: 's', parents: []},
                {id: 'confirm', kind: 'tool', tool: 'inventory.confirm', scopeId: 's', parents: []},
                {id: 'ready', kind: 'confirmation-barrier', parents: ['reserve', 'confirm']},
                {id: 'capture', kind: 'tool', tool: 'payment.capture', scopeId: 's', parents: ['ready']},
            ],
        };
        expect(checkSubDag(withBarrier, registry)).toEqual({accepted: true, violations: []});
    });

    it('requires a confirmation barrier before independent parallel pivots', () => {
        const registry = createMockCommerceRegistry();
        const withoutBarrier: SubDagProposal = {
            scopes: [
                {id: 'payment', members: ['authorize', 'capture']},
                {id: 'shipping', members: ['draft', 'book']},
            ],
            vertices: [
                {id: 'authorize', kind: 'tool', tool: 'payment.authorize', scopeId: 'payment', parents: []},
                {id: 'draft', kind: 'tool', tool: 'channel.draft', scopeId: 'shipping', parents: []},
                {id: 'capture', kind: 'tool', tool: 'payment.capture', scopeId: 'payment', parents: ['authorize']},
                {id: 'book', kind: 'tool', tool: 'logistics.book', scopeId: 'shipping', parents: ['draft']},
            ],
        };
        expect(checkSubDag(withoutBarrier, registry).violations.map((violation) => violation.rule)).toContain('R5');

        const withBarrier: SubDagProposal = {
            ...withoutBarrier,
            vertices: [
                {id: 'authorize', kind: 'tool', tool: 'payment.authorize', scopeId: 'payment', parents: []},
                {id: 'draft', kind: 'tool', tool: 'channel.draft', scopeId: 'shipping', parents: []},
                {id: 'ready', kind: 'confirmation-barrier', parents: ['authorize', 'draft']},
                {id: 'capture', kind: 'tool', tool: 'payment.capture', scopeId: 'payment', parents: ['ready']},
                {id: 'book', kind: 'tool', tool: 'logistics.book', scopeId: 'shipping', parents: ['ready']},
            ],
        };
        expect(checkSubDag(withBarrier, registry)).toEqual({accepted: true, violations: []});
    });
});
