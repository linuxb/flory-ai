import {describe, expect, it} from 'vitest';
import {DEFAULT_LAYOUT, layout} from '../graph/layout.js';
import {relationsOf, toFlow} from '../graph/toFlow.js';
import {model, vertex} from './fixtures.js';

/**
 *   parent-a ┐
 *            ├→ middle ┬→ child-a
 *   parent-b ┘         └→ child-b
 *   stranger (unrelated)
 */
const vertices = [
    vertex('parent-a', {created_seq: 1, depth: 0}),
    vertex('parent-b', {created_seq: 2, depth: 0}),
    vertex('stranger', {created_seq: 3, depth: 0}),
    vertex('middle', {created_seq: 4, depth: 1, parent_refs: ['parent-a', 'parent-b']}),
    vertex('child-a', {created_seq: 5, depth: 2, parent_refs: ['middle']}),
    vertex('child-b', {created_seq: 6, depth: 2, parent_refs: ['middle'], is_shadowed: true}),
];

function flow(selected: string | null) {
    const dag = model(vertices);
    return toFlow(dag, layout(dag, DEFAULT_LAYOUT), selected);
}

describe('what one selection relates to', () => {
    it('separates who derived it from what it derived', () => {
        const relations = relationsOf(model(vertices), 'middle')!;
        expect([...relations.upstream].sort()).toEqual(['parent-a', 'parent-b']);
        expect([...relations.downstream].sort()).toEqual(['child-a', 'child-b']);
    });

    it('reads direct relations only, never an ancestor', () => {
        // A grandparent highlighted the same way as a parent answers a different question than the
        // one asked. Tracing a lineage is clicking along it, and every step stays exact.
        const relations = relationsOf(model(vertices), 'child-a')!;
        expect([...relations.upstream]).toEqual(['middle']);
        expect(relations.upstream.has('parent-a')).toBe(false);
    });

    it('is nothing at all when nothing is selected', () => {
        expect(relationsOf(model(vertices), null)).toBeNull();
        // And then no node or edge carries a relation class, so the canvas reads as one graph.
        const graph = flow(null);
        expect(graph.nodes.every((node) => !node.className)).toBe(true);
        expect(graph.edges.every((edge) => !edge.className?.includes('related-'))).toBe(true);
    });
});

describe('what the canvas draws for it', () => {
    it('colours an edge by direction relative to the selection, not by its own arrow', () => {
        // The edge into `middle` points at the selection and is still upstream: the question is
        // which side of the selection the *other* end sits on.
        const edges = new Map(flow('middle').edges.map((edge) => [edge.id, edge.className ?? '']));
        expect(edges.get('parent-a->middle')).toContain('related-upstream');
        expect(edges.get('middle->child-a')).toContain('related-downstream');
    });

    it('dims every node and edge the selection does not touch', () => {
        const graph = flow('middle');
        const byId = new Map(graph.nodes.map((node) => [node.id, node.className ?? '']));
        expect(byId.get('stranger')).toBe('related-dimmed');
        expect(byId.get('parent-a')).toBe('related-upstream');
        expect(byId.get('middle')).toBe('related-self');
    });

    it('keeps a discarded edge dashed while it is highlighted', () => {
        // The two facts compose: an edge can be both part of the selection and part of work that
        // a replan threw away, and collapsing either into the other loses a reason.
        const className = flow('middle').edges.find((edge) => edge.id === 'middle->child-b')!.className!;
        expect(className).toContain('edge-shadowed');
        expect(className).toContain('related-downstream');
    });

    it('points every edge from the vertex that derived it', () => {
        // Without an arrowhead the canvas shows that two vertices are related and not which came
        // from which, which in a graph grown one frozen chunk at a time is the whole question.
        expect(flow(null).edges.every((edge) => Boolean(edge.markerEnd))).toBe(true);
    });
});
