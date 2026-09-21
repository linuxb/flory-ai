import {randomUUID} from 'node:crypto';
import {createServer, type Server} from 'node:http';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {consoleDatabaseUrl, engineDatabaseUrl} from '../../../db/config.js';
import {ConsoleEventReader} from '../../../console/server/src/reader.js';
import {createConsoleHandler} from '../../../console/server/src/server.js';
import {PollingTailSource, TailerRegistry} from '../../../console/server/src/stream/tail.js';
import type {ConsoleDagModel, ConsoleStreamEvent} from '../../../console/server/src/projection/model.js';
import {EventStore} from '../../src/log/store.js';

const engine = new EventStore({connectionString: engineDatabaseUrl, actor: 'engine'});
const reader = new ConsoleEventReader(consoleDatabaseUrl);
/** A one-entry buffer, so a reconnect after two deltas is forced down the re-snapshot path. */
const tinyReader = new ConsoleEventReader(consoleDatabaseUrl);

let server: Server;
let tinyServer: Server;
let base = '';
let tinyBase = '';

const planner = () => randomUUID();

/** Freezes one vertex, which is what the engine does in a single transaction. */
async function freezeVertex(runId: string, vertexId: string, label: string, parents: string[] = []): Promise<void> {
    await engine.appendEvents(runId, [{event_type: 'subgraph/proposed', payload: {tool_view_ref: 'r', tool_view_digest: `sha256:${'a'.repeat(64)}`, source: 'submitted'}}]);
    const events = await engine.readStream(runId);
    await engine.appendEvents(runId, [
        {
            event_type: 'subgraph/frozen',
            payload: {proposed_seq: events.at(-1)!.run_seq, tool_view_digest: `sha256:${'a'.repeat(64)}`, vertices: [{author_id: label, vertex_id: vertexId, role: 'planner'}]},
        },
        {event_type: 'vertex/created', vertex_id: vertexId, parent_refs: parents, payload: {role: 'planner'}},
    ]);
}

async function startedRun(): Promise<string> {
    const runId = await engine.createRun();
    await engine.appendEvents(runId, [{event_type: 'run/start', payload: {schema_version: 'v1'}}]);
    return runId;
}

/** Reads SSE frames off a response body until `count` events have arrived or it times out. */
async function readEvents(response: Response, count: number, timeoutMs = 8000): Promise<ConsoleStreamEvent[]> {
    const decoder = new TextDecoderStream();
    const stream = response.body!.pipeThrough(decoder).getReader();
    const events: ConsoleStreamEvent[] = [];
    let buffered = '';
    const deadline = Date.now() + timeoutMs;
    while (events.length < count && Date.now() < deadline) {
        const {value, done} = await stream.read();
        if (done) break;
        buffered += value;
        for (const frame of buffered.split('\n\n')) {
            const data = frame.split('\n').find((line) => line.startsWith('data: '));
            if (data) events.push(JSON.parse(data.slice('data: '.length)) as ConsoleStreamEvent);
        }
        buffered = buffered.endsWith('\n\n') ? '' : (buffered.split('\n\n').at(-1) ?? '');
        if (events.length >= count) break;
    }
    void stream.cancel().catch(() => undefined);
    return events;
}

