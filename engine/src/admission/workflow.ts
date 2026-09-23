import {randomUUID, createHash} from 'node:crypto';
import {canonicalJson, type EventDraft} from '../log/events.js';
import type {ProposalScope, ProposalVertex, RouterPlacement, SubDagProposal, VertexKind} from './check-rules.js';
import type {ResolvedToolView} from '../gateway/gateway-client.js';
import {slotIdOf} from '../router/rule-template.js';

/** Fields every submitted vertex carries, whatever its role. */
export interface SubmittedVertexBase {
    /** Author-chosen and human-readable. Never a UUID; the compiler allocates those. */
    id: string;
    parents?: string[];
    /** Author-chosen scope name, resolved to a UUID at compile time. */
    scope?: string;
}

/** A submitted tool call. */
export interface SubmittedToolVertex extends SubmittedVertexBase {
    kind: 'tool';
    tool: string;
    input?: Record<string, unknown>;
    idempotencyKey?: string;
    confirmedOutput?: boolean;
}

/** A submitted decision point that calls a model. */
export interface SubmittedPlannerVertex extends SubmittedVertexBase {
    kind: 'planner';
    goal?: string;
}

/** A submitted deterministic branch point. */
export interface SubmittedRouterVertex extends SubmittedVertexBase {
    kind: 'router';
    /** Pins a published rule template. Absent means an unbound slot, which falls through. */
    templateRef?: string;
}

/** A submitted barrier that waits for every required try to seal. */
export interface SubmittedBarrierVertex extends SubmittedVertexBase {
    kind: 'confirmation-barrier';
}

/** One vertex of a submitted workflow. */
export type SubmittedVertex = SubmittedToolVertex | SubmittedPlannerVertex | SubmittedRouterVertex | SubmittedBarrierVertex;

/** A workflow as its author wrote it, before the engine normalizes or compiles anything. */
export interface WorkflowSubmission {
    /** Caller-chosen idempotency key for this submission. */
    submissionId: string;
    schemaVersion: 'v1';
    vertices: SubmittedVertex[];
    scopes?: Array<{id: string; members: string[]}>;
    /**
     * Names the kind of workflow this is, for slot identity.
     *
     * A slot is keyed by workflow type, upstream tool types, and the planner it feeds, so that the
     * same junction in the same kind of workflow resolves the same rule however its vertices are
     * named.
     */
    workflowType?: string;
    /**
     * Existing vertex ids that every root of this submission attaches to.
     *
     * A router emitting a branch is the case this exists for: the branch is authored without
     * knowing the graph it lands in, so the engine supplies the causal edge back to the router
     * rather than the template naming a vertex it cannot know.
     */
    attachTo?: string[];
    /**
     * Who decided this submission exists.
     *
     * `submitted` is an author or a planner proposing work; `router` is a rule template emitting a
     * branch with no model consulted. The distinction is the whole point of a deterministic router
     * and it is invisible in the graph's shape, so a reader that had to infer it would be left
     * comparing a parent router's start sequence against its child's creation — or parsing a
     * submission id. Recording it makes an operator's most basic question about a branch — did a
     * model choose this? — answerable from the event that created it.
     */
    source?: 'submitted' | 'router';
}

/** A submission after the engine has inserted every router R14 requires. */
export interface NormalizedWorkflow {
    workflow: WorkflowSubmission;
    /** Author ids of the routers the engine inserted, for the proposal record. */
    interposed: string[];
}

/** The compiled form of one submission: the symbol table plus the events that persist it. */
export interface CompiledSubgraph {
    /** Author id to allocated vertex UUID. */
    vertexIds: Map<string, string>;
    /** Author scope name to allocated scope UUID. */
    scopeIds: Map<string, string>;
    /** `vertex/created` drafts in topological order. */
    drafts: EventDraft[];
}

