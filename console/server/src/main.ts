import {createServer} from 'node:http';
import {consoleDatabaseUrl} from '../../../db/config.js';
import {ConsoleEventReader} from './reader.js';
import {createConsoleHandler} from './server.js';
import {PollingTailSource, TailerRegistry} from './stream/tail.js';

/**
 * The Console's observability API.
 *
 * The first long-lived Node process in this repository, so it follows the shape the tool-service
 * SDK already established: read the environment here and nowhere else, build the handler from
 * injected dependencies, and shut down on a signal.
 */

const address = process.env.CONSOLE_ADDR ?? '127.0.0.1';
const port = Number(process.env.CONSOLE_PORT ?? 8094);
const pollMs = Number(process.env.CONSOLE_POLL_MS ?? 250);

/**
 * Who may read a run is undecided — design document 11 section 7 — and this surface serves frozen
 * inputs and tool results. Until that question has an answer the process refuses to listen
 * anywhere but loopback, and says so rather than binding quietly. An override exists because a
 * trusted network is a legitimate deployment; requiring it to be typed out is the point.
 */
const loopback = new Set(['127.0.0.1', 'localhost', '::1']);
if (!loopback.has(address) && process.env.CONSOLE_ALLOW_REMOTE !== 'true') {
    throw new Error(
        `refusing to bind ${address}: the console has no authorization and serves prompts and tool payloads. ` +
            'Who may read a run is an open question in design document 11 section 7. Set CONSOLE_ALLOW_REMOTE=true to override on a trusted network.',
    );
}
if (!loopback.has(address)) {
    process.stderr.write(`console: bound to ${address} with CONSOLE_ALLOW_REMOTE; it has no authorization (design document 11 section 7)\n`);
}

const reader = new ConsoleEventReader(consoleDatabaseUrl);
const tailers = new TailerRegistry(new PollingTailSource(reader), {activeIntervalMs: pollMs});
const server = createServer(createConsoleHandler({reader, tailers}));

server.listen(port, address, () => process.stdout.write(`console: observability API on http://${address}:${port}\n`));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
        tailers.stopAll();
        server.close(() => void reader.close().then(() => process.exit(0)));
    });
}
