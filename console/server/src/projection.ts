import {EVENT_TYPES, type StoredEvent} from '../../../engine/src/events.js';
import {rendersInPlannerPrompt} from '../../../engine/src/projection.js';
import type {EffectClass} from '../../../engine/src/check-rules.js';
import {
    CONSOLE_PROJECTOR_VERSION,
    type ConsoleBracket,
    type ConsoleCallCost,
    type ConsoleCounterfactual,
    type ConsoleDagModel,
    type ConsoleDelta,
    type ConsoleProposal,
    type ConsoleReplan,
    type ConsoleRouterOutcome,
    type ConsoleScope,
    type ConsoleVertex,
} from './model.js';

/**
 * The observability fold: one run's events, as an operator needs to read them.
 *
 * It is a projection in the same sense the planner's surface is — a pure function of one run's
 * events in `run_seq` order, reproducible from the log, carrying its own version so a rendering
 * can be attributed. It performs no I/O, reads no clock, and queries no projection table: `txn_scope`
 * and `txn_bracket` are themselves triggers over these same events, and they are additionally wrong
 * for a counterfactual, whose inherited rows the trigger skips.
 *
 * It exists beside the surface rather than replacing it because the two have opposite requirements.
 * Everything the surface drops it drops on purpose — shadowed subtrees so a model does not reason
 * about discarded work, timestamps so a prompt stays replayable, scope structure so a planner does
 * not read back its own declaration, a fall-through router so prompt prefixes stay stable — and an
 * operator needs every one of them.
 */

const KNOWN_EVENTS = new Set<string>(EVENT_TYPES);

/** Returns the model one run's fold starts from. */
export function emptyConsoleDag(runId: string, version = CONSOLE_PROJECTOR_VERSION): ConsoleDagModel {
    return {
        run_id: runId,
        kind: 'production',
        at_run_seq: 0,
        started_at: null,
        vertices: [],
        scopes: [],
        replans: [],
        proposals: [],
        counterfactuals: [],
        spend: {calls: 0, input_tokens: 0, output_tokens: 0, amount: null, currency: null},
        announced: {},
        console_projector_version: version,
    };
}

/** One fold step: the model it produced and the changes a live reader should be told about. */
export interface ConsoleStep {
    model: ConsoleDagModel;
    deltas: ConsoleDelta[];
}

/**
 * Folds one committed batch of events onto a model and reports what changed.
 *
 * The batch rather than the event is the unit, and that is load-bearing. `run_seq` is allocated
 * under the run row lock and a freeze commits its `subgraph/frozen` with all of its `vertex/created`
 * rows in one transaction, so a reader tailing the log never sees half a frozen subgraph — which
 * lets one `subgraph_appended` carry a whole branch instead of one delta per vertex.
 *
 * {@link consoleDag} is defined as a fold of this function rather than written separately. Two
 * implementations could let a client that resumed and a client that reconnected fresh end up with
 * different models, and that difference is precisely what the reconnect property asserts; with one
 * implementation the property cannot fail.
 */
export function advanceConsoleDag(model: ConsoleDagModel, batch: readonly StoredEvent[]): ConsoleStep {
    const state = new FoldState(model);
    for (const event of batch) state.apply(event);
    return state.finish();
}

/** Folds one run into its console model, optionally through a boundary. */
export function consoleDag(events: readonly StoredEvent[], atRunSeq = Number.MAX_SAFE_INTEGER, version = CONSOLE_PROJECTOR_VERSION): ConsoleDagModel {
    const included = events.filter((event) => event.run_seq <= atRunSeq);
    const runId = included[0]?.run_id ?? '';
    return advanceConsoleDag(emptyConsoleDag(runId, version), included).model;
}

/**
 * The mutable working set of one fold step.
 *
 * Vertices live in a `Map` while folding and are ordered once at the end, because a vertex is
 * touched many times and sorted once.
 */
class FoldState {
    private readonly vertices: Map<string, ConsoleVertex>;
    private readonly scopes: Map<string, ConsoleScope>;
    private readonly model: ConsoleDagModel;
    private readonly deltas: ConsoleDelta[] = [];
    /** Vertices created in this batch, keyed by the `run_seq` of the freeze that carried them. */
    private readonly appended = new Map<number, string[]>();
    /** Vertices whose state changed in this batch and which the batch did not create. */
    private readonly patched = new Set<string>();
    private lastSeq = 0;
    private ordinal = 0;