/**
 * What freeze decided about one router, stamped onto the vertex it creates.
 *
 * Both fields are derived at freeze rather than authored: placement from the recorded scope state,
 * and the pin from resolving the template the router binds. Resolving at evaluation time instead
 * would make a replay read whatever the registry holds at replay time, so the same log could route
 * two different ways; pinning the digest makes the decision a function of recorded history, and
 * makes a rule change an ordinary `pin_version` substitution that leaves topology untouched.
 */
export interface RouterBinding {
    placement: RouterPlacement;
    /** Content digest of the bound template. Absent on an unbound slot, which falls through. */
    pinVersion?: string;
}

/** Suffix that names the router the engine interposes ahead of one planner. */
export const INTERPOSED_ROUTER_SUFFIX = '#router';

/**
 * Reports whether a planner still needs a router interposed ahead of it.
 *
 * The invariant the compiler produces is stronger than R14's prohibition and much simpler to reason
 * about: **every planner that has parents reaches them through exactly one router**. Rather than
 * classifying each parent, all of them move behind one junction, which is also what a slot identity
 * assumes — one planner, one junction, keyed by the set of what flows into it.
 *
 * A parentless planner is left alone: it begins the run, so there is no incoming edge to intercept
 * and nothing upstream for a rule to read.
 */
function needsInterposedRouter(parents: readonly string[], byId: ReadonlyMap<string, SubmittedVertex>): boolean {
    if (!parents.length) return false;
    // Already canonical, which is what makes the pass idempotent.
    return !(parents.length === 1 && byId.get(parents[0]!)!.kind === 'router');
}

/**
 * Puts a router in front of every planner that has parents.
 *
 * This is deliberately stronger than R14, which only prohibits a tool caller from handing control
 * straight to a planner. Guaranteeing the junction per planner rather than per edge means business
 * policy has one interception point wherever a decision is made, and it removes the question of
 * what each parent role should do.
 *
 * Idempotent by construction: after one pass every such planner has exactly one parent and that
 * parent is a router, so a second pass finds nothing to do. That is what lets the invariant be
 * asserted as a post-condition rather than trusted.
 */
export function normalizeWorkflow(submission: WorkflowSubmission): NormalizedWorkflow {
    const byId = new Map(submission.vertices.map((vertex) => [vertex.id, vertex]));
    for (const vertex of submission.vertices) {
        for (const parent of vertex.parents ?? []) {
            if (!byId.has(parent)) throw new Error(`workflow names unknown parent ${parent} for ${vertex.id}`);
        }
    }
    const vertices: SubmittedVertex[] = [];
    const interposed: string[] = [];
    for (const vertex of submission.vertices) {
        if (vertex.kind !== 'planner') {
            vertices.push(vertex);
            continue;
        }
        const parents = vertex.parents ?? [];
        if (!needsInterposedRouter(parents, byId)) {
            vertices.push(vertex);
            continue;
        }
        const routerId = `${vertex.id}${INTERPOSED_ROUTER_SUFFIX}`;
        // A deterministic id, not a random one: replay and pin-substitution forks both require the
        // frozen graph to be reproducible, and a random id would make a no-substitution fork diverge
        // structurally from its source.
        if (byId.has(routerId)) throw new Error(`cannot interpose a router for ${vertex.id}: ${routerId} already exists`);
        vertices.push({id: routerId, kind: 'router', parents: [...parents]});
        vertices.push({...vertex, parents: [routerId]});
        interposed.push(routerId);
    }
    return {workflow: {...submission, vertices}, interposed};
}

/**
 * Lowers a submission into the structure the checker admits.
 *
 * Deliberately lossy and one-way. `checkSubDag` accepts only a proposal and an immutable tool view
 * and performs no I/O, so everything the checker must not read — tool input, the template pin, the
 * planner's goal — is dropped here. Nothing ever lifts a proposal back into a submission.
 */
