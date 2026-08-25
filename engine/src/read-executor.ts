import type {Pool} from 'pg';
import type {FoldMode} from './generated/event-log.js';
import type {AttemptOutcome, GatewayClient} from './gateway-client.js';
import {GatewayRefusal} from './gateway-client.js';
import type {EventStore} from './store.js';

/** One vertex the Orchestrator may execute. */
export interface ReadWorkItem {
    vertexId: string;
    runId: string;
    attempt: number;
    tool: string;
    toolVersion: string;
    toolViewDigest: string;
    input: Record<string, unknown>;
    effectClass: string;
}

/** What one execution pass did, so a caller can drive the loop without reading the log back. */
export interface ReadExecutionReport {
    vertexId: string;
    outcome: AttemptOutcome | 'blocked' | 'refused';
    detail?: string;
}

interface ToolPayload {
    role?: string;
    tool?: string;
    tool_version?: string;
    tool_view_digest?: string;
    input?: Record<string, unknown>;
    txn?: {effect_class?: string};
}

/**
 * Executes the tool-caller vertices the Orchestrator owns.
 *
 * A vertex belongs here when its pinned contract declares `effect_class: none` and it carries no scope. Such a vertex
 * has no bracket, no compensation, and no pivot interaction, so there is nothing for a transaction coordinator to own.
 * The database enforces the same partition on both the work queue and the event log; this class never decides it, it
 * only refuses to act outside it.
 */
export class ReadExecutor {
    constructor(
        private readonly store: EventStore,
        private readonly pool: Pool,
        private readonly gateway: GatewayClient,
        private readonly worker: string,
        private readonly foldMode: FoldMode = 'reads-live',
    ) {}

    /** Claims and executes at most one ready read, returning null when the queue holds none. */
    async processOne(): Promise<ReadExecutionReport | null> {
        const item = await this.claim();
        if (!item) return null;
        // A second guard behind the database's. It is also where discipline 7e's fold-mode ladder is enforced: an
        // evaluation below reads-live records an unverified estimate rather than reaching a live tool at all.
        if (item.effectClass !== 'none') {
            await this.release(item.vertexId);
            return {vertexId: item.vertexId, outcome: 'blocked', detail: `${item.tool} declares effect_class ${item.effectClass}; only the Coordinator may execute it`};
        }
        if (this.foldMode !== 'reads-live') {
            await this.release(item.vertexId);
            return {vertexId: item.vertexId, outcome: 'blocked', detail: `fold_mode ${this.foldMode} may not execute ${item.tool} live`};
        }

        await this.store.appendEvents(item.runId, [{event_type: 'vertex/started', vertex_id: item.vertexId, payload: {attempt: item.attempt}}]);
        try {
            const result = await this.gateway.call(item.tool, item.input, {
                runId: item.runId,
                vertexId: item.vertexId,
                toolVersion: item.toolVersion,
                toolViewDigest: item.toolViewDigest,
                attempt: item.attempt,
            });
            if (result.outcome === 'succeeded') {
                await this.store.appendEvents(item.runId, [{event_type: 'vertex/succeeded', vertex_id: item.vertexId, payload: {attempts: item.attempt, result: result.result ?? {}}}]);
                await this.complete(item.vertexId);
                return {vertexId: item.vertexId, outcome: 'succeeded'};
            }
            await this.store.appendEvents(item.runId, [{event_type: 'vertex/failed', vertex_id: item.vertexId, payload: {attempts: item.attempt, outcome: result.outcome, error: result.error ?? ''}}]);
            await this.complete(item.vertexId);
            return {vertexId: item.vertexId, outcome: result.outcome, detail: result.error};
        } catch (error: unknown) {
            // A gateway refusal was decided before anything was dispatched, so it is a fact about the request rather
            // than an ambiguous outcome. Recording it as a failure is honest; retrying it unchanged would not help.
            const refused = error instanceof GatewayRefusal;
            const detail = error instanceof Error ? error.message : String(error);
            if (!refused) {
                await this.release(item.vertexId);
                return {vertexId: item.vertexId, outcome: 'unknown', detail};
            }
            await this.store.appendEvents(item.runId, [{event_type: 'vertex/failed', vertex_id: item.vertexId, payload: {attempts: item.attempt, outcome: 'permanent-failure', error: detail}}]);
            await this.complete(item.vertexId);
            return {vertexId: item.vertexId, outcome: 'refused', detail};
        }
    }

    private async claim(): Promise<ReadWorkItem | null> {
        const claimed = await this.pool.query<{vertex_id: string; run_id: string; payload: ToolPayload; attempt: number}>('SELECT vertex_id, run_id, payload, attempt FROM claim_ready_read($1, $2)', [
            this.worker,
            30,
        ]);
        const row = claimed.rows[0];
        if (!row) return null;
        const payload = row.payload;
        if (payload.role !== 'tool' || !payload.tool) throw new Error(`claim_ready_read returned a non-tool vertex ${row.vertex_id}`);
        if (!payload.tool_version || !payload.tool_view_digest) throw new Error(`vertex ${row.vertex_id} is not pinned to a tool version and view`);
        return {
            vertexId: row.vertex_id,
            runId: row.run_id,
            attempt: row.attempt,
            tool: payload.tool,
            toolVersion: payload.tool_version,
            toolViewDigest: payload.tool_view_digest,
            input: payload.input ?? {},
            effectClass: payload.txn?.effect_class ?? 'unknown',
        };
    }

    private async complete(vertexId: string): Promise<void> {
        await this.pool.query('SELECT complete_read($1, $2)', [this.worker, vertexId]);
    }

    private async release(vertexId: string, delayMs = 1000): Promise<void> {
        await this.pool.query('SELECT release_read($1, $2, $3)', [this.worker, vertexId, delayMs]);
    }
}
