import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import type {ToolService} from '../../sdk/typescript/index.js';
import {startChannelService} from '../mocks/ecommerce/channel-service.js';
import {FaultSchedule, type InjectedOutcome} from '../mocks/ecommerce/faults.js';
import {startInventoryService} from '../mocks/ecommerce/inventory-service.js';
import {startLogisticsService} from '../mocks/ecommerce/logistics-service.js';
import {startPaymentService} from '../mocks/ecommerce/payment-service.js';
import {MockCommerceWorld} from '../mocks/ecommerce/services.js';

interface ResetRequest {
    seed?: string;
    faults?: Record<string, InjectedOutcome>;
}

/**
 * The deterministic test world.
 *
 * It owns the ledgers, the fault schedule, and the oracle snapshot, and it hosts four tool services. It is not itself
 * a tool service and contains no gateway protocol: registration, heartbeat, and health belong to the SDK, and the
 * contracts belong to the services that implement them.
 */
export class Sandbox {
    private world = new MockCommerceWorld();
    private readonly faults = new FaultSchedule();
    private services: ToolService[] = [];

    /** Returns the current ledgers, so a tool service reads the world it is meant to act on. */
    get commerce(): MockCommerceWorld {
        return this.world;
    }

    /** Starts the four tool services and registers them with the gateway. */
    async start(gatewayUrl: string, heartbeatIntervalMs?: number): Promise<void> {
        const options = {gatewayUrl, faults: this.faults, heartbeatIntervalMs};
        // The world is read through this.world on every call, so a reset swaps the ledgers underneath the services
        // without restarting them -- and therefore without disturbing the published tool view.
        const proxy = new Proxy({} as MockCommerceWorld, {get: (_target, property) => this.world[property as keyof MockCommerceWorld]});
        this.services = await Promise.all([startInventoryService(proxy, options), startPaymentService(proxy, options), startLogisticsService(proxy, options), startChannelService(proxy, options)]);
        for (const service of this.services) {
            await service.register();
            service.start();
        }
    }

    /** Stops every service, deregistering each so its route is withdrawn cleanly. */
    async stop(): Promise<void> {
        await Promise.all(this.services.map((service) => service.stop()));
        this.services = [];
    }

    /**
     * Resets the ledgers and installs deterministic `(seed, tool, attempt)` outcomes.
     *
     * It deliberately leaves the services registered: the tool view is a contract catalog, and a scenario resetting
     * its world must not change what the tools are.
     */
    reset(request: ResetRequest = {}): void {
        this.world = new MockCommerceWorld();
        this.faults.reset(request.seed, request.faults);
    }

    /** Returns an oracle-visible snapshot; this endpoint is never a production contract. */
    snapshot(): Record<string, unknown> {
        return {
            inventory: {available: this.world.inventory.check('SKU-1'), open_holds: this.world.inventory.openHoldCount(), ledger: this.world.inventory.ledger},
            payment: {charges: Object.fromEntries(this.world.payment.charges)},
            logistics: {bookings: Object.fromEntries(this.world.logistics.bookings)},
            channel: {published: [...this.world.channel.published]},
        };
    }
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return chunks.length ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>) : {};
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
    response.writeHead(status, {'Content-Type': 'application/json'});
    response.end(JSON.stringify(value));
}

/** Creates the world's control handler. It exposes reset and snapshots only, never tool execution. */
export function createSandboxHandler(sandbox: Sandbox): (request: IncomingMessage, response: ServerResponse) => void {
    return (request, response) => {
        void (async () => {
            if (request.method === 'POST' && request.url === '/test/reset') {
                sandbox.reset((await readJson(request)) as ResetRequest);
                response.writeHead(204).end();
                return;
            }
            if (request.method === 'GET' && request.url === '/test/snapshot') {
                writeJson(response, 200, sandbox.snapshot());
                return;
            }
            if (request.method === 'GET' && request.url === '/healthz') {
                response.writeHead(204).end();
                return;
            }
            response.writeHead(404).end();
        })().catch((error: unknown) => writeJson(response, 500, {error: error instanceof Error ? error.message : String(error)}));
    };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
    const address = process.env.SANDBOX_ADDR ?? '127.0.0.1';
    const port = Number(process.env.SANDBOX_PORT ?? 8090);
    const gatewayUrl = process.env.GATEWAYD_BASE_URL ?? 'http://127.0.0.1:8093';
    const sandbox = new Sandbox();
    await sandbox.start(gatewayUrl, Number(process.env.GATEWAYD_HEARTBEAT_MS ?? 5000));
    createServer(createSandboxHandler(sandbox)).listen(port, address, () => process.stdout.write(`sandbox world listening on http://${address}:${port}\n`));
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        process.on(signal, () => {
            void sandbox.stop().then(() => process.exit(0));
        });
    }
}
