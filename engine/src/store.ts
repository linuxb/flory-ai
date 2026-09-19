import {randomUUID} from 'node:crypto';
import {Pool, type PoolClient} from 'pg';
import type {ScopeSnapshot} from './check-rules.js';
import {assertEventDraft, type BusinessFactDraft, type DomainAppendResult, type EventDraft, type ForkRequest, type ForkSubstitution, type StoredBusinessEvent, type StoredEvent} from './events.js';

/** A service role permitted to append events. */
export type Actor = 'engine' | 'coordinator';
/** Connection and ownership settings for an event store. */
export interface EventStoreOptions {
    connectionString: string;
    actor: Actor;
}
/** Metadata describing the fork created from a source run. */
export interface ForkResult {
    child_run_id: string;
    /** Run sequence of the fork's `run/end-seed` event, always `eval_up_to_seq + 1`. */
    end_seed_seq: number;
    /** Inherited events copied into the seed before `run/end-seed`. */
    seed_event_count: number;
    /** Causally independent events left for lazy merging via {@link EventStore.mergeIndependentEvents}. */
    deferred_event_count: number;
}
/** The causal partition of a source window computed for one fork. */
export interface ForkSlice {
    /** Inherited events at or before the divergence vertex, copied as the fork's seed. */
    seed: StoredEvent[];
    /** Causally independent events after the divergence vertex, merged lazily on demand. */
    deferred: StoredEvent[];
    /** Causal descendants of the substituted divergence vertex; never inherited, the fork regenerates them. */
    invalidated: StoredEvent[];
    /** Run sequence of the divergence vertex's `vertex/created` event. */
    divergence_seq: number;
}

const EXECUTION_EVENT_TYPES = new Set(['vertex/started', 'vertex/succeeded', 'vertex/failed', 'vertex/retried', 'budget/charged']);

/** Returns every vertex causally downstream of one vertex, derived from `vertex/created` parent references. */
export function causalDescendants(events: readonly StoredEvent[], vertexId: string): Set<string> {
    const children = new Map<string, string[]>();
    for (const event of events) {
        if (event.event_type !== 'vertex/created' || !event.vertex_id) continue;
        for (const parent of event.parent_refs) children.set(parent, [...(children.get(parent) ?? []), event.vertex_id]);
    }
    const descendants = new Set<string>();
    const frontier = [vertexId];
    while (frontier.length) {
        for (const child of children.get(frontier.pop()!) ?? []) {
            if (!descendants.has(child)) {
                descendants.add(child);
                frontier.push(child);
            }
        }
    }
    return descendants;
}

/**
 * Partitions a source stream for a lazy causal fork (Doc 01 §5.2, Doc 08 §4). With substitutions present, the
 * divergence vertex's causal descendants and its own execution events are invalidated — their cause
 * changed, so the fork regenerates them; with no substitutions nothing is invalidated and everything
 * merges. All remaining events up to `eval_up_to_seq` are inherited: at or before the divergence
 * vertex they form the seed, after it they are deferred for lazy merging.
 */