    constructor(previous: ConsoleDagModel) {
        this.model = {
            ...previous,
            vertices: [],
            scopes: [],
            replans: [...previous.replans],
            proposals: [...previous.proposals],
            counterfactuals: [...previous.counterfactuals],
            announced: {...previous.announced},
        };
        this.vertices = new Map(previous.vertices.map((vertex) => [vertex.vertex_id, vertex]));
        this.scopes = new Map(previous.scopes.map((scope) => [scope.scope_id, scope]));
    }

    apply(event: StoredEvent): void {
        // Fail closed, exactly as the surface does: an unknown event means this reader does not
        // understand the run, and rendering the part it does understand would be a lie of omission.
        if (!KNOWN_EVENTS.has(event.event_type) && !event.ignorable) throw new Error(`unknown non-ignorable event in stream: ${event.event_type}`);
        if (event.ignorable && !KNOWN_EVENTS.has(event.event_type)) return;
        this.lastSeq = Math.max(this.lastSeq, event.run_seq);
        if (!this.model.run_id) this.model.run_id = event.run_id;

        switch (event.event_type) {
            case 'run/start':
                this.model.started_at = event.created_at;
                return;
            case 'run/end-seed':
                this.model.kind = 'counterfactual';
                return;
            case 'fork/created':
                this.model.counterfactuals.push(counterfactualOf(event));
                return;
            case 'subgraph/proposed':
                this.model.proposals.push(proposalOf(event));
                return;
            case 'subgraph/rejected':
                this.closeProposal(event, 'rejected');
                return;
            case 'subgraph/frozen':
                this.freeze(event);
                return;
            case 'vertex/created':
                this.create(event);
                return;
            case 'vertex/started':
            case 'vertex/succeeded':
            case 'vertex/failed':
            case 'vertex/retried':
                this.lifecycle(event);
                return;
            case 'subgraph/shadowed':
                this.shadow(event);
                return;
            case 'replan/boundary':
                this.boundary(event);
                return;
            case 'txn/scope':
                this.scopeState(event);
                return;
            case 'txn/try':
            case 'txn/confirm':
            case 'txn/cancel':
                this.bracket(event);
                return;
            case 'txn/pivot-passed':
                this.pivotPassed(event);
                return;
            case 'budget/charged':
                this.charge(event);
                return;
            // A published rule lives in the configuration stream, never in a run. Named rather than
            // left to fall through, so the exhaustiveness check below stays meaningful.
            case 'rule_template/published':
            case 'run/end':
                return;
            default:
                return;
        }
    }

    finish(): ConsoleStep {
        // One total order: creation sequence, then identifier. Deliberately not the identifier
        // alone, which is what `linearize` uses to keep a prompt reproducible across replays. An
        // operator wants the order the run actually recorded, and this projection feeds no prompt
        // and is never compared across two runs, so the requirement that forces the other choice
        // does not apply here.
        const ordered = [...this.vertices.values()].sort((first, second) => first.created_seq - second.created_seq || first.vertex_id.localeCompare(second.vertex_id));
        for (const [, ids] of [...this.appended].sort((first, second) => first[0] - second[0])) {
            const vertices = ids.map((id) => this.vertices.get(id)!).sort((first, second) => first.created_seq - second.created_seq);
            const scopeIds = new Set(vertices.map((vertex) => vertex.txn.scope_id).filter((id): id is string => Boolean(id)));
            this.deltas.push({
                type: 'subgraph_appended',
                at_run_seq: this.lastSeq,
                ordinal: this.ordinal++,
                spend: this.model.spend,
                vertices,
                scopes: [...scopeIds].map((id) => this.scopes.get(id)!).filter(Boolean),
            });
        }
        for (const id of this.patched) {
            const vertex = this.vertices.get(id);
            // Complete replacement, never a sparse patch. A partial one would put merge semantics
            // in the browser — which fields may change, what a null means — and the surest defence
            // of a renderer that folds nothing is a wire format with nothing to be clever about.
            if (vertex) this.deltas.push({type: 'vertex_patched', at_run_seq: this.lastSeq, ordinal: this.ordinal++, spend: this.model.spend, vertex});
        }
        const watermark = Math.max(this.model.at_run_seq, this.lastSeq);
        return {
            model: {...this.model, at_run_seq: watermark, vertices: ordered, scopes: [...this.scopes.values()].sort((a, b) => a.opened_seq - b.opened_seq)},
            // Every delta is fenced at the watermark this batch reached, never at the sequence of
            // the event that motivated it, and ordinals are renumbered in send order. A freeze's
            // own `run_seq` is *lower* than the `vertex/created` rows committed with it, so an
            // append fenced there carries a cursor that runs backwards the moment a reader splits
            // a freeze from its vertices — which it may, because atomicity stops a partial commit
            // being visible but does not stop a poll boundary or a read limit falling between
            // them. A subscriber fences on the cursor, so that append is discarded as already
            // seen and every vertex in it is lost. Nothing is given up by this: which freeze
            // produced a vertex is on the vertex as `frozen_by_seq`, and which event a shadow
            // came from is inside the replan it carries.
            deltas: this.deltas.map((delta, index) => ({...delta, at_run_seq: watermark, ordinal: index, spend: this.model.spend})),
        };
    }