export function lowerToProposal(workflow: WorkflowSubmission): SubDagProposal {
    const vertices: ProposalVertex[] = workflow.vertices.map((vertex) => ({
        id: vertex.id,
        parents: [...(vertex.parents ?? [])],
        kind: vertex.kind as VertexKind,
        ...(vertex.kind === 'tool' ? {tool: vertex.tool} : {}),
        ...(vertex.scope ? {scopeId: vertex.scope} : {}),
        ...(vertex.kind === 'tool' && vertex.confirmedOutput ? {confirmedOutput: true} : {}),
        ...(vertex.kind === 'router' && vertex.templateRef ? {templateRef: vertex.templateRef} : {}),
    }));
    const scopes: ProposalScope[] = (workflow.scopes ?? []).map((scope) => ({id: scope.id, members: [...scope.members]}));
    return {vertices, scopes};
}

/** Orders vertices so every parent is emitted before its children. */
function topologicalOrder(vertices: readonly SubmittedVertex[]): SubmittedVertex[] {
    const byId = new Map(vertices.map((vertex) => [vertex.id, vertex]));
    const ordered: SubmittedVertex[] = [];
    const placed = new Set<string>();
    const visiting = new Set<string>();
    const visit = (id: string): void => {
        if (placed.has(id)) return;
        if (visiting.has(id)) throw new Error(`workflow contains a cycle at ${id}`);
        visiting.add(id);
        const vertex = byId.get(id)!;
        for (const parent of vertex.parents ?? []) visit(parent);
        visiting.delete(id);
        placed.add(id);
        ordered.push(vertex);
    };
    for (const vertex of vertices) visit(vertex.id);
    return ordered;
}

/**
 * Compiles a normalized workflow into the `vertex/created` drafts that persist it.
 *
 * `newId` is injected so this stays a pure function of its arguments and a unit test can pin the
 * output. Vertex ids are freshly allocated per freeze and never derived from the submission:
 * `work_queue.vertex_id` is a globally unique primary key and its insert is `ON CONFLICT DO
 * NOTHING`, so a reused id would produce vertices that pass every check and are silently never
 * enqueued.
 */
export function compileVertexDrafts(
    workflow: WorkflowSubmission,
    resolved: ResolvedToolView,
    bindings: ReadonlyMap<string, RouterBinding> = new Map(),
    newId: () => string = randomUUID,
    brackets: ReadonlyMap<string, readonly BracketRecord[]> = new Map(),
): CompiledSubgraph {
    const vertexIds = new Map(workflow.vertices.map((vertex) => [vertex.id, newId()]));
    const scopeIds = new Map((workflow.scopes ?? []).map((scope) => [scope.id, newId()]));
    const contracts = new Map(resolved.document.tools.map((tool) => [tool.tool_id, tool]));
    const slotIds = routerSlotIds(workflow);
    const drafts: EventDraft[] = [];
    for (const vertex of topologicalOrder(workflow.vertices)) {
        const declared = vertex.parents ?? [];
        // A root of this submission inherits the attach point; a vertex with parents inside the
        // submission already has its causal position.
        const parentRefs = declared.length ? declared.map((parent) => vertexIds.get(parent)!) : [...(workflow.attachTo ?? [])];
        const scopeId = vertex.scope ? scopeIds.get(vertex.scope) : undefined;
        if (vertex.scope && !scopeId) throw new Error(`${vertex.id} names undeclared scope ${vertex.scope}`);
        const draft: EventDraft = {
            event_type: 'vertex/created',
            vertex_id: vertexIds.get(vertex.id)!,
            parent_refs: parentRefs,
            payload: vertexPayload(vertex, contracts, resolved, slotIds.get(vertex.id), bindings.get(vertex.id), brackets),
        };
        // The pin is a column rather than a payload field, and deliberately so: a fork substitutes
        // pins by column, so a bound rule is substitutable by exactly the mechanism that already
        // substitutes a model endpoint or a tool contract.
        const pinVersion = bindings.get(vertex.id)?.pinVersion;
        if (pinVersion) draft.pin_version = pinVersion;
        // The scope is a column, not only a payload field: the database derives the executor class
        // from (payload, scope_id) as separate arguments, so a scoped vertex whose scope lives only
        // in the payload is routed to the Orchestrator, which then refuses it.
        if (scopeId) draft.scope_id = scopeId;
        drafts.push(draft);
    }
    return {vertexIds, scopeIds, drafts};
}

