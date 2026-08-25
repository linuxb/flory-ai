import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {checkSubDag} from '../../engine/src/check-rules.js';
import {GatewayClient, GatewayRefusal} from '../../engine/src/gateway-client.js';
import {canonicalize, digestOf, loadToolRegistry, type ToolViewDocument} from '../../engine/src/tool-view.js';
import {createComplexCommerceDag} from '../mocks/ecommerce/services.js';

/**
 * Exercises a live topology: gatewayd in front of four SDK-registered tool services.
 *
 * Bring it up with `npm run e2e:up` and point GATEWAY_BASE_URL at it. Skipped otherwise, so a plain `npm test` needs
 * no external processes.
 */
const gatewayUrl = process.env.GATEWAY_BASE_URL;
const describeLive = gatewayUrl ? describe : describe.skip;

const recorded = JSON.parse(readFileSync(new URL('../fixtures/tool-view-ecommerce.json', import.meta.url), 'utf8')) as ToolViewDocument;

function client(): GatewayClient {
    return new GatewayClient({baseUrl: gatewayUrl ?? ''});
}

/** The read-only tool the Orchestrator is allowed to execute itself. */
const READ_TOOL = 'inventory.check';

describeLive('a live gateway in front of the mock tool services', () => {
    it('publishes exactly what the services declared, and nothing they did not', async () => {
        const resolved = await client().resolveToolView();
        const published = resolved.document.tools.map((tool) => tool.tool_id).sort();
        expect(published).toEqual(recorded.tools.map((tool) => tool.tool_id).sort());
        // Every tool traces back to a service that declared it; there is no catalog anywhere else to disagree with.
        expect(published.every((toolId) => toolId.includes('.'))).toBe(true);
    });

    // Doc 05 requires recorded evaluation to consume the recorded view. If the live view has moved, every check-rule
    // test in this repository is validating a contract that execution no longer uses.
    it('still publishes the digest the fixture recorded', async () => {
        const resolved = await client().resolveToolView();
        expect(resolved.identity.tool_view_digest).toBe(digestOf(canonicalize(recorded)));
    });

    it('carries transaction metadata a planner can derive structure from, without declaring what it must derive', async () => {
        const response = await fetch(`${gatewayUrl}/mcp`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/list', params: {}}),
        });
        const decoded = (await response.json()) as {result: {tools: Array<{name: string; metadata: {flory_transaction: Record<string, unknown>}}>}};
        const pivots = decoded.result.tools.filter((tool) => tool.metadata.flory_transaction.effect_class === 'irreversible').map((tool) => tool.name);
        // The three designated pivots from doc 06 section 3.4, one per realistic failure mode.
        expect(pivots.sort()).toEqual(['inventory.commit', 'logistics.book', 'payment.capture']);
        for (const tool of decoded.result.tools) {
            expect(tool.metadata.flory_transaction).not.toHaveProperty('is_pivot');
            expect(tool.metadata.flory_transaction).not.toHaveProperty('compensable');
        }
    });

    it('admits the complex commerce DAG from the view it actually publishes', async () => {
        const resolved = await client().resolveToolView();
        expect(checkSubDag(createComplexCommerceDag(), resolved.registry)).toEqual({accepted: true, violations: []});
        // And the same proposal admits identically from the recording, which is what makes replay honest.
        expect(checkSubDag(createComplexCommerceDag(), loadToolRegistry(recorded))).toEqual({accepted: true, violations: []});
    });

    it('routes one attempt to the tool service that declared it', async () => {
        const resolved = await client().resolveToolView();
        const result = await client().call(READ_TOOL, {sku: 'SKU-1'}, {runId: 'e2e-run', vertexId: 'e2e-vertex', toolVersion: '1.0.0', toolViewDigest: resolved.identity.tool_view_digest, attempt: 1});
        expect(result.outcome).toBe('succeeded');
        expect(result.result).toHaveProperty('available');
    });

    // Every one of these is decided before dispatch, so none of them reaches a tool service at all.
    it('refuses a stale digest rather than upgrading it to the current view', async () => {
        const stale = `sha256:${'b'.repeat(64)}`;
        await expect(client().call(READ_TOOL, {sku: 'SKU-1'}, {runId: 'r', vertexId: 'v', toolVersion: '1.0.0', toolViewDigest: stale, attempt: 1})).rejects.toMatchObject({
            reason: 'unknown-tool-view',
        });
    });

    it('refuses a version the pinned view does not contain', async () => {
        const resolved = await client().resolveToolView();
        await expect(client().call(READ_TOOL, {sku: 'SKU-1'}, {runId: 'r', vertexId: 'v', toolVersion: '9.9.9', toolViewDigest: resolved.identity.tool_view_digest, attempt: 1})).rejects.toMatchObject(
            {reason: 'version-absent-from-view'},
        );
    });

    it('validates arguments against the frozen schema at the gateway', async () => {
        const resolved = await client().resolveToolView();
        await expect(
            client().call(READ_TOOL, {skew: 'SKU-1'}, {runId: 'r', vertexId: 'v', toolVersion: '1.0.0', toolViewDigest: resolved.identity.tool_view_digest, attempt: 1}),
        ).rejects.toBeInstanceOf(GatewayRefusal);
    });

    it('resolves a superseded view from storage, which is what makes a frozen subgraph independent of current state', async () => {
        const resolved = await client().resolveToolView();
        const again = await client().resolveToolView(resolved.identity.tool_view_digest);
        expect(again.identity.tool_view_digest).toBe(resolved.identity.tool_view_digest);
        expect(again.document.tools.length).toBe(resolved.document.tools.length);
    });
});
