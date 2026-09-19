import {canonicalJson, type StoredEvent} from '../events.js';
import {assemble, linearize, slice, surface, type FoldReducer, type SurfaceVertex} from '../projection.js';

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
