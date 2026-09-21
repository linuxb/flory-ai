import {mkdir, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {consoleDatabaseUrl} from '../../db/config.js';
import {payloadDetail, retentionUnavailable} from '../server/src/detail.js';
import {advanceConsoleDag, emptyConsoleDag} from '../server/src/projection.js';
import {ConsoleEventReader} from '../server/src/reader.js';
import {cursorOf} from '../server/src/stream.js';
import type {ConsoleStreamEvent} from '../server/src/model.js';

/**
 * Records one real run as the fixture the mock server replays.
 *
 * The frames are produced by the server's own projector over the run's own events, one committed
 * batch at a time, so the fixture is the wire format rather than a guess at it. Building the
 * client against invented shapes and meeting the real ones later is how a canvas ends up with a
 * special case per field.
 *
 * Batching by `run_seq` is what a tailer sees: a freeze commits atomically with its vertices, so a
 * reader can never observe half a frozen subgraph, and one frame therefore carries a whole branch.
 */

const runId = process.argv[2];
const output = resolve(process.argv[3] ?? 'console/client/fixtures/retail-run.json');
if (!runId) throw new Error('usage: tsx console/dev/capture-fixture.ts <run-id> [output.json]');

const reader = new ConsoleEventReader(consoleDatabaseUrl);
const events = await reader.readStream(runId);
if (!events.length) throw new Error(`run ${runId} holds no events`);

const frames: ConsoleStreamEvent[] = [];
let model = emptyConsoleDag(runId);
// One batch per distinct `run_seq`, which is the finest grain a reader can observe. Anything
// coarser would hide a split the client must survive; anything finer does not exist.
for (const event of events) {
    const step = advanceConsoleDag(model, [event]);
    model = step.model;
    frames.push(...step.deltas);
}

// The snapshot a first-connect receives, taken at the first frame's position so a replay can start
// from it and reach the same place a straight-through client did.
const firstDelta = frames[0];
const snapshot: ConsoleStreamEvent = {
    type: 'topology_snapshot',
    at_run_seq: firstDelta?.at_run_seq ?? 0,
    ordinal: 0,
    model: advanceConsoleDag(
        emptyConsoleDag(runId),
        events.filter((event) => event.run_seq <= (firstDelta?.at_run_seq ?? 0)),
    ).model,
};

const details: Record<string, unknown> = {};
for (const vertex of model.vertices) {
    details[vertex.vertex_id] = {
        payload: payloadDetail(events, vertex.vertex_id),
        prompt: retentionUnavailable(events, vertex.vertex_id, 'prompt'),
        logs: retentionUnavailable(events, vertex.vertex_id, 'logs'),
    };
}

await mkdir(dirname(output), {recursive: true});
await writeFile(
    output,
    `${JSON.stringify(
        {
            captured_from: runId,
            console_projector_version: model.console_projector_version,
            final: model,
            snapshot,
            frames: frames.slice(1).map((event) => ({id: cursorOf(event), event})),
            details,
        },
        null,
        2,
    )}\n`,
);
process.stdout.write(`captured ${frames.length} frames and ${model.vertices.length} vertices to ${output}\n`);
await reader.close?.();
