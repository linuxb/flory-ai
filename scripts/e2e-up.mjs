// Brings up the gateway-mediated topology: blob store, gatewayd, and the four
// mock tool services, in dependency order.
//
// It waits for each stage rather than sleeping, and finishes only once the
// gateway reports a published tool view -- which is the first moment anything
// downstream can resolve a contract to plan or execute against.
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';

const gatewayHttp = process.env.GATEWAY_BASE_URL ?? 'http://127.0.0.1:8092';
const gatewayGrpc = process.env.GATEWAYD_GRPC_ADDR ?? '127.0.0.1:8093';
const children = [];
let shuttingDown = false;

/** Starts a child process and keeps it attached to this one's lifetime. */
function start(name, command, argumentList, environment = {}) {
    const child = spawn(command, argumentList, {stdio: ['ignore', 'inherit', 'inherit'], env: {...process.env, ...environment}});
    children.push({name, child});
    child.on('exit', (code) => {
        if (shuttingDown) return;
        process.stderr.write(`${name} exited with code ${code}\n`);
        void shutdown(1);
    });
    return child;
}

async function shutdown(code) {
    shuttingDown = true;
    for (const {child} of children) child.kill('SIGTERM');
    await delay(200);
    process.exit(code);
}

/** Polls a URL until it answers, so a stage starts only once the one below it is up. */
async function waitFor(name, url, attempts = 100) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
            const response = await fetch(url);
            if (response.ok || response.status === 204) return;
        } catch {
            // Not listening yet.
        }
        await delay(100);
    }
    throw new Error(`${name} did not become ready at ${url}`);
}

/**
 * Refuses to start if a port is already taken.
 *
 * Without this, a gatewayd left over from an earlier run keeps answering, the
 * newly spawned one dies on bind, and every service registers against the stale
 * process -- which looks like a working topology right up until its leftover
 * registrations contradict the ones this run just made.
 */
async function requireFreePort(name, host, port) {
    const probe = createServer();
    try {
        await new Promise((resolve, reject) => {
            probe.once('error', reject);
            probe.listen(port, host, resolve);
        });
    } catch (error) {
        throw new Error(`${name} cannot start: ${host}:${port} is already in use. Stop the process holding it first (${error.code}).`);
    } finally {
        await new Promise((resolve) => probe.close(resolve));
    }
}

process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));

const backend = process.env.GATEWAYD_BLOB_BACKEND ?? 'memory';
if (backend === 'gcs' && !process.env.STORAGE_EMULATOR_HOST) {
    // Against a real bucket this script would be provisioning production storage, which is a deployment decision.
    throw new Error("GATEWAYD_BLOB_BACKEND=gcs needs STORAGE_EMULATOR_HOST; it must match the emulator's -public-host or reads resolve to nothing");
}

const httpTarget = new URL(gatewayHttp);
const [grpcHost, grpcPort] = gatewayGrpc.split(':');
await requireFreePort('gatewayd', httpTarget.hostname, Number(httpTarget.port));
await requireFreePort('gatewayd', grpcHost, Number(grpcPort));
await requireFreePort('the sandbox world', process.env.SANDBOX_ADDR ?? '127.0.0.1', Number(process.env.SANDBOX_PORT ?? 8090));

process.stdout.write(`starting gatewayd (blob backend: ${backend})\n`);
start('gatewayd', 'go', ['-C', 'gatewayd', 'run', './cmd/gatewayd'], {
    GOTOOLCHAIN: process.env.GOTOOLCHAIN ?? 'go1.25.0',
    GATEWAYD_BLOB_BACKEND: backend,
    GATEWAYD_HTTP_ADDR: new URL(gatewayHttp).host,
    GATEWAYD_GRPC_ADDR: gatewayGrpc,
});
await waitFor('gatewayd', `${gatewayHttp}/healthz`);

process.stdout.write('starting the mock tool services\n');
start('sandbox', 'npx', ['tsx', 'test/sandbox/server.ts'], {
    GATEWAYD_BASE_URL: process.env.GATEWAYD_BASE_URL ?? `http://${gatewayGrpc}`,
    GATEWAYD_HEARTBEAT_MS: process.env.GATEWAYD_HEARTBEAT_MS ?? '1000',
});
await waitFor('sandbox world', `http://${process.env.SANDBOX_ADDR ?? '127.0.0.1'}:${process.env.SANDBOX_PORT ?? 8090}/healthz`);

// Registration is asynchronous, so the topology is only ready once the gateway has admitted something.
for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(`${gatewayHttp}/v1/tool-view`);
    if (response.ok) {
        const view = await response.json();
        if (view.tool_count > 0) {
            process.stdout.write(`tool view published: ${view.tool_view_digest} (${view.tool_count} tools)\n`);
            break;
        }
    }
    if (attempt > 100) throw new Error('the gateway published no tools; check the registration logs above');
    await delay(100);
}

process.stdout.write('topology ready; press Ctrl-C to stop\n');
await once(process, 'SIGCONT');
