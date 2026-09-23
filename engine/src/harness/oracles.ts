import {canonicalJson, type StoredEvent} from '../log/events.js';
import {assemble, linearize, slice, surface, type FoldReducer, type SurfaceVertex} from '../log/projection.js';

/** The pass/fail result and optional detail returned by a harness oracle. */
export interface OracleResult {
    name: string;
    passed: boolean;
    detail?: string;
}
/** Detects fork-authored mutations of inherited transaction brackets, keyed on provenance rather than position. */
export function noInheritedMutation(events: StoredEvent[]): OracleResult {
    const inheritedScopes = new Set(
        events
            .filter((event) => event.event_type === 'txn/try' && event.inherited)
            .map((event) => event.scope_id)
            .filter((id): id is string => Boolean(id)),
    );
    if (!inheritedScopes.size) return {name: 'O2.no_inherited_mutation', passed: true};
    const violation = events.find((event) => !event.inherited && (event.event_type === 'txn/cancel' || event.event_type === 'txn/confirm') && event.scope_id && inheritedScopes.has(event.scope_id));
    return violation ? {name: 'O2.no_inherited_mutation', passed: false, detail: `mutation at run_seq ${violation.run_seq}`} : {name: 'O2.no_inherited_mutation', passed: true};
}
/** Checks that a no-substitution fork reproduces its source surface. */
export function replayIdentity(source: StoredEvent[], child: StoredEvent[]): OracleResult {
    const sourceSurface = canonicalJson([...surface(source).vertices.values()].sort((a, b) => a.vertex_id.localeCompare(b.vertex_id)));
    const childSurface = canonicalJson([...surface(child).vertices.values()].sort((a, b) => a.vertex_id.localeCompare(b.vertex_id)));
    return {name: 'O2.replay_identity', passed: sourceSurface === childSurface, detail: sourceSurface === childSurface ? undefined : 'surfaces differ'};
}
/** Checks that a supplied domain reducer is independent of concurrent event order. */
export function foldPermutationInvariant<View>(first: StoredEvent[], second: StoredEvent[], reducer: FoldReducer<View>): OracleResult {
    const firstView = canonicalJson(reducer.reduce(first));
    const secondView = canonicalJson(reducer.reduce(second));
    return {name: 'O4.permutation_invariant', passed: firstView === secondView, detail: firstView === secondView ? undefined : `fold differs for ${reducer.ref}`};
}

/**
 * O2.router_admission: a refused proposal froze nothing.
 *
 * Checks the window between each `subgraph/proposed` and the `subgraph/rejected` that answers it:
 * no vertex may be created inside it. That is the whole claim freeze-time admission makes — a
 * branch that cannot run where its router sits is refused before anything exists to run — and it
 * is the one property that fails the moment admission is moved after compilation.
 */
export function routerAdmission(events: StoredEvent[]): OracleResult {
    const name = 'O2.router_admission';
    for (const rejection of events.filter((event) => event.event_type === 'subgraph/rejected')) {
        const proposedSeq = (rejection.payload as {proposed_seq?: number}).proposed_seq ?? 0;
        const frozen = events.find((event) => event.event_type === 'vertex/created' && event.run_seq > proposedSeq && event.run_seq < rejection.run_seq);
        if (frozen) return {name, passed: false, detail: `vertex ${frozen.vertex_id} was created before the proposal at run_seq ${proposedSeq} was refused`};
    }
    return {name, passed: true};
}

/**
 * O4.router_invisibility: a rule that matches nothing renders exactly like no rule at all.
 *
 * Compared after replacing each vertex identifier with its rank in causal order. Two runs allocate
 * fresh identifiers for everything, and a prompt is ordered by identifier, so an unnormalized hash
 * would differ between any two runs of any scenario and could never detect what this row exists to
 * detect: whether a fall-through router adds a line to the prompt. Everything else — the items,
 * their contents, their relative order, and the versions the prompt is assembled under — is
 * compared verbatim, so an extra rendered line changes the hash.
 */
export function routerInvisibility(
    first: {events: StoredEvent[]; plannerVertexId: string},
    second: {events: StoredEvent[]; plannerVertexId: string},
    versions: {projector_version: string; harness_state_version: string},
): OracleResult {
    const name = 'O4.router_invisibility';
    const hashOf = (run: {events: StoredEvent[]; plannerVertexId: string}): string => assemble(linearize(byCausalRank(slice(surface(run.events), run.plannerVertexId))), versions).hash;
    const firstHash = hashOf(first);
    const secondHash = hashOf(second);
    return firstHash === secondHash ? {name, passed: true} : {name, passed: false, detail: `prompt hashes differ: ${firstHash} vs ${secondHash}`};
}

