import {readFile} from 'node:fs/promises';
import type {LlmCostEstimate, LlmProtocol, LlmUsage} from './generated/event-log.js';

export type {LlmCostEstimate, LlmProtocol, LlmUsage};

/** One message sent to a planner model. */
export interface LlmMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

/** A pricing snapshot used to estimate one call's cost. */
export interface LlmPricing {
    currency: string;
    cache_hit_input_per_million: number;
    cache_miss_input_per_million: number;
    output_per_million: number;
    reference: string;
    tier?: string;
}

/** Runtime settings for one LLM provider endpoint. */
export interface LlmProviderConfig {
    provider: string;
    protocol: LlmProtocol;
    endpoint: string;
    apiKey: string;
    model: string;
    timeoutMs: number;
    maxOutputTokens?: number;
    requestOptions?: Record<string, unknown>;
    additionalHeaders?: Record<string, string>;
    pricing?: LlmPricing;
}

/** Provider-neutral result returned to the planner executor. */
export interface LlmCallResult {
    responseId: string | null;
    responseModel: string;
    content: string;
    finishReason: string | null;
    durationMs: number;
    usage: LlmUsage;
}

interface OpenAiResponse {
    id?: string;
    model?: string;
    choices?: Array<{message?: {content?: string}; finish_reason?: string}>;
    usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        prompt_cache_hit_tokens?: number;
        prompt_cache_miss_tokens?: number;
        prompt_tokens_details?: {cached_tokens?: number};
        completion_tokens_details?: {reasoning_tokens?: number};
    };
    error?: {message?: string; type?: string};
}

interface AnthropicResponse {
    id?: string;
    model?: string;
    content?: Array<{type?: string; text?: string}>;
    stop_reason?: string;
    usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
    };
    error?: {message?: string; type?: string};
}

function required(value: string | undefined, name: string): string {
    if (!value?.trim()) throw new Error(`${name} is required`);
    return value.trim();
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
    if (value === undefined || value === '') return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
    return parsed;
}

