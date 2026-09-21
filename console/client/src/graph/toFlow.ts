import type {Edge, Node} from '@xyflow/react';
import type {ConsoleDagModel} from '../types/engine.js';
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

export function toFlow(model: ConsoleDagModel, placed: LayoutResult): FlowGraph {
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
        });
        for (const parent of vertex.parent_refs) {
            // A parent outside the model would mean the client is holding a partial graph, which
            // `applyEvent` turns into a resync rather than letting it reach here. Skipping keeps
            // the render total in the moment before that resync lands.
            if (!placed.vertices.has(parent)) continue;
            edges.push({
                id: `${parent}->${vertex.vertex_id}`,
                source: parent,
                target: vertex.vertex_id,
                type: 'smoothstep',
                // A running child is the one place the canvas moves on its own: it marks where the
                // run currently is, which is the first thing an operator looks for.
                animated: vertex.status === 'started',
                className: vertex.is_shadowed ? 'edge-shadowed' : undefined,
                zIndex: 1,
            });
        }
    }

    return {nodes, edges};
}