    /* ---------------------------------------------------------------- proposals and freezes */

    private closeProposal(event: StoredEvent, outcome: ConsoleProposal['outcome']): void {
        const payload = event.payload as {proposed_seq?: number; stage?: string; violations?: unknown[]};
        const proposal = this.model.proposals.find((candidate) => candidate.proposed_seq === payload.proposed_seq) ?? this.model.proposals.at(-1);
        if (!proposal) return;
        proposal.outcome = outcome;
        proposal.terminal_seq = event.run_seq;
        proposal.stage = payload.stage ?? null;
        proposal.violations = payload.violations ?? [];
    }

    private freeze(event: StoredEvent): void {
        this.closeProposal(event, 'frozen');
        const payload = event.payload as {vertices?: Array<{author_id: string; vertex_id: string}>; scopes?: Array<{author_id: string; scope_id: string}>};
        // Announced now, consumed as each vertex is created — possibly in a later read. One delta
        // then carries a whole branch however the reader split the stream.
        for (const entry of payload.vertices ?? []) this.model.announced[entry.vertex_id] = {label: entry.author_id, frozen_by_seq: event.run_seq};
        for (const entry of payload.scopes ?? []) this.ensureScope(entry.scope_id, event.run_seq);
    }

    /* ---------------------------------------------------------------- vertices */

    private create(event: StoredEvent): void {
        if (!event.vertex_id) return;
        const payload = event.payload as {role?: string; tool?: string; tool_version?: string; input?: Record<string, unknown>; txn?: {effect_class?: EffectClass}};
        const announced = this.model.announced[event.vertex_id];
        const role = vertexRole(payload.role);
        const effectClass = payload.txn?.effect_class ?? null;
        const vertex: ConsoleVertex = {
            vertex_id: event.vertex_id,
            parent_refs: [...event.parent_refs],
            label: announced?.label ?? event.vertex_id.slice(0, 8),
            role,
            tool: typeof payload.tool === 'string' ? payload.tool : null,
            tool_version: typeof payload.tool_version === 'string' ? payload.tool_version : null,
            status: 'created',
            is_shadowed: false,
            shadowed_at_seq: null,
            decided_by: this.decidedBy(event),
            pin_version: event.pin_version,
            input: payload.input ?? null,
            log_fields: null,
            created_seq: event.run_seq,
            frozen_by_seq: announced?.frozen_by_seq ?? null,
            depth: this.depthOf(event.parent_refs),
            txn: {scope_id: event.scope_id, is_pivot: effectClass === 'irreversible', effect_class: effectClass, pivot_passed: false},
            timing: {started_at: null, last_attempt_started_at: null, completed_at: null, duration_ms: null, attempts: 0},
            bracket: null,
            router_outcome: role === 'router' ? {kind: 'pending'} : null,
            cost: null,
            in_planner_prompt: rendersInPlannerPrompt({role}),
        };
        this.vertices.set(vertex.vertex_id, vertex);
        if (event.scope_id) {
            const scope = this.ensureScope(event.scope_id, event.run_seq);
            if (!scope.member_vertex_ids.includes(vertex.vertex_id)) scope.member_vertex_ids.push(vertex.vertex_id);
            if (vertex.txn.is_pivot) scope.pivot_vertex_id = vertex.vertex_id;
        }
        delete this.model.announced[vertex.vertex_id];
        const group = vertex.frozen_by_seq ?? vertex.created_seq;
        this.appended.set(group, [...(this.appended.get(group) ?? []), vertex.vertex_id]);
    }

