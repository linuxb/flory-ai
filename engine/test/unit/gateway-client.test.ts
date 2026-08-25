import {describe, expect, it} from 'vitest';
import {GatewayClient, GatewayRefusal} from '../../src/gateway-client.js';
import {canonicalize, digestOf, type ToolViewDocument, toolViewRef} from '../../src/tool-view.js';

function view(): ToolViewDocument {
    return {
        tool_view_version: '1',
        tools: [
            {
                tool_id: 'inventory.check',
                tool_version: '1.0.0',
                input_schema: {type: 'object'},
                output_schema: {type: 'object'},
                route_id: 'inventory',
                adapter: {protocol: 'grpc'},
                txn: {effect_class: 'none', mode: 'plain', idempotent_retryable: true},
                compensation_style: 'not-compensating',
                footprint: ['inventory:{sku}'],
                writes: [],
                timeout_ms: 5000,
                retry_constraints: {max_attempts: 3, initial_backoff_ms: 100, multiplier_milli: 2000, max_backoff_ms: 5000},
                owner: 'inventory-team',
            },
        ],
    };
}

interface StubOptions {
    document?: string;
    digest?: string;
    error?: {code: number; message: string; data?: {reason: string}};
    result?: Record<string, unknown>;
}

/** A stub MCP surface, so the client's own behaviour is what is under test. */
function stubGateway(options: StubOptions = {}): {client: GatewayClient; requests: Array<Record<string, unknown>>} {
    const canonical = options.document ?? canonicalize(view());
    const digest = options.digest ?? digestOf(canonical);
    const requests: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_url: string, init?: {body?: string}) => {
        const request = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
        requests.push(request);
        if (options.error) return jsonResponse({jsonrpc: '2.0', id: request.id, error: options.error});
        if (request.method === 'tools/list') {
            return jsonResponse({
                jsonrpc: '2.0',
                id: request.id,
                result: {tools: [], _meta: {tool_view_ref: toolViewRef(digest), tool_view_digest: digest, tool_view_document: canonical}},
            });
        }
        return jsonResponse({jsonrpc: '2.0', id: request.id, result: options.result ?? {structuredContent: {outcome: 'succeeded', result: {available: 7}}}});
    }) as unknown as typeof globalThis.fetch;
    return {client: new GatewayClient({baseUrl: 'http://gateway.invalid', fetch: fetchImpl}), requests};
}

function jsonResponse(body: unknown): Response {
    return {ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body)} as unknown as Response;
}

describe('resolving a tool view', () => {
    it('returns the identity a proposal records and a registry the checker can use', async () => {
        const {client} = stubGateway();
        const resolved = await client.resolveToolView();
        expect(resolved.identity.tool_view_digest).toBe(digestOf(canonicalize(view())));
        expect(resolved.identity.tool_view_ref).toBe(toolViewRef(resolved.identity.tool_view_digest));
        expect(resolved.registry.get('inventory.check').effectClass).toBe('none');
    });

    // Content addressing is only a guarantee if the reader checks it. A gateway that served the wrong document -- for
    // any reason -- must fail closed rather than quietly change what planning validates against.
    it('refuses a document that does not canonicalise to the digest it was served with', async () => {
        const {client} = stubGateway({digest: `sha256:${'a'.repeat(64)}`});
        await expect(client.resolveToolView()).rejects.toThrow(/canonicalises to/);
    });

    it('refuses a response with no canonical document to verify', async () => {
        const fetchImpl = (async (_url: string, init?: {body?: string}) => {
            const request = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
            return jsonResponse({jsonrpc: '2.0', id: request.id, result: {tools: [], _meta: {tool_view_digest: `sha256:${'b'.repeat(64)}`, tool_view_ref: 'x'}}});
        }) as unknown as typeof globalThis.fetch;
        const client = new GatewayClient({baseUrl: 'http://gateway.invalid', fetch: fetchImpl});
        await expect(client.resolveToolView()).rejects.toThrow(/no canonical document/);
    });
});

describe('routing one attempt', () => {
    it('sends the caller pin the gateway needs to resolve an exact contract', async () => {
        const {client, requests} = stubGateway();
        const digest = digestOf(canonicalize(view()));
        const result = await client.call('inventory.check', {sku: 'SKU-1'}, {runId: 'run-1', vertexId: 'v-1', toolVersion: '1.0.0', toolViewDigest: digest, attempt: 1, idempotencyKey: 'key-1'});
        expect(result.outcome).toBe('succeeded');
        const call = requests.find((request) => request.method === 'tools/call');
        const params = call?.params as {name: string; _meta: Record<string, unknown>};
        expect(params.name).toBe('inventory.check');
        expect(params._meta.tool_version).toBe('1.0.0');
        expect(params._meta.tool_view_digest).toBe(digest);
        expect(params._meta.idempotency_key).toBe('key-1');
    });

    it('sends exactly one request per attempt', async () => {
        const {client, requests} = stubGateway({result: {structuredContent: {outcome: 'retryable-failure', error: 'upstream busy'}}});
        const result = await client.call('inventory.check', {}, {runId: 'r', vertexId: 'v', toolVersion: '1.0.0', toolViewDigest: `sha256:${'c'.repeat(64)}`, attempt: 1});
        expect(result.outcome).toBe('retryable-failure');
        // Whether this may be attempted again is the executor's decision; a client that retried would make it here.
        expect(requests.filter((request) => request.method === 'tools/call')).toHaveLength(1);
    });

    // A refusal means the attempt never left the gateway, which is what lets a caller treat it as decisive.
    it('surfaces a gateway refusal with the reason that decided it', async () => {
        const {client} = stubGateway({error: {code: -32000, message: 'route inventory has no healthy instance', data: {reason: 'route-unhealthy'}}});
        await expect(client.call('inventory.check', {}, {runId: 'r', vertexId: 'v', toolVersion: '1.0.0', toolViewDigest: `sha256:${'d'.repeat(64)}`, attempt: 1})).rejects.toThrow(GatewayRefusal);
        try {
            await client.call('inventory.check', {}, {runId: 'r', vertexId: 'v', toolVersion: '1.0.0', toolViewDigest: `sha256:${'d'.repeat(64)}`, attempt: 1});
        } catch (error) {
            expect((error as GatewayRefusal).reason).toBe('route-unhealthy');
        }
    });
});
