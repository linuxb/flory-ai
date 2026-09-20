import type {StoredEvent} from '../../../engine/src/events.js';

/**
 * The bodies the inspector drawer fetches on demand.
 *
 * Pure builders over a run's events. Heavy data is fetched rather than streamed because an
 * operator reads one payload at a time and the canvas would otherwise pay, on every update, for
 * bytes almost never looked at.
 */

/** Everything the drawer can show about one vertex from the log alone. */
export interface PayloadDetail {
    vertex_id: string;
    role: string;
    status: string;
    /** The frozen input a tool was called with, or a planner's goal. */
    input: unknown;
    result: unknown;
    failure: unknown;
    /** The summary fields lifted for a rule to read. */
    log_fields: Record<string, unknown> | null;
    attempts: number;
    /**
     * References to bulk output held outside the log. Always empty today: both executors write the
     * whole result inline, so nothing is offloaded yet. The field stays so that when retention
     * lands a reference appears rather than the shape changing.
     */
    blob_refs: string[];
}

/** Why a detail this design promises cannot be served yet. */
export interface RetentionUnavailable {
    error: 'retention_unavailable';
    reason: string;
    /** What the log *does* hold, which is enough to compare two runs. */
    input_digest: string | null;
    output_digest: string | null;
    prerequisite: string;
}

/** Builds the payload view, or null when the run holds no such vertex. */
export function payloadDetail(events: readonly StoredEvent[], vertexId: string): PayloadDetail | null {
    const created = events.find((event) => event.event_type === 'vertex/created' && event.vertex_id === vertexId);
    if (!created) return null;
    const payload = created.payload as {role?: string; input?: unknown; goal?: string};
    const terminal = [...events].reverse().find((event) => event.vertex_id === vertexId && (event.event_type === 'vertex/succeeded' || event.event_type === 'vertex/failed'));
    const outcome = (terminal?.payload ?? {}) as {result?: unknown; log_fields?: Record<string, unknown>; attempts?: number; error?: unknown; failure?: unknown};
    const failed = terminal?.event_type === 'vertex/failed';
    return {
        vertex_id: vertexId,
        role: typeof payload.role === 'string' ? payload.role : 'unknown',
        status: terminal ? terminal.event_type.slice('vertex/'.length) : 'pending',
        input: payload.input ?? payload.goal ?? null,
        result: failed ? null : (outcome.result ?? null),
        failure: failed ? (outcome.failure ?? outcome.error ?? null) : null,
        log_fields: outcome.log_fields ?? null,
        attempts: outcome.attempts ?? 0,
        blob_refs: [],
    };
}

/**
 * Explains why a prompt or an execution log cannot be served.
 *
 * `501`, not `404`. A 404 asserts that this vertex has no prompt, which is false for a planner —
 * the engine records `input_digest` and `output_digest` and discards the text. The honest answer
 * is that the server does not implement retention, which lets the drawer render a "not retained"
 * tab rather than an error, and the digests are genuinely useful: an operator comparing two runs
 * can tell whether the same prompt was sent even though neither was kept.
 */
export function retentionUnavailable(events: readonly StoredEvent[], vertexId: string, kind: 'prompt' | 'logs'): RetentionUnavailable {
    const started = events.find((event) => event.event_type === 'vertex/started' && event.vertex_id === vertexId);
    const succeeded = events.find((event) => event.event_type === 'vertex/succeeded' && event.vertex_id === vertexId);
    const input = (started?.payload as {input_digest?: string} | undefined)?.input_digest ?? null;
    const output = ((succeeded?.payload as {result?: {output_digest?: string}} | undefined)?.result ?? {}).output_digest ?? null;
    return {
        error: 'retention_unavailable',
        reason:
            kind === 'prompt'
                ? 'raw model input and output are not retained; the log records their digests only'
                : 'tool execution output is not collected anywhere; the log records the returned result, which /payload serves',
        input_digest: input,
        output_digest: output,
        prerequisite: 'no artifact write path exists: the engine has no blob client and nothing persists prompts or execution output',
    };
}