/**
 * Renames every vertex to its rank in creation order, keeping parent references consistent.
 *
 * Zero-padded so that the identifier sort `linearize` applies reproduces creation order rather than
 * scattering the tenth vertex among the first ten.
 */
function byCausalRank(vertices: SurfaceVertex[]): SurfaceVertex[] {
    const rank = new Map([...vertices].sort((a, b) => a.created_seq - b.created_seq).map((vertex, index) => [vertex.vertex_id, `#${String(index).padStart(6, '0')}`]));
    return vertices.map((vertex) => ({...vertex, vertex_id: rank.get(vertex.vertex_id)!, parent_refs: vertex.parent_refs.map((parent) => rank.get(parent) ?? parent)}));
}

/**
 * O2.rule_pin_substitution: a rule-template counterfactual differs in a pin, never in topology.
 *
 * Compares the two surfaces with every identifier and every pin erased, so what remains is the
 * shape: roles and the parent structure between them. Interposition is mandatory and applies
 * uniformly, so substituting which rule a router binds cannot move a vertex; a structural
 * difference means it was not applied uniformly, and the surfaces are then not comparable by the
 * standard evaluators at all.
 */
export function rulePinSubstitution(source: StoredEvent[], fork: StoredEvent[]): OracleResult {
    const name = 'O2.rule_pin_substitution';
    const sourceShape = shapeOf(source);
    const forkShape = shapeOf(fork);
    return sourceShape === forkShape ? {name, passed: true} : {name, passed: false, detail: 'fork and source differ structurally, not only in a pin'};
}

/** Renders a run's vertex topology with identifiers replaced by their position in role order. */
function shapeOf(events: StoredEvent[]): string {
    const vertices = [...surface(events).vertices.values()].sort((a, b) => a.vertex_id.localeCompare(b.vertex_id));
    const position = new Map(vertices.map((vertex, index) => [vertex.vertex_id, index]));
    return canonicalJson(
        vertices.map((vertex) => ({
            role: vertex.role,
            tool: vertex.tool ?? null,
            parents: vertex.parent_refs.map((parent) => position.get(parent) ?? -1).sort((a, b) => a - b),
        })),
    );
}

/**
 * O2.no_deterministic_replan: a failure inside a router-emitted branch never calls a model.
 *
 * A branch emitted by a router is told apart from the planner the router feeds by when it was
 * created, not by its shape: both hang off the router, but the planner is frozen in the same
 * subgraph as the router, before the router has ever run, while an emitted branch can only be
 * created after the router started. The router's own `vertex/started` is therefore the dividing
 * line, and not its `vertex/succeeded`: a router emits its branch first and reports success after,
 * so success is already too late to separate the two.
 * Once a deterministic branch fails, handing it to a model would let the model invent a way around
 * a rule that was meant to bind, so a replan that *selects* a planner, or a planner starting
 * anywhere after that failure, is itself the defect ([03 §2.5](../../doc/design/03-replan-and-recovery.md)).
 * The ladder's own answer is allowed and expected: a request to cancel the branch's scope, then an
 * escalation — a `replan/boundary` whose `selected` is null.
 */
export function noDeterministicReplan(events: StoredEvent[]): OracleResult {
    const name = 'O2.no_deterministic_replan';
    const created = events.filter((event) => event.event_type === 'vertex/created' && event.vertex_id);
    const routers = new Set(created.filter((event) => (event.payload as {role?: string}).role === 'router').map((event) => event.vertex_id!));
    const startedAt = new Map(events.filter((event) => event.event_type === 'vertex/started' && event.vertex_id && routers.has(event.vertex_id)).map((event) => [event.vertex_id!, event.run_seq]));

    // A vertex is on a deterministic branch when a running router emitted it, or when it descends
    // from one that was.
    const deterministic = new Set<string>();
    for (const event of created) {
        const emittedBy = event.parent_refs.some((parent) => (startedAt.get(parent) ?? Infinity) < event.run_seq);
        if (emittedBy || event.parent_refs.some((parent) => deterministic.has(parent))) deterministic.add(event.vertex_id!);
    }

    const failure = events.find((event) => event.event_type === 'vertex/failed' && event.vertex_id && deterministic.has(event.vertex_id));
    if (!failure) return {name, passed: true};
    const replan = events.find((event) => event.event_type === 'replan/boundary' && event.run_seq > failure.run_seq && event.payload.selected);
    if (replan) return {name, passed: false, detail: `replan/boundary at run_seq ${replan.run_seq} follows a deterministic branch failure at ${failure.run_seq}`};
    const planners = new Set(created.filter((event) => (event.payload as {role?: string}).role === 'planner').map((event) => event.vertex_id!));
    const called = events.find((event) => event.event_type === 'vertex/started' && event.run_seq > failure.run_seq && event.vertex_id && planners.has(event.vertex_id));
    return called ? {name, passed: false, detail: `planner ${called.vertex_id} started after a deterministic branch failure at run_seq ${failure.run_seq}`} : {name, passed: true};
}