/**
 * Derives the slot coordinate of every interposed router.
 *
 * Exported because freeze resolves each router's template before compiling: the slot is the
 * coordinate that resolution looks up, and recomputing it in the caller would be a second copy of
 * the rule that decides which routers have one.
 *
 * Only an interposed one gets a slot: a declared router already pins its template, and giving it a
 * coordinate as well would create two ways to answer the same question.
 */
export function routerSlotIds(workflow: WorkflowSubmission): Map<string, string> {
    const byId = new Map(workflow.vertices.map((vertex) => [vertex.id, vertex]));
    const slots = new Map<string, string>();
    for (const vertex of workflow.vertices) {
        if (vertex.kind !== 'router' || vertex.templateRef || !vertex.id.endsWith(INTERPOSED_ROUTER_SUFFIX)) continue;
        const upstream = (vertex.parents ?? [])
            .map((parent) => byId.get(parent))
            .filter((parent): parent is SubmittedVertex & {kind: 'tool'} => parent?.kind === 'tool')
            .map((parent) => parent.tool);
        const target = vertex.id.slice(0, -INTERPOSED_ROUTER_SUFFIX.length);
        slots.set(vertex.id, slotIdOf(workflow.workflowType ?? 'default', upstream, target));
    }
    return slots;
}

function vertexPayload(
    vertex: SubmittedVertex,
    contracts: ReadonlyMap<string, ResolvedToolView['document']['tools'][number]>,
    resolved: ResolvedToolView,
    slotId?: string,
    binding?: RouterBinding,
    brackets: ReadonlyMap<string, readonly BracketRecord[]> = new Map(),
): Record<string, unknown> {
    if (vertex.kind === 'planner') return {role: 'planner', ...(vertex.goal ? {goal: vertex.goal} : {})};
    if (vertex.kind === 'confirmation-barrier') return {role: 'confirmation-barrier'};
    if (vertex.kind === 'router') {
        return {
            role: 'router',
            origin: vertex.id.endsWith(INTERPOSED_ROUTER_SUFFIX) ? 'interposed' : 'declared',
            ...(vertex.templateRef ? {template_ref: vertex.templateRef} : {}),
            ...(slotId ? {slot_id: slotId} : {}),
            ...(binding ? {placement: binding.placement} : {}),
        };
    }
    const contract = contracts.get(vertex.tool);
    if (!contract) throw new Error(`${vertex.id} names ${vertex.tool}, absent from the resolved tool view`);
    const retry = contract.retry_constraints;
    const base = baseIdempotencyKey(vertex, contract);
    const idempotencyKey = base === undefined ? undefined : nextIdempotencyKey(base, brackets.get(base) ?? []);
    return {
        role: 'tool',
        tool: contract.tool_id,
        tool_version: contract.tool_version,
        tool_view_digest: resolved.identity.tool_view_digest,
        input: vertex.input ?? {},
        retry_policy: {
            max_attempts: retry.max_attempts,
            initial_backoff_ms: retry.initial_backoff_ms,
            // The view carries thousandths so its canonical encoding stays integer-valued; the event
            // schema wants a plain number. Copying it straight through publishes a 1000x multiplier
            // that still satisfies the schema's `minimum: 1`.
            multiplier: retry.multiplier_milli / 1000,
            max_backoff_ms: retry.max_backoff_ms,
        },
        // effect_class is what the database routes on. Omitting `txn` makes the lookup NULL, which
        // silently turns a read into Coordinator work.
        txn: {
            effect_class: contract.txn.effect_class,
            mode: contract.txn.mode,
            ...(idempotencyKey ? {idempotency_key: idempotencyKey} : {}),
            ...(contract.txn.try_timeout_s ? {try_timeout_s: contract.txn.try_timeout_s} : {}),
            ...(contract.txn.confirm_tool ? {confirm_tool: contract.txn.confirm_tool} : {}),
            ...(contract.txn.cancel_tool ? {cancel_tool: contract.txn.cancel_tool} : {}),
            ...(contract.txn.compensate_tool ? {compensate_tool: contract.txn.compensate_tool} : {}),
            ...(contract.txn.status_tool ? {status_tool: contract.txn.status_tool} : {}),
            ...companionInputs(vertex, contract),
        },
    };
}

