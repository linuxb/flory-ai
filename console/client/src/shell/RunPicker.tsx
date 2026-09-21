import {useEffect, useState} from 'react';
import type {ConsoleRunSummary} from '../types/engine.js';

/**
 * The entry point, because there is otherwise no way into the console but pasting a UUID.
 *
 * Deliberately minimal: doc 11 section 7 defers fleet views, not a front door.
 */
export function RunPicker({onOpenRun}: {onOpenRun: (runId: string) => void}): React.JSX.Element {
    const [runs, setRuns] = useState<ConsoleRunSummary[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const controller = new AbortController();
        void fetch('/api/v1/runs?limit=25', {signal: controller.signal})
            .then(async (response) => (response.ok ? ((await response.json()) as ConsoleRunSummary[]) : Promise.reject(new Error(`${response.status} ${response.statusText}`))))
            .then(setRuns)
            .catch((cause: unknown) => {
                if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
            });
        return () => controller.abort();
    }, []);

    return (
        <div className="run-picker">
            <h2>Recent runs</h2>
            {error ? <p className="drawer-error">{error}</p> : null}
            {!runs && !error ? <p className="drawer-empty">loading…</p> : null}
            {runs?.length === 0 ? <p className="drawer-empty">no runs yet — start one with npm run demo:retail</p> : null}
            <ul>
                {runs?.map((run) => (
                    <li key={run.run_id}>
                        <button type="button" onClick={() => onOpenRun(run.run_id)}>
                            <span className="mono">{run.run_id}</span>
                            {run.kind === 'counterfactual' ? <span className="badge counterfactual small">counterfactual</span> : null}
                            <span className="run-picker-meta">
                                {new Date(run.created_at).toLocaleString()} · {run.event_count} events
                            </span>
                        </button>
                    </li>
                ))}
            </ul>
        </div>
    );
}
