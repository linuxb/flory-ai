import {describe, expect, it, vi} from 'vitest';
import {estimateLlmCost, LlmClient, loadLlmConfig, type LlmProviderConfig} from '../../src/llm-client.js';

const baseConfig: LlmProviderConfig = {
    provider: 'compatible-provider',
    protocol: 'openai-chat-completions',
    endpoint: 'https://llm.example.test/v1/chat/completions?secret=hidden',
    apiKey: 'test-secret-key',
    model: 'best-model',
    timeoutMs: 1000,
    pricing: {
        currency: 'USD',
        cache_hit_input_per_million: 0.1,
        cache_miss_input_per_million: 1,
        output_per_million: 2,
        reference: 'price-snapshot-1',
    },
};

describe('LLM client', () => {
    it('normalizes OpenAI-compatible usage and sends the configured endpoint and key', async () => {
        const fetchMock = vi.fn(
            async () =>
                new Response(
                    JSON.stringify({
                        id: 'response-1',
                        model: 'best-model-20260901',
                        choices: [{message: {content: 'plan'}, finish_reason: 'stop'}],
                        usage: {
                            prompt_tokens: 100,
                            completion_tokens: 25,
                            total_tokens: 125,
                            prompt_tokens_details: {cached_tokens: 40},
                            completion_tokens_details: {reasoning_tokens: 10},
                        },
                    }),
                    {status: 200, headers: {'content-type': 'application/json'}},
                ),
        );
        const client = new LlmClient(baseConfig, fetchMock as typeof fetch);
        const result = await client.call([{role: 'user', content: 'plan this'}]);

        expect(result.content).toBe('plan');
        expect(result.usage).toEqual({
            input_tokens: 100,
            output_tokens: 25,
            total_tokens: 125,
            reasoning_tokens: 10,
            cache_hit_input_tokens: 40,
            cache_miss_input_tokens: 60,
        });
        expect(fetchMock).toHaveBeenCalledWith(baseConfig.endpoint, expect.objectContaining({headers: expect.objectContaining({authorization: 'Bearer test-secret-key'})}));
        expect(estimateLlmCost(result.usage, baseConfig.pricing!).amount).toBe(0.000114);
    });

    it('adapts system messages and cache usage to Anthropic Messages', async () => {
        const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
            expect(JSON.parse(String(init?.body))).toEqual({
                model: 'claude-compatible',
                max_tokens: 100,
                system: 'be precise',
                messages: [{role: 'user', content: 'plan this'}],
            });
            return new Response(
                JSON.stringify({
                    id: 'message-1',
                    model: 'claude-compatible',
                    content: [{type: 'text', text: 'plan'}],
                    stop_reason: 'end_turn',
                    usage: {input_tokens: 60, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 10},
                }),
                {status: 200},
            );
        });
        const client = new LlmClient({...baseConfig, protocol: 'anthropic-messages', model: 'claude-compatible', maxOutputTokens: 100}, fetchMock as typeof fetch);
        const result = await client.call([
            {role: 'system', content: 'be precise'},
            {role: 'user', content: 'plan this'},
        ]);

        expect(result.usage).toEqual({
            input_tokens: 100,
            output_tokens: 20,
            total_tokens: 120,
            reasoning_tokens: 0,
            cache_hit_input_tokens: 30,
            cache_miss_input_tokens: 70,
        });
    });

    it('loads provider-neutral settings without placing the API key in other fields', async () => {
        const config = await loadLlmConfig({
            FLORY_LLM_PROVIDER: 'deepseek',
            FLORY_LLM_PROTOCOL: 'openai-chat-completions',
            FLORY_LLM_ENDPOINT: 'https://api.deepseek.com/chat/completions',
            FLORY_LLM_MODEL: 'deepseek-v4-pro',
            FLORY_LLM_API_KEY: 'direct-test-key-which-is-not-real',
        });
        expect(config.apiKey.length).toBeGreaterThan(10);
        expect(JSON.stringify({...config, apiKey: undefined})).not.toContain(config.apiKey);
    });
});
