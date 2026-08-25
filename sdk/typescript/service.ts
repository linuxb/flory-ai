import type {Http2Server} from 'node:http2';
import {createServer} from 'node:http2';
import {createClient, type Client, type ConnectRouter} from '@connectrpc/connect';
import {connectNodeAdapter, createGrpcTransport} from '@connectrpc/connect-node';
import {create} from '@bufbuild/protobuf';
import {timestampDate} from '@bufbuild/protobuf/wkt';
import {type ExecuteRequest, type ExecuteResponse, Outcome as WireOutcome, ToolExecutionService} from './gen/flory/gateway/v1/execution_pb.js';
import {HealthReportSchema, InstanceInfoSchema, RegistryService, ServingStatus, type ToolStatus, ToolState} from './gen/flory/gateway/v1/registry_pb.js';
import type {ToolContract} from './gen/flory/gateway/v1/tool_contract_pb.js';
import {Health, HealthCheckResponse_ServingStatus} from './gen-health/grpc/health/v1/health_pb.js';
import {buildContract, type Contract, contractViolation} from './contract.js';

/** What a handler reports about one attempt, in the executors' own vocabulary. */
export type Outcome = 'succeeded' | 'retryable-failure' | 'permanent-failure' | 'unknown';

/** One attempt delivered to a handler. */
export interface Call {
    runId: string;
    vertexId: string;
    scopeId: string;
    attemptNo: number;
    toolId: string;
    toolVersion: string;
    idempotencyKey: string;
    /** Arguments already validated by the gateway against the frozen input schema. */
    args: Record<string, unknown>;
    deadline?: Date;
}

/** A handler's answer. */
export interface Result {
    outcome: Outcome;
    value?: unknown;
    error?: string;
}

/**
 * Executes one attempt of one tool.
 *
 * It is called at most once per attempt: neither the SDK nor the gateway will call it again on its own. If the same
 * idempotency key arrives twice, that is an executor's deliberate retry, and the handler must be idempotent in
 * exactly the way its contract declared.
 */
export type Handler = (call: Call) => Promise<Result> | Result;

/** A declared contract paired with the handler that serves it. */
export interface Tool {
    contract: Contract;
    handler: Handler;
}

/** Describes one tool-service instance. */
export interface ServiceConfig {
    /** Unique per process. A restarted process may reuse it; re-registering an identical contract is idempotent. */
    instanceId: string;
    /** The logical route this service serves. Several instances share it, which is what lets the gateway spread attempts. */
    routeId: string;
    /** The address the gateway will reach this instance on, which is not always the listen address. */
    target: string;
    /** The gateway's registration surface, as a base URL. */
    gatewayUrl: string;
    leaseTtlMs?: number;
    heartbeatIntervalMs?: number;
    log?: (message: string, detail?: unknown) => void;
}

/** Keeps several beats inside one lease, so a single lost heartbeat does not withdraw a healthy instance. */
export const DEFAULT_LEASE_TTL_MS = 30_000;
/** The default heartbeat cadence. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;

const OUTCOMES: Record<Outcome, WireOutcome> = {
    succeeded: WireOutcome.SUCCEEDED,
    'retryable-failure': WireOutcome.RETRYABLE_FAILURE,
    'permanent-failure': WireOutcome.PERMANENT_FAILURE,
    unknown: WireOutcome.UNKNOWN,
};

/** One registering, heartbeating tool service. */
export class ToolService {
    private readonly tools = new Map<string, Tool>();
    private readonly contracts = new Map<string, ToolContract>();
    private readonly registry: Client<typeof RegistryService>;
    private readonly log: (message: string, detail?: unknown) => void;
    private server?: Http2Server;
    private heartbeat?: ReturnType<typeof setInterval>;
    private serving = false;

    constructor(private readonly config: ServiceConfig) {
        if (!config.instanceId || !config.routeId || !config.target) throw new Error('sdk: instanceId, routeId, and target are all required');
        this.log = config.log ?? (() => {});
        this.registry = createClient(RegistryService, createGrpcTransport({baseUrl: config.gatewayUrl}));
    }

    /**
     * Adds tools this service offers.
     *
     * Contracts are validated here, at startup, before any network call: a service that declares a saga with no
     * compensator should fail while someone is watching it start.
     */
    declare(...tools: readonly Tool[]): void {
        for (const tool of tools) {
            const violation = contractViolation(tool.contract);
            if (violation) throw new Error(`sdk: ${tool.contract.toolId} is not registrable: ${violation}`);
            if (this.tools.has(tool.contract.toolId)) throw new Error(`sdk: ${tool.contract.toolId} is declared twice`);
            this.tools.set(tool.contract.toolId, tool);
            this.contracts.set(tool.contract.toolId, buildContract(tool.contract, this.config.routeId));
        }
    }

