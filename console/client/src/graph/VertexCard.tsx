import {Handle, Position, type NodeProps, type Node} from '@xyflow/react';
import {RoleIcon} from './roleIcon.js';
import type {ConsoleVertex} from '../types/engine.js';

export interface VertexCardData extends Record<string, unknown> {
    vertex: ConsoleVertex;
}

/** How long a vertex took, or how long it has been going. */
function duration(vertex: ConsoleVertex): string | null {
    if (vertex.timing.duration_ms !== null) return `${vertex.timing.duration_ms}ms`;
    // A running vertex has no recorded end, so an elapsed time is a clock read against a server
    // timestamp and carries this laptop's skew. Marked approximate so nobody quotes it as measured.
    if (vertex.timing.started_at) return `~${Math.max(0, Math.round((Date.now() - Date.parse(vertex.timing.started_at)) / 1000))}s`;
    return null;
}

/**
 * One vertex, as a card.
 *
 * The left edge carries the status colour, which is theme-invariant; the fill composes that same
 * hue with a theme-dependent alpha, so no CSS here branches on light or dark.
 */
export function VertexCard({data, selected}: NodeProps<Node<VertexCardData, 'vertex'>>): React.JSX.Element {
    const {vertex} = data;
    const elapsed = duration(vertex);
    return (
        <div className={`vertex-card status-${vertex.status}${vertex.is_shadowed ? ' shadowed' : ''}${selected ? ' selected' : ''}`} data-role={vertex.role}>
            <Handle type="target" position={Position.Top} isConnectable={false} />
            <div className="vertex-card-head">
                <RoleIcon role={vertex.role} />
                <span className="vertex-card-label" title={vertex.vertex_id}>
                    {vertex.label}
                </span>
                {elapsed ? <span className="vertex-card-time">{elapsed}</span> : null}
            </div>
            <div className="vertex-card-meta">
                {vertex.tool ? <span className="chip tool">{vertex.tool}</span> : null}
                {/* A branch a rule emitted must not read as a model's choice; that is what a
                    deterministic router is for, and it is invisible in the graph's shape. */}
                {vertex.decided_by === 'router' ? <span className="chip rule">by rule</span> : null}
                {vertex.txn.is_pivot ? <span className="chip pivot">{vertex.txn.pivot_passed ? 'pivot passed' : 'pivot'}</span> : null}
                {vertex.bracket ? <span className="chip bracket">{vertex.bracket.state}</span> : null}
                {vertex.router_outcome && vertex.router_outcome.kind !== 'pending' ? <span className="chip router">{routerLabel(vertex.router_outcome.kind)}</span> : null}
                {vertex.cost ? <span className="chip cost">{vertex.cost.input_tokens + vertex.cost.output_tokens} tok</span> : null}
                {/* A planner that answered and produced nothing looks identical to one that has
                    not been reached yet, and it is the reason a run stopped. */}
                {vertex.stall ? <span className="chip stalled">answer unreadable</span> : null}
                {vertex.is_shadowed ? <span className="chip shadowed">discarded</span> : null}
            </div>
            <Handle type="source" position={Position.Bottom} isConnectable={false} />
        </div>
    );
}

function routerLabel(kind: string): string {
    return {matched: 'matched', fell_through: 'no rule matched', evaluation_error: 'could not decide', proposal_rejected: 'branch refused'}[kind] ?? kind;
}
