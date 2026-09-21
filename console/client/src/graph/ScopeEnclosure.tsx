import type {Node, NodeProps} from '@xyflow/react';
import type {ConsoleScope} from '../engine.js';
import type {PlacedScope} from './layout.js';

export interface ScopeEnclosureData extends Record<string, unknown> {
    scope: ConsoleScope;
    placed: PlacedScope;
}

/**
 * A transaction scope, drawn behind its members with the commit boundary marked.
 *
 * A background node rather than a React Flow group, because a group forces child coordinates to
 * be parent-relative and would put the library's extent logic in the middle of our layout.
 */
export function ScopeEnclosure({data}: NodeProps<Node<ScopeEnclosureData, 'scope'>>): React.JSX.Element {
    const {scope, placed} = data;
    return (
        <div className={`scope-enclosure state-${scope.state}`} style={{width: placed.width, height: placed.height}}>
            <span className="scope-label">
                scope {scope.scope_id.slice(0, 8)} · {scope.state}
            </span>
            {placed.pivotY !== null ? (
                <div className="scope-pivot" style={{top: placed.pivotY - placed.y}}>
                    <span>compensable above · irreversible below</span>
                </div>
            ) : null}
        </div>
    );
}
