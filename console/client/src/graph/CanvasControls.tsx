import {useReactFlow} from '@xyflow/react';

export interface CanvasControlsProps {
    /** Vertices appended since the operator last looked, in arrival order. */
    pending: readonly string[];
    onFollow: () => void;
}

/**
 * Zoom, fit, and the growth pill.
 *
 * The pill is the whole viewport policy in one control: an append never moves the view, because an
 * operator who has panned to a failing branch must not be yanked away by unrelated work finishing.
 * So growth is *announced* and moving there is a click.
 */
export function CanvasControls({pending, onFollow}: CanvasControlsProps): React.JSX.Element {
    const flow = useReactFlow();
    return (
        <div className="canvas-controls">
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