function optionalNumber(value: string | undefined, name: string): number | undefined {
    if (value === undefined || value === '') return undefined;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative number`);
    return parsed;
}

function jsonObject(value: string | undefined, name: string): Record<string, unknown> | undefined {
    if (!value) return undefined;
    const parsed: unknown = JSON.parse(value);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error(`${name} must be a JSON object`);
    return parsed as Record<string, unknown>;
}

function validateEndpoint(endpoint: string): string {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname))) {
        throw new Error('FLORY_LLM_ENDPOINT must use HTTPS except for a loopback endpoint');
    }
    return url.toString();
}

/** Loads provider-neutral LLM settings from `FLORY_LLM_*` variables, including an optional key file. */
export async function loadLlmConfig(environment: NodeJS.ProcessEnv = process.env): Promise<LlmProviderConfig> {
    const keyFile = environment.FLORY_LLM_API_KEY_FILE?.trim();
    const apiKey = environment.FLORY_LLM_API_KEY?.trim() ?? (keyFile ? (await readFile(keyFile, 'utf8')).trim() : '');
    const protocol = required(environment.FLORY_LLM_PROTOCOL, 'FLORY_LLM_PROTOCOL');
    if (protocol !== 'openai-chat-completions' && protocol !== 'anthropic-messages') throw new Error(`unsupported FLORY_LLM_PROTOCOL: ${protocol}`);
    const hit = optionalNumber(environment.FLORY_LLM_PRICE_CACHE_HIT_INPUT, 'FLORY_LLM_PRICE_CACHE_HIT_INPUT');
    const miss = optionalNumber(environment.FLORY_LLM_PRICE_CACHE_MISS_INPUT, 'FLORY_LLM_PRICE_CACHE_MISS_INPUT');
    const output = optionalNumber(environment.FLORY_LLM_PRICE_OUTPUT, 'FLORY_LLM_PRICE_OUTPUT');
    const pricingValues = [hit, miss, output];
    if (pricingValues.some((value) => value !== undefined) && pricingValues.some((value) => value === undefined)) {
        throw new Error('all three FLORY_LLM_PRICE_* rates are required when cost estimation is enabled');
    }
    const pricing =
        hit === undefined
            ? undefined
            : {
                  currency: environment.FLORY_LLM_PRICE_CURRENCY?.trim() || 'USD',
                  cache_hit_input_per_million: hit,
                  cache_miss_input_per_million: miss!,
                  output_per_million: output!,
                  reference: required(environment.FLORY_LLM_PRICE_REFERENCE, 'FLORY_LLM_PRICE_REFERENCE'),
                  ...(environment.FLORY_LLM_PRICE_TIER?.trim() ? {tier: environment.FLORY_LLM_PRICE_TIER.trim()} : {}),
              };
    return {
        provider: required(environment.FLORY_LLM_PROVIDER, 'FLORY_LLM_PROVIDER'),
        protocol,
        endpoint: validateEndpoint(required(environment.FLORY_LLM_ENDPOINT, 'FLORY_LLM_ENDPOINT')),
        apiKey: required(apiKey, 'FLORY_LLM_API_KEY or FLORY_LLM_API_KEY_FILE'),
        model: required(environment.FLORY_LLM_MODEL, 'FLORY_LLM_MODEL'),
        timeoutMs: positiveInteger(environment.FLORY_LLM_TIMEOUT_MS, 60_000, 'FLORY_LLM_TIMEOUT_MS'),
        ...(environment.FLORY_LLM_MAX_OUTPUT_TOKENS ? {maxOutputTokens: positiveInteger(environment.FLORY_LLM_MAX_OUTPUT_TOKENS, 0, 'FLORY_LLM_MAX_OUTPUT_TOKENS')} : {}),
        ...(environment.FLORY_LLM_REQUEST_OPTIONS ? {requestOptions: jsonObject(environment.FLORY_LLM_REQUEST_OPTIONS, 'FLORY_LLM_REQUEST_OPTIONS')} : {}),
        ...(environment.FLORY_LLM_HEADERS ? {additionalHeaders: jsonObject(environment.FLORY_LLM_HEADERS, 'FLORY_LLM_HEADERS') as Record<string, string>} : {}),
        ...(pricing ? {pricing} : {}),
    };
}

/** Removes credentials, query parameters, and fragments before an endpoint is written to the event log. */
export function publicEndpoint(endpoint: string): string {
    const url = new URL(endpoint);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
}

/** Estimates cost from normalized usage and the exact configured price snapshot. */
export function estimateLlmCost(usage: LlmUsage, pricing: LlmPricing): LlmCostEstimate {
    const amount =
        (usage.cache_hit_input_tokens * pricing.cache_hit_input_per_million + usage.cache_miss_input_tokens * pricing.cache_miss_input_per_million + usage.output_tokens * pricing.output_per_million) /
        1_000_000;
    return {
        currency: pricing.currency,
        amount: Number(amount.toFixed(12)),
        pricing_ref: pricing.reference,
        ...(pricing.tier ? {pricing_tier: pricing.tier} : {}),
        rates_per_million: {
            cache_hit_input: pricing.cache_hit_input_per_million,
            cache_miss_input: pricing.cache_miss_input_per_million,
            output: pricing.output_per_million,
        },
    };
}

function normalizeOpenAiUsage(response: OpenAiResponse): LlmUsage {
    const usage = response.usage ?? {};
    const input = usage.prompt_tokens ?? 0;
    const output = usage.completion_tokens ?? 0;
    const hit = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
    const miss = usage.prompt_cache_miss_tokens ?? Math.max(0, input - hit);
    return {
        input_tokens: input,
        output_tokens: output,
        total_tokens: usage.total_tokens ?? input + output,
        reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
        cache_hit_input_tokens: hit,
        cache_miss_input_tokens: miss,
    };
}

function normalizeAnthropicUsage(response: AnthropicResponse): LlmUsage {
    const usage = response.usage ?? {};
    const uncached = usage.input_tokens ?? 0;
    const hit = usage.cache_read_input_tokens ?? 0;
    const created = usage.cache_creation_input_tokens ?? 0;
    const input = uncached + hit + created;
    const output = usage.output_tokens ?? 0;
    return {
        input_tokens: input,
        output_tokens: output,
        total_tokens: input + output,
        reasoning_tokens: 0,
        cache_hit_input_tokens: hit,
        cache_miss_input_tokens: uncached + created,
    };
}

function errorMessage(status: number, body: OpenAiResponse | AnthropicResponse, apiKey: string): string {
    const providerError = body.error;
    const detail = (providerError?.type ?? providerError?.message)?.replaceAll(apiKey, '[redacted]');
    return detail ? `LLM endpoint returned HTTP ${status}: ${detail}` : `LLM endpoint returned HTTP ${status}`;
}

/** Calls an OpenAI- or Anthropic-compatible endpoint and normalizes its result and usage. */
export class LlmClient {
    constructor(
        readonly config: LlmProviderConfig,
        private readonly fetchImplementation: typeof fetch = fetch,
    ) {}

    /** Executes one planner call. */
    async call(messages: readonly LlmMessage[]): Promise<LlmCallResult> {
        if (!messages.length) throw new Error('an LLM call requires at least one message');
        const started = performance.now();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
        try {
            const anthropic = this.config.protocol === 'anthropic-messages';
            const system = messages
                .filter((message) => message.role === 'system')
                .map((message) => message.content)
                .join('\n\n');
            const providerMessages = anthropic ? messages.filter((message) => message.role !== 'system') : messages;
            const body = anthropic
                ? {
                      ...this.config.requestOptions,
                      model: this.config.model,
                      max_tokens: this.config.maxOutputTokens ?? 4096,
                      ...(system ? {system} : {}),
                      messages: providerMessages,
                  }
                : {
                      ...this.config.requestOptions,
                      model: this.config.model,
                      ...(this.config.maxOutputTokens ? {max_tokens: this.config.maxOutputTokens} : {}),
                      messages: providerMessages,
                  };
            const headers: Record<string, string> = {
                'content-type': 'application/json',
                ...(anthropic ? {'x-api-key': this.config.apiKey, 'anthropic-version': '2023-06-01'} : {authorization: `Bearer ${this.config.apiKey}`}),
                ...this.config.additionalHeaders,
            };
            const response = await this.fetchImplementation(this.config.endpoint, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                signal: controller.signal,
            });
            const decoded = (await response.json()) as OpenAiResponse | AnthropicResponse;
            if (!response.ok) throw new Error(errorMessage(response.status, decoded, this.config.apiKey));
            const durationMs = Number((performance.now() - started).toFixed(3));
            if (anthropic) {
                const value = decoded as AnthropicResponse;
                return {
                    responseId: value.id ?? null,
                    responseModel: value.model ?? this.config.model,
                    content:
                        value.content
                            ?.filter((part) => part.type === 'text')
                            .map((part) => part.text ?? '')
                            .join('') ?? '',
                    finishReason: value.stop_reason ?? null,
                    durationMs,
                    usage: normalizeAnthropicUsage(value),
                };
            }
            const value = decoded as OpenAiResponse;
            return {
                responseId: value.id ?? null,
                responseModel: value.model ?? this.config.model,
                content: value.choices?.[0]?.message?.content ?? '',
                finishReason: value.choices?.[0]?.finish_reason ?? null,
                durationMs,
                usage: normalizeOpenAiUsage(value),
            };
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') throw new Error(`LLM endpoint timed out after ${this.config.timeoutMs} ms`);
            throw error;
        } finally {
            clearTimeout(timeout);
        }
    }
}
