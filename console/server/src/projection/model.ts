import type {EffectClass} from '../../../../engine/src/admission/check-rules.js';

/**
 * The shapes an operator's view of one run is made of.
 *
 * This module is a **type leaf**: it imports nothing but types, and nothing with a runtime. The
 * browser client imports these declarations directly rather than maintaining a mirror of them, so
 * a field renamed here breaks the client's build — which only works while this file pulls in no
 * `pg`, no `ajv`, and no Node builtins. Keep it that way; the projector lives next door.
 */

/** This projection's own version, independent of the planner pipeline's `projector_version`. */
export const CONSOLE_PROJECTOR_VERSION = 'console-projector@v1';

/** What an operator needs to know about one vertex, as opposed to what a model needs. */
export interface ConsoleVertex {
    vertex_id: string;
    parent_refs: string[];
    /** The author's own name for it, from the freeze that created it. Falls back to the id. */
    label: string;
    role: 'planner' | 'tool' | 'router' | 'confirmation-barrier' | 'unknown';
    /** Tool identifier and the version frozen onto it; null on every non-tool role. */
    tool: string | null;
    tool_version: string | null;
    status: 'created' | 'started' | 'succeeded' | 'failed' | 'retried';
    /**
     * Flagged, never removed. The planner's surface deletes a shadowed vertex to keep discarded
     * work out of a prompt; an operator is usually looking for exactly that work.
     */
    is_shadowed: boolean;
    /** `run_seq` of the `subgraph/shadowed` that hid it; null while it is still active. */
    shadowed_at_seq: number | null;
    /** Whether a rule or a planner decided this vertex exists. */
    decided_by: 'planner' | 'router';
    /** The external contract this vertex was frozen against, from the column. */
    pin_version: string | null;
    /** The frozen input, for a tool vertex. */
    input: Record<string, unknown> | null;
    /** The summary fields the executor lifted; the only fields a rule may read. */
    log_fields: Record<string, unknown> | null;
    /** `run_seq` of this vertex's `vertex/created`. The order the canvas grew in. */
    created_seq: number;
    /** `run_seq` of the freeze that created it: which planner turn or rule this branch came from. */
    frozen_by_seq: number | null;
    /** Distance from a root, so the client reads its layer rather than deriving one. */
    depth: number;
    txn: ConsoleTxn;
    timing: ConsoleTiming;
    /** The transaction bracket this vertex holds, once the Coordinator opens one. */
    bracket: ConsoleBracket | null;
    /** Present only on a router; null on every other role. */
    router_outcome: ConsoleRouterOutcome | null;
    /** What one model call cost, on a planner that has made one. */
    cost: ConsoleCallCost | null;
    /** Whether `linearize` would render this vertex into a downstream planner's prompt. */
    in_planner_prompt: boolean;
    /** Set on a planner whose answer the engine could not read as a proposal. */
    stall: ConsoleStall | null;
}

/**
 * A planner turn that produced no work.
 *
 * Worth a field of its own rather than a status, because the vertex did not fail: the model
 * answered and the engine refused to read the answer as a proposal. An operator looking at a run
 * that simply stopped needs to see which planner stopped it and why, and neither the status nor
 * the payload says so.
 */
export interface ConsoleStall {
    reason: string;
    /** The answer is not retained, for the same reason no prompt is; its digest identifies it. */
    answer_digest: string;
    at_run_seq: number;
}

/** Transaction position, all of it derived and none of it declared. */
export interface ConsoleTxn {
    /** From the `scope_id` column on `vertex/created`, never from a projection table. */
    scope_id: string | null;
    /** `effect_class === 'irreversible'`. Shown as a derivation, never accepted as a declaration. */
    is_pivot: boolean;
    /** From the tool vertex's own `vertex/created` payload; null off a tool. */
    effect_class: EffectClass | null;
    /** True once a `txn/pivot-passed` named this vertex: past here nothing compensates. */
    pivot_passed: boolean;
}

/** Wall-clock latency, taken from the `created_at` on the log rows and from nothing else. */
export interface ConsoleTiming {
    /** `created_at` of the first `vertex/started`; null until it starts. */
    started_at: string | null;
    /** `created_at` of the most recent `vertex/started`, which differs after a retry. */
    last_attempt_started_at: string | null;
    /** `created_at` of the terminal event; null while it is still running. */
    completed_at: string | null;
    /** End to end across retries; null unless both ends are known. */
    duration_ms: number | null;
    attempts: number;
}

/** One TCC or Saga bracket, as the log brackets it. */
export interface ConsoleBracket {
    state: 'sealed' | 'confirmed' | 'cancelled';
    idempotency_key: string | null;
    deadline_at: string | null;
}

/** The outcomes a router reaches, plus not having run yet. */
export type ConsoleRouterOutcome =
    | {kind: 'pending'}
    | {kind: 'matched'; matched_condition: string; branch: number | null}
    | {kind: 'fell_through'}
    | {kind: 'evaluation_error'; reason: string | null}
    | {kind: 'proposal_rejected'; violations: unknown[]};

