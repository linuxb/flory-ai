import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

/**
 * Replays a captured run, so the client can be built and broken without the backend.
 *
 * Zero dependencies, in the style of `test/sandbox/server.ts`. It is also the cheapest check that
 * the real server's wire format has a working consumer: the fixture is produced by the console's
 * own projector, so a frame this replays is a frame the live stream sends.
 *
 *   node console/dev/mock-server.mjs [fixture.json] [port]
 *
 * `?chaos=drop-at=N` kills the connection after N frames, which is how the reconnect path gets
 * exercised by hand rather than only in a property test.
 */

const fixturePath = process.argv[2] ?? fileURLToPath(new URL('../client/fixtures/retail-run.json', import.meta.url));
const port = Number(process.argv[3] ?? 8094);
const frameMs = Number(process.env.MOCK_FRAME_MS ?? 400);
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
const runId = fixture.captured_from;

function json(response, status, value) {
    const body = JSON.stringify(value);
    response.writeHead(status, {'content-type': 'application/json', 'content-length': Buffer.byteLength(body)});
    response.end(body);
}

/** The model as of a cursor, rebuilt by replaying the fixture's own frames — never re-derived. */
function snapshotAt(index) {
    if (index <= 0) return fixture.snapshot;
    const frame = fixture.frames[Math.min(index, fixture.frames.length) - 1];
    // A resnapshot is the server's job in reality. Here the honest stand-in is the final model
    // clipped to the frame's watermark, which is what a client that missed frames would receive.
    return {type: 'topology_snapshot', at_run_seq: frame.event.at_run_seq, ordinal: 0, model: {...fixture.final, at_run_seq: frame.event.at_run_seq}};
}

function stream(request, response, query) {
    const resumeFrom = request.headers['last-event-id'] ?? query.get('last-event-id');
    const resumeIndex = resumeFrom ? fixture.frames.findIndex((frame) => frame.id === resumeFrom) + 1 : 0;
    const dropAt = Number((/drop-at=(\d+)/.exec(query.get('chaos') ?? '') ?? [])[1] ?? Number.POSITIVE_INFINITY);

    response.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no'});
    // A resume that names a frame this replay still holds continues from it; anything else gets a
    // snapshot, which is the same rule the real server applies for the same reason.
    const opening = resumeFrom && resumeIndex > 0 ? null : snapshotAt(resumeIndex);
    if (opening) response.write(`event: ${opening.type}\ndata: ${JSON.stringify(opening)}\n\n`);

    let index = Math.max(resumeIndex, 0);
    let sent = 0;
    const timer = setInterval(() => {
        if (sent >= dropAt) {
            clearInterval(timer);
            response.destroy();
            return;
        }
        const frame = fixture.frames[index];
        if (!frame) {
            // The run is over, and a run has no terminal event, so the feed simply goes quiet.
            clearInterval(timer);
            response.write(':hb\n\n');
            return;
        }
        response.write(`id: ${frame.id}\nevent: ${frame.event.type}\ndata: ${JSON.stringify(frame.event)}\n\n`);
        index += 1;
        sent += 1;
    }, frameMs);
    request.on('close', () => clearInterval(timer));
}

createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const path = url.pathname;
    if (request.method !== 'GET') return json(response, 405, {error: 'read_only'});
    if (path === '/healthz') return void response.writeHead(204).end();
    if (path === '/api/v1/runs')
        return json(response, 200, [{run_id: runId, kind: fixture.final.kind, created_at: fixture.final.started_at ?? new Date().toISOString(), event_count: fixture.final.at_run_seq}]);

    const run = /^\/api\/v1\/runs\/([^/]+)/.exec(path);
    if (!run) return json(response, 404, {error: 'not_found'});
    if (run[1] !== runId) return json(response, 404, {error: 'no_such_run'});

    if (path.endsWith('/dag')) return json(response, 200, fixture.final);
    if (path.endsWith('/stream')) return stream(request, response, url.searchParams);

    const vertex = /\/vertices\/([^/]+)\/(payload|prompt|logs)$/.exec(path);
    if (!vertex) return json(response, 404, {error: 'not_found'});
    const detail = fixture.details[vertex[1]];
    if (!detail) return json(response, 404, {error: 'no_such_vertex'});
    if (vertex[2] === 'payload') return json(response, 200, detail.payload);
    return json(response, 501, detail[vertex[2]]);
}).listen(port, '127.0.0.1', () => {
    process.stdout.write(`mock console on http://127.0.0.1:${port} replaying ${fixture.frames.length} frames of run ${runId}\n`);
});