export function computeForkSlice(source: readonly StoredEvent[], atVertexId: string, substitutions: readonly ForkSubstitution[], evalUpToSeq: number): ForkSlice {
    const window = source.filter((event) => event.run_seq <= evalUpToSeq);
    const divergence = window.find((event) => event.event_type === 'vertex/created' && event.vertex_id === atVertexId);
    if (!divergence) throw new Error(`divergence vertex ${atVertexId} is not created within eval_up_to_seq ${evalUpToSeq}`);
    const substituted = new Map(substitutions.map((item) => [item.run_seq, item.pin_version]));
    if (substituted.size !== substitutions.length) throw new Error('fork substitutions must not repeat a run sequence');
    for (const sequence of substituted.keys()) {
        const event = window.find((candidate) => candidate.run_seq === sequence);
        if (!event?.pin_version || event.vertex_id !== atVertexId) throw new Error(`substitution ${sequence} must name a pinned event of the divergence vertex`);
    }
    const invalidatedVertices = substituted.size ? causalDescendants(window, atVertexId) : new Set<string>();
    const isInvalidated = (event: StoredEvent): boolean => {
        if (!substituted.size) return false;
        if (event.vertex_id && invalidatedVertices.has(event.vertex_id)) return true;
        if (event.vertex_id === atVertexId && EXECUTION_EVENT_TYPES.has(event.event_type)) return true;
        return event.parent_refs.some((parent) => parent === atVertexId || invalidatedVertices.has(parent));
    };
    const seed: StoredEvent[] = [];
    const deferred: StoredEvent[] = [];
    const invalidated: StoredEvent[] = [];
    for (const event of window) {
        if (isInvalidated(event)) invalidated.push(event);
        else if (event.run_seq <= divergence.run_seq) seed.push(event);
        else deferred.push(event);
    }
    for (const sequence of substituted.keys()) {
        if (invalidated.some((event) => event.run_seq === sequence)) throw new Error(`substitution ${sequence} names an invalidated event`);
    }
    return {seed, deferred, invalidated, divergence_seq: divergence.run_seq};
}

function rowToEvent(row: Record<string, unknown>): StoredEvent {
    return {
        run_id: String(row.run_id),
        run_seq: Number(row.run_seq),
        global_seq: Number(row.global_seq),
        event_type: String(row.event_type),
        vertex_id: row.vertex_id ? String(row.vertex_id) : null,
        parent_refs: (row.parent_refs as string[] | null) ?? [],
        planner_id: row.planner_id ? String(row.planner_id) : null,
        scope_id: row.scope_id ? String(row.scope_id) : null,
        pin_version: row.pin_version ? String(row.pin_version) : null,
        ignorable: Boolean(row.ignorable),
        inherited: Boolean(row.inherited),
        payload: row.payload as Record<string, unknown>,
        created_at: new Date(row.created_at as string).toISOString(),
    };
}

function rowToBusinessEvent(row: Record<string, unknown>): StoredBusinessEvent {
    return {
        stream_id: String(row.stream_id),
        stream_seq: Number(row.stream_seq),
        global_seq: Number(row.global_seq),
        run_id: row.run_id === null ? null : String(row.run_id),
        run_seq: row.run_seq === null ? null : Number(row.run_seq),
        event_type: String(row.event_type),
        is_counterfactual: Boolean(row.is_counterfactual),
        payload: (row.payload ?? {}) as Record<string, unknown>,
        created_at: String(row.created_at),
    };
}

function toInheritedCopy(event: StoredEvent, pinOverride?: string): Record<string, unknown> {
    return {
        run_seq: event.run_seq,
        event_type: event.event_type,
        vertex_id: event.vertex_id,
        parent_refs: event.parent_refs,
        planner_id: event.planner_id,
        scope_id: event.scope_id,
        pin_version: pinOverride ?? event.pin_version,
        ignorable: event.ignorable,
        payload: event.payload,
    };
}

interface ForkProvenance {
    source_run_id: string;
    at_vertex_id: string;
    eval_up_to_seq: number;
    substitutions: ForkSubstitution[];
}

/** PostgreSQL-backed event-log store that enforces service event ownership. */
/** What freeze admission needs to know about the run a subgraph is freezing into. */
export interface RunAdmissionContext {
    scopes: ScopeSnapshot[];
    /** True on a fork run: an offline simulation, where no emitted branch may carry an effect. */
    isCounterfactual: boolean;
}

export class EventStore {
    private readonly pool: Pool;
    constructor(private readonly options: EventStoreOptions) {
        this.pool = new Pool({connectionString: options.connectionString});
    }
    /** Closes the underlying connection pool. */
    async close(): Promise<void> {
        await this.pool.end();
    }
    private requireEngine(): void {
        if (this.options.actor !== 'engine') throw new Error('operation requires engine role');
    }

