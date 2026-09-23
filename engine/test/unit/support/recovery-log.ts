import {DEFAULT_RECOVERY_POLICY, type RecoveryPolicy} from '../../../src/recovery.js';
import type {EventDraft, StoredEvent} from '../../../src/log/events.js';

/**
 * A hand-built run log for recovery tests, with the Coordinator's side written exactly as the
 * Coordinator and the database write it.
 *
 * Every builder appends to one log and numbers it, so a test reads as the sequence of things that
 * happened. The shapes follow the real writers: `txn/scope {open}` when the Coordinator first
 * claims into a scope, `txn/try` and `vertex/succeeded` for a sealed try, the fence as the scoped
 * `vertex/failed` itself, and a cancellation as `requested` then `completed`.
 */

export const RUN = '00000000-0000-4000-8000-0000000000ff';
/** Readable ids that are still UUIDs, because the IDL checks the format. */
export const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const POLICY: RecoveryPolicy = {
    ...DEFAULT_RECOVERY_POLICY,
    pricing: {currency: 'CNY', cache_hit_input_per_million: 1, cache_miss_input_per_million: 4, output_per_million: 16, reference: 'test'},
};

export const cancelKey = (scopeId: string): string => `scope:${scopeId}:cancel`;

export class RecoveryLog {
    readonly events: StoredEvent[] = [];

    /** Appends one event with the next sequence number. */
    push(event_type: string, options: Partial<StoredEvent> = {}): StoredEvent {
        const seq = this.events.length + 1;
        const event: StoredEvent = {
            run_id: RUN,
            run_seq: seq,
            global_seq: seq,
            event_type,
            vertex_id: null,
            parent_refs: [],
            planner_id: null,
            scope_id: null,
            pin_version: null,
            ignorable: false,
            inherited: false,
            payload: {},
            created_at: '2026-01-01T00:00:00.000Z',
            ...options,
        };
        this.events.push(event);
        return event;
    }

    /** Appends drafts the way the store would, as stored events. */
    append(drafts: readonly EventDraft[]): number[] {
        return drafts.map((draft) => this.push(draft.event_type, {vertex_id: draft.vertex_id ?? null, scope_id: draft.scope_id ?? null, payload: draft.payload}).run_seq);
    }

    start(): this {
        this.push('run/start');
        return this;
    }

    /** One freeze and the vertices it created. The proposal records who authored them. */
    freeze(source: 'submitted' | 'router', vertices: {id: string; role: string; parents?: string[]; scope?: string; tool?: string}[]): this {
        const proposed = this.push('subgraph/proposed', {payload: {source}});
        this.push('subgraph/frozen', {payload: {proposed_seq: proposed.run_seq, vertices: []}});
        for (const vertex of vertices) {
            this.push('vertex/created', {
                vertex_id: vertex.id,
                parent_refs: vertex.parents ?? [],
                scope_id: vertex.scope ?? null,
                payload: {role: vertex.role, ...(vertex.role === 'tool' ? {tool: vertex.tool ?? 'mock.tool'} : {})},
            });
        }
        return this;
    }

    /** A planner (or any vertex) that ran and succeeded. */
    succeed(vertexId: string, scopeId: string | null = null): this {
        this.push('vertex/started', {vertex_id: vertexId, scope_id: scopeId, payload: {attempt: 1}});
        this.push('vertex/succeeded', {vertex_id: vertexId, scope_id: scopeId, payload: {attempts: 1, result: {}}});
        return this;
    }

    /** The Coordinator's first claim into a scope opens it. */
    open(scopeId: string): this {
        this.push('txn/scope', {scope_id: scopeId, payload: {state: 'open'}});
        return this;
    }

    /** A member that ran and sealed a try. */
    seal(vertexId: string, scopeId: string): this {
        this.push('vertex/started', {vertex_id: vertexId, scope_id: scopeId, payload: {attempt: 1}});
        this.push('txn/try', {vertex_id: vertexId, scope_id: scopeId, payload: {idempotency_key: `try:${vertexId}`, deadline_at: '2026-01-01T00:10:00.000Z'}});
        this.push('vertex/succeeded', {vertex_id: vertexId, scope_id: scopeId, payload: {attempts: 1, result: {}}});
        return this;
    }

    /** A terminal failure. In a scope this is also the database's fence. */
    fail(vertexId: string, scopeId: string | null = null, outcome = 'permanent-failure'): this {
        this.push('vertex/started', {vertex_id: vertexId, scope_id: scopeId, payload: {attempt: 3}});
        this.push('vertex/failed', {vertex_id: vertexId, scope_id: scopeId, payload: {attempts: 3, outcome, error: 'the counterparty refused'}});
        return this;
    }

    cancelRequested(scopeId: string): this {
        this.push('txn/cancel', {scope_id: scopeId, payload: {idempotency_key: cancelKey(scopeId), phase: 'requested', reason: 'engine request'}});
        return this;
    }

    cancelCompleted(scopeId: string): this {
        this.push('txn/cancel', {scope_id: scopeId, payload: {idempotency_key: cancelKey(scopeId), phase: 'completed'}});
        return this;
    }

    suspend(scopeId: string): this {
        this.push('txn/scope', {scope_id: scopeId, payload: {state: 'suspended', reason: 'unresolved attempt'}});
        return this;
    }

    /** An admitted pivot, as `admit_pivot` records it. */
    pivotStarted(vertexId: string, scopeId: string): this {
        this.push('vertex/started', {vertex_id: vertexId, scope_id: scopeId, payload: {phase: 'pivot'}});
        return this;
    }

    pivotPassed(vertexId: string, scopeId: string): this {
        this.push('txn/pivot-passed', {vertex_id: vertexId, scope_id: scopeId, payload: {}});
        this.push('vertex/succeeded', {vertex_id: vertexId, scope_id: scopeId, payload: {attempts: 1, result: {}}});
        return this;
    }
}
