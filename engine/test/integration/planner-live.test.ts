import {randomUUID} from 'node:crypto';
import {afterAll, describe, expect, it} from 'vitest';
import {engineDatabaseUrl} from '../../../db/config.js';
import {LlmClient, loadLlmConfig} from '../../src/llm-client.js';
import {PlannerExecutor} from '../../src/planner-executor.js';
import {EventStore} from '../../src/store.js';

const live = process.env.FLORY_LLM_LIVE === '1';
const store = live ? new EventStore({connectionString: engineDatabaseUrl, actor: 'engine'}) : null;

afterAll(async () => store?.close());

describe.skipIf(!live)('live planner thought call', () => {
    it('calls the configured model and persists measured usage in the event log', async () => {
        const config = await loadLlmConfig();
        const runId = await store!.createRun();
        const plannerId = randomUUID();
        await store!.appendEvents(runId, [
            {event_type: 'run/start', payload: {schema_version: 'v1', test_tier: 'live-model'}},
            {event_type: 'vertex/created', vertex_id: plannerId, pin_version: `model://${config.provider}/${config.model}`, payload: {role: 'planner'}},
        ]);

        const result = await new PlannerExecutor(store!, new LlmClient(config)).execute({
            runId,
            plannerId,
            messages: [
                {role: 'system', content: 'Return only valid JSON.'},
                {role: 'user', content: 'Produce the minimal planner result: {"vertices":[]}.'},
            ],
        });
        const events = await store!.readStream(runId);
        const charge = events.find((event) => event.event_type === 'budget/charged');

        expect(result.content).toContain('vertices');
        expect(charge?.vertex_id).toBe(plannerId);
        expect(charge?.payload).toMatchObject({category: 'llm', provider: config.provider, requested_model: config.model});
        expect((charge?.payload.usage as {total_tokens: number}).total_tokens).toBeGreaterThan(0);
        expect(charge?.payload.duration_ms as number).toBeGreaterThan(0);
        if (config.pricing) expect((charge?.payload.estimated_cost as {amount: number}).amount).toBeGreaterThan(0);
    });
});