    /** Starts the gRPC surface the gateway dispatches to, and its health check. */
    async listen(port: number, host = '127.0.0.1'): Promise<number> {
        const routes = (router: ConnectRouter): void => {
            router.service(ToolExecutionService, {execute: (request) => this.execute(request)});
            // The gateway probes this itself rather than trusting the heartbeat report, so it has to answer even
            // while the service considers itself unready.
            router.service(Health, {
                check: () => ({status: this.serving ? HealthCheckResponse_ServingStatus.SERVING : HealthCheckResponse_ServingStatus.NOT_SERVING}),
            });
        };
        // gRPC mandates HTTP/2, so this is an h2c server rather than the HTTP/1.1
        // one a Connect-only service could use. A gRPC client -- the Go gateway --
        // cannot talk to an HTTP/1.1 listener at all.
        this.server = createServer(connectNodeAdapter({routes, grpc: true}));
        await new Promise<void>((resolve) => this.server!.listen(port, host, resolve));
        const address = this.server.address();
        return typeof address === 'object' && address ? address.port : port;
    }

    /**
     * Publishes this instance's own readiness.
     *
     * It drives both signals the gateway consults: the health check it probes, and the report carried on each
     * heartbeat. A service that knows it cannot work says so here and stops receiving attempts, without deregistering.
     */
    setServing(serving: boolean): void {
        this.serving = serving;
    }

    /** Declares this instance and its contracts to the gateway. */
    async register(): Promise<readonly ToolStatus[]> {
        const response = await this.registry.register({
            instance: create(InstanceInfoSchema, {
                instanceId: this.config.instanceId,
                routeId: this.config.routeId,
                target: this.config.target,
                leaseTtlMs: this.config.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS,
            }),
            tools: this.declaredContracts(),
            health: this.healthReport(),
        });
        for (const status of response.statuses) {
            if (status.state === ToolState.REJECTED) this.log('tool registration rejected', {tool: status.toolId, code: status.code, detail: status.detail});
        }
        return response.statuses;
    }

    /**
     * Keeps the registration alive until stop() is called.
     *
     * Heartbeats are retried on transport failure, unlike a tool call: a heartbeat is idempotent control-plane traffic
     * with no side effect, so repeating one is free, while repeating a tool call could duplicate a business effect.
     *
     * When the gateway reports this instance unknown, this registers again. That is the whole recovery path for a
     * gateway that deliberately keeps no durable registry: it restarts empty, and every live service tells it what it
     * serves again.
     */
    start(): void {
        const interval = this.config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
        this.heartbeat = setInterval(() => {
            void (async () => {
                try {
                    const response = await this.registry.heartbeat({instanceId: this.config.instanceId, health: this.healthReport()});
                    if (!response.knownInstance) {
                        this.log('gateway does not know this instance; registering again');
                        await this.register();
                    }
                } catch (error: unknown) {
                    this.log('heartbeat failed', error);
                }
            })();
        }, interval);
    }

    /**
     * Deregisters and stops serving.
     *
     * Deregistration withdraws this instance's route. It does not withdraw the contracts: the published view and its
     * digest are unchanged, so a subgraph frozen against them still resolves, and calls fail as unroutable rather
     * than as unknown.
     */
    async stop(): Promise<void> {
        this.setServing(false);
        if (this.heartbeat) clearInterval(this.heartbeat);
        try {
            await this.registry.deregister({instanceId: this.config.instanceId});
        } catch (error: unknown) {
            this.log('deregistration failed', error);
        }
        if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    }

    private declaredContracts(): ToolContract[] {
        // Stable order, so two runs of the same service send byte-identical registrations.
        return [...this.contracts.keys()].sort().map((name) => this.contracts.get(name)!);
    }

    private healthReport() {
        return create(HealthReportSchema, {status: this.serving ? ServingStatus.SERVING : ServingStatus.NOT_SERVING});
    }

    private async execute(request: ExecuteRequest): Promise<ExecuteResponse> {
        const tool = this.tools.get(request.toolId);
        if (!tool) {
            return {outcome: WireOutcome.PERMANENT_FAILURE, result: '', error: `${this.config.instanceId} does not serve ${request.toolId}`} as ExecuteResponse;
        }
        let args: Record<string, unknown> = {};
        if (request.arguments) args = JSON.parse(request.arguments) as Record<string, unknown>;
        const result = await tool.handler({
            runId: request.runId,
            vertexId: request.vertexId,
            scopeId: request.scopeId,
            attemptNo: request.attemptNo,
            toolId: request.toolId,
            toolVersion: request.toolVersion,
            idempotencyKey: request.idempotencyKey,
            args,
            deadline: request.deadline ? timestampDate(request.deadline) : undefined,
        });
        const outcome = OUTCOMES[result.outcome];
        if (outcome === undefined) {
            // A handler that returned no outcome has told us nothing about whether its effect happened, and unknown is
            // exactly that statement.
            return {outcome: WireOutcome.UNKNOWN, result: '', error: `handler returned an unknown outcome ${String(result.outcome)}`} as ExecuteResponse;
        }
        return {outcome, result: result.value === undefined ? '' : JSON.stringify(result.value), error: result.error ?? ''} as ExecuteResponse;
    }
}