    /**
     * Reports whether a rule or a planner decided this vertex exists.
     *
     * Read from the proposal that carried it, because the engine records it. The structural
     * alternative — a parent router that had already started when this vertex was created — is the
     * same conclusion reached by inference, and inference is what the recorded field replaced.
     */
    private decidedBy(event: StoredEvent): 'planner' | 'router' {
        const proposal = this.model.proposals.at(-1);
        return proposal?.source === 'router' && proposal.outcome === 'frozen' ? 'router' : 'planner';
    }

    /** Distance from a root, so the client reads its layer instead of deriving one. */
    private depthOf(parents: readonly string[]): number {
        let depth = 0;
        for (const parent of parents) {
            const known = this.vertices.get(parent);
            if (known) depth = Math.max(depth, known.depth + 1);
        }
        return depth;
    }

    private lifecycle(event: StoredEvent): void {
        const vertex = event.vertex_id ? this.vertices.get(event.vertex_id) : undefined;
        if (!vertex) return;
        const payload = event.payload as {
            result?: unknown;
            log_fields?: Record<string, unknown>;
            attempts?: number;
            matched_condition?: unknown;
            branch?: number;
            outcome?: string;
            reason?: string;
            violations?: unknown[];
        };
        const status = event.event_type.slice('vertex/'.length) as ConsoleVertex['status'];
        vertex.status = status;
        if (status === 'started') {
            vertex.timing.started_at ??= event.created_at;
            vertex.timing.last_attempt_started_at = event.created_at;
            vertex.timing.completed_at = null;
            vertex.timing.duration_ms = null;
            vertex.timing.attempts = Math.max(vertex.timing.attempts, 1);
        } else if (status === 'retried') {
            vertex.timing.attempts += 1;
            vertex.timing.completed_at = null;
            vertex.timing.duration_ms = null;
        } else {
            vertex.timing.completed_at = event.created_at;
            vertex.timing.duration_ms = elapsed(vertex.timing.started_at, event.created_at);
            if (typeof payload.attempts === 'number') vertex.timing.attempts = payload.attempts;
        }
        if (status === 'succeeded' && payload.log_fields) vertex.log_fields = payload.log_fields;
        if (vertex.role === 'router' && (status === 'succeeded' || status === 'failed')) {
            vertex.router_outcome = routerOutcome(status, payload);
            vertex.in_planner_prompt = rendersInPlannerPrompt({role: 'router', matched_condition: vertex.router_outcome.kind === 'matched' ? vertex.router_outcome.matched_condition : null});
        }
        this.touch(vertex.vertex_id);
    }

    /* ---------------------------------------------------------------- shadowing and replans */

    private shadow(event: StoredEvent): void {
        const payload = event.payload as {vertex_ids?: unknown; vertex_seqs?: unknown; reason?: string};
        const named = Array.isArray(payload.vertex_ids) ? payload.vertex_ids.filter((id): id is string => typeof id === 'string') : [];
        const bySeq = Array.isArray(payload.vertex_seqs) ? payload.vertex_seqs.filter((seq): seq is number => typeof seq === 'number') : [];
        const hidden = new Set(named);
        for (const vertex of this.vertices.values()) if (bySeq.includes(vertex.created_seq)) hidden.add(vertex.vertex_id);
        for (const id of hidden) {
            const vertex = this.vertices.get(id);
            // Flagged, never deleted. The surface removes it because a model must not reason about
            // discarded work; an operator is usually looking for exactly the discarded work.
            if (!vertex || vertex.is_shadowed) continue;
            vertex.is_shadowed = true;
            vertex.shadowed_at_seq = event.run_seq;
        }
        // Only the named ids, never their descendants — the same rule the surface applies. The two
        // projections must disagree about retention and agree about membership; a console that
        // shadowed more than the engine believes would be showing a graph that never existed.
        const replan: ConsoleReplan = {at_run_seq: event.run_seq, vertex_ids: [...hidden], boundary_seq: null, boundary_vertex_id: null, reason: payload.reason ?? null};
        this.model.replans.push(replan);
        this.deltas.push({type: 'subgraph_shadowed', at_run_seq: event.run_seq, ordinal: this.ordinal++, spend: this.model.spend, replan});
    }

