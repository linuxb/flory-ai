import {canonicalJson, type StoredEvent} from '../events.js';
import {surface, type FoldReducer} from '../projection.js';

/** The pass/fail result and optional detail returned by a harness oracle. */
export interface OracleResult {
    name: string;
    passed: boolean;
    detail?: string;
}
/** Detects mutations of transaction brackets inherited by a fork. */
export function noInheritedMutation(events: StoredEvent[]): OracleResult {
    const seed = events.find((event) => event.event_type === 'run/end-seed');
    if (!seed) return {name: 'O2.no_inherited_mutation', passed: true};
    const inheritedScopes = new Set(
        events
            .filter((event) => event.event_type === 'txn/try' && event.stream_seq < seed.stream_seq)
            .map((event) => event.scope_id)
            .filter((id): id is string => Boolean(id)),
    );
    const violation = events.find(
        (event) => event.stream_seq > seed.stream_seq && (event.event_type === 'txn/cancel' || event.event_type === 'txn/confirm') && event.scope_id && inheritedScopes.has(event.scope_id),
    );
    return violation ? {name: 'O2.no_inherited_mutation', passed: false, detail: `mutation at stream_seq ${violation.stream_seq}`} : {name: 'O2.no_inherited_mutation', passed: true};
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
