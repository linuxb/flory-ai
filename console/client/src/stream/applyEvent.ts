import type {ConsoleDagModel, ConsoleStreamEvent, ConsoleVertex} from '../types/engine.js';

/**
 * Applying a delta, which is not the same as folding an event.
 *
 * The rule, stated so a reviewer can apply it mechanically:
 *
 * > The client may write a field only when the server named both the field and its value in the
 * > event. It may never compute a value from the graph.
 *
 * So a snapshot replaces the model, an append inserts exactly the vertices it carried, a shadow
 * marks exactly the ids it listed, and a patch swaps in the replacement vertex the server sent.
 * Nothing here walks `parent_refs`, derives a scope, infers an edge, or recomputes a status. If
 * this function ever needs to look at something other than the delta in front of it, the delta is
 * wrong and the fix belongs in the engine.
 */

/** The client's whole state: the server's model, plus an index. */
export interface ClientModel {
    readonly model: ConsoleDagModel;
    /** A lookup built from the same objects, by reference. Indexing is not folding. */
    readonly byId: ReadonlyMap<string, ConsoleVertex>;
}

export function clientModel(model: ConsoleDagModel): ClientModel {
    return {model, byId: new Map(model.vertices.map((vertex) => [vertex.vertex_id, vertex]))};
}

/** What applying one event did. */
export type ApplyOutcome =
    | {kind: 'applied'; next: ClientModel}
    /** Already seen. A resume redelivers the delta the cursor named, which is not an error. */
    | {kind: 'ignored'; reason: 'behind-watermark'}
    /** The client cannot continue from here and must ask the server again. */
    | {kind: 'resync'; reason: ResyncReason};

export type ResyncReason = 'delta-before-snapshot' | 'run-mismatch' | 'unknown-vertex' | 'unknown-event-type';

/**
 * Applies one stream event, or reports that the client must resync.
 *
 * `resync` is never handled here. It is returned to the connection, which reopens without a
 * cursor and receives a fresh snapshot — so the client has exactly one recovery mechanism, and it
 * is "ask the server again". That is what keeps it a renderer.
 *
 * There is deliberately no gap detection. `run_seq` counts log events, most of which produce no
 * console event, so two consecutive stream events are not consecutive in `run_seq` and a client
 * cannot tell a gap from an ordinary quiet stretch. Contiguity is the server's contract;
 * monotonicity is the only sequence rule the client is entitled to.
 */
export function applyEvent(current: ClientModel | null, event: ConsoleStreamEvent): ApplyOutcome {
    if (event.type === 'topology_snapshot') return {kind: 'applied', next: clientModel(event.model)};
    if (!current) return {kind: 'resync', reason: 'delta-before-snapshot'};
    if (event.at_run_seq <= current.model.at_run_seq) return {kind: 'ignored', reason: 'behind-watermark'};

    switch (event.type) {
        case 'subgraph_appended': {
            // Inserted verbatim, edges included: the payload carries them, so the client never
            // reads `parent_refs` to decide that an edge exists.
            const scopeIds = new Set(event.scopes.map((scope) => scope.scope_id));
            return applied(current, event.at_run_seq, {
                vertices: [...current.model.vertices, ...event.vertices],
                scopes: [...current.model.scopes.filter((scope) => !scopeIds.has(scope.scope_id)), ...event.scopes],
            });
        }
        case 'subgraph_shadowed': {
            const hidden = new Set(event.replan.vertex_ids);
            // Exactly the ids listed. Walking edges to find descendants would be shadow tracking
            // in the browser, which is the review gate this file exists to satisfy.
            for (const id of hidden) if (!current.byId.has(id)) return {kind: 'resync', reason: 'unknown-vertex'};
            return applied(current, event.at_run_seq, {
                vertices: current.model.vertices.map((vertex) => (hidden.has(vertex.vertex_id) ? {...vertex, is_shadowed: true, shadowed_at_seq: event.replan.at_run_seq} : vertex)),
                replans: [...current.model.replans.filter((replan) => replan.at_run_seq !== event.replan.at_run_seq), event.replan],
            });
        }
        case 'vertex_patched': {
            if (!current.byId.has(event.vertex.vertex_id)) return {kind: 'resync', reason: 'unknown-vertex'};
            // The whole vertex, not a sparse patch: there is nothing here to merge and therefore
            // nothing to be clever about.
            return applied(current, event.at_run_seq, {
                vertices: current.model.vertices.map((vertex) => (vertex.vertex_id === event.vertex.vertex_id ? event.vertex : vertex)),
            });
        }
        default:
            // An unrecognised type means the server knows something this build does not. Asking
            // again is the only honest response; guessing is how a canvas starts lying.
            return {kind: 'resync', reason: 'unknown-event-type'};
    }
}

/** Rebuilds the model with the given changes, advancing the watermark in the same construction. */
function applied(current: ClientModel, atRunSeq: number, changes: Partial<ConsoleDagModel>): ApplyOutcome {
    // The watermark moves with the state it describes, so the two cannot drift apart.
    return {kind: 'applied', next: clientModel({...current.model, ...changes, at_run_seq: atRunSeq})};
}