    /** Creates a run with an optional caller-supplied identifier. */
    async createRun(runId = randomUUID()): Promise<string> {
        this.requireEngine();
        await this.pool.query('SELECT create_run($1)', [runId]);
        return runId;
    }
    /** Appends one or more validated events and returns their run sequence numbers. */
    async appendEvents(runId: string, events: EventDraft[]): Promise<number[]> {
        if (!events.length) throw new Error('appendEvents requires at least one event');
        events.forEach(assertEventDraft);
        const result = await this.pool.query<{run_seq: string}>('SELECT run_seq FROM append_events($1, $2::jsonb)', [runId, JSON.stringify(events)]);
        return result.rows.map((row) => Number(row.run_seq));
    }
    /** Atomically appends a frozen-subgraph event and its vertex-created events. */
    async appendFrozenSubgraph(runId: string, frozen: EventDraft, vertices: EventDraft[]): Promise<number[]> {
        this.requireEngine();
        if (frozen.event_type !== 'subgraph/frozen' || vertices.some((event) => event.event_type !== 'vertex/created'))
            throw new Error('frozen subgraph requires one frozen event followed by vertex/created events');
        return this.appendEvents(runId, [frozen, ...vertices]);
    }
    /** Reads one run in ascending stream-sequence order, optionally through a boundary. */
    async readStream(runId: string, atRunSeq?: number): Promise<StoredEvent[]> {
        const result = await this.pool.query('SELECT * FROM run_event_log WHERE run_id = $1 AND ($2::bigint IS NULL OR run_seq <= $2) ORDER BY run_seq', [runId, atRunSeq ?? null]);
        return result.rows.map(rowToEvent);
    }