/**
 * Resolves each companion operation's arguments from the mapping its tool declared.
 *
 * Resolved here, at freeze, and recorded: a confirm that built its arguments at execution time
 * would be reconstructing them from a contract that may since have been republished, and a replay
 * would then confirm with arguments the original run never sent. Freezing them makes the companion
 * call a recorded fact, and leaves the Coordinator nothing to construct — which matters most
 * because a confirm runs *after* the pivot, where a refusal can no longer be rolled back.
 *
 * The mapping itself is the tool's to declare and never an executor's to infer. Passing the try's
 * own arguments through is the inference that looks harmless and is not: a companion takes the
 * identity of what was reserved, not the parameters the reservation was made with, so its schema is
 * usually narrower and refuses them.
 */
function companionInputs(vertex: SubmittedToolVertex, contract: ResolvedToolView['document']['tools'][number]): Record<string, Record<string, unknown>> {
    const inputs: Record<string, Record<string, unknown>> = {};
    for (const [field, mapping] of [
        ['confirm_input', contract.txn.confirm_arguments],
        ['cancel_input', contract.txn.cancel_arguments],
        ['compensate_input', contract.txn.compensate_arguments],
    ] as const) {
        if (!mapping) continue;
        const resolved: Record<string, unknown> = {};
        for (const [parameter, path] of Object.entries(mapping)) {
            const value = valueAtArgumentPath(vertex.input ?? {}, path);
            // A source the frozen arguments do not carry fails the freeze. Sending the companion a
            // parameter short would fail at dispatch instead, and after the pivot that is
            // unrecoverable, so the cheap refusal has to happen here.
            if (value === undefined) throw new Error(`${vertex.id} calls ${contract.tool_id}, whose ${field} reads ${path}, absent from its frozen arguments`);
            resolved[parameter] = value;
        }
        inputs[field] = resolved;
    }
    return inputs;
}

/** Resolves a `$.name` or `$.name.nested` path against a tool's frozen arguments. */
function valueAtArgumentPath(input: Record<string, unknown>, path: string): unknown {
    let current: unknown = input;
    for (const segment of path
        .replace(/^\$\.?/, '')
        .split('.')
        .filter(Boolean)) {
        if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
        current = (current as Record<string, unknown>)[segment];
    }
    return current;
}

/**
 * Resolves the idempotency key a contract's declared key path names.
 *
 * Frozen here rather than chosen at execution: a bracket is keyed by it, and an attempt retried
 * after a crash must present the same key or it becomes a second operation. A planner cannot supply
 * it either — it would be inventing the identity of a side effect it is not accountable for.
 *
 * The declared path is honoured literally, because it is the contract's own statement of what makes
 * two calls the same call. A tool keyed on the order says that two reserves for one order are one
 * operation; if they are not, the contract is where that is fixed, not here.
 *
 * A declared path that the frozen input does not satisfy fails the freeze. The alternative is an
 * empty key, and `txn_bracket` is keyed by it, so an empty one makes the first bracket anywhere in
 * the database collide with every later one.
 */
/** The business identity of a call: a submitted key, or the one its contract derives from the input. */
export function baseIdempotencyKey(vertex: SubmittedToolVertex, contract: ResolvedToolView['document']['tools'][number]): string | undefined {
    return vertex.idempotencyKey ?? derivedIdempotencyKey(vertex, contract);
}

