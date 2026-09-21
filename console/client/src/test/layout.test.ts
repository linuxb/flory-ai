import {describe, expect, it} from 'vitest';
import {DEFAULT_LAYOUT, layout, type LayoutResult} from '../graph/layout.js';
import type {ConsoleScope} from '../types/engine.js';
import {model, vertex} from './fixtures.js';

/** The retail run's shape: two parallel reads, a router, a planner, then a transaction chain. */
const growth = [
    [vertex('demand', {created_seq: 4, depth: 0}), vertex('catalogue', {created_seq: 5, depth: 0})],
    [vertex('router', {created_seq: 6, depth: 1, parent_refs: ['demand', 'catalogue'], role: 'router'})],
    [vertex('source', {created_seq: 7, depth: 2, parent_refs: ['router'], role: 'planner'})],
    [vertex('negotiate', {created_seq: 9, depth: 3, parent_refs: ['router'], role: 'planner', decided_by: 'router'})],
    [
        vertex('po', {created_seq: 20, depth: 3, parent_refs: ['source'], txn: {scope_id: 's1', is_pivot: false, effect_class: 'bufferable', pivot_passed: false}}),
        vertex('capture', {created_seq: 21, depth: 4, parent_refs: ['po'], txn: {scope_id: 's1', is_pivot: true, effect_class: 'irreversible', pivot_passed: true}}),
    ],
];

function scope(memberIds: string[], pivot: string | null): ConsoleScope {
    return {scope_id: 's1', state: 'open', member_vertex_ids: memberIds, pivot_vertex_id: pivot, pivot_passed_seq: null, pivot_declaration_mismatch: false, opened_seq: 19, closed_seq: null};
}

