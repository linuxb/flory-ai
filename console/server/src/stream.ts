import type {ConsoleDelta, ConsoleStreamEvent} from './model.js';

/**
 * The wire format and the resume protocol.
 *
 * Server-Sent Events, not a WebSocket, for three reasons that all point the same way in this
 * repository. Node has no WebSocket *server*, so one would cost a runtime dependency for a
 * read-only feed in a package that keeps five. SSE is one-directional by construction, which makes
 * "the Console writes nothing" structural rather than a rule a later handler could break. And
 * `Last-Event-ID` *is* the resume protocol design document 11 section 3.3 describes, so the
 * browser performs it with no client code to get wrong.
 */

/** A cursor is `<run_seq>.<ordinal>`: the sequence a delta reflects, and its place in that batch. */
export interface StreamCursor {
    at_run_seq: number;
    ordinal: number;
}

/** Formats one event's cursor for the SSE `id:` line. */
export function cursorOf(event: ConsoleStreamEvent): string {
    return `${event.at_run_seq}.${event.ordinal}`;
}

/**
 * Reads a `Last-Event-ID` back into a cursor, or reports that it cannot.
 *
 * A malformed cursor is never repaired and never partially trusted. It came from a client, and the
 * cost of getting it wrong is a canvas that silently disagrees with the log; the cost of
 * rejecting it is one extra snapshot.
 */
export function parseCursor(value: string | undefined): StreamCursor | null {
    if (!value) return null;
    const match = /^(\d+)\.(\d+)$/.exec(value.trim());
    if (!match) return null;
    return {at_run_seq: Number(match[1]), ordinal: Number(match[2])};
}

/** Whether one cursor precedes another in the total order the stream emits. */
function precedes(first: StreamCursor, second: StreamCursor): boolean {
    return first.at_run_seq < second.at_run_seq || (first.at_run_seq === second.at_run_seq && first.ordinal < second.ordinal);
}

/** Where a reconnecting subscriber resumes, or that it cannot. */
export type ResumeDecision = {mode: 'replay'; deltas: ConsoleDelta[]} | {mode: 'snapshot'; reason: ResumeRefusal};

/** Why a resume was refused, which the server logs and the client never has to act on. */
export type ResumeRefusal = 'first-connect' | 'malformed-cursor' | 'below-buffer' | 'ahead-of-watermark';

/**
 * Decides whether a cursor can be served from the buffer of recent deltas.
 *
 * A gap is never handed to a client. Reconciling one would mean folding, and folding in the
 * browser is the thing this whole design exists to prevent — so every case this cannot answer
 * exactly falls back to a fresh snapshot, which is always correct and merely more expensive.
 *
 * The case worth naming is a cursor *ahead* of the watermark: a client that outlived a server
 * restart holds a position this process has never emitted. The obvious implementation returns the
 * empty tail of the buffer and the canvas then waits forever for deltas that already happened.
 */
export function resolveResume(cursor: StreamCursor | null, buffer: ResumableDeltas, watermark: number): ResumeDecision {
    if (!cursor) return {mode: 'snapshot', reason: 'first-connect'};
    if (!Number.isInteger(cursor.at_run_seq) || !Number.isInteger(cursor.ordinal)) return {mode: 'snapshot', reason: 'malformed-cursor'};
    if (cursor.at_run_seq > watermark) return {mode: 'snapshot', reason: 'ahead-of-watermark'};

    // What makes a replay safe is not where the cursor sits but whether anything between it and
    // the buffer was thrown away. While the buffer has evicted nothing it holds every delta this
    // process emitted, so any cursor at or under the watermark can be served from it. Once it has
    // evicted, only cursors at or after what survived can be — and a cursor whose successors are
    // partly gone gets a snapshot, because the alternative is handing over a gap.
    if (buffer.dropped) {
        const floor = buffer.entries[0];
        if (!floor || precedes(cursor, {at_run_seq: floor.at_run_seq, ordinal: floor.ordinal - 1})) return {mode: 'snapshot', reason: 'below-buffer'};
    }
    return {mode: 'replay', deltas: buffer.entries.filter((delta) => precedes(cursor, {at_run_seq: delta.at_run_seq, ordinal: delta.ordinal}))};
}

/** The deltas a resume may be served from, and whether any older ones were evicted. */
export interface ResumableDeltas {
    entries: readonly ConsoleDelta[];
    dropped: boolean;
}

/**
 * A bounded window of the deltas this process has emitted for one run.
 *
 * Bounded because a run is unbounded: nothing appends `run/end`, so a stream never closes on its
 * own and an unbounded buffer would grow for as long as the process lives. When a cursor falls
 * past the floor the subscriber gets a snapshot, which is the same answer it gets on first
 * connect.
 */
export class DeltaBuffer implements ResumableDeltas {
    private readonly deltas: ConsoleDelta[] = [];
    private evicted = false;

    constructor(private readonly capacity = 512) {}

    push(...deltas: readonly ConsoleDelta[]): void {
        this.deltas.push(...deltas);
        if (this.deltas.length <= this.capacity) return;
        this.deltas.splice(0, this.deltas.length - this.capacity);
        // Recorded rather than inferred from the length: once anything is gone, a cursor older
        // than what remains can no longer be served, and that stays true afterwards.
        this.evicted = true;
    }

    get entries(): readonly ConsoleDelta[] {
        return this.deltas;
    }

    get dropped(): boolean {
        return this.evicted;
    }
}

/**
 * Encodes one event as an SSE frame.
 *
 * The payload is JSON on a single `data:` line. A raw newline inside `data:` would split the frame
 * silently and the client would see two malformed events instead of one good one, so the encoding
 * that guarantees no newline — `JSON.stringify` — is the whole of the escaping story.
 */
export function encodeFrame(event: ConsoleStreamEvent): string {
    return `id: ${cursorOf(event)}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** The headers an SSE response needs, including the two that stop an intermediary buffering it. */
export const SSE_HEADERS: Readonly<Record<string, string>> = {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // nginx and several proxies buffer a response body by default, which turns a live stream into
    // one delivery at the end. This is the documented opt-out.
    'x-accel-buffering': 'no',
};

/** A comment frame, sent periodically so an idle stream is not reaped as dead. */
export const HEARTBEAT_FRAME = ':hb\n\n';
