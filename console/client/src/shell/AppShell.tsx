import {useCallback, useEffect, useMemo, useState} from 'react';
import {RunHeader} from './RunHeader.js';
import {RunPicker} from './RunPicker.js';
import {DagCanvas} from '../graph/DagCanvas.js';
import {InspectorDrawer, type DrawerTab} from '../inspector/InspectorDrawer.js';
import {useRunStream} from '../stream/useRunStream.js';

/**
 * The whole console: a header, a canvas, and a drawer.
 *
 * Selection and the open tab live here rather than alongside the model, because they are session
 * state and the model is not. A reconnect replaces the graph; it must not close the drawer, move
 * the viewport, or send the operator back to the first tab. The selected id is re-resolved against
 * whatever model is current, so a selection that survives a resync keeps working and one whose
 * vertex vanished simply closes.
 */
export function AppShell({runId, onOpenRun}: {runId: string | null; onOpenRun: (runId: string | null) => void}): React.JSX.Element {
    const {model, status, resyncs, error} = useRunStream(runId);
    const [selectedVertexId, setSelected] = useState<string | null>(null);
    const [tab, setTab] = useState<DrawerTab>('details');

    // Clear the selection when the run changes, and only then: it belongs to a run, not to a feed.
    useEffect(() => setSelected(null), [runId]);

    const selected = useMemo(() => model?.model.vertices.find((vertex) => vertex.vertex_id === selectedVertexId) ?? null, [model, selectedVertexId]);
    const select = useCallback((vertexId: string | null) => setSelected(vertexId), []);

    return (
        <div className="app-shell">
            <RunHeader model={model?.model ?? null} status={status} resyncs={resyncs} error={error} onOpenRun={onOpenRun} />
            <main className={selected ? 'with-drawer' : undefined}>
                {!runId ? <RunPicker onOpenRun={onOpenRun} /> : null}
                {runId && !model ? <p className="drawer-empty centred">{error ?? 'waiting for the first snapshot…'}</p> : null}
                {runId && model ? <DagCanvas model={model.model} selectedVertexId={selectedVertexId} onSelect={select} /> : null}
                {runId && model ? <InspectorDrawer runId={runId} model={model.model} vertex={selected} tab={tab} onTab={setTab} onClose={() => setSelected(null)} /> : null}
            </main>
        </div>
    );
}
