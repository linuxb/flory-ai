import {describe, expect, it} from 'vitest';
import type {EventDraft} from '../../src/events.js';
import {LlmClient, type LlmProviderConfig} from '../../src/llm-client.js';
import {PlannerExecutor} from '../../src/planner-executor.js';

const plannerId = '00000000-0000-4000-8000-000000000501';

class MemorySink {
    readonly events: EventDraft[] = [];
    async appendEvents(_runId: string, events: EventDraft[]): Promise<number[]> {
        this.events.push(...events);
        return events.map((_event, index) => this.events.length - events.length + index + 1);
    }
}

function config(): LlmProviderConfig {
    return {
        provider: 'deepseek',
        protocol: 'openai-chat-completions',
        endpoint: 'https://api.example.test/chat/completions?private=one',
        apiKey: 'never-record-this-key',
        model: 'deepseek-v4-pro',
        timeoutMs: 1000,
        pricing: {
            currency: 'USD',
            cache_hit_input_per_million: 0.022,
            cache_miss_input_per_million: 0.66,
            output_per_million: 1.98,
            reference: 'provider-price-snapshot',
            tier: 'off-peak',
        },
    };
}

describe('planner executor', () => {
    it('records lifecycle, normalized usage, timing, and estimated cost without raw content or secrets', async () => {
        const sink = new MemorySink();
        const client = new LlmClient(
            config(),
            async () =>
                new Response(
                    JSON.stringify({
                        id: 'call-1',
                        model: 'deepseek-v4-pro-0813',
                        choices: [{message: {content: '{"vertices":[]}'}, finish_reason: 'stop'}],
                        usage: {
                            prompt_tokens: 88,
                            completion_tokens: 14,
                            total_tokens: 102,
                            prompt_cache_hit_tokens: 0,
                            prompt_cache_miss_tokens: 88,
                            completion_tokens_details: {reasoning_tokens: 12},
                        },
                    }),
                    {status: 200},
                ),
        );
        const result = await new PlannerExecutor(sink, client).execute({runId: 'run-1', plannerId, messages: [{role: 'user', content: 'make a plan'}]});

        expect(result.content).toBe('{"vertices":[]}');
        expect(sink.events.map((event) => event.event_type)).toEqual(['vertex/started', 'budget/charged', 'vertex/succeeded']);
        const charge = sink.events[1]!;
        expect(charge.payload).toMatchObject({
            endpoint: 'https://api.example.test/chat/completions',
            requested_model: 'deepseek-v4-pro',
            response_model: 'deepseek-v4-pro-0813',
            usage: {input_tokens: 88, output_tokens: 14, total_tokens: 102, reasoning_tokens: 12},
            estimated_cost: {amount: 0.0000858, currency: 'USD', pricing_tier: 'off-peak'},
        });
        const serialized = JSON.stringify(sink.events);
        expect(serialized).not.toContain('never-record-this-key');
        expect(serialized).not.toContain('make a plan');
        expect(serialized).not.toContain('{"vertices":[]}');
        expect(result.inputDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(result.outputDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    });

    it('records a sanitized failure event', async () => {
        const sink = new MemorySink();
        const client = new LlmClient(config(), async () => new Response(JSON.stringify({error: {message: 'rejected never-record-this-key'}}), {status: 401}));
        await expect(new PlannerExecutor(sink, client).execute({runId: 'run-1', plannerId, messages: [{role: 'user', content: 'plan'}]})).rejects.toThrow('HTTP 401');
        expect(sink.events.map((event) => event.event_type)).toEqual(['vertex/started', 'vertex/failed']);
        expect(JSON.stringify(sink.events)).not.toContain('never-record-this-key');
        expect(JSON.stringify(sink.events)).toContain('[redacted]');
    });
});
