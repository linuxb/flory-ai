import {JsonBlock} from './JsonBlock.js';
import type {DetailState} from './useVertexDetail.js';
import type {PayloadDetail} from '../types/engine.js';

export function PayloadTab({state}: {state: DetailState<PayloadDetail | unknown>}): React.JSX.Element {
    if (state.kind === 'loading') return <p className="drawer-empty">loading…</p>;
    if (state.kind === 'missing') return <p className="drawer-empty">this run holds no such vertex</p>;
    if (state.kind === 'error') return <p className="drawer-error">{state.message}</p>;
    if (state.kind === 'unavailable') return <p className="drawer-empty">{state.detail.reason}</p>;
    const detail = state.value as PayloadDetail;
    return (
        <>
            <section>
                <h4>input</h4>
                <JsonBlock value={detail.input} empty="frozen with no input" />
            </section>
            <section>
                <h4>{detail.failure ? 'failure' : 'result'}</h4>
                <JsonBlock value={detail.failure ?? detail.result} empty={detail.status === 'pending' ? 'still running' : 'returned nothing'} />
            </section>
            <section>
                <h4>lifted log fields</h4>
                {/* The only fields a router may read. Shown apart from the result so it is visible
                    that a rule saw a summary, not the whole payload. */}
                <JsonBlock value={detail.log_fields} empty="this tool lifted no summary fields" />
            </section>
        </>
    );
}
