import {Pool} from 'pg';
import {rowToEvent, type RunEventReader} from '../../../engine/src/log/store.js';
import type {StoredEvent} from '../../../engine/src/log/events.js';
import type {ConsoleRunSummary} from './projection/model.js';

/**
 * Reads runs as a role that cannot write to them.
 *
 * Structurally this could be an `EventStore` — the read methods are identical. It is a separate
 * class because it holds a `console_role` pool, and that role's grants are the enforcement of
 * "the Console writes nothing": an `EventStore` here would be one refactor away from appending.
 *
 * It shares `rowToEvent` rather than mapping rows itself. That function normalizes `created_at`,
 * which every duration on the canvas is derived from, and a second copy would drift.
 */
export class ConsoleEventReader implements RunEventReader {
    private readonly pool: Pool;

    constructor(connectionString: string) {
        this.pool = new Pool({connectionString});
    }

    /** Reads one run in ascending sequence order, optionally through a boundary. */
    async readStream(runId: string, atRunSeq?: number): Promise<StoredEvent[]> {
        const result = await this.pool.query('SELECT * FROM run_event_log WHERE run_id = $1 AND ($2::bigint IS NULL OR run_seq <= $2) ORDER BY run_seq', [runId, atRunSeq ?? null]);
        return result.rows.map(rowToEvent);
    }

    /** Reads what has happened since a position, which is what following a live run costs. */
    async readStreamAfter(runId: string, afterRunSeq: number, limit = 512): Promise<StoredEvent[]> {
        const result = await this.pool.query('SELECT * FROM run_event_log WHERE run_id = $1 AND run_seq > $2 ORDER BY run_seq LIMIT $3', [runId, afterRunSeq, limit]);
        return result.rows.map(rowToEvent);
    }

    /**
     * Lists recent runs, newest first.
     *
     * `event_count` is activity rather than progress: nothing appends `run/end`, so a run has no
     * terminal state and this cannot say whether one finished. `kind` comes from `seed_floor`,
     * which is the authoritative record that a run is a counterfactual — and a counterfactual
     * listed as an ordinary run is a simulation an operator will read as fact.
     */
    async listRuns(limit = 50): Promise<ConsoleRunSummary[]> {
        const result = await this.pool.query<{run_id: string; created_at: Date | string; next_seq: string; fork: boolean}>(
            'SELECT run_id, created_at, next_seq, seed_floor IS NOT NULL AS fork FROM run ORDER BY created_at DESC LIMIT $1',
            [limit],
        );
        return result.rows.map((row) => ({
            run_id: row.run_id,
            kind: row.fork ? 'counterfactual' : 'production',
            created_at: new Date(row.created_at).toISOString(),
            event_count: Number(row.next_seq) - 1,
        }));
    }

    /** Whether the database is answering at all, for the readiness endpoint. */
    async ready(): Promise<boolean> {
        try {
            await this.pool.query('SELECT 1');
            return true;
        } catch {
            return false;
        }
    }

    async close(): Promise<void> {
        await this.pool.end();
    }
}
