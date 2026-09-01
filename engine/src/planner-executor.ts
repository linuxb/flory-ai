import {createHash} from 'node:crypto';
import type {EventDraft} from './events.js';
import {canonicalJson} from './events.js';
import {estimateLlmCost, publicEndpoint, type LlmCallResult, type LlmClient, type LlmMessage} from './llm-client.js';

/** Minimal event-log boundary used by the planner executor. */
export interface PlannerEventSink {
    appendEvents(runId: string, events: EventDraft[]): Promise<number[]>;
}

/** One real planner thought-call request. */
export interface PlannerExecutionRequest {
    runId: string;
    plannerId: string;
    messages: readonly LlmMessage[];
}

/** Returned planner text plus normalized provider metadata. */
export interface PlannerExecutionResult extends LlmCallResult {
    inputDigest: string;
    outputDigest: string;
}

function digest(value: unknown): string {
    return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function safeFailure(error: unknown, secrets: readonly string[]): Record<string, unknown> {
    if (!(error instanceof Error)) return {error_type: 'unknown', message: 'LLM call failed'};
    const message = secrets.reduce((value, secret) => (secret ? value.replaceAll(secret, '[redacted]') : value), error.message);
    return {error_type: error.name, message: message.slice(0, 500)};
}

/** Executes planner vertices against a real LLM and records lifecycle plus usage in the event log. */
export class PlannerExecutor {
    constructor(
        private readonly events: PlannerEventSink,
        private readonly llm: LlmClient,
    ) {}

    /** Runs one thought call for an existing planner vertex. */
    async execute(request: PlannerExecutionRequest): Promise<PlannerExecutionResult> {
        const inputDigest = digest(request.messages);
        await this.events.appendEvents(request.runId, [
            {
                event_type: 'vertex/started',
                vertex_id: request.plannerId,
                payload: {attempt: 1, execution: 'llm', input_digest: inputDigest},
            },
        ]);
        try {
            const result = await this.llm.call(request.messages);
            const outputDigest = digest(result.content);
            const pricing = this.llm.config.pricing;
            await this.events.appendEvents(request.runId, [
                {
                    event_type: 'budget/charged',
                    vertex_id: request.plannerId,
                    payload: {
                        category: 'llm',
                        provider: this.llm.config.provider,
                        protocol: this.llm.config.protocol,
                        endpoint: publicEndpoint(this.llm.config.endpoint),
                        requested_model: this.llm.config.model,
                        response_model: result.responseModel,
                        duration_ms: result.durationMs,
                        usage: result.usage,
                        ...(pricing ? {estimated_cost: estimateLlmCost(result.usage, pricing)} : {}),
                    },
                },
                {
                    event_type: 'vertex/succeeded',
                    vertex_id: request.plannerId,
                    payload: {
                        attempts: 1,
                        result: {
                            response_id: result.responseId,
                            response_model: result.responseModel,
                            finish_reason: result.finishReason,
                            output_digest: outputDigest,
                        },
                    },
                },
            ]);
            return {...result, inputDigest, outputDigest};
        } catch (error) {
            await this.events.appendEvents(request.runId, [
                {
                    event_type: 'vertex/failed',
                    vertex_id: request.plannerId,
                    payload: {attempts: 1, failure: safeFailure(error, [this.llm.config.apiKey, this.llm.config.endpoint])},
                },
            ]);
            throw error;
        }
    }
}
