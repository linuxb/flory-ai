import {describe, expect, it} from 'vitest';
import {DeltaBuffer, cursorOf, encodeFrame, parseCursor, resolveResume} from '../../../console/server/src/stream/stream.js';
import type {ConsoleDelta, ConsoleVertex} from '../../../console/server/src/projection/model.js';

function vertex(id: string): ConsoleVertex {
    return {
        vertex_id: id,
        parent_refs: [],
        label: id,
        role: 'tool',
        tool: 'record.read',
        tool_version: '1.0.0',
        status: 'created',
        is_shadowed: false,
        shadowed_at_seq: null,
        decided_by: 'planner',
        pin_version: null,
        input: null,
        log_fields: null,
        created_seq: 1,
        frozen_by_seq: null,
        depth: 0,
        txn: {scope_id: null, is_pivot: false, effect_class: 'none', pivot_passed: false},
        timing: {started_at: null, last_attempt_started_at: null, completed_at: null, duration_ms: null, attempts: 0},
        bracket: null,
        router_outcome: null,
        cost: null,
        stall: null,
        in_planner_prompt: true,
    };
}

type VertexPatch = Extract<ConsoleDelta, {type: 'vertex_patched'}>;

function patch(at_run_seq: number, ordinal: number, id = 'v'): VertexPatch {
    return {type: 'vertex_patched', at_run_seq, ordinal, spend: {calls: 0, input_tokens: 0, output_tokens: 0, amount: null, currency: null}, vertex: {...vertex(id), created_seq: at_run_seq}};
}

describe('stream cursors', () => {
    it('round-trips a cursor and refuses anything else', () => {
        expect(parseCursor(cursorOf(patch(17, 2)))).toEqual({at_run_seq: 17, ordinal: 2});
        for (const malformed of [undefined, '', 'seventeen', '17', '17.', '.2', '17.2.3', '-1.0']) {
            expect(parseCursor(malformed)).toBeNull();
        }
    });

    it('needs the ordinal, because one commit produces several deltas', () => {
        // Without it a client that disconnected between two deltas of the same batch would resume
        // at that run_seq and lose the rest of the batch permanently.
        expect(cursorOf(patch(17, 0))).toBe('17.0');
        expect(cursorOf(patch(17, 1))).toBe('17.1');
    });
});

describe('resuming a stream', () => {
    /** A buffer that has not evicted anything: it still holds every delta emitted. */
    const buffer = {entries: [patch(10, 0), patch(11, 0), patch(11, 1), patch(12, 0)], dropped: false};
    /** The same window, but older deltas were evicted to make room. */
    const truncated = {...buffer, dropped: true};

    it('replays exactly what follows a cursor inside the buffer', () => {
        const decision = resolveResume({at_run_seq: 11, ordinal: 0}, buffer, 12);
        expect(decision.mode).toBe('replay');
        if (decision.mode !== 'replay') throw new Error('unreachable');
        // The rest of run_seq 11's batch, then 12. Resuming at the batch rather than at the
        // sequence is the whole reason the ordinal exists.
        expect(decision.deltas.map(cursorOf)).toEqual(['11.1', '12.0']);
    });

    it('snapshots on first connect and on a cursor it cannot read', () => {
        expect(resolveResume(null, buffer, 12)).toMatchObject({mode: 'snapshot', reason: 'first-connect'});
        expect(resolveResume(parseCursor('nonsense'), buffer, 12)).toMatchObject({mode: 'snapshot', reason: 'first-connect'});
    });

    it('snapshots when the cursor is older than the buffer floor', () => {
        // The intervening deltas are gone. Handing over what is left would leave a gap, and a gap
        // is the one thing a client must never be asked to reconcile.
        expect(resolveResume({at_run_seq: 4, ordinal: 0}, truncated, 12)).toMatchObject({mode: 'snapshot', reason: 'below-buffer'});
    });

    it('snapshots when the cursor is ahead of the watermark', () => {
        // A client that outlived a server restart. The obvious implementation returns the empty
        // tail of the buffer and the canvas then waits forever for deltas that already happened.
        expect(resolveResume({at_run_seq: 99, ordinal: 0}, buffer, 12)).toMatchObject({mode: 'snapshot', reason: 'ahead-of-watermark'});
    });

    it('replays nothing when the cursor is current and nothing has happened', () => {
        expect(resolveResume({at_run_seq: 12, ordinal: 0}, {entries: [], dropped: false}, 12)).toEqual({mode: 'replay', deltas: []});
        expect(resolveResume({at_run_seq: 5, ordinal: 0}, {entries: [], dropped: true}, 12)).toMatchObject({mode: 'snapshot', reason: 'below-buffer'});
    });

    it('replays everything for a cursor just below a buffer that has evicted nothing', () => {
        // Nothing was thrown away, so nothing can be missing between the cursor and the window.
        const decision = resolveResume({at_run_seq: 9, ordinal: 9}, buffer, 12);
        expect(decision.mode).toBe('replay');
        if (decision.mode !== 'replay') throw new Error('unreachable');
        expect(decision.deltas).toHaveLength(4);
    });
});

describe('the delta buffer', () => {
    it('keeps the most recent deltas and drops the oldest', () => {
        const buffer = new DeltaBuffer(3);
        buffer.push(patch(1, 0), patch(2, 0));
        expect(buffer.dropped).toBe(false);
        buffer.push(patch(3, 0), patch(4, 0));
        expect(buffer.dropped).toBe(true);
        // Bounded because a run is unbounded: nothing appends `run/end`, so a stream never closes
        // on its own and an unbounded buffer would grow for the life of the process.
        expect(buffer.entries.map(cursorOf)).toEqual(['2.0', '3.0', '4.0']);
    });
});

describe('the SSE frame', () => {
    it('carries the cursor, the type, and one line of JSON', () => {
        const frame = encodeFrame(patch(17, 1, 'a'));
        expect(frame).toMatch(/^id: 17\.1\nevent: vertex_patched\ndata: \{/);
        expect(frame.endsWith('\n\n')).toBe(true);
    });

    it('never emits a raw newline inside data, which would split the frame', () => {
        const broken = patch(1, 0);
        broken.vertex.label = 'line one\nline two';
        const frame = encodeFrame(broken);
        const dataLines = frame.split('\n').filter((line) => line.startsWith('data: '));
        expect(dataLines).toHaveLength(1);
        expect(JSON.parse(dataLines[0]!.slice('data: '.length)).vertex.label).toBe('line one\nline two');
    });
});
