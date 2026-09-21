import {useEffect, useState} from 'react';
import {fetchPayload, fetchRetained, type DetailResult} from '../api/detail.js';
import type {PayloadDetail} from '../types/engine.js';

export type DetailState<T> = {kind: 'loading'} | DetailResult<T>;

/**
 * Fetches one vertex's detail, and abandons it the moment the selection moves.
 *
 * The abort matters more than it looks: clicking along a chain of cards starts a fetch per card,
 * and without it a slow earlier response can land after a faster later one and put the previous
 * vertex's payload under the current vertex's header. That is a canvas telling a lie, which is the
 * one failure this console cannot have.
 */
export function useVertexDetail(runId: string, vertexId: string | null, tab: 'payload' | 'prompt' | 'logs'): DetailState<PayloadDetail | unknown> {
    const [state, setState] = useState<DetailState<PayloadDetail | unknown>>({kind: 'loading'});
    useEffect(() => {
        if (!vertexId) return;
        const controller = new AbortController();
        setState({kind: 'loading'});
        const request = tab === 'payload' ? fetchPayload(runId, vertexId, controller.signal) : fetchRetained(runId, vertexId, tab, controller.signal);
        void request.then((result) => {
            if (!controller.signal.aborted) setState(result);
        });
        return () => controller.abort();
    }, [runId, vertexId, tab]);
    return state;
}
