import type {ConsoleDagModel, ConsoleScope, ConsoleVertex} from '../engine.js';

/**
 * Where each vertex sits, computed so that growth does not move what is already on screen.
 *
 * Written here rather than delegated because the requirement is unusual and neither library
 * satisfies it. `dagre` ranks stably under append but its ordering phase is global — a depth-first
 * pass plus barycentre sweeps — so adding one leaf can permute siblings several layers up, with no
 * option to pin the previous order. `elkjs` does solve it, at roughly ten times the bundle of
 * everything else here plus a configuration surface nobody would own. And neither knows about
 * transaction scopes, so either way the ordering would have to be fought to make an enclosure
 * drawable.
 *
 * Three properties of this graph make the hand-written version both short and stable:
 *
 *  1. Edges only ever run from an existing vertex to a new one, so a vertex's layer never changes.
 *     The server supplies `depth`, so even that is a read rather than a derivation.
 *  2. The server supplies a total order, `created_seq`, so within-layer order is a read too.
 *  3. Scope members must be adjacent for an enclosure to be honest, and only this code knows that.
 *
 * What it does not do is minimise edge crossings. That is a legibility cost, accepted against
 * reshuffling, which is a correctness-of-perception failure: on a console, motion means "something
 * happened here", and motion that means nothing teaches an operator to ignore motion.
 */

export interface LayoutOptions {
    nodeWidth: number;
    nodeHeight: number;
    layerGap: number;
    siblingGap: number;
    scopePadding: number;
}

export const DEFAULT_LAYOUT: LayoutOptions = {nodeWidth: 216, nodeHeight: 72, layerGap: 56, siblingGap: 24, scopePadding: 20};

export interface PlacedVertex {
    vertexId: string;
    /** Never changes once assigned, because a vertex never gains a parent. */
    layer: number;
    /** Ordinal within the layer. Never permutes relative to a sibling. */
    index: number;
    x: number;
    y: number;
}

export interface PlacedScope {
    scopeId: string;
    x: number;
    y: number;
    width: number;
    height: number;
    /** Canvas y of the commit boundary, or null while the scope has no pivot. */
    pivotY: number | null;
    /** False when members are not contiguous, and an enclosure would enclose non-members. */
    drawable: boolean;
}

export interface LayoutResult {
    vertices: ReadonlyMap<string, PlacedVertex>;
    scopes: readonly PlacedScope[];
    bounds: {width: number; height: number};
}

/**
 * Places every vertex, keeping anything already placed exactly where it was.
 *
 * `previous` is what makes that a guarantee rather than a tendency: an existing vertex keeps its
 * `(layer, index)` outright, and only new vertices are assigned.
 */
export function layout(model: ConsoleDagModel, options: LayoutOptions = DEFAULT_LAYOUT, previous?: LayoutResult): LayoutResult {
    const scopeRank = new Map<string, number>();
    for (const vertex of model.vertices) {
        const scopeId = vertex.txn.scope_id;
        // First appearance order, so members of one scope cluster together and an enclosure has a
        // chance of being an honest rectangle.
        if (scopeId && !scopeRank.has(scopeId)) scopeRank.set(scopeId, scopeRank.size);
    }

    const layers = new Map<number, string[]>();
    const pinned = new Map<string, PlacedVertex>();
    const fresh: ConsoleVertex[] = [];
    for (const vertex of model.vertices) {
        const kept = previous?.vertices.get(vertex.vertex_id);
        if (kept) {
            pinned.set(vertex.vertex_id, kept);
            layers.set(kept.layer, [...(layers.get(kept.layer) ?? []), vertex.vertex_id]);
        } else {
            fresh.push(vertex);
        }
    }
    // New vertices sort by scope first so an enclosure stays contiguous, then by the order the run
    // recorded. Both keys come from the server; neither is invented here.
    //
    // An unscoped vertex ranks *after* every scope, which is not arbitrary: a scope's members
    // must hold the same columns in every layer they occupy, or the rectangle drawn around them
    // spans columns that a non-member owns in some other layer. Ranking unscoped work first put
    // it in column 0 wherever it happened to appear, which pushed the scope's column sideways
    // layer by layer and made the enclosure undrawable on the very first real run.
    const rankOf = (scopeId: string | null): number => (scopeId ? (scopeRank.get(scopeId) ?? scopeRank.size) : scopeRank.size);
    fresh.sort((first, second) => rankOf(first.txn.scope_id) - rankOf(second.txn.scope_id) || first.created_seq - second.created_seq);
    for (const vertex of fresh) layers.set(vertex.depth, [...(layers.get(vertex.depth) ?? []), vertex.vertex_id]);

    const placed = new Map<string, PlacedVertex>();
    let widest = 0;
    for (const [layer, ids] of [...layers].sort((first, second) => first[0] - second[0])) {
        // Existing members keep their index; new ones take the next ones. Nothing is reordered.
        const existing = ids.filter((id) => pinned.has(id)).sort((first, second) => pinned.get(first)!.index - pinned.get(second)!.index);
        const added = ids.filter((id) => !pinned.has(id));
        const ordered = [...existing, ...added];
        widest = Math.max(widest, ordered.length);
        for (const [index, id] of ordered.entries()) {
            placed.set(id, {
                vertexId: id,
                layer,
                index,
                x: index * (options.nodeWidth + options.siblingGap),
                y: layer * (options.nodeHeight + options.layerGap),
            });
        }
    }

    const depth = Math.max(0, ...[...placed.values()].map((vertex) => vertex.layer)) + 1;
    return {
        vertices: placed,
        scopes: model.scopes.map((scope) => placeScope(scope, model, placed, options)),
        bounds: {width: widest * (options.nodeWidth + options.siblingGap), height: depth * (options.nodeHeight + options.layerGap)},
    };
}