function listen(handler: (request: never, response: never) => void): Promise<{server: Server; base: string}> {
    return new Promise((resolve) => {
        const created = createServer(handler as never);
        created.listen(0, '127.0.0.1', () => {
            const address = created.address();
            resolve({server: created, base: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`});
        });
    });
}

beforeAll(async () => {
    const full = await listen(createConsoleHandler({reader, tailers: new TailerRegistry(new PollingTailSource(reader), {activeIntervalMs: 40})}) as never);
    server = full.server;
    base = full.base;
    const tiny = await listen(createConsoleHandler({reader: tinyReader, tailers: new TailerRegistry(new PollingTailSource(tinyReader), {activeIntervalMs: 40, bufferSize: 1})}) as never);
    tinyServer = tiny.server;
    tinyBase = tiny.base;
});

afterAll(async () => {
    server.close();
    tinyServer.close();
    await Promise.all([engine.close(), reader.close(), tinyReader.close()]);
});

describe('the console read surface', () => {
    it('serves GET and refuses every verb that implies a write', async () => {
        expect((await fetch(`${base}/healthz`)).status).toBe(204);
        for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
            const response = await fetch(`${base}/api/v1/runs`, {method});
            // The console writes nothing, and refusing the verbs is the cheapest statement of it.
            expect(response.status).toBe(405);
            expect(await response.json()).toMatchObject({error: 'read_only'});
        }
    });

    it('refuses a malformed identifier before reaching the database', async () => {
        expect((await fetch(`${base}/api/v1/runs/not-a-uuid/dag`)).status).toBe(400);
    });

    it('lists runs and marks a counterfactual as one', async () => {
        const runId = await startedRun();
        const vertex = planner();
        await freezeVertex(runId, vertex, 'decide');
        const fork = await engine.fork({
            source_run_id: runId,
            at_vertex_id: vertex,
            substitutions: [],
            eval_up_to_seq: (await engine.readStream(runId)).at(-1)!.run_seq,
            fold_mode: 'recorded',
            evaluator_pin: 'eval://identity@v1',
            projector_version: 'projector@v1',
            harness_state_version: 'harness@v1',
        });

        const runs = (await (await fetch(`${base}/api/v1/runs?limit=200`)).json()) as Array<{run_id: string; kind: string}>;
        // Listed unlabelled beside production runs, a simulation is read as fact. The kind is the
        // presentation-layer counterpart of `is_counterfactual` in the data plane.
        expect(runs.find((entry) => entry.run_id === runId)?.kind).toBe('production');
        expect(runs.find((entry) => entry.run_id === fork.child_run_id)?.kind).toBe('counterfactual');
    });

    it('serves the model, and the same model at a historical boundary', async () => {
        const runId = await startedRun();
        const first = planner();
        const second = planner();
        await freezeVertex(runId, first, 'one');
        const boundary = (await engine.readStream(runId)).at(-1)!.run_seq;
        await freezeVertex(runId, second, 'two', [first]);

        const now = (await (await fetch(`${base}/api/v1/runs/${runId}/dag`)).json()) as ConsoleDagModel;
        expect(now.vertices.map((vertex) => vertex.label)).toEqual(['one', 'two']);
        // Historical inspection is the same operation as the live read, which is what makes a
        // disputed screenshot answerable.
        const earlier = (await (await fetch(`${base}/api/v1/runs/${runId}/dag?at_run_seq=${boundary}`)).json()) as ConsoleDagModel;
        expect(earlier.vertices.map((vertex) => vertex.label)).toEqual(['one']);
    });

    it('answers a payload from the log, and says plainly what is not retained', async () => {
        const runId = await startedRun();
        const vertex = planner();
        await freezeVertex(runId, vertex, 'decide');
        await engine.appendEvents(runId, [{event_type: 'vertex/started', vertex_id: vertex, payload: {attempt: 1, execution: 'llm', input_digest: `sha256:${'b'.repeat(64)}`}}]);
        await engine.appendEvents(runId, [{event_type: 'vertex/succeeded', vertex_id: vertex, payload: {attempts: 1, result: {output_digest: `sha256:${'c'.repeat(64)}`}}}]);

        expect(await (await fetch(`${base}/api/v1/runs/${runId}/vertices/${vertex}/payload`)).json()).toMatchObject({role: 'planner', status: 'succeeded'});

        // 501 rather than 404: a planner does have a prompt, and the server is the thing that does
        // not keep it. The digests are returned because they answer "was the same prompt sent".
        const prompt = await fetch(`${base}/api/v1/runs/${runId}/vertices/${vertex}/prompt`);
        expect(prompt.status).toBe(501);
        expect(await prompt.json()).toMatchObject({error: 'retention_unavailable', input_digest: `sha256:${'b'.repeat(64)}`, output_digest: `sha256:${'c'.repeat(64)}`});
        expect((await fetch(`${base}/api/v1/runs/${runId}/vertices/${vertex}/logs`)).status).toBe(501);
        expect((await fetch(`${base}/api/v1/runs/${runId}/vertices/${planner()}/payload`)).status).toBe(404);
    });
});

describe('following a run', () => {
    it('opens with a snapshot and then streams what happens', async () => {
        const runId = await startedRun();
        const first = planner();
        await freezeVertex(runId, first, 'one');

        const response = await fetch(`${base}/api/v1/runs/${runId}/stream`);
        expect(response.headers.get('content-type')).toContain('text/event-stream');
        const openingPromise = readEvents(response, 1);
        const opening = await openingPromise;
        expect(opening[0]).toMatchObject({type: 'topology_snapshot'});

        const second = await fetch(`${base}/api/v1/runs/${runId}/stream`);
        const growth = readEvents(second, 2);
        const next = planner();
        await freezeVertex(runId, next, 'two', [first]);
        await engine.appendEvents(runId, [{event_type: 'vertex/started', vertex_id: next, payload: {attempt: 1}}]);
        const events = await growth;
        // A freeze arrives as one append carrying the whole branch, not one delta per vertex.
        expect(events.map((event) => event.type)).toEqual(['topology_snapshot', 'subgraph_appended']);
    });

    it('reconnects by replay and reaches the state a fresh reader would hold', async () => {
        const runId = await startedRun();
        const first = planner();
        await freezeVertex(runId, first, 'one');
        const opening = await readEvents(await fetch(`${base}/api/v1/runs/${runId}/stream`), 1);
        const snapshot = opening[0] as Extract<ConsoleStreamEvent, {type: 'topology_snapshot'}>;

        // Disconnected. Three more events land while nothing is listening.
        const second = planner();
        await freezeVertex(runId, second, 'two', [first]);
        await engine.appendEvents(runId, [{event_type: 'vertex/started', vertex_id: second, payload: {attempt: 1}}]);

        const resumed = await fetch(`${base}/api/v1/runs/${runId}/stream`, {headers: {'last-event-id': `${snapshot.at_run_seq}.0`}});
        const replayed = await readEvents(resumed, 1);
        // Resumed rather than re-snapshotted, because nothing was evicted.
        expect(replayed[0]!.type).toBe('subgraph_appended');

        const fresh = (await (await fetch(`${base}/api/v1/runs/${runId}/dag`)).json()) as ConsoleDagModel;
        expect(fresh.vertices.map((vertex) => vertex.label)).toEqual(['one', 'two']);
    });

    it('reconnects by snapshot when the buffer no longer holds the cursor', async () => {
        // Same criterion, the other branch: "whether the server resumed or re-snapshotted".
        const runId = await startedRun();
        const first = planner();
        await freezeVertex(runId, first, 'one');
        const opening = await readEvents(await fetch(`${tinyBase}/api/v1/runs/${runId}/stream`), 1);
        const snapshot = opening[0] as Extract<ConsoleStreamEvent, {type: 'topology_snapshot'}>;

        for (const label of ['two', 'three', 'four']) {
            const vertex = planner();
            await freezeVertex(runId, vertex, label, [first]);
            await engine.appendEvents(runId, [{event_type: 'vertex/started', vertex_id: vertex, payload: {attempt: 1}}]);
        }

        const resumed = await fetch(`${tinyBase}/api/v1/runs/${runId}/stream`, {headers: {'last-event-id': `${snapshot.at_run_seq}.0`}});
        const served = await readEvents(resumed, 1);
        expect(served[0]!.type).toBe('topology_snapshot');
        const model = (served[0] as Extract<ConsoleStreamEvent, {type: 'topology_snapshot'}>).model;
        // Converged, not merely told something: the snapshot carries every vertex.
        expect(model.vertices.map((vertex) => vertex.label).sort()).toEqual(['four', 'one', 'three', 'two']);
    });

    it('re-snapshots a cursor ahead of the watermark rather than falling silent', async () => {
        const runId = await startedRun();
        await freezeVertex(runId, planner(), 'one');
        const response = await fetch(`${base}/api/v1/runs/${runId}/stream`, {headers: {'last-event-id': '99999.0'}});
        expect((await readEvents(response, 1))[0]!.type).toBe('topology_snapshot');
    });

    it('answers 404 for a run that does not exist', async () => {
        expect((await fetch(`${base}/api/v1/runs/${randomUUID()}/stream`)).status).toBe(404);
    });
});

describe('the console database role', () => {
    it('cannot write, whatever the code above it does', async () => {
        const runId = await startedRun();
        const write = new ConsoleEventReader(consoleDatabaseUrl);
        // The privilege, not the interface, is what makes "the console writes nothing" true.
        await expect(
            (write as unknown as {pool: {query(text: string, values: unknown[]): Promise<unknown>}}).pool.query(
                "INSERT INTO run_event_log (run_id, run_seq, event_type, payload) VALUES ($1, 9999, 'run/end', '{}'::jsonb)",
                [runId],
            ),
        ).rejects.toThrow(/permission denied/);
        await write.close();
    });
});
