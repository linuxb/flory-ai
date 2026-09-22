import type {StoredEvent} from '../../../../engine/src/log/events.js';
import type {PayloadDetail, RetentionUnavailable} from './model.js';

// Re-exported so a server caller still finds them beside the builders that produce them. Their
// declarations live in `model.ts` because that is the one module the browser client imports, and
// it must stay reachable without pulling in anything that has a runtime.
export type {PayloadDetail, RetentionUnavailable};

/**
 * The bodies the inspector drawer fetches on demand.
 *
 * Pure builders over a run's events. Heavy data is fetched rather than streamed because an
 * operator reads one payload at a time and the canvas would otherwise pay, on every update, for
 * bytes almost never looked at.
 */

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