    private boundary(event: StoredEvent): void {
        const payload = event.payload as {boundary_seq?: number; reason?: string};
        const open = [...this.model.replans].reverse().find((replan) => replan.boundary_seq === null);
        const replan = open ?? {at_run_seq: event.run_seq, vertex_ids: [], boundary_seq: null, boundary_vertex_id: null, reason: null};
        replan.boundary_seq = payload.boundary_seq ?? event.run_seq;
        replan.boundary_vertex_id = event.vertex_id;
        replan.reason = payload.reason ?? replan.reason;
        if (!open) this.model.replans.push(replan);
        this.deltas.push({type: 'subgraph_shadowed', at_run_seq: event.run_seq, ordinal: this.ordinal++, spend: this.model.spend, replan});
    }

    /* ---------------------------------------------------------------- transactions */

    private ensureScope(scopeId: string, openedSeq: number): ConsoleScope {
        const existing = this.scopes.get(scopeId);
        if (existing) return existing;
        const scope: ConsoleScope = {
            scope_id: scopeId,
            state: 'open',
            member_vertex_ids: [],
            pivot_vertex_id: null,
            pivot_passed_seq: null,
            pivot_declaration_mismatch: false,
            opened_seq: openedSeq,
            closed_seq: null,
        };
        this.scopes.set(scopeId, scope);
        return scope;
    }

    private scopeState(event: StoredEvent): void {
        if (!event.scope_id) return;
        const payload = event.payload as {state?: string; pivot_vertex?: string};
        const scope = this.ensureScope(event.scope_id, event.run_seq);
        const state = payload.state as ConsoleScope['state'] | undefined;
        if (state) scope.state = state;
        if (state === 'committed' || state === 'cancelled') scope.closed_seq = event.run_seq;
        // Compared, never assigned: a declaration that disagrees with the derivation is a fact an
        // operator should see rather than one the projection quietly adopts.
        if (payload.pivot_vertex && scope.pivot_vertex_id && payload.pivot_vertex !== scope.pivot_vertex_id) scope.pivot_declaration_mismatch = true;
        for (const id of scope.member_vertex_ids) this.touch(id);
    }

    private bracket(event: StoredEvent): void {
        const payload = event.payload as {idempotency_key?: string; deadline_at?: string; phase?: string};
        if (event.event_type === 'txn/try') {
            const vertex = event.vertex_id ? this.vertices.get(event.vertex_id) : undefined;
            if (!vertex) return;
            vertex.bracket = {state: 'sealed', idempotency_key: payload.idempotency_key ?? null, deadline_at: payload.deadline_at ?? null};
            this.touch(vertex.vertex_id);
            return;
        }
        if (event.event_type === 'txn/confirm') {
            const vertex = event.vertex_id ? this.vertices.get(event.vertex_id) : undefined;
            if (!vertex?.bracket) return;
            vertex.bracket = {...vertex.bracket, state: 'confirmed'};
            this.touch(vertex.vertex_id);
            return;
        }
        // txn/cancel is a scope action, never a per-try one.
        if (!event.scope_id) return;
        const scope = this.ensureScope(event.scope_id, event.run_seq);
        const completed = payload.phase === 'completed';
        scope.state = completed ? 'cancelled' : 'cancelling';
        if (completed) scope.closed_seq = event.run_seq;
        for (const id of scope.member_vertex_ids) {
            const member = this.vertices.get(id);
            if (completed && member?.bracket?.state === 'sealed') member.bracket = {...member.bracket, state: 'cancelled'};
            this.touch(id);
        }
    }

