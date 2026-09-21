import type {ConsoleStreamEvent} from '../engine.js';

/**
 * One run's live feed.
 *
 * Native `EventSource` rather than `fetch` plus a hand-written frame parser, for one strong
 * reason: the server puts the cursor on every frame's `id:`, so the browser sends `Last-Event-ID`
 * on its own reconnect. The resume protocol is then the SSE specification, with no client code to
 * get wrong and nothing to test in the reconnect path beyond "we reopened".
 *
 * The one real cost is that `EventSource` cannot set an `Authorization` header. Who may read a run
 * is still open (design document 11 section 7); if the answer is a bearer token rather than a
 * cookie, only this file changes — everything above it is transport-agnostic.
 */

export type ConnectionStatus = 'connecting' | 'live' | 'reconnecting' | 'error';

export interface StreamHandlers {
    onEvent(event: ConsoleStreamEvent): void;
    onStatus(status: ConnectionStatus, detail?: string): void;
}

export interface RunStreamConnection {
    close(): void;
}

const EVENT_TYPES = ['topology_snapshot', 'subgraph_appended', 'subgraph_shadowed', 'vertex_patched'] as const;

/**
 * Opens the feed for one run.
 *
 * Each type is listened for by name rather than through a catch-all, so a frame this build does
 * not know lands nowhere and is visible as a missing update — instead of being silently dropped
 * by a default branch that looked like it was handling it.
 */
export function openRunStream(runId: string, handlers: StreamHandlers): RunStreamConnection {
    handlers.onStatus('connecting');
    const source = new EventSource(`/api/v1/runs/${encodeURIComponent(runId)}/stream`);

    source.addEventListener('open', () => handlers.onStatus('live'));
    for (const type of EVENT_TYPES) {
        source.addEventListener(type, (message) => {
            try {
                handlers.onEvent(JSON.parse((message as MessageEvent<string>).data) as ConsoleStreamEvent);
            } catch (error) {
                handlers.onStatus('error', error instanceof Error ? error.message : String(error));
            }
        });
    }
    source.addEventListener('error', () => {
        // EventSource reconnects on its own and presents its cursor when it does; a closed one has
        // given up, and only then is this an error rather than a gap in service.
        handlers.onStatus(source.readyState === EventSource.CLOSED ? 'error' : 'reconnecting');
    });

    return {close: () => source.close()};
}
