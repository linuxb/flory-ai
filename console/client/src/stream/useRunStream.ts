import {useEffect, useRef, useState} from 'react';
import {applyEvent, type ClientModel} from './applyEvent.js';
import {openRunStream, type ConnectionStatus} from './connection.js';

/** What a view needs to know about one run and the feed carrying it. */
export interface RunStreamState {
    model: ClientModel | null;
    status: ConnectionStatus;
    /** Forced resyncs, surfaced so an operator can see a feed that is unhealthy rather than idle. */
    resyncs: number;
    error: string | null;
}

/**
 * Subscribes to one run and keeps its model current.
 *
 * The model lives in a ref as well as in state because the reconnect path reads the live
 * watermark, and a closure over state would read whatever it captured when the effect ran.
 *
 * A `resync` outcome bumps a generation counter that the effect depends on, which reopens the
 * connection without a cursor and earns a fresh snapshot. That is the client's only recovery
 * mechanism, and having exactly one is what keeps it a renderer.
 */
export function useRunStream(runId: string | null): RunStreamState {
    const [model, setModel] = useState<ClientModel | null>(null);
    const [status, setStatus] = useState<ConnectionStatus>('connecting');
    const [error, setError] = useState<string | null>(null);
    const [resyncs, setResyncs] = useState(0);
    const [generation, setGeneration] = useState(0);
    const live = useRef<ClientModel | null>(null);

    useEffect(() => {
        if (!runId) return;
        live.current = null;
        setModel(null);
        const connection = openRunStream(runId, {
            onStatus: (next, detail) => {
                setStatus(next);
                setError(detail ?? null);
            },
            onEvent: (event) => {
                const outcome = applyEvent(live.current, event);
                if (outcome.kind === 'applied') {
                    live.current = outcome.next;
                    setModel(outcome.next);
                } else if (outcome.kind === 'resync') {
                    setResyncs((count) => count + 1);
                    setGeneration((value) => value + 1);
                }
            },
        });
        return () => connection.close();
    }, [runId, generation]);

    return {model, status, resyncs, error};
}