describe('canvas layout', () => {
    it('never moves a vertex that is already placed, however the graph grows', () => {
        // The invariant, asserted directly over every prefix of the run. It is what the whole
        // hand-written layout exists for: on a console, motion means "something happened here",
        // and a node that drifts because an unrelated branch appeared teaches an operator to stop
        // trusting motion.
        let placed: LayoutResult | undefined;
        let vertices = growth[0]!;
        placed = layout(model(vertices), DEFAULT_LAYOUT);

        for (const batch of growth.slice(1)) {
            vertices = [...vertices, ...batch];
            const next = layout(model(vertices), DEFAULT_LAYOUT, placed);
            for (const [id, before] of placed.vertices) {
                const after = next.vertices.get(id)!;
                expect({id, layer: after.layer, index: after.index}).toEqual({id, layer: before.layer, index: before.index});
            }
            placed = next;
        }
    });

    it('reads the layer the server assigned rather than deriving one', () => {
        const placed = layout(model(growth.flat()), DEFAULT_LAYOUT);
        expect(placed.vertices.get('demand')!.layer).toBe(0);
        expect(placed.vertices.get('router')!.layer).toBe(1);
        expect(placed.vertices.get('capture')!.layer).toBe(4);
    });

    it('keeps siblings apart and stacks layers downward', () => {
        const placed = layout(model(growth[0]!), DEFAULT_LAYOUT);
        const [first, second] = [placed.vertices.get('demand')!, placed.vertices.get('catalogue')!];
        expect(first.y).toBe(second.y);
        expect(Math.abs(first.x - second.x)).toBe(DEFAULT_LAYOUT.nodeWidth + DEFAULT_LAYOUT.siblingGap);
    });

    it('encloses a scope and marks where the commit boundary falls', () => {
        const vertices = growth.flat();
        const placed = layout(model(vertices, {scopes: [scope(['po', 'capture'], 'capture')]}), DEFAULT_LAYOUT);
        const enclosure = placed.scopes[0]!;
        expect(enclosure.drawable).toBe(true);
        expect(enclosure.width).toBeGreaterThan(DEFAULT_LAYOUT.nodeWidth);
        // Above the pivot's own layer: everything above compensates, nothing below does.
        expect(enclosure.pivotY).toBe(placed.vertices.get('capture')!.y - DEFAULT_LAYOUT.layerGap / 2);
    });

    it('refuses to draw an enclosure that would enclose a non-member', () => {
        // Two scope members with an outsider between them in the same layer. A rectangle here
        // would tell an operator the outsider is inside the transaction, and they would believe
        // it — worse than drawing nothing.
        const vertices = [
            vertex('left', {created_seq: 1, depth: 0, txn: {scope_id: 's1', is_pivot: false, effect_class: 'reversible', pivot_passed: false}}),
            vertex('outsider', {created_seq: 2, depth: 0}),
            vertex('right', {created_seq: 3, depth: 0, txn: {scope_id: 's1', is_pivot: false, effect_class: 'reversible', pivot_passed: false}}),
        ];
        // Built up so the outsider is pinned between them: `left` alone first, then the outsider
        // joins beside it, and only then does `right` arrive. Clustering cannot help once the
        // middle position is already taken by something that must not move.
        const first = layout(model([vertices[0]!]), DEFAULT_LAYOUT);
        const second = layout(model([vertices[0]!, vertices[1]!]), DEFAULT_LAYOUT, first);
        const placed = layout(model(vertices, {scopes: [scope(['left', 'right'], null)]}), DEFAULT_LAYOUT, second);
        expect(placed.vertices.get('outsider')!.index).toBe(1);
        expect(placed.scopes[0]!.drawable).toBe(false);
    });

    it('refuses an enclosure whose box reaches into another layer it does not own', () => {
        // The shape the first real run produced, and which a per-layer contiguity check passed:
        // the scope holds column 1 in one layer and column 0 in the next, so its bounding box is
        // two columns wide and swallows whatever sits in column 1 of the second layer. Each layer
        // is contiguous on its own; the rectangle still encloses a non-member.
        const vertices = [
            vertex('member-top', {created_seq: 1, depth: 0, txn: {scope_id: 's1', is_pivot: false, effect_class: 'reversible', pivot_passed: false}}),
            vertex('member-bottom', {created_seq: 2, depth: 1, parent_refs: ['member-top'], txn: {scope_id: 's1', is_pivot: false, effect_class: 'reversible', pivot_passed: false}}),
            vertex('stranger', {created_seq: 3, depth: 1}),
        ];
        // Pinned so ordering cannot rescue it: the top member is pushed into column 1 by a
        // neighbour that arrived first, while the bottom member keeps column 0.
        const first = layout(model([vertex('neighbour', {created_seq: 0, depth: 0})]), DEFAULT_LAYOUT);
        const placed = layout(model([vertex('neighbour', {created_seq: 0, depth: 0}), ...vertices], {scopes: [scope(['member-top', 'member-bottom'], null)]}), DEFAULT_LAYOUT, first);

        expect(placed.vertices.get('member-top')!.index).toBe(1);
        expect(placed.vertices.get('member-bottom')!.index).toBe(0);
        expect(placed.vertices.get('stranger')!.index).toBe(1);
        expect(placed.scopes[0]!.drawable).toBe(false);
    });

    it('holds a scope in the same column across every layer it spans', () => {
        // The fix that makes the retail run's enclosure drawable at all: an unscoped vertex ranks
        // after every scope, so a chain of scope members keeps column 0 layer after layer instead
        // of being pushed sideways by whichever unscoped vertex happened to appear alongside it.
        const vertices = [
            vertex('outsider-a', {created_seq: 1, depth: 0}),
            vertex('m1', {created_seq: 2, depth: 0, txn: {scope_id: 's1', is_pivot: false, effect_class: 'reversible', pivot_passed: false}}),
            vertex('m2', {created_seq: 3, depth: 1, parent_refs: ['m1'], txn: {scope_id: 's1', is_pivot: false, effect_class: 'reversible', pivot_passed: false}}),
            vertex('outsider-b', {created_seq: 4, depth: 1}),
        ];
        const placed = layout(model(vertices, {scopes: [scope(['m1', 'm2'], null)]}), DEFAULT_LAYOUT);
        expect([placed.vertices.get('m1')!.index, placed.vertices.get('m2')!.index]).toEqual([0, 0]);
        expect(placed.scopes[0]!.drawable).toBe(true);
    });

    it('clusters new scope members so an enclosure can be honest', () => {
        // Same three vertices with nothing pinned: scope rank orders first, so the members land
        // next to each other and the enclosure is drawable after all.
        const vertices = [
            vertex('outsider', {created_seq: 1, depth: 0}),
            vertex('left', {created_seq: 2, depth: 0, txn: {scope_id: 's1', is_pivot: false, effect_class: 'reversible', pivot_passed: false}}),
            vertex('right', {created_seq: 3, depth: 0, txn: {scope_id: 's1', is_pivot: false, effect_class: 'reversible', pivot_passed: false}}),
        ];
        expect(layout(model(vertices, {scopes: [scope(['left', 'right'], null)]}), DEFAULT_LAYOUT).scopes[0]!.drawable).toBe(true);
    });
});
