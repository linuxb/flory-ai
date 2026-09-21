import {ThemeToggle} from './ThemeToggle.js';
import type {ConnectionStatus} from '../stream/connection.js';
import type {ConsoleDagModel} from '../types/engine.js';

export interface RunHeaderProps {
    model: ConsoleDagModel | null;
    status: ConnectionStatus;
    resyncs: number;
    error: string | null;
    onOpenRun: (runId: string) => void;
}

const STATUS_TEXT: Record<ConnectionStatus, string> = {connecting: 'connecting', live: 'live', reconnecting: 'reconnecting', error: 'disconnected'};

export function RunHeader({model, status, resyncs, error, onOpenRun}: RunHeaderProps): React.JSX.Element {
    return (
        <header className="run-header">
            <div className="run-identity">
                <h1>Flory console</h1>
                {model ? (
                    <>
                        {/* Unmistakable, and first. The data plane keeps a counterfactual's writes
                            in their own namespace precisely so a simulation is never read as
                            fact; an unlabelled header would undo that at the last step. */}
                        {model.kind === 'counterfactual' ? <span className="badge counterfactual">counterfactual — not a production run</span> : null}
                        <span className="mono run-id">{model.run_id}</span>
                    </>
                ) : null}
            </div>

            {model ? (
                <dl className="run-stats">
                    <div>
                        <dt>folded to</dt>
                        <dd>run_seq {model.at_run_seq}</dd>
                    </div>
                    <div>
                        <dt>vertices</dt>
                        <dd>{model.vertices.length}</dd>
                    </div>
                    <div>
                        <dt>model calls</dt>
                        <dd>
                            {model.spend.calls} · {model.spend.input_tokens + model.spend.output_tokens} tok
                            {model.spend.amount === null ? '' : ` · ${model.spend.amount} ${model.spend.currency ?? ''}`}
                        </dd>
                    </div>
                    {model.counterfactuals.length ? (
                        <div>
                            <dt>counterfactuals</dt>
                            <dd className="counterfactual-links">
                                {/* Linked, never drawn into this graph: an inherited copy keeps the
                                    source's own `vertex_id`, so merging the two would need an
                                    invented disambiguation rule — which is itself the proof that
                                    the picture is not one run. */}
                                {model.counterfactuals.map((fork) => (
                                    <button
                                        key={fork.child_run_id}
                                        type="button"
                                        onClick={() => onOpenRun(fork.child_run_id)}
                                        title={`forked at ${fork.at_vertex_id}, evaluated to run_seq ${fork.eval_up_to_seq}`}
                                    >
                                        {fork.child_run_id.slice(0, 8)}
                                    </button>
                                ))}
                            </dd>
                        </div>
                    ) : null}
                </dl>
            ) : null}

            <div className="run-controls">
                <span className={`feed-status feed-${status}`} title={error ?? undefined}>
                    <i aria-hidden="true" /> {STATUS_TEXT[status]}
                    {resyncs ? ` · ${resyncs} resync${resyncs === 1 ? '' : 's'}` : ''}
                </span>
                {/* Doc 11 section 5's attribution rule only works if a screenshot carries the
                    answer, so the projector version is on screen rather than in a tooltip. */}
                {model ? <span className="mono projector">{model.console_projector_version}</span> : null}
                <ThemeToggle />
            </div>
        </header>
    );
}
