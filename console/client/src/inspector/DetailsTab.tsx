import type {ConsoleDagModel, ConsoleRouterOutcome, ConsoleVertex} from '../types/engine.js';
import {JsonBlock} from './JsonBlock.js';

/** How an operator should read one router outcome. */
export interface RouterNote {
    tone: 'neutral' | 'warning' | 'error';
    /** One line, in an operator's words rather than the log's. */
    headline: string;
    /** The supporting fact, when there is one worth showing. */
    detail: string | null;
}

/**
 * Turns a router's recorded outcome into something an operator can act on.
 *
 * A router is the one vertex whose *absence of effect* is the interesting case: three of its four
 * outcomes mean "no branch appeared here", and they mean it for very different reasons.
 */
function describeRouterOutcome(outcome: ConsoleRouterOutcome): RouterNote {
    switch (outcome.kind) {
        case 'pending':
            return {tone: 'neutral', headline: 'has not evaluated yet', detail: null};
        case 'matched':
            // The only outcome that produced work. Naming the condition matters more than naming
            // the branch: an operator asking "why is this here" is asking which rule fired.
            return {
                tone: 'neutral',
                headline: 'a rule matched, and emitted this branch with no model call',
                detail: `condition: ${outcome.matched_condition}${outcome.branch === null ? '' : ` (branch ${outcome.branch})`}`,
            };
        case 'fell_through':
            // Warning, not neutral. Falling through is a legitimate design — a router may exist
            // precisely to do nothing in the common case — but it is indistinguishable on the
            // canvas from a rule set that no longer covers the data it was written for, and the
            // second is the reason someone opened this drawer. Neutral would hide the question;
            // an error would cry wolf on a healthy run.
            return {
                tone: 'warning',
                headline: 'no rule matched, so no branch was created',
                detail: 'the run continued past this router unchanged; check whether a condition should have covered this case',
            };
        case 'evaluation_error':
            // The rule set itself is broken here, which is an operator's problem rather than the
            // run's: the graph is missing work that the author intended to exist.
            return {tone: 'error', headline: 'a condition could not be evaluated', detail: outcome.reason ?? 'the log recorded no reason'};
        case 'proposal_rejected':
            // A rule fired and admission refused what it proposed. The violations are the answer,
            // and they are structured objects rather than prose, so they belong in the payload tab
            // where they can be read whole — a headline that flattened them would lose the detail
            // that makes them useful.
            return {
                tone: 'error',
                headline: 'a rule fired, but the branch it proposed was refused by admission',
                detail: `${outcome.violations.length} rule violation${outcome.violations.length === 1 ? '' : 's'}; see the payload tab for each one`,
            };
    }
}

