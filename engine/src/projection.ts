import {createHash} from 'node:crypto';
import {canonicalJson, EVENT_TYPES, type StoredEvent} from './events.js';

/** A vertex represented in a run's active surface. */
export interface SurfaceVertex {
    vertex_id: string;
    parent_refs: string[];
    role?: string;
    tool?: string;
    parameters?: unknown;
    result?: unknown;
    status?: string;
    /** On a router: the condition that matched, or null when it fell through. */
    matched_condition?: string | null;
    created_seq: number;
}
/** The active vertex view for one run at a stream-sequence boundary. */
export interface Surface {
    run_id: string;
    at_run_seq: number;
    vertices: Map<string, SurfaceVertex>;
    shadowed: Set<string>;
}
/** A planner-context item derived from an active surface vertex. */
export interface ContextItem {
    vertex_id: string;
    role?: string;
    tool?: string;
    result?: unknown;
    status?: string;
    /** Present only on a router that matched, explaining why its branch exists. */
    condition?: string;
}
/** A pure, versioned domain reducer consumed by the framework projection pipeline. */
export interface FoldReducer<View> {
    ref: string;
    reduce(events: readonly StoredEvent[]): View;
}
/** Registers domain reducers without importing domain concepts into the engine. */
export class FoldRegistry {
    private readonly reducers = new Map<string, FoldReducer<unknown>>();

    /** Adds one versioned reducer reference. Duplicate references are a configuration error. */
    register<View>(reducer: FoldReducer<View>): void {
        if (this.reducers.has(reducer.ref)) throw new Error(`fold reducer already registered: ${reducer.ref}`);
        this.reducers.set(reducer.ref, reducer as FoldReducer<unknown>);
    }

    /** Executes a registered pure reducer for a single event stream. */
    fold<View>(ref: string, events: readonly StoredEvent[]): View {
        const reducer = this.reducers.get(ref);
        if (!reducer) throw new Error(`unknown fold reducer: ${ref}`);
        return reducer.reduce(events) as View;
    }
}

const known = new Set<string>(EVENT_TYPES);
function assertReadable(events: StoredEvent[]): void {
    for (const event of events) if (!known.has(event.event_type) && !event.ignorable) throw new Error(`unknown non-ignorable event in stream: ${event.event_type}`);
}
function stringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** Folds a run's events into its active vertex surface. */
export function surface(events: StoredEvent[], atRunSeq = Number.MAX_SAFE_INTEGER): Surface {
    assertReadable(events);
    const included = events.filter((event) => event.run_seq <= atRunSeq);
    const vertices = new Map<string, SurfaceVertex>();
    const shadowed = new Set<string>();
    for (const event of included) {
        if (event.event_type === 'vertex/created' && event.vertex_id) {
            vertices.set(event.vertex_id, {
                vertex_id: event.vertex_id,
                parent_refs: event.parent_refs,
                role: typeof event.payload.role === 'string' ? event.payload.role : undefined,
                tool: typeof event.payload.tool === 'string' ? event.payload.tool : undefined,
                parameters: event.payload.parameters,
                created_seq: event.run_seq,
            });
        }
        if (event.event_type === 'subgraph/shadowed') {
            for (const vertexId of stringArray(event.payload.vertex_ids)) shadowed.add(vertexId);
            for (const sequence of (event.payload.vertex_seqs as unknown[]) ?? []) {
                if (typeof sequence === 'number') for (const vertex of vertices.values()) if (vertex.created_seq === sequence) shadowed.add(vertex.vertex_id);
            }
        }
        if (event.vertex_id && (event.event_type === 'vertex/started' || event.event_type === 'vertex/succeeded' || event.event_type === 'vertex/failed' || event.event_type === 'vertex/retried')) {
            const vertex = vertices.get(event.vertex_id);
            if (vertex) {
                vertex.status = event.event_type.slice('vertex/'.length);
                if (event.event_type === 'vertex/succeeded') {
                    vertex.result = event.payload.result;
                    if ('matched_condition' in event.payload) {
                        const matched = event.payload.matched_condition;
                        vertex.matched_condition = typeof matched === 'string' ? matched : null;
                    }
                }
            }
        }
    }
    for (const vertexId of shadowed) vertices.delete(vertexId);
    return {run_id: included[0]?.run_id ?? '', at_run_seq: included.at(-1)?.run_seq ?? 0, vertices, shadowed};
}

/** Returns the active planner vertex and all of its active ancestors. */
export function slice(view: Surface, plannerVertexId: string): SurfaceVertex[] {
    if (!view.vertices.has(plannerVertexId)) throw new Error(`planner ${plannerVertexId} is not active`);
    const included = new Set<string>();
    const visit = (id: string): void => {
        if (included.has(id)) return;
        const vertex = view.vertices.get(id);
        if (!vertex) return;
        included.add(id);
        vertex.parent_refs.forEach(visit);
    };
    visit(plannerVertexId);
    return [...included].map((id) => view.vertices.get(id)!).sort((a, b) => a.vertex_id.localeCompare(b.vertex_id));
}

/**
 * Sorts active vertices by identifier and converts them to context items.
 *
 * A router appears only when it matched, and then only as the condition that explains the branch
 * it emitted. One that fell through is omitted entirely, so the downstream planner receives a
 * context byte-identical to a run in which no router existed. That matters because interposition
 * is mandatory: rendering fall-throughs would add a line at every junction of every prompt and
 * destroy the prefix stability the cache dividend rests on.
 */
export function linearize(vertices: SurfaceVertex[]): ContextItem[] {
    return [...vertices]
        .filter((vertex) => vertex.role !== 'router' || typeof vertex.matched_condition === 'string')
        .sort((a, b) => a.vertex_id.localeCompare(b.vertex_id))
        .map(({vertex_id, role, tool, result, status, matched_condition}) => ({
            vertex_id,
            role,
            tool,
            result,
            status,
            ...(typeof matched_condition === 'string' ? {condition: matched_condition} : {}),
        }));
}

/** Serializes a versioned planner context and returns its integrity hash. */
export function assemble(items: ContextItem[], versions: {projector_version: string; harness_state_version: string}): {text: string; hash: string} {
    const text = canonicalJson({harness_state_version: versions.harness_state_version, items, projector_version: versions.projector_version});
    return {text, hash: createHash('sha256').update(text).digest('hex')};
}

/** Computes every canonical projection layer for a planner vertex. */
export function dumpProjection<View>(
    events: StoredEvent[],
    plannerVertexId: string,
    versions: {projector_version: string; harness_state_version: string},
    registry?: FoldRegistry,
    reducerRef?: string,
) {
    const active = surface(events);
    const relevant = slice(active, plannerVertexId);
    const items = linearize(relevant);
    const fold = registry && reducerRef ? registry.fold<View>(reducerRef, events) : undefined;
    return {surface: [...active.vertices.values()].sort((a, b) => a.vertex_id.localeCompare(b.vertex_id)), slice: relevant, fold, linearize: items, assemble: assemble(items, versions)};
}
