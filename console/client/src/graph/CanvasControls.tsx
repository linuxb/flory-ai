import {useReactFlow} from '@xyflow/react';

export interface CanvasControlsProps {
    /** Vertices appended since the operator last looked, in arrival order. */
    pending: readonly string[];
    onFollow: () => void;
    /** True while a vertex is selected, which is the only time the relation colours mean anything. */
    showRelationLegend: boolean;
}

/**
 * Zoom, fit, and the growth pill.
 *
 * The pill is the whole viewport policy in one control: an append never moves the view, because an
 * operator who has panned to a failing branch must not be yanked away by unrelated work finishing.
 * So growth is *announced* and moving there is a click.
 */
export function CanvasControls({pending, onFollow, showRelationLegend}: CanvasControlsProps): React.JSX.Element {
    const flow = useReactFlow();
    return (
        <div className="canvas-controls">
            {/* Shown only while something is selected. A permanent legend for a transient state is
                clutter the rest of the time, and the colours mean nothing without a selection. */}
            {showRelationLegend ? (
                <div className="relation-legend">
                    <span className="upstream">
                        <i aria-hidden="true" />
                        derived this
                    </span>
                    <span className="downstream">
                        <i aria-hidden="true" />
                        derived from this
                    </span>
                </div>
            ) : null}
            {pending.length ? (
                <button type="button" className="growth-pill" onClick={onFollow}>
                    +{pending.length} new
                </button>
            ) : null}
            <div className="control-cluster">
                <button type="button" onClick={() => void flow.zoomIn({duration: 160})} title="Zoom in" aria-label="Zoom in">
                    +
                </button>
                <button type="button" onClick={() => void flow.zoomOut({duration: 160})} title="Zoom out" aria-label="Zoom out">
                    −
                </button>
                <button type="button" onClick={() => void flow.fitView({duration: 240, padding: 0.2})} title="Fit the whole graph" aria-label="Fit view">
                    ⤢
                </button>
            </div>
        </div>
    );
}
