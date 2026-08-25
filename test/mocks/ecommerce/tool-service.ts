import {type Contract, defaultRetry, type Handler, type Result, ToolService} from '../../../sdk/typescript/index.js';
import type {FaultSchedule} from './faults.js';

/** How a mock tool service is wired into the test world. */
export interface MockServiceOptions {
    /** The gateway's registration surface, as a base URL. */
    gatewayUrl: string;
    /** Listen port; 0 asks the operating system for one. */
    port?: number;
    faults: FaultSchedule;
    heartbeatIntervalMs?: number;
}

/** One tool a mock service offers. */
export interface MockTool {
    contract: Contract;
    run: (args: Record<string, unknown>) => Record<string, unknown> | void;
}

/**
 * Wraps an actor's method as a tool handler.
 *
 * It applies the harness's fault schedule first, then translates a thrown error into a permanent failure. A mock actor
 * signals "this cannot work" by throwing, which is a business outcome rather than a transport one.
 */
function handlerFor(tool: MockTool, faults: FaultSchedule): Handler {
    return (call): Result => {
        const injected = faults.injected(tool.contract.toolId, call.attemptNo);
        if (injected) return {outcome: injected, error: `injected ${injected}`};
        try {
            return {outcome: 'succeeded', value: tool.run(call.args) ?? {}};
        } catch (error: unknown) {
            return {outcome: 'permanent-failure', error: error instanceof Error ? error.message : String(error)};
        }
    };
}

/**
 * Builds one registering, heartbeating mock tool service.
 *
 * Each mock service is a real tool service: it declares its own contracts, serves them over the SDK, and registers with
 * the gateway exactly as a production service does. The declaration lives with the service that implements it, so there
 * is no separate catalog anywhere — the catalog is the tool view the gateway publishes.
 */
export async function startMockService(name: string, tools: readonly MockTool[], options: MockServiceOptions): Promise<ToolService> {
    const port = options.port ?? 0;
    const service = new ToolService({
        instanceId: `${name}-1`,
        routeId: name,
        // Resolved to the bound port below, because port 0 is only known after listening.
        target: `127.0.0.1:${port}`,
        gatewayUrl: options.gatewayUrl,
        heartbeatIntervalMs: options.heartbeatIntervalMs,
        log: (message, detail) => process.stdout.write(`${name}: ${message} ${detail === undefined ? '' : JSON.stringify(detail)}\n`),
    });
    service.declare(...tools.map((tool) => ({contract: tool.contract, handler: handlerFor(tool, options.faults)})));
    const bound = await service.listen(port);
    service.setTarget(`127.0.0.1:${bound}`);
    service.setServing(true);
    return service;
}

/** Shared contract defaults, so each service states only what makes its tool distinctive. */
export function baseContract(toolId: string, overrides: Partial<Contract>): Contract {
    return {
        toolId,
        toolVersion: '1.0.0',
        inputSchema: '{"type":"object"}',
        outputSchema: '{"type":"object"}',
        effectClass: 'none',
        mode: 'plain',
        idempotentRetryable: true,
        timeoutMs: 5000,
        retry: defaultRetry(),
        owner: 'flory-sandbox',
        ...overrides,
    };
}
