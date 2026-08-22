import {randomUUID} from 'node:crypto';
import {Pool, type PoolClient} from 'pg';
import {assertEventDraft, type EventDraft, type ForkRequest, type StoredEvent} from './events.js';

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
    source_tail_end_seq: number;
    end_seed_seq: number;
}

function rowToEvent(row: Record<string, unknown>): StoredEvent {
    return {
        run_id: String(row.run_id),
        stream_seq: Number(row.stream_seq),
        global_seq: Number(row.global_seq),
        event_type: String(row.event_type),
        vertex_id: row.vertex_id ? String(row.vertex_id) : null,
        parent_refs: (row.parent_refs as string[] | null) ?? [],
        planner_id: row.planner_id ? String(row.planner_id) : null,
        scope_id: row.scope_id ? String(row.scope_id) : null,
        pin_version: row.pin_version ? String(row.pin_version) : null,
        ignorable: Boolean(row.ignorable),
        payload: row.payload as Record<string, unknown>,
        created_at: new Date(row.created_at as string).toISOString(),
    };
}

/** PostgreSQL-backed event-log store that enforces service event ownership. */
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
    /** Appends one or more validated events and returns their stream sequence numbers. */
    async appendEvents(runId: string, events: EventDraft[]): Promise<number[]> {
        if (!events.length) throw new Error('appendEvents requires at least one event');
        events.forEach(assertEventDraft);
        const result = await this.pool.query<{stream_seq: string}>('SELECT stream_seq FROM append_events($1, $2::jsonb)', [runId, JSON.stringify(events)]);
        return result.rows.map((row) => Number(row.stream_seq));
    }
    /** Atomically appends a frozen-subgraph event and its vertex-created events. */
    async appendFrozenSubgraph(runId: string, frozen: EventDraft, vertices: EventDraft[]): Promise<number[]> {
        this.requireEngine();
        if (frozen.event_type !== 'subgraph/frozen' || vertices.some((event) => event.event_type !== 'vertex/created'))
            throw new Error('frozen subgraph requires one frozen event followed by vertex/created events');
        return this.appendEvents(runId, [frozen, ...vertices]);
    }
    /** Reads one run in ascending stream-sequence order, optionally through a boundary. */
    async readStream(runId: string, atStreamSeq?: number): Promise<StoredEvent[]> {
        const result = await this.pool.query('SELECT * FROM event_log WHERE run_id = $1 AND ($2::bigint IS NULL OR stream_seq <= $2) ORDER BY stream_seq', [runId, atStreamSeq ?? null]);
        return result.rows.map(rowToEvent);
    }

    /** Creates an offline, immutable counterfactual fork from a permitted boundary. */
    async fork(request: ForkRequest): Promise<ForkResult> {
        this.requireEngine();
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const tail = await client.query<{tail_end: string}>('SELECT lock_fork_source($1) AS tail_end', [request.source_run_id]);
            const sourceTailEnd = Number(tail.rows[0]!.tail_end);
            if (request.at_stream_seq > sourceTailEnd) throw new Error('fork boundary is beyond source tail');
            const source = await this.readStreamWith(client, request.source_run_id);
            this.assertForkBoundary(source, request.at_stream_seq);
            const substitutions = new Map(request.substitutions.map((item) => [item.stream_seq, item.pin_version]));
            if (substitutions.size !== request.substitutions.length) throw new Error('fork substitutions must not repeat a stream sequence');
            for (const sequence of substitutions.keys()) {
                const event = source.find((candidate) => candidate.stream_seq === sequence);
                if (!event?.pin_version) throw new Error(`substitution ${sequence} does not name a pinned source event`);
            }
            const childRunId = randomUUID();
            await client.query('SELECT create_run($1)', [childRunId]);
            await this.appendWith(client, request.source_run_id, [
                {
                    event_type: 'fork/created',
                    payload: {
                        child_run_id: childRunId,
                        at_stream_seq: request.at_stream_seq,
                        source_tail_end_seq: sourceTailEnd,
                        substitutions: request.substitutions,
                        fold_mode: request.fold_mode,
                        evaluator_pin: request.evaluator_pin,
                        projector_version: request.projector_version,
                        harness_state_version: request.harness_state_version,
                    },
                },
            ]);
            const inherited = source.map((event) => ({
                event_type: event.event_type,
                vertex_id: event.vertex_id,
                parent_refs: event.parent_refs,
                planner_id: event.planner_id,
                scope_id: event.scope_id,
                pin_version: substitutions.get(event.stream_seq) ?? event.pin_version,
                ignorable: event.ignorable,
                payload: event.payload,
            }));
            await client.query('SELECT stream_seq FROM copy_inherited_events($1, $2::jsonb)', [childRunId, JSON.stringify(inherited)]);
            const seeded = await this.appendWith(client, childRunId, [{event_type: 'run/end-seed', payload: {inherited_through_seq: sourceTailEnd, source_run_id: request.source_run_id}}]);
            await client.query('COMMIT');
            return {child_run_id: childRunId, source_tail_end_seq: sourceTailEnd, end_seed_seq: seeded[0]!};
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    private async appendWith(client: PoolClient, runId: string, events: EventDraft[]): Promise<number[]> {
        events.forEach(assertEventDraft);
        const result = await client.query<{stream_seq: string}>('SELECT stream_seq FROM append_events($1, $2::jsonb)', [runId, JSON.stringify(events)]);
        return result.rows.map((row) => Number(row.stream_seq));
    }
    private async readStreamWith(client: PoolClient, runId: string): Promise<StoredEvent[]> {
        return (await client.query('SELECT * FROM event_log WHERE run_id = $1 ORDER BY stream_seq', [runId])).rows.map(rowToEvent);
    }
    private assertForkBoundary(events: StoredEvent[], boundary: number): void {
        const prefix = events.filter((event) => event.stream_seq <= boundary);
        const at = prefix.find((event) => event.stream_seq === boundary);
        const planner = at?.event_type === 'vertex/succeeded' && events.some((event) => event.event_type === 'vertex/created' && event.vertex_id === at.vertex_id && event.payload.role === 'planner');
        if (!planner) throw new Error('fork boundary must be a succeeded planner vertex');
        const openScopes = new Set<string>();
        for (const event of prefix) {
            if (event.event_type === 'txn/try' && event.scope_id) openScopes.add(event.scope_id);
            if ((event.event_type === 'txn/confirm' || event.event_type === 'txn/cancel') && event.scope_id) openScopes.delete(event.scope_id);
        }
        if (openScopes.size) throw new Error('fork boundary is inside an open transaction bracket');
        const latestPivot = Math.max(0, ...events.filter((event) => event.event_type === 'txn/pivot-passed').map((event) => event.stream_seq));
        if (boundary < latestPivot) throw new Error('fork boundary is below the pivot floor');
    }
}
