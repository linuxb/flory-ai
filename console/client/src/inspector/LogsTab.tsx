import type {DetailState} from './useVertexDetail.js';
import type {RetentionUnavailable} from '../engine.js';

/**
 * The prompt and execution-log tabs.
 *
 * Both are expected to be unavailable: nothing in the engine persists a prompt or a tool's
 * execution output, only their digests. The tab says so plainly and shows the digests, which are
 * the one genuinely useful thing the log does hold — two runs with the same `input_digest` were
 * sent the same prompt, even though neither prompt was kept.
 */
export function LogsTab({state, kind}: {state: DetailState<unknown>; kind: 'prompt' | 'logs'}): React.JSX.Element {
    if (state.kind === 'loading') return <p className="drawer-empty">loading…</p>;
    if (state.kind === 'missing') return <p className="drawer-empty">this run holds no such vertex</p>;
    if (state.kind === 'error') return <p className="drawer-error">{state.message}</p>;
    if (state.kind !== 'unavailable') return <pre className="json-block">{JSON.stringify(state.value, null, 2)}</pre>;
    return <NotRetained detail={state.detail} kind={kind} />;
}

function NotRetained({detail, kind}: {detail: RetentionUnavailable; kind: 'prompt' | 'logs'}): React.JSX.Element {
    return (
        <section className="not-retained">
            <h4>{kind === 'prompt' ? 'prompt not retained' : 'execution output not collected'}</h4>
            <p>{detail.reason}</p>
            <dl className="digest-list">
                <dt>input digest</dt>
                <dd>{detail.input_digest ?? '—'}</dd>
                <dt>output digest</dt>
                <dd>{detail.output_digest ?? '—'}</dd>
            </dl>
            <p className="drawer-note">{detail.prerequisite}</p>
        </section>
    );
}