/** What one planner call cost, from `budget/charged`. */
export interface ConsoleCallCost {
    model: string;
    duration_ms: number;
    input_tokens: number;
    output_tokens: number;
    /** Only when the charge carried a priced estimate. */
    amount: number | null;
    currency: string | null;
}

/** A transaction scope, drawn as an enclosure with its commit point marked. */
export interface ConsoleScope {
    scope_id: string;
    state: 'open' | 'cancelling' | 'committed' | 'cancelled' | 'suspended';
    /** Vertices whose `vertex/created` carried this `scope_id`. */
    member_vertex_ids: string[];
    /** Derived from member effect classes, never taken from a `txn/scope` declaration. */
    pivot_vertex_id: string | null;
    /** `run_seq` of `txn/pivot-passed`: the boundary the canvas draws. */
    pivot_passed_seq: number | null;
    /** True when a declaration disagreed with the derivation, which is worth seeing. */
    pivot_declaration_mismatch: boolean;
    opened_seq: number;
    closed_seq: number | null;
}

/** One replan: what it discarded, and where it resumed. */
export interface ConsoleReplan {
    at_run_seq: number;
    vertex_ids: string[];
    boundary_seq: number | null;
    boundary_vertex_id: string | null;
    reason: string | null;
}

/** One proposal and the terminal event that answered it, so a refusal is visible. */
export interface ConsoleProposal {
    proposed_seq: number;
    outcome: 'frozen' | 'rejected' | 'open';
    /** Whether a planner or a rule made this proposal. */
    source: 'planner' | 'router';
    terminal_seq: number | null;
    stage: string | null;
    violations: unknown[];
}

/** A counterfactual taken off this run, so an operator can follow it. */
export interface ConsoleCounterfactual {
    child_run_id: string;
    at_vertex_id: string;
    eval_up_to_seq: number;
    at_run_seq: number;
}

/** Accumulated model spend across the run. */
export interface ConsoleSpend {
    calls: number;
    input_tokens: number;
    output_tokens: number;
    /** Only when every charge carried an estimate in one currency. */
    amount: number | null;
    currency: string | null;
}

/**
 * One run's graph as an operator needs to see it.
 *
 * `kind` rather than a raw `seed_floor`: a counterfactual is structurally a run but is not a
 * workflow execution — it is never scheduled, may call nothing at all, and is capped so it never
 * completes. The data plane already keeps its writes apart; presenting it as an ordinary run would
 * undo that at the last step, so the projection names it and the client cannot get it wrong.
 */
export interface ConsoleDagModel {
    run_id: string;
    kind: 'production' | 'counterfactual';
    /** The highest `run_seq` folded. Every stream event is fenced against this. */
    at_run_seq: number;
    started_at: string | null;
    /** Ordered by `(created_seq, vertex_id)`. Shadowed vertices stay. */
    vertices: ConsoleVertex[];
    scopes: ConsoleScope[];
    replans: ConsoleReplan[];
    proposals: ConsoleProposal[];
    counterfactuals: ConsoleCounterfactual[];
    spend: ConsoleSpend;
    /**
     * Vertices a freeze has announced but whose `vertex/created` has not been folded yet.
     *
     * A freeze commits atomically with its vertices, so no reader can see one without the others —
     * but a reader may still *split* them across two reads, and the fold must not depend on where
     * that split falls. Holding the announcement here rather than in a local keeps the fold's
     * result a function of the events alone, which is what the reconnect property asserts.
     */
    announced: Record<string, {label: string; frozen_by_seq: number}>;
    console_projector_version: string;
}

/**
 * What every delta carries regardless of what changed.
 *
 * `spend` is here rather than only on the snapshot because it is a run-level rollup, and a client
 * forbidden to recompute rollups has no other way to keep it current: it would show the value the
 * snapshot happened to carry and go stale for the rest of the run. Sending it costs six numbers
 * per frame and keeps the rule — the client writes only what the server named — intact.
 */
interface ConsoleDeltaEnvelope {
    at_run_seq: number;
    ordinal: number;
    spend: ConsoleSpend;
}

/** A structural or status change one committed batch of events produced. */
export type ConsoleDelta =
    | (ConsoleDeltaEnvelope & {type: 'subgraph_appended'; vertices: ConsoleVertex[]; scopes: ConsoleScope[]})
    | (ConsoleDeltaEnvelope & {type: 'subgraph_shadowed'; replan: ConsoleReplan})
    | (ConsoleDeltaEnvelope & {type: 'vertex_patched'; vertex: ConsoleVertex});

/** The whole model, sent on connect and whenever deltas cannot close a gap. */
export interface ConsoleSnapshot {
    type: 'topology_snapshot';
    at_run_seq: number;
    ordinal: number;
    model: ConsoleDagModel;
}

/** Everything the stream can carry. */
export type ConsoleStreamEvent = ConsoleSnapshot | ConsoleDelta;

/** One row of the run list: enough to choose a run without opening it. */
export interface ConsoleRunSummary {
    run_id: string;
    kind: 'production' | 'counterfactual';
    created_at: string;
    /** Highest allocated sequence, which is activity rather than completion: runs do not end. */
    event_count: number;
}
