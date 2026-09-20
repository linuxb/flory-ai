import {linearize, slice, surface} from '../../../engine/src/projection.js';
import type {OracleResult} from '../../../engine/src/harness/oracles.js';
import type {StoredEvent} from '../../../engine/src/events.js';
import {consoleDag} from './projection.js';

/**
 * Harness oracles that need both projections at once.
 *
 * They live here rather than beside the others in `engine/src/harness/` because they depend on the
 * console projection, and the dependency runs one way: the console consumes the engine, never the
 * reverse. An oracle about the disagreement between two readers belongs with the newer reader.
 */
/**
 * O4.console_router_visibility: the two projections disagree about a fall-through router, and
 * about nothing else.
 *
 * An operator's canvas must carry the junction, so it is visible that a decision point existed and
 * that no rule matched. The downstream prompt must not, because interposition is mandatory and a
 * rendered fall-through would add a line at every junction of every prompt
 * ([10 §8](../../doc/design/10-deterministic-routers.md#8-prompt-invisibility)).
 *
 * Asserted within **one** run, which is what makes it different from `routerInvisibility`. That
 * oracle compares two runs differing only in whether a rule is bound, and so can show that binding
 * a non-matching rule changes nothing. This one shows that the same log, read by two readers,
 * yields a router in one and not the other — a conjunction no pair of runs can express.
 */
export function consoleRouterVisibility(events: StoredEvent[], target: {routerVertexId: string; plannerVertexId: string}): OracleResult {
    const name = 'O4.console_router_visibility';
    const model = consoleDag(events);
    const router = model.vertices.find((vertex) => vertex.vertex_id === target.routerVertexId);
    if (!router) return {name, passed: false, detail: 'the console projection does not carry the router at all'};
    if (router.router_outcome?.kind !== 'fell_through') return {name, passed: false, detail: `router outcome is ${router.router_outcome?.kind}, not a fall-through`};
    if (router.is_shadowed) return {name, passed: false, detail: 'the router is on the canvas but greyed out as discarded'};

    const prompt = linearize(slice(surface(events), target.plannerVertexId));
    const rendered = prompt.find((item) => item.vertex_id === target.routerVertexId);
    if (rendered) return {name, passed: false, detail: `the fall-through router reached the planner's prompt as ${JSON.stringify(rendered)}`};
    // The projection's own account of the same fact, which the canvas reads rather than re-deriving.
    if (router.in_planner_prompt) return {name, passed: false, detail: 'the console says this router renders into a prompt, and it does not'};
    return {name, passed: true};
}
