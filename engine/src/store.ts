import {randomUUID} from 'node:crypto';
import {Pool, type PoolClient} from 'pg';
import type {ScopeAdmissionBlock, ScopeSnapshot} from './check-rules.js';
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
    /** Inherited events copied before `run/end-seed`: the seed and the independent events both. */
    inherited_event_count: number;
}
/** The causal partition of a source window computed for one fork. */
export interface ForkSlice {
    /** Inherited events at or before the divergence vertex. */
    seed: StoredEvent[];
    /** Inherited events after the divergence vertex that are causally independent of it. */
    independent: StoredEvent[];
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
 * merges. All remaining events up to `eval_up_to_seq` are inherited, split only to describe where
 * they sit: at or before the divergence vertex they are the seed, after it they are the causally
 * independent remainder. Both are copied when the counterfactual is created.
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
    const independent: StoredEvent[] = [];
    const invalidated: StoredEvent[] = [];
    for (const event of window) {
        if (isInvalidated(event)) invalidated.push(event);
        else if (event.run_seq <= divergence.run_seq) seed.push(event);
        else independent.push(event);
    }
    for (const sequence of substituted.keys()) {
        if (invalidated.some((event) => event.run_seq === sequence)) throw new Error(`substitution ${sequence} names an invalidated event`);
    }
    return {seed, independent, invalidated, divergence_seq: divergence.run_seq};
}

/**
 * Maps one `run_event_log` row onto a stored event.
 *
 * Exported so a read-only reader shares it rather than keeping a second copy. The `created_at`
 * normalization below is load-bearing for anything deriving a duration from the log, and two
 * copies of it would drift apart silently.
 */
