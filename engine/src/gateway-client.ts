import {loadToolRegistry, parseToolView, type ToolViewDocument, type ToolViewIdentity} from './tool-view.js';
import type {ToolRegistry} from './check-rules.js';

/** The four-outcome vocabulary both executors reason with. */
export type AttemptOutcome = 'succeeded' | 'retryable-failure' | 'permanent-failure' | 'unknown';

/** What one routed attempt returned. */
export interface AttemptResult {
    outcome: AttemptOutcome;
    result?: Record<string, unknown>;
    error?: string;
}

/** The pin and identity an executor attaches to one attempt. */
export interface AttemptPin {
    runId: string;
    vertexId: string;
    scopeId?: string;
    toolVersion: string;
    toolViewDigest: string;
    attempt: number;
    idempotencyKey?: string;
    deadlineMs?: number;
}

/** A resolved tool view together with the registry the checker consumes. */
export interface ResolvedToolView {
    identity: ToolViewIdentity;
    document: ToolViewDocument;
    registry: ToolRegistry;
}

/**
 * A refusal the gateway decided before dispatching anything.
 *
 * Every reason in this class means the attempt never left the gateway, which is what lets a caller treat it as
 * decisive rather than as an ambiguous outcome needing a status query.
 */
export class GatewayRefusal extends Error {
    constructor(
        readonly reason: string,
        message: string,
    ) {
        super(message);
        this.name = 'GatewayRefusal';
    }
}

/** Options for reaching a gatewayd MCP surface. */
export interface GatewayClientOptions {
    baseUrl: string;
    fetch?: typeof globalThis.fetch;
}

interface RpcResponse {
    result?: Record<string, unknown>;
    error?: {code: number; message: string; data?: {reason?: string}};
}

/**
 * The Orchestrator's client for the gateway's MCP surface.
 *
 * It is used for two things, and it matters that they are separate. `resolveToolView` is discovery: it runs before
 * planning, and the immutable snapshot it returns is what `checkSubDag` is given, so no live lookup ever happens
 * inside a check-rule or a replay. `call` executes one attempt of one tool, and the Orchestrator may only use it for
 * vertices whose pinned contract declares `effect_class: none`.
 */
export class GatewayClient {
    private readonly baseUrl: string;
    private readonly fetchImpl: typeof globalThis.fetch;
    private nextId = 1;

    constructor(options: GatewayClientOptions) {
        this.baseUrl = options.baseUrl.replace(/\/+$/, '');
        this.fetchImpl = options.fetch ?? globalThis.fetch;
    }

    /**
     * Resolves one immutable tool view and builds the registry the checker consumes.
     *
     * Pass a digest to resolve an exact historical view; pass nothing to take the current one, whose identity the
     * caller then records in `subgraph/proposed` so a later replay resolves the same contract by reference.
     */
    async resolveToolView(toolViewDigest?: string): Promise<ResolvedToolView> {
        const result = await this.send('tools/list', toolViewDigest ? {tool_view_digest: toolViewDigest} : {});
        const meta = result['_meta'] as (ToolViewIdentity & {tool_view_document?: string}) | undefined;
        if (!meta?.tool_view_digest) throw new Error('gateway: tools/list returned no tool-view identity');
        if (!meta.tool_view_document) throw new Error('gateway: tools/list returned no canonical document to verify');
        // Verify rather than trust: the digest is re-derived here from the bytes the gateway served, so a gateway that
        // served the wrong view -- for any reason -- fails closed instead of quietly changing what was planned against.
        const {document} = parseToolView(meta.tool_view_document, meta.tool_view_digest);
        return {identity: {tool_view_ref: meta.tool_view_ref, tool_view_digest: meta.tool_view_digest}, document, registry: loadToolRegistry(document)};
    }

    /**
     * Routes one attempt of one tool.
     *
     * It sends exactly one request and reports whatever came back. It never retries: whether the same operation may be
     * attempted again depends on idempotency and transaction state that the calling executor owns, and a client that
     * retried on its own would make that decision somewhere it cannot be made correctly.
     */
    async call(name: string, args: Record<string, unknown>, pin: AttemptPin): Promise<AttemptResult> {
        const result = await this.send('tools/call', {
            name,
            arguments: args,
            _meta: {
                run_id: pin.runId,
                vertex_id: pin.vertexId,
                scope_id: pin.scopeId ?? '',
                tool_version: pin.toolVersion,
                tool_view_digest: pin.toolViewDigest,
                attempt: pin.attempt,
                idempotency_key: pin.idempotencyKey ?? '',
                deadline_ms: pin.deadlineMs ?? 0,
            },
        });
        const structured = result['structuredContent'] as AttemptResult | undefined;
        if (!structured?.outcome) throw new Error(`gateway: tools/call for ${name} returned no outcome`);
        return structured;
    }

    private async send(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
        const response = await this.fetchImpl(`${this.baseUrl}/mcp`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({jsonrpc: '2.0', id: this.nextId++, method, params}),
        });
        if (!response.ok) throw new Error(`gateway: ${method} returned HTTP ${response.status}`);
        const decoded = (await response.json()) as RpcResponse;
        if (decoded.error) {
            const reason = decoded.error.data?.reason;
            if (reason) throw new GatewayRefusal(reason, decoded.error.message);
            throw new Error(`gateway: ${method}: ${decoded.error.message}`);
        }
        return decoded.result ?? {};
    }
}