    private pivotPassed(event: StoredEvent): void {
        if (event.scope_id) {
            const scope = this.ensureScope(event.scope_id, event.run_seq);
            scope.pivot_passed_seq = event.run_seq;
        }
        const vertex = event.vertex_id ? this.vertices.get(event.vertex_id) : undefined;
        if (!vertex) return;
        vertex.txn = {...vertex.txn, pivot_passed: true};
        this.touch(vertex.vertex_id);
    }

    /* ---------------------------------------------------------------- spend */

    private charge(event: StoredEvent): void {
        const payload = event.payload as {
            requested_model?: string;
            response_model?: string;
            duration_ms?: number;
            usage?: {input_tokens?: number; output_tokens?: number};
            estimated_cost?: {amount?: number; currency?: string};
        };
        const cost: ConsoleCallCost = {
            model: payload.response_model ?? payload.requested_model ?? 'unknown',
            duration_ms: payload.duration_ms ?? 0,
            input_tokens: payload.usage?.input_tokens ?? 0,
            output_tokens: payload.usage?.output_tokens ?? 0,
            amount: payload.estimated_cost?.amount ?? null,
            currency: payload.estimated_cost?.currency ?? null,
        };
        const spend = this.model.spend;
        this.model.spend = {
            calls: spend.calls + 1,
            input_tokens: spend.input_tokens + cost.input_tokens,
            output_tokens: spend.output_tokens + cost.output_tokens,
            // Only priced when every charge so far carried an estimate in one currency; a partial
            // total is worse than none, because it reads as a total.
            amount: cost.amount === null || (spend.currency !== null && spend.currency !== cost.currency) ? null : (spend.amount ?? 0) + cost.amount,
            currency: cost.currency ?? spend.currency,
        };
        const vertex = event.vertex_id ? this.vertices.get(event.vertex_id) : undefined;
        if (!vertex) return;
        vertex.cost = cost;
        this.touch(vertex.vertex_id);
    }

    /** Records that a vertex changed, unless this batch also created it. */
    private touch(vertexId: string): void {
        for (const ids of this.appended.values()) if (ids.includes(vertexId)) return;
        this.patched.add(vertexId);
    }
}

/* ------------------------------------------------------------------ pure helpers */

function vertexRole(role: unknown): ConsoleVertex['role'] {
    return role === 'planner' || role === 'tool' || role === 'router' || role === 'confirmation-barrier' ? role : 'unknown';
}

function proposalOf(event: StoredEvent): ConsoleProposal {
    const payload = event.payload as {source?: string};
    return {proposed_seq: event.run_seq, outcome: 'open', source: payload.source === 'router' ? 'router' : 'planner', terminal_seq: null, stage: null, violations: []};
}

function counterfactualOf(event: StoredEvent): ConsoleCounterfactual {
    const payload = event.payload as {child_run_id?: string; at_vertex_id?: string; eval_up_to_seq?: number};
    return {child_run_id: payload.child_run_id ?? '', at_vertex_id: payload.at_vertex_id ?? '', eval_up_to_seq: payload.eval_up_to_seq ?? 0, at_run_seq: event.run_seq};
}

function routerOutcome(status: 'succeeded' | 'failed', payload: {matched_condition?: unknown; branch?: number; outcome?: string; reason?: string; violations?: unknown[]}): ConsoleRouterOutcome {
    if (status === 'failed') {
        return payload.outcome === 'proposal_rejected' ? {kind: 'proposal_rejected', violations: payload.violations ?? []} : {kind: 'evaluation_error', reason: payload.reason ?? null};
    }
    return typeof payload.matched_condition === 'string' ? {kind: 'matched', matched_condition: payload.matched_condition, branch: payload.branch ?? null} : {kind: 'fell_through'};
}

/**
 * Milliseconds between two recorded timestamps.
 *
 * Parsing a recorded `created_at` is not a clock read: the store normalizes every one of them
 * through `toISOString`, so the input is an offset-free ISO-8601 string and the result depends on
 * neither the locale nor the time zone this runs in.
 */
function elapsed(startedAt: string | null, completedAt: string): number | null {
    if (!startedAt) return null;
    return Date.parse(completedAt) - Date.parse(startedAt);
}

export type {ConsoleBracket};
