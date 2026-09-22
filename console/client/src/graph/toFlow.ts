import {MarkerType, type Edge, type Node} from '@xyflow/react';
import type {ConsoleDagModel} from '../engine.js';
import type {LayoutResult} from './layout.js';
import type {VertexCardData} from './VertexCard.js';
import type {ScopeEnclosureData} from './ScopeEnclosure.js';

/**
 * Turns the server's model plus a layout into what React Flow draws.
 *
 * This is a translation, not a derivation. Every field read here — `parent_refs`, `depth`,
 * `member_vertex_ids`, `status` — was named by the server in the event that carried the vertex.
 * Nothing walks the graph: an edge exists because a vertex says who its parents are, and no edge is
 * closed over, reversed, or implied from scope membership. The only numbers invented here come from
 * `layout()`, which is presentation.
 */
export type FlowNode = Node<VertexCardData, 'vertex'> | Node<ScopeEnclosureData, 'scope'>;

export interface FlowGraph {
    nodes: FlowNode[];
    edges: Edge[];
}

/** One vertex's immediate neighbourhood: who derived it, and what it derived. */
export interface Relations {
    /** Vertices this one names as parents. */
    upstream: Set<string>;
    /** Vertices that name this one as a parent. */
    downstream: Set<string>;
}

/**
 * Reads one vertex's direct parents and direct children.
 *
 * Direct only, and deliberately: an ancestor highlighted the same way as a parent would answer a
 * different question than the one being asked. Tracing a lineage is then clicking along it, which
 * keeps every step's answer exact.
 *
 * `parent_refs` is the only thing read, because it is the only thing the server said. An edge
 * exists because a vertex named a parent — nothing here closes over the relation or reverses it
 * beyond the one inversion that "children" means.
 */
export function relationsOf(model: ConsoleDagModel, vertexId: string | null): Relations | null {
    if (!vertexId) return null;
    const self = model.vertices.find((vertex) => vertex.vertex_id === vertexId);
    if (!self) return null;
    return {
        upstream: new Set(self.parent_refs),
        downstream: new Set(model.vertices.filter((vertex) => vertex.parent_refs.includes(vertexId)).map((vertex) => vertex.vertex_id)),
    };
}

/** What a node or edge is, relative to the current selection. */
function relationClass(relations: Relations | null, selectedVertexId: string | null, id: string): string | undefined {
    if (!relations || !selectedVertexId) return undefined;
    if (id === selectedVertexId) return 'related-self';
    if (relations.upstream.has(id)) return 'related-upstream';
    if (relations.downstream.has(id)) return 'related-downstream';
    return 'related-dimmed';
}

export function toFlow(model: ConsoleDagModel, placed: LayoutResult, selectedVertexId: string | null = null): FlowGraph {
    const relations = relationsOf(model, selectedVertexId);
    const nodes: FlowNode[] = [];

    // Enclosures first, so they paint behind their members. An undrawable scope is omitted
    // entirely rather than approximated — `layout` already decided that, and a rectangle around a
    // non-member is worse than none.
    for (const scope of model.scopes) {
        const box = placed.scopes.find((candidate) => candidate.scopeId === scope.scope_id);
        if (!box?.drawable) continue;
        nodes.push({
            id: `scope:${scope.scope_id}`,
            type: 'scope',
            position: {x: box.x, y: box.y},
            data: {scope, placed: box},
            draggable: false,
            selectable: false,
            focusable: false,
            zIndex: 0,
            style: {width: box.width, height: box.height},
        });
    }

    const edges: Edge[] = [];
    for (const vertex of model.vertices) {
        const spot = placed.vertices.get(vertex.vertex_id);
        if (!spot) continue;
        nodes.push({
            id: vertex.vertex_id,
            type: 'vertex',
            position: {x: spot.x, y: spot.y},
            data: {vertex},
            draggable: false,
            zIndex: 1,
            className: relationClass(relations, selectedVertexId, vertex.vertex_id),
        });
        for (const parent of vertex.parent_refs) {
            // A parent outside the model would mean the client is holding a partial graph, which
            // `applyEvent` turns into a resync rather than letting it reach here. Skipping keeps
            // the render total in the moment before that resync lands.
            if (!placed.vertices.has(parent)) continue;
            // An edge belongs to the selection when either end is the selected vertex, and it
            // takes the direction's colour: an edge coming *into* the selection is upstream even
            // though its target is the selected vertex.
            const touchesSelection = parent === selectedVertexId || vertex.vertex_id === selectedVertexId;
            const direction = parent === selectedVertexId ? 'related-downstream' : 'related-upstream';
            edges.push({
                id: `${parent}->${vertex.vertex_id}`,
                source: parent,
                target: vertex.vertex_id,
                type: 'smoothstep',
                // A running child is the one place the canvas moves on its own: it marks where the
                // run currently is, which is the first thing an operator looks for.
                animated: vertex.status === 'started',
                // An arrowhead on every edge, always. Without one the canvas shows that two
                // vertices are related and not which derived which, and in a graph a planner grew
                // one chunk at a time that is the whole question.
                markerEnd: {type: MarkerType.ArrowClosed, width: 16, height: 16, color: 'var(--edge-arrow)'},
                className: [vertex.is_shadowed ? 'edge-shadowed' : '', relations ? (touchesSelection ? direction : 'related-dimmed') : ''].filter(Boolean).join(' ') || undefined,
                zIndex: touchesSelection ? 2 : 1,
            });
        }
    }

    return {nodes, edges};
}
