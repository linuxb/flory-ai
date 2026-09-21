import {DetailsTab} from './DetailsTab.js';
import {PayloadTab} from './PayloadTab.js';
import {LogsTab} from './LogsTab.js';
import {useVertexDetail} from './useVertexDetail.js';
import type {ConsoleDagModel, ConsoleVertex} from '../engine.js';

export type DrawerTab = 'details' | 'payload' | 'prompt' | 'logs';

export interface InspectorDrawerProps {
    runId: string;
    model: ConsoleDagModel;
    vertex: ConsoleVertex | null;
    tab: DrawerTab;
    onTab: (tab: DrawerTab) => void;
    onClose: () => void;
}

const TABS: {id: DrawerTab; label: string}[] = [
    {id: 'details', label: 'Details'},
    {id: 'payload', label: 'Payload'},
    {id: 'prompt', label: 'Prompt'},
    {id: 'logs', label: 'Logs'},
];

/**
 * The right-hand drawer.
 *
 * The open tab is session state, not model state: a reconnect replaces the graph and must not
 * close the drawer or send the operator back to Details. Doc 11 section 3.3 says a snapshot
 * "replaces its whole model" — taken literally that resets the operator's place on an ordinary
 * network blip, which is a visible failure for a non-failure.
 */
export function InspectorDrawer({runId, model, vertex, tab, onTab, onClose}: InspectorDrawerProps): React.JSX.Element | null {
    // Hook order cannot depend on the selection, so the fetch is declared unconditionally and the
    // hook itself no-ops on a null vertex.
    const detail = useVertexDetail(runId, vertex && tab !== 'details' ? vertex.vertex_id : null, tab === 'details' ? 'payload' : tab);
    if (!vertex) return null;
    return (
        <aside className="inspector-drawer" aria-label={`Details for ${vertex.label}`}>
            <header className="drawer-head">
                <div>
                    <h3>{vertex.label}</h3>
                    <p className="mono drawer-id">{vertex.vertex_id}</p>
                </div>
                <button type="button" className="drawer-close" onClick={onClose} aria-label="Close details">
                    ×
                </button>
            </header>
            <nav className="drawer-tabs" role="tablist">
                {TABS.map((entry) => (
                    <button key={entry.id} type="button" role="tab" aria-selected={tab === entry.id} className={tab === entry.id ? 'active' : undefined} onClick={() => onTab(entry.id)}>
                        {entry.label}
                    </button>
                ))}
            </nav>
            <div className="drawer-body">
                {tab === 'details' ? <DetailsTab vertex={vertex} model={model} /> : null}
                {tab === 'payload' ? <PayloadTab state={detail} /> : null}
                {tab === 'prompt' || tab === 'logs' ? <LogsTab state={detail} kind={tab} /> : null}
            </div>
        </aside>
    );
}