function derivedIdempotencyKey(vertex: SubmittedToolVertex, contract: ResolvedToolView['document']['tools'][number]): string | undefined {
    const path = contract.txn.idempotency_key_path;
    if (!path) return undefined;
    const segments = path
        .replace(/^\$\.?/, '')
        .split('.')
        .filter(Boolean);
    let current: unknown = vertex.input ?? {};
    for (const segment of segments) {
        if (!current || typeof current !== 'object' || Array.isArray(current)) {
            current = undefined;
            break;
        }
        current = (current as Record<string, unknown>)[segment];
    }
    if (typeof current !== 'string' && typeof current !== 'number') {
        throw new Error(`${vertex.id} calls ${contract.tool_id}, whose idempotency key path ${path} resolves to nothing in its input`);
    }
    return `${contract.tool_id}:${current}`;
}

/** One transaction bracket already recorded under a business key or one of its generations. */
export interface BracketRecord {
    idempotencyKey: string;
    state: 'sealed' | 'confirmed' | 'cancelled';
}

/** The separator between a business key and its generation: `record.reserve:ORDER-1#2`. */
export const GENERATION_SEPARATOR = '#';

/**
 * The generation of `key` under `base`: 1 for the base key itself, `n` for `base#n`, and null when
 * `key` is not one of `base`'s generations at all (`base#x`, or a different key that merely starts
 * the same way).
 */
export function generationOf(base: string, key: string): number | null {
    if (key === base) return 1;
    if (!key.startsWith(`${base}${GENERATION_SEPARATOR}`)) return null;
    const suffix = key.slice(base.length + GENERATION_SEPARATOR.length);
    return /^[1-9][0-9]*$/.test(suffix) ? Number(suffix) : null;
}

/**
 * Chooses the idempotency key a new call is frozen with, given the brackets already recorded under
 * its business key.
 *
 * The business key alone is right almost always, and it is what makes a duplicated delivery one
 * operation: two tries for one order are one reservation. It stops being right once a cancellation
 * has run. A cancelled bracket is finished — its reservation was released — and a replan that
 * reserves for the same order again is a new operation, not a repeat of the old one. Freezing it
 * under the old key collides with the cancelled bracket (`txn_bracket` is keyed by it), and the
 * Coordinator could never record the new try at all. So a key all of whose generations were
 * cancelled moves on to the next generation, which the tool sees as a new reservation.
 *
 * A key with any generation still live — sealed, or confirmed — is not moved on: that call
 * genuinely is a duplicate of one in flight or done, and keeping the live key is what lets the
 * database and the Coordinator refuse it.
 */
export function nextIdempotencyKey(base: string, existing: readonly BracketRecord[]): string {
    const generations = existing
        .map((record) => ({record, generation: generationOf(base, record.idempotencyKey)}))
        .filter((entry): entry is {record: BracketRecord; generation: number} => entry.generation !== null);
    if (!generations.length) return base;
    // Any live generation wins over the latest one. Generations only move on past a cancelled one,
    // so a live generation below a newer one should not exist — but if it did, a fresh key would
    // make a second live reservation for one business operation, which is the one thing keys exist
    // to prevent. Keeping the live key lets the database and the Coordinator refuse the call.
    const live = generations.find((entry) => entry.record.state !== 'cancelled');
    if (live) return live.record.idempotencyKey;
    const latest = Math.max(...generations.map((entry) => entry.generation));
    return `${base}${GENERATION_SEPARATOR}${latest + 1}`;
}

/**
 * Returns the content address of a submission.
 *
 * Uses the event log's canonical encoding rather than the tool view's, which refuses non-integer
 * numbers that a submitted tool input may legitimately contain.
 */
export function submissionDigest(submission: WorkflowSubmission): string {
    return `sha256:${createHash('sha256').update(canonicalJson(submission), 'utf8').digest('hex')}`;
}
