import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import {MockCommerceWorld} from '../mocks/ecommerce/services.js';

interface OperationRequest {
    run_id: string;
    vertex_id: string;
    attempt_no: number;
    tool: string;
    idempotency_key?: string;
    input: Record<string, unknown>;
}

interface ResetRequest {
    seed?: string;
    faults?: Record<string, 'retryable-failure' | 'permanent-failure' | 'unknown'>;
}

/** Deterministic, test-only business adapter world exposed over HTTP. */
export class Sandbox {
    private world = new MockCommerceWorld();
    private seed = 'default';
    private faults: ResetRequest['faults'] = {};

    /** Resets all ledgers and installs deterministic `(seed, tool, attempt)` outcomes. */
    reset(request: ResetRequest = {}): void {
        this.world = new MockCommerceWorld();
        this.seed = request.seed ?? 'default';
        this.faults = {...request.faults};
    }

    /** Executes one adapter request using idempotent mock actors. */
    execute(request: OperationRequest): Record<string, unknown> {
        const injected = this.faults?.[`${this.seed}:${request.tool}:${request.attempt_no}`];
        if (injected) return {outcome: injected, error: `injected ${injected}`};
        const input = request.input;
        const key = request.idempotency_key ?? String(input.order_id ?? request.vertex_id);
        try {
            let result: Record<string, unknown> = {};
            switch (request.tool) {
                case 'inventory.check':
                    result = {available: this.world.inventory.check(String(input.sku))};
                    break;
                case 'inventory.reserve':
                    this.world.inventory.reserve(key, String(input.sku), Number(input.quantity));
                    break;
                case 'inventory.confirm':
                    this.world.inventory.confirm(key);
                    break;
                case 'inventory.release':
                    this.world.inventory.release(key);
                    break;
                case 'payment.authorize':
                    this.world.payment.authorize(String(input.order_id), Number(input.amount));
                    break;
                case 'payment.capture':
                    this.world.payment.capture(String(input.order_id));
                    break;
                case 'payment.void':
                    this.world.payment.void(String(input.order_id));
                    break;
                case 'payment.status':
                    result = {occurred: this.world.payment.charges.has(String(input.order_id))};
                    break;
                case 'logistics.quote':
                    result = {price: this.world.logistics.quote(String(input.carrier), String(input.postcode))};
                    break;
                case 'logistics.book':
                    this.world.logistics.book(String(input.order_id), String(input.carrier), String(input.postcode));
                    break;
                case 'channel.draft':
                    this.world.channel.draft(String(input.listing_id), String(input.sku), Number(input.price));
                    break;
                case 'channel.publish':
                    this.world.channel.publish(String(input.listing_id));
                    break;
                default:
                    return {outcome: 'permanent-failure', error: `unknown sandbox tool ${request.tool}`};
            }
            return {outcome: 'succeeded', result};
        } catch (error) {
            return {outcome: 'permanent-failure', error: error instanceof Error ? error.message : String(error)};
        }
    }

    /** Returns an oracle-visible snapshot; this endpoint is never a production adapter contract. */
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

/** Creates the out-of-process deterministic sandbox HTTP handler. */
export function createSandboxHandler(sandbox = new Sandbox()): (request: IncomingMessage, response: ServerResponse) => void {
    return (request, response) => {
        void (async () => {
            if (request.method === 'POST' && request.url === '/v1/execute') {
                writeJson(response, 200, sandbox.execute((await readJson(request)) as unknown as OperationRequest));
                return;
            }
            if (request.method === 'POST' && request.url === '/test/reset') {
                sandbox.reset((await readJson(request)) as ResetRequest);
                response.writeHead(204).end();
                return;
            }
            if (request.method === 'GET' && request.url === '/test/snapshot') {
                writeJson(response, 200, sandbox.snapshot());
                return;
            }
            response.writeHead(404).end();
        })().catch((error: unknown) => writeJson(response, 500, {error: error instanceof Error ? error.message : String(error)}));
    };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
    const address = process.env.SANDBOX_ADDR ?? '127.0.0.1';
    const port = Number(process.env.SANDBOX_PORT ?? 8090);
    createServer(createSandboxHandler()).listen(port, address, () => process.stdout.write(`sandbox listening on http://${address}:${port}\n`));
}