/**
 * Boxes one scope around its members, and reports whether the box would tell the truth.
 *
 * A rectangle only encloses a scope's members without also enclosing non-members if the members
 * are contiguous in every layer they occupy. When they are not, the honest answer is to not draw
 * one: an enclosure around a vertex that is not in the scope is worse than no enclosure, because
 * an operator will believe it.
 */
function placeScope(scope: ConsoleScope, model: ConsoleDagModel, placed: ReadonlyMap<string, PlacedVertex>, options: LayoutOptions): PlacedScope {
    const members = scope.member_vertex_ids.map((id) => placed.get(id)).filter((vertex): vertex is PlacedVertex => Boolean(vertex));
    if (!members.length) return {scopeId: scope.scope_id, x: 0, y: 0, width: 0, height: 0, pivotY: null, drawable: false};

    const box = {
        x: Math.min(...members.map((member) => member.x)) - options.scopePadding,
        y: Math.min(...members.map((member) => member.y)) - options.scopePadding,
        right: Math.max(...members.map((member) => member.x)) + options.nodeWidth + options.scopePadding,
        bottom: Math.max(...members.map((member) => member.y)) + options.nodeHeight + options.scopePadding,
    };
    const pivot = scope.pivot_vertex_id ? placed.get(scope.pivot_vertex_id) : undefined;
    return {
        scopeId: scope.scope_id,
        x: box.x,
        y: box.y,
        width: box.right - box.x,
        height: box.bottom - box.y,
        // Between the pivot's layer and the one above it: everything above compensates, nothing
        // below does.
        pivotY: pivot ? pivot.y - options.layerGap / 2 : null,
        drawable: boxHolds(scope, placed, box, options),
    };
}

/**
 * Whether the rectangle contains only members.
 *
 * Checked against the actual rectangle rather than layer by layer, because the rectangle is a
 * single bounding box over every member and a per-layer check cannot see it. A scope occupying
 * column 1 in one layer and column 0 in the next produces a two-column box, and the vertex sitting
 * in column 1 of that second layer is enclosed by it while belonging to something else — which is
 * precisely what the first real run did. The operator would have read a foreign tool call as part
 * of the transaction, and believed it.
 */
function boxHolds(scope: ConsoleScope, placed: ReadonlyMap<string, PlacedVertex>, box: {x: number; y: number; right: number; bottom: number}, options: LayoutOptions): boolean {
    const members = new Set(scope.member_vertex_ids);
    for (const vertex of placed.values()) {
        if (members.has(vertex.vertexId)) continue;
        const overlaps = vertex.x < box.right && vertex.x + options.nodeWidth > box.x && vertex.y < box.bottom && vertex.y + options.nodeHeight > box.y;
        if (overlaps) return false;
    }
    return true;
}