export function rowToEvent(row: Record<string, unknown>): StoredEvent {
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

/** PostgreSQL-backed event-log store that enforces service event ownership. */
/**
 * The read surface a console-class reader needs. {@link EventStore} structurally satisfies it.
 *
 * Narrowed so the Console depends on reading rather than on the store that happens to provide it,
 * and so a reader connected as a role with no write privileges can stand in without pretending to
 * be an `EventStore`.
 */
export interface RunEventReader {
    readStream(runId: string, atRunSeq?: number): Promise<StoredEvent[]>;
    readStreamAfter(runId: string, afterRunSeq: number, limit?: number): Promise<StoredEvent[]>;
}

/** What freeze admission needs to know about the run a subgraph is freezing into. */
export interface RunAdmissionContext {
    scopes: ScopeSnapshot[];
    /** True on a fork run: an offline simulation, where no emitted branch may carry an effect. */
    isCounterfactual: boolean;
}

/**
 * What a freeze decided once it could see the run's scopes under lock: the events to append, or a
 * refusal whose reasons the caller already holds.
 */
export type FreezeDecision = {admitted: true; events: EventDraft[]} | {admitted: false};

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
    /**
     * Takes one freeze decision and its append inside a single transaction that holds the run's
     * scope rows.
     *
     * Reading the scope state and appending afterwards is not the same thing as deciding under the
     * lock. Between the two, a sweeper can fence the very scope the decision was made about, and
     * the vertices this freeze writes would then queue work under a cancellation already in
     * progress. Holding `txn_scope FOR UPDATE` across the append is also the schema's lock order
     * (Doc 08 §3) — scope first, then the `work_queue` rows the enqueue trigger inserts — which is
     * what lets branch admission, worker claiming and sweeper cancellation serialize through one
     * row instead of deadlocking against each other.
     *
     * `decide` runs exactly once, inside the open transaction, and must stay pure: any I/O of its
     * own would be performed while holding those locks.
     */
    async freezeUnderScopeLock(runId: string, decide: (context: RunAdmissionContext) => FreezeDecision): Promise<number[] | null> {
        this.requireEngine();
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const decision = decide(await this.readAdmissionContextWith(client, runId));
            if (!decision.admitted) {
                await client.query('ROLLBACK');
                return null;
            }
            const [frozen, ...vertices] = decision.events;
            if (frozen?.event_type !== 'subgraph/frozen' || vertices.some((event) => event.event_type !== 'vertex/created'))
                throw new Error('frozen subgraph requires one frozen event followed by vertex/created events');
            const sequences = await this.appendWith(client, runId, decision.events);
            await client.query('COMMIT');
            return sequences;
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }
    /**
     * Reads one run's events after a position, for a reader following a live run.
     *
     * Distinct from {@link readStream}'s `atRunSeq`, which bounds a fold from above: this bounds it
     * from below, so following a run costs an index range scan inside one hash partition and
     * returns nothing at all when nothing has happened.
     */
    async readStreamAfter(runId: string, afterRunSeq: number, limit = 512): Promise<StoredEvent[]> {
        const result = await this.pool.query('SELECT * FROM run_event_log WHERE run_id = $1 AND run_seq > $2 ORDER BY run_seq LIMIT $3', [runId, afterRunSeq, limit]);
        return result.rows.map(rowToEvent);
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
     * `eval_up_to_seq`, so `run/end-seed` lands at `eval_up_to_seq + 1`.
     *
     * Everything the counterfactual will ever inherit is copied here, in this transaction. The
     * split between the seed and the causally independent remainder describes where those events
     * sat in the source, not when they arrive: both are known the moment the slice is computed, so
     * deferring either would only mean writing later what is already decided. It would also leave
     * inherited rows landing *below* a reader's watermark long after the counterfactual's own
     * events — every inherited copy keeps its source `run_seq`, which is at or under
     * `eval_up_to_seq`, while its own events start above — and any reader following the log would
     * silently miss them.
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
                        inherited_event_count: slice.seed.length + slice.independent.length,
                        substitutions: request.substitutions,
                        fold_mode: request.fold_mode,
                        evaluator_pin: request.evaluator_pin,
                        projector_version: request.projector_version,
                        harness_state_version: request.harness_state_version,
                    },
                },
            ]);
            const substituted = new Map(request.substitutions.map((item) => [item.run_seq, item.pin_version]));
            // One list: a substitution can only name the divergence vertex's own pinned event,
            // which `computeForkSlice` validates and which therefore always sits in the seed.
            const inherited = [...slice.seed, ...slice.independent];
            await this.copyInheritedWith(
                client,
                childRunId,
                inherited.map((event) => toInheritedCopy(event, substituted.get(event.run_seq))),
            );
            const seeded = await this.appendWith(client, childRunId, [
                {
                    event_type: 'run/end-seed',
                    payload: {
                        source_run_id: request.source_run_id,
                        at_vertex_id: request.at_vertex_id,
                        eval_up_to_seq: request.eval_up_to_seq,
                        substitutions: request.substitutions,
                        inherited_event_count: inherited.length,
                    },
                },
            ]);
            await client.query('COMMIT');
            return {child_run_id: childRunId, end_seed_seq: seeded[0]!, inherited_event_count: inherited.length};
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

    /**
     * Reads everything freeze admission needs to know about the run it is freezing into, holding
     * every one of that run's scope rows for the rest of the transaction.
     *
     * The two facts travel together because one gate consumes both: the scopes above decide where a
     * router sits, and a fork run makes the whole context read-only. `half-open` is not a stored
     * state — it is an unclosed scope holding a sealed but unconfirmed try, which is exactly what
     * forbids a fresh scope below it. Only `committed` and `cancelled` are terminal; `cancelling`,
     * `suspended`, `pivot-inflight` and `pivot-passed` are all still unclosed, so none of them may
     * be mistaken for a savepoint. `seed_floor` is the authoritative record that a run is a fork.
     */
    private async readAdmissionContextWith(client: PoolClient, runId: string): Promise<RunAdmissionContext> {
        const scopes = await client.query<{scope_id: string; state: string; pivot_count: number; has_sealed_try: boolean; has_expired_try: boolean}>(
            'SELECT scope_id, state, pivot_count, has_sealed_try, has_expired_try FROM lock_run_scopes($1)',
            [runId],
        );
        const run = await client.query<{fork: boolean}>('SELECT seed_floor IS NOT NULL AS fork FROM run WHERE run_id = $1', [runId]);
        return {scopes: scopes.rows.map(rowToScopeSnapshot), isCounterfactual: run.rows[0]?.fork ?? false};
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

/** Maps one locked scope row onto the snapshot the pure checker reads. */
function rowToScopeSnapshot(row: {scope_id: string; state: string; pivot_count: number; has_sealed_try: boolean; has_expired_try: boolean}): ScopeSnapshot {
    const block = admissionBlock(row.state, row.has_expired_try);
    return {
        scopeId: row.scope_id,
        state: snapshotState(row.state, row.has_sealed_try),
        pivotCount: Number(row.pivot_count),
        ...(block ? {admissionBlock: block} : {}),
    };
}

/** Maps a stored scope state onto the four states admission distinguishes. */
function snapshotState(stored: string, hasSealedTry: boolean): ScopeSnapshot['state'] {
    if (stored === 'committed') return 'committed';
    if (stored === 'cancelled') return 'cancelled';
    return hasSealedTry ? 'half-open' : 'open';
}

/**
 * Reports why a scope refuses new work, when it does.
 *
 * `snapshotState` deliberately collapses every unclosed state onto `open` or `half-open`, because
 * that is all the structural rules need to know. Admission needs the distinction it drops: a
 * fencing scope and an open one look identical to R12 and behave nothing alike.
 */
function admissionBlock(stored: string, hasExpiredSealedTry: boolean): ScopeAdmissionBlock | undefined {
    if (stored === 'cancelling' || stored === 'suspended' || stored === 'pivot-inflight' || stored === 'pivot-passed') return stored;
    return hasExpiredSealedTry ? 'expired-try' : undefined;
}