    /**
     * Creates a lazy causal counterfactual fork at any vertex (Doc 01 §5.2, Doc 08 §4). The divergence point is a
     * vertex — planner or tool-caller, inside or outside a bracket, above or below the pivot floor.
     * Inherited copies preserve their source `run_seq`; the fork numbers its own events above
     * `eval_up_to_seq`, so `run/end-seed` lands at `eval_up_to_seq + 1`. Causally independent events
     * after the divergence vertex are merged lazily via {@link mergeIndependentEvents}.
     */
    async fork(request: ForkRequest): Promise<ForkResult> {
        this.requireEngine();
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const tail = await client.query<{tail_end: string}>('SELECT lock_fork_source($1) AS tail_end', [request.source_run_id]);
            const sourceTailEnd = Number(tail.rows[0]!.tail_end);
            if (!Number.isInteger(request.eval_up_to_seq) || request.eval_up_to_seq < 1 || request.eval_up_to_seq > sourceTailEnd)
                throw new Error('eval_up_to_seq must name a recorded source position');
            const source = await this.readStreamWith(client, request.source_run_id);
            const slice = computeForkSlice(source, request.at_vertex_id, request.substitutions, request.eval_up_to_seq);
            const childRunId = randomUUID();
            await client.query('SELECT create_fork_run($1, $2)', [childRunId, request.eval_up_to_seq]);
            await this.appendWith(client, request.source_run_id, [
                {
                    event_type: 'fork/created',
                    payload: {
                        child_run_id: childRunId,
                        source_run_id: request.source_run_id,
                        at_vertex_id: request.at_vertex_id,
                        eval_up_to_seq: request.eval_up_to_seq,
                        seed_event_count: slice.seed.length,
                        substitutions: request.substitutions,
                        fold_mode: request.fold_mode,
                        evaluator_pin: request.evaluator_pin,
                        projector_version: request.projector_version,
                        harness_state_version: request.harness_state_version,
                    },
                },
            ]);
            const substituted = new Map(request.substitutions.map((item) => [item.run_seq, item.pin_version]));
            await this.copyInheritedWith(
                client,
                childRunId,
                slice.seed.map((event) => toInheritedCopy(event, substituted.get(event.run_seq))),
            );
            const seeded = await this.appendWith(client, childRunId, [
                {
                    event_type: 'run/end-seed',
                    payload: {
                        source_run_id: request.source_run_id,
                        at_vertex_id: request.at_vertex_id,
                        eval_up_to_seq: request.eval_up_to_seq,
                        substitutions: request.substitutions,
                        seed_event_count: slice.seed.length,
                    },
                },
            ]);
            await client.query('COMMIT');
            return {child_run_id: childRunId, end_seed_seq: seeded[0]!, seed_event_count: slice.seed.length, deferred_event_count: slice.deferred.length};
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * Lazily merges causally independent source events into a fork, no further than `throughSeq`
     * (defaulting to the fork's `eval_up_to_seq`). The causal slice is re-derived from the fork
     * provenance recorded on `run/end-seed`, already-present sequences are skipped, and the merged
     * rows are read-only inherited copies preserving their source `run_seq`. Returns the merged
     * run sequences.
     */
    async mergeIndependentEvents(childRunId: string, throughSeq?: number): Promise<number[]> {
        this.requireEngine();
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('SELECT lock_fork_run($1)', [childRunId]);
            const child = await this.readStreamWith(client, childRunId);
            const seedEvent = child.find((event) => event.event_type === 'run/end-seed');
            if (!seedEvent) throw new Error(`fork ${childRunId} has no run/end-seed provenance`);
            const provenance = seedEvent.payload as unknown as ForkProvenance;
            const limit = Math.min(throughSeq ?? provenance.eval_up_to_seq, provenance.eval_up_to_seq);
            const source = await this.readStreamWith(client, provenance.source_run_id);
            const slice = computeForkSlice(source, provenance.at_vertex_id, provenance.substitutions, provenance.eval_up_to_seq);
            const present = new Set(child.map((event) => event.run_seq));
            const toMerge = slice.deferred.filter((event) => event.run_seq <= limit && !present.has(event.run_seq));
            if (toMerge.length) {
                await this.copyInheritedWith(
                    client,
                    childRunId,
                    toMerge.map((event) => toInheritedCopy(event)),
                );
            }
            await client.query('COMMIT');
            return toMerge.map((event) => event.run_seq);
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * Appends one orchestration event and the business facts it caused, writing both planes in one
     * transaction. Each sequence is allocated from a counter column on its owning row — the run row
     * first, then the stream row, which is the lock order the whole schema keeps — so a rollback
     * un-increments both and neither ordering develops a gap. Quarantine is decided by the
     * database from the run's fork provenance, never by the caller.
     */
    async appendDomainEvents(runId: string, streamId: string, event: EventDraft, facts: BusinessFactDraft[]): Promise<DomainAppendResult[]> {
        assertEventDraft(event);
        if (!facts.length) throw new Error('appendDomainEvents requires at least one business fact; use appendEvents for orchestration-only appends');
        const result = await this.pool.query<{run_seq: string; stream_seq: string}>('SELECT run_seq, stream_seq FROM append_domain_events($1, $2, $3::jsonb, $4::jsonb)', [
            runId,
            streamId,
            JSON.stringify(event),
            JSON.stringify(facts),
        ]);
        return result.rows.map((row) => ({run_seq: Number(row.run_seq), stream_seq: Number(row.stream_seq)}));
    }

    /**
     * Reads one business entity in ascending stream-sequence order. Counterfactual rows are a
     * fork's quarantined writes, so a production fold never sees them unless it asks.
     */
    async readBusinessStream(streamId: string, options: {throughStreamSeq?: number; includeCounterfactual?: boolean} = {}): Promise<StoredBusinessEvent[]> {
        const result = await this.pool.query(
            'SELECT * FROM business_event_stream WHERE stream_id = $1 AND ($2::boolean OR NOT is_counterfactual) AND ($3::bigint IS NULL OR stream_seq <= $3) ORDER BY stream_seq',
            [streamId, options.includeCounterfactual ?? false, options.throughStreamSeq ?? null],
        );
        return result.rows.map(rowToBusinessEvent);
    }

    /**
     * Reads everything freeze admission needs to know about a run it is about to freeze into.
     *
     * The two facts travel together because one gate consumes both: the scopes above decide where a
     * router sits, and a fork run makes the whole context read-only. `half-open` is not a stored
     * state — it is an unclosed scope holding a sealed but unconfirmed try, which is exactly what
     * forbids a fresh scope below it. Only `committed` and `cancelled` are terminal; `cancelling`,
     * `suspended`, `pivot-inflight` and `pivot-passed` are all still unclosed, so none of them may
     * be mistaken for a savepoint. `seed_floor` is the authoritative record that a run is a fork.
     */
    async readAdmissionContext(runId: string): Promise<RunAdmissionContext> {
        const scopes = await this.pool.query<{scope_id: string; state: string; pivots: number; sealed: boolean}>(
            `SELECT s.scope_id,
                    s.state,
                    (s.pivot_vertex_id IS NOT NULL)::int AS pivots,
                    EXISTS (SELECT 1 FROM txn_bracket b WHERE b.scope_id = s.scope_id AND b.state = 'sealed') AS sealed
               FROM txn_scope s
              WHERE s.run_id = $1
              ORDER BY s.opened_seq`,
            [runId],
        );
        const run = await this.pool.query<{fork: boolean}>('SELECT seed_floor IS NOT NULL AS fork FROM run WHERE run_id = $1', [runId]);
        return {
            scopes: scopes.rows.map((row) => ({scopeId: row.scope_id, state: snapshotState(row.state, row.sealed), pivotCount: Number(row.pivots)})),
            isCounterfactual: run.rows[0]?.fork ?? false,
        };
    }

    /**
     * Records one rule-template mutation in the configuration stream.
     *
     * A publication has no causing orchestration step, so it takes neither a run nor the
     * dual-allocation path: it is the one data-plane row with no `(run_id, run_seq)` provenance,
     * and the database constrains that exception rather than merely allowing it.
     */
    async appendConfigEvent(streamId: string, eventType: string, payload: Record<string, unknown>): Promise<number> {
        this.requireEngine();
        const result = await this.pool.query<{append_config_event: string}>('SELECT append_config_event($1, $2, $3::jsonb) AS append_config_event', [streamId, eventType, JSON.stringify(payload)]);
        return Number(result.rows[0]!.append_config_event);
    }

    private async appendWith(client: PoolClient, runId: string, events: EventDraft[]): Promise<number[]> {
        events.forEach(assertEventDraft);
        const result = await client.query<{run_seq: string}>('SELECT run_seq FROM append_events($1, $2::jsonb)', [runId, JSON.stringify(events)]);
        return result.rows.map((row) => Number(row.run_seq));
    }
    private async copyInheritedWith(client: PoolClient, runId: string, copies: Record<string, unknown>[]): Promise<void> {
        if (!copies.length) return;
        await client.query('SELECT run_seq FROM copy_inherited_events($1, $2::jsonb)', [runId, JSON.stringify(copies)]);
    }
    private async readStreamWith(client: PoolClient, runId: string): Promise<StoredEvent[]> {
        return (await client.query('SELECT * FROM run_event_log WHERE run_id = $1 ORDER BY run_seq', [runId])).rows.map(rowToEvent);
    }
}

/** Maps a stored scope state onto the four states admission distinguishes. */
function snapshotState(stored: string, hasSealedTry: boolean): ScopeSnapshot['state'] {
    if (stored === 'committed') return 'committed';
    if (stored === 'cancelled') return 'cancelled';
    return hasSealedTry ? 'half-open' : 'open';
}