export function DetailsTab({vertex, model}: {vertex: ConsoleVertex; model: ConsoleDagModel}): React.JSX.Element {
    const scope = model.scopes.find((candidate) => candidate.scope_id === vertex.txn.scope_id);
    const note = vertex.router_outcome ? describeRouterOutcome(vertex.router_outcome) : null;
    return (
        <>
            <dl className="detail-grid">
                <dt>role</dt>
                <dd>{vertex.role}</dd>
                <dt>status</dt>
                <dd className={`status-text status-${vertex.status}`}>{vertex.status}</dd>
                {vertex.tool ? (
                    <>
                        <dt>tool</dt>
                        <dd>
                            {vertex.tool}
                            {vertex.tool_version ? ` @ ${vertex.tool_version}` : ''}
                        </dd>
                    </>
                ) : null}
                <dt>created by</dt>
                {/* The distinction routers exist for: this branch was decided by a rule, with no
                    model consulted, and the graph's shape alone cannot say so. */}
                <dd>{vertex.decided_by === 'router' ? 'a routing rule, with no model call' : 'a planner'}</dd>
                <dt>frozen at</dt>
                <dd>run_seq {vertex.frozen_by_seq ?? vertex.created_seq}</dd>
                {vertex.pin_version ? (
                    <>
                        <dt>pinned contract</dt>
                        <dd className="mono">{vertex.pin_version}</dd>
                    </>
                ) : null}
                <dt>duration</dt>
                <dd>{vertex.timing.duration_ms === null ? (vertex.timing.started_at ? 'still running' : 'not started') : `${vertex.timing.duration_ms} ms`}</dd>
                {vertex.timing.attempts > 1 ? (
                    <>
                        <dt>attempts</dt>
                        <dd>{vertex.timing.attempts}</dd>
                    </>
                ) : null}
                <dt>in downstream prompts</dt>
                {/* Reported from the engine's own predicate, never restated here: a second copy of
                    that rule could disagree with the first and nothing would notice. */}
                <dd>{vertex.in_planner_prompt ? 'yes' : 'no — a downstream planner never sees this vertex'}</dd>
            </dl>

            {note ? (
                <section className={`router-note tone-${note.tone}`}>
                    <h4>{note.headline}</h4>
                    {note.detail ? <p>{note.detail}</p> : null}
                </section>
            ) : null}

            {vertex.txn.scope_id ? (
                <section>
                    <h4>transaction</h4>
                    <dl className="detail-grid">
                        <dt>scope</dt>
                        <dd className="mono">{vertex.txn.scope_id}</dd>
                        <dt>state</dt>
                        <dd>{scope?.state ?? 'not opened yet'}</dd>
                        <dt>effect</dt>
                        <dd>{vertex.txn.effect_class ?? 'none declared'}</dd>
                        <dt>pivot</dt>
                        <dd>{vertex.txn.is_pivot ? (vertex.txn.pivot_passed ? 'yes — passed, nothing past here compensates' : 'yes — not passed yet') : 'no'}</dd>
                        {vertex.bracket ? (
                            <>
                                <dt>bracket</dt>
                                <dd>{vertex.bracket.state}</dd>
                                <dt>idempotency key</dt>
                                <dd className="mono">{vertex.bracket.idempotency_key ?? '—'}</dd>
                            </>
                        ) : null}
                        {scope?.pivot_declaration_mismatch ? (
                            <>
                                <dt>warning</dt>
                                <dd className="tone-warning">the declared pivot disagrees with the derived one</dd>
                            </>
                        ) : null}
                    </dl>
                </section>
            ) : null}

            {vertex.cost ? (
                <section>
                    <h4>model call</h4>
                    <dl className="detail-grid">
                        <dt>model</dt>
                        <dd>{vertex.cost.model}</dd>
                        <dt>tokens</dt>
                        <dd>
                            {vertex.cost.input_tokens} in · {vertex.cost.output_tokens} out
                        </dd>
                        <dt>latency</dt>
                        <dd>{vertex.cost.duration_ms} ms</dd>
                        {vertex.cost.amount !== null ? (
                            <>
                                <dt>cost</dt>
                                <dd>
                                    {vertex.cost.amount} {vertex.cost.currency ?? ''}
                                </dd>
                            </>
                        ) : null}
                    </dl>
                </section>
            ) : null}

            {vertex.stall ? (
                <section className="router-note tone-error">
                    <h4>this planner answered, and the answer was not a proposal</h4>
                    <p>{vertex.stall.reason}</p>
                    <p className="drawer-note mono">{vertex.stall.answer_digest}</p>
                    <p className="drawer-note">
                        Nothing failed here, so the run has no failed vertex — it simply stopped. The recovery ladder treats this as a stall and asks this planner again with the refusal as evidence.
                    </p>
                </section>
            ) : null}

            {vertex.is_shadowed ? (
                <section className="router-note tone-warning">
                    <h4>discarded by a replan at run_seq {vertex.shadowed_at_seq}</h4>
                    <p>This work was planned and then abandoned. It stays on the canvas because what was discarded is usually what an operator came to look at.</p>
                </section>
            ) : null}

            <section>
                <h4>lifted log fields</h4>
                <JsonBlock value={vertex.log_fields} empty="this vertex lifted no summary fields" />
            </section>
        </>
    );
}