/*
 * Cancel-before-replan (03 §2.4 rule 1), checked on the log rather than recomputed.
 *
 * The three oracles below read transaction state with their own few lines instead of the engine's
 * scope fold. They check the engine's decisions, so borrowing its reading of the log would let a
 * misreading pass both sides at once.
 */

/** When each scope opened, and when (if ever) it closed, read directly off the log. */
function scopeHistory(events: readonly StoredEvent[]): Map<string, {openedAt: number; cancellingAt?: number; closedAt?: number; suspendedAt?: number; pivotAt?: number; members: Set<string>}> {
    const scopes = new Map<string, {openedAt: number; cancellingAt?: number; closedAt?: number; suspendedAt?: number; pivotAt?: number; members: Set<string>}>();
    const entry = (scopeId: string) => {
        let found = scopes.get(scopeId);
        if (!found) {
            found = {openedAt: Infinity, members: new Set()};
            scopes.set(scopeId, found);
        }
        return found;
    };
    for (const event of events) {
        if (!event.scope_id) continue;
        const scope = entry(event.scope_id);
        if (event.event_type === 'vertex/created' && event.vertex_id) scope.members.add(event.vertex_id);
        if (event.event_type === 'txn/scope' || event.event_type === 'txn/try') scope.openedAt = Math.min(scope.openedAt, event.run_seq);
        if (event.event_type === 'txn/scope' && (event.payload.state === 'committed' || event.payload.state === 'cancelled')) scope.closedAt ??= event.run_seq;
        if (event.event_type === 'txn/scope' && event.payload.state === 'suspended') scope.suspendedAt ??= event.run_seq;
        if (event.event_type === 'txn/cancel' && event.payload.phase === 'requested') scope.cancellingAt ??= event.run_seq;
        if (event.event_type === 'txn/cancel' && event.payload.phase === 'completed') scope.closedAt ??= event.run_seq;
        if (event.event_type === 'vertex/started' && event.payload.phase === 'pivot') scope.pivotAt ??= event.run_seq;
    }
    return scopes;
}

/**
 * O2.cancel_before_replan: no replan discards work from a scope that has not closed.
 *
 * For every `replan/boundary` that selects a planner, every scope the Coordinator had opened that
 * holds a vertex the following `subgraph/shadowed` discards must have closed — cancellation
 * completed, or committed — strictly before the boundary. A requested cancellation is not enough:
 * its inverses have not run. The boundary's `cancelled_scopes` must name only scopes that really
 * did finish cancelling before it.
 *
 * An escalation is held to the same standard for the failure's own scope: it may not be recorded
 * while that scope could still be cancelled — opened, and not yet closed, suspended or past its
 * pivot. Escalating there is the answer that used to strand a failure: recorded once, on a state
 * that a cancellation already under way was about to change.
 */
export function cancelBeforeReplan(events: StoredEvent[]): OracleResult {
    const name = 'O2.cancel_before_replan';
    const scopes = scopeHistory(events);
    for (const [index, boundary] of events.entries()) {
        if (boundary.event_type !== 'replan/boundary') continue;
        for (const cited of (boundary.payload.cancelled_scopes as string[] | undefined) ?? []) {
            const closed = scopes.get(cited)?.closedAt;
            const completed = events.some((event) => event.event_type === 'txn/cancel' && event.scope_id === cited && event.payload.phase === 'completed' && event.run_seq < boundary.run_seq);
            if (!completed || closed === undefined) return {name, passed: false, detail: `boundary at run_seq ${boundary.run_seq} cites ${cited} as cancelled before it had finished cancelling`};
        }
        if (!boundary.payload.selected) {
            const failed = boundary.payload.failed_vertex_id as string;
            const own = events.find((event) => event.event_type === 'vertex/created' && event.vertex_id === failed)?.scope_id;
            const scope = own ? scopes.get(own) : undefined;
            if (scope && scope.openedAt < boundary.run_seq) {
                const released = [scope.closedAt, scope.suspendedAt, scope.pivotAt].some((seq) => seq !== undefined && seq < boundary.run_seq);
                if (!released) return {name, passed: false, detail: `escalation at run_seq ${boundary.run_seq} left scope ${own} of ${failed} unreleased`};
            }
            continue;
        }
        const shadow = events.slice(index + 1).find((event) => event.event_type === 'subgraph/shadowed');
        const discarded = new Set((shadow?.payload.vertex_ids as string[] | undefined) ?? []);
        for (const [scopeId, scope] of scopes) {
            if (scope.openedAt > boundary.run_seq) continue;
            if (![...scope.members].some((member) => discarded.has(member))) continue;
            if (scope.closedAt === undefined || scope.closedAt > boundary.run_seq) {
                return {name, passed: false, detail: `boundary at run_seq ${boundary.run_seq} discards work in scope ${scopeId}, which had not closed`};
            }
        }
    }
    return {name, passed: true};
}

