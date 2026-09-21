import type {IncomingMessage, ServerResponse} from 'node:http';
import {consoleDag} from './projection/projection.js';
import {payloadDetail, retentionUnavailable} from './projection/detail.js';
import {HEARTBEAT_FRAME, SSE_HEADERS, encodeFrame, parseCursor, resolveResume} from './stream/stream.js';
import type {TailerRegistry} from './stream/tail.js';
import type {ConsoleEventReader} from './reader.js';
import type {ConsoleSnapshot, ConsoleStreamEvent} from './projection/model.js';

/**
 * The Console's read surface.
 *
 * `GET` only, and every other method answers 405. Design document 11 section 5 says the Console
 * writes nothing; refusing the verbs is the cheapest possible statement of it, and it sits on top
 * of a database role that could not write even if a handler tried.
 *
 * No router library: a route table plus twenty lines of matching, following the shape of
 * `gatewayd/internal/httpapi`, which uses a standard-library mux and one shared JSON writer.
 */

export interface ConsoleHandlerOptions {
    reader: ConsoleEventReader;
    tailers: TailerRegistry;
    /** How often an idle stream sends a comment so an intermediary does not reap it. */
    heartbeatMs?: number;
    /** Bytes of unflushed response body after which a slow subscriber is dropped and told to resync. */
    backpressureBytes?: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Route {
    method: 'GET';
    pattern: string;
    handle(context: RouteContext): Promise<void> | void;
}

interface RouteContext {
    request: IncomingMessage;
    response: ServerResponse;
    params: Record<string, string>;
    query: URLSearchParams;
    options: Required<ConsoleHandlerOptions>;
}

/** Builds the handler. Dependencies are injected so a test can drive it without a process. */
export function createConsoleHandler(options: ConsoleHandlerOptions): (request: IncomingMessage, response: ServerResponse) => void {
    const resolved: Required<ConsoleHandlerOptions> = {heartbeatMs: 15_000, backpressureBytes: 1_000_000, ...options};
    const routes: Route[] = [
        {method: 'GET', pattern: '/healthz', handle: ({response}) => void response.writeHead(204).end()},
        {
            method: 'GET',
            pattern: '/readyz',
            handle: async ({response, options}) => void ((await options.reader.ready()) ? response.writeHead(204).end() : writeJson(response, 503, {error: 'database_unavailable'})),
        },
        {method: 'GET', pattern: '/api/v1/runs', handle: async ({response, query, options}) => writeJson(response, 200, await options.reader.listRuns(positiveInteger(query.get('limit'), 50)))},
        {method: 'GET', pattern: '/api/v1/runs/:runId/dag', handle: serveDag},
        {method: 'GET', pattern: '/api/v1/runs/:runId/stream', handle: serveStream},
        {method: 'GET', pattern: '/api/v1/runs/:runId/vertices/:vertexId/payload', handle: servePayload},
        {method: 'GET', pattern: '/api/v1/runs/:runId/vertices/:vertexId/prompt', handle: (context) => serveRetention(context, 'prompt')},
        {method: 'GET', pattern: '/api/v1/runs/:runId/vertices/:vertexId/logs', handle: (context) => serveRetention(context, 'logs')},
    ];

    return (request, response) => {
        void (async () => {
            const url = new URL(request.url ?? '/', 'http://console.invalid');
            const matched = routes.map((route) => ({route, params: match(url.pathname, route.pattern)})).find((candidate) => candidate.params);
            if (!matched?.params) {
                // A known path reached by a write verb is refused as a method error rather than a
                // missing route, so the refusal says what it is.
                const pathExists = routes.some((route) => match(url.pathname, route.pattern));
                return pathExists ? writeJson(response, 405, {error: 'read_only', detail: 'the console serves GET only'}) : writeJson(response, 404, {error: 'not_found'});
            }
            if (request.method !== 'GET') return writeJson(response, 405, {error: 'read_only', detail: 'the console serves GET only'});
            const runId = matched.params.runId;
            const vertexId = matched.params.vertexId;
            if ((runId && !UUID.test(runId)) || (vertexId && !UUID.test(vertexId))) return writeJson(response, 400, {error: 'malformed_identifier'});
            await matched.route.handle({request, response, params: matched.params, query: url.searchParams, options: resolved});
        })().catch((error: unknown) => writeJson(response, 500, {error: 'internal', detail: error instanceof Error ? error.message : String(error)}));
    };
}

/* ------------------------------------------------------------------ handlers */

/** The whole model, optionally at a historical boundary — the same operation as the live one. */
async function serveDag({response, params, query, options}: RouteContext): Promise<void> {
    const events = await options.reader.readStream(params.runId!);
    if (!events.length) return writeJson(response, 404, {error: 'no_such_run'});
    const boundary = query.get('at_run_seq');
    writeJson(response, 200, consoleDag(events, boundary === null ? undefined : Number(boundary)));
}

async function servePayload({response, params, options}: RouteContext): Promise<void> {
    const events = await options.reader.readStream(params.runId!);
    const detail = payloadDetail(events, params.vertexId!);
    return detail ? writeJson(response, 200, detail) : writeJson(response, 404, {error: 'no_such_vertex'});
}

/** Answers for a detail this design promises and no write path produces. */
async function serveRetention({response, params, options}: RouteContext, kind: 'prompt' | 'logs'): Promise<void> {
    const events = await options.reader.readStream(params.runId!);
    if (!events.some((event) => event.vertex_id === params.vertexId)) return writeJson(response, 404, {error: 'no_such_vertex'});
    writeJson(response, 501, retentionUnavailable(events, params.vertexId!, kind));
}

/**
 * Streams one run's deltas, resuming from `Last-Event-ID` when it can.
 *
 * The subscriber is handed either a snapshot or a replay and then live deltas. It is never handed
 * a gap: reconciling one would mean folding, which is the thing the whole design prevents.
 */
async function serveStream({request, response, params, options}: RouteContext): Promise<void> {
    const runId = params.runId!;
    const tailer = options.tailers.for(runId);
    const model = await tailer.prime();
    if (!model.at_run_seq) return writeJson(response, 404, {error: 'no_such_run'});

    response.writeHead(200, SSE_HEADERS);
    const cursor = parseCursor(firstHeader(request.headers['last-event-id']) ?? undefined);
    const decision = resolveResume(cursor, tailer.buffer, model.at_run_seq);
    if (decision.mode === 'replay') {
        for (const delta of decision.deltas) response.write(encodeFrame(delta));
    } else {
        response.write(encodeFrame(snapshotOf(model)));
    }

    let closed = false;
    const send = (event: ConsoleStreamEvent): void => {
        if (closed) return;
        response.write(encodeFrame(event));
        // A subscriber that cannot keep up is dropped rather than allowed to hold unbounded memory
        // here. It reconnects, presents its cursor, and converges — which is what the resume
        // protocol is for.
        if (response.writableLength > options.backpressureBytes) stop();
    };
    const unsubscribe = tailer.subscribe((deltas) => {
        for (const delta of deltas) send(delta);
    });
    const heartbeat = setInterval(() => {
        if (!closed) response.write(HEARTBEAT_FRAME);
    }, options.heartbeatMs);
    heartbeat.unref?.();

    function stop(): void {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        response.end();
    }
    request.on('close', stop);
}

/* ------------------------------------------------------------------ plumbing */

function snapshotOf(model: ConsoleSnapshot['model']): ConsoleSnapshot {
    return {type: 'topology_snapshot', at_run_seq: model.at_run_seq, ordinal: 0, model};
}

/** Matches one path against a `:name` pattern, returning the captures or null. */
export function match(path: string, pattern: string): Record<string, string> | null {
    const actual = path.split('/');
    const expected = pattern.split('/');
    if (actual.length !== expected.length) return null;
    const params: Record<string, string> = {};
    for (const [index, segment] of expected.entries()) {
        const value = actual[index]!;
        if (segment.startsWith(':')) {
            if (!value) return null;
            params[segment.slice(1)] = decodeURIComponent(value);
        } else if (segment !== value) {
            return null;
        }
    }
    return params;
}

function firstHeader(value: string | string[] | undefined): string | null {
    return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

function positiveInteger(value: string | null, fallback: number): number {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 500) : fallback;
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
    response.writeHead(status, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'});
    response.end(JSON.stringify(value));
}
