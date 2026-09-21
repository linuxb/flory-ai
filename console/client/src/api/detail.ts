import type {PayloadDetail, RetentionUnavailable} from '../types/engine.js';

/**
 * The drawer's fetches.
 *
 * Three states, because the server distinguishes three true things: the data, "no such vertex",
 * and "this is not retained yet, and here is what the log does hold". Collapsing the last two into
 * one error would lose exactly the information an operator opens the tab for.
 */
export type DetailResult<T> = {kind: 'ok'; value: T} | {kind: 'missing'} | {kind: 'unavailable'; detail: RetentionUnavailable} | {kind: 'error'; message: string};

async function get<T>(path: string, signal: AbortSignal): Promise<DetailResult<T>> {
    let response: Response;
    try {
        response = await fetch(path, {signal, headers: {accept: 'application/json'}});
    } catch (error) {
        return {kind: 'error', message: error instanceof Error ? error.message : String(error)};
    }
    if (response.status === 404) return {kind: 'missing'};
    if (response.status === 501) return {kind: 'unavailable', detail: (await response.json()) as RetentionUnavailable};
    if (!response.ok) return {kind: 'error', message: `${response.status} ${response.statusText}`};
    return {kind: 'ok', value: (await response.json()) as T};
}

export function fetchPayload(runId: string, vertexId: string, signal: AbortSignal): Promise<DetailResult<PayloadDetail>> {
    return get<PayloadDetail>(`/api/v1/runs/${runId}/vertices/${vertexId}/payload`, signal);
}

/** Always resolves `unavailable` today; kept so the drawer needs no change when retention lands. */
export function fetchRetained(runId: string, vertexId: string, kind: 'prompt' | 'logs', signal: AbortSignal): Promise<DetailResult<unknown>> {
    return get<unknown>(`/api/v1/runs/${runId}/vertices/${vertexId}/${kind}`, signal);
}