/**
 * O2.cancel_request_discipline: each cancellation is asked for once, of a scope that could still
 * cancel, and nothing answers the failure until every scope asked about has resolved.
 *
 * Resolved means cancellation completed, or suspended by the Coordinator. With `final`, the log is
 * a finished run and every request must also have resolved by its end.
 */
export function cancelRequestDiscipline(events: StoredEvent[], options: {final?: boolean} = {}): OracleResult {
    const name = 'O2.cancel_request_discipline';
    const scopes = scopeHistory(events);
    const requested = new Map<string, number>();
    const resolvedAt = (scopeId: string): number => Math.min(scopes.get(scopeId)?.closedAt ?? Infinity, scopes.get(scopeId)?.suspendedAt ?? Infinity);
    for (const request of events) {
        if (request.event_type !== 'replan/cancel-requested') continue;
        const failed = request.payload.failed_vertex_id as string;
        for (const scopeId of (request.payload.scope_ids as string[] | undefined) ?? []) {
            if (requested.has(scopeId)) return {name, passed: false, detail: `scope ${scopeId} requested twice, at run_seq ${requested.get(scopeId)} and ${request.run_seq}`};
            requested.set(scopeId, request.run_seq);
            const scope = scopes.get(scopeId);
            if (!scope || scope.openedAt > request.run_seq) return {name, passed: false, detail: `scope ${scopeId} was requested at run_seq ${request.run_seq} before the Coordinator opened it`};
            const settledBefore = [scope.cancellingAt, scope.closedAt, scope.suspendedAt, scope.pivotAt].some((seq) => seq !== undefined && seq < request.run_seq);
            if (settledBefore) return {name, passed: false, detail: `scope ${scopeId} was requested at run_seq ${request.run_seq} after it could no longer be cancelled`};
            const resolved = resolvedAt(scopeId);
            const early = events.find((event) => event.event_type === 'replan/boundary' && event.payload.failed_vertex_id === failed && event.run_seq > request.run_seq && event.run_seq < resolved);
            if (early) return {name, passed: false, detail: `boundary at run_seq ${early.run_seq} answered ${failed} before scope ${scopeId} resolved`};
            if (options.final && resolved === Infinity) return {name, passed: false, detail: `scope ${scopeId} requested at run_seq ${request.run_seq} never resolved`};
        }
    }
    return {name, passed: true};
}

/**
 * O2.one_answer_per_failure: a failure is answered at most once.
 *
 * Between one failure of a vertex (or one unreadable answer from a planner) and the next, at most
 * one `replan/boundary` names it. Two would mean the ladder decided the same failure twice — once
 * escalating on a state that was about to change, and once again after it had.
 */
export function oneAnswerPerFailure(events: StoredEvent[]): OracleResult {
    const name = 'O2.one_answer_per_failure';
    const answers = new Map<string, number>();
    for (const event of events) {
        const failedVertex = event.event_type === 'vertex/failed' ? event.vertex_id : event.event_type === 'subgraph/unreadable' ? (event.payload.planner_vertex_id as string) : null;
        if (failedVertex) answers.set(failedVertex, 0);
        if (event.event_type !== 'replan/boundary') continue;
        const answered = event.payload.failed_vertex_id as string;
        const count = (answers.get(answered) ?? 0) + 1;
        answers.set(answered, count);
        if (count > 1) return {name, passed: false, detail: `${answered} answered a second time at run_seq ${event.run_seq}`};
    }
    return {name, passed: true};
}
