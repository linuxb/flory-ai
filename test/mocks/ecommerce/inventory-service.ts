import type {ToolService} from '../../../sdk/typescript/index.js';
import type {MockCommerceWorld} from './services.js';
import {baseContract, type MockServiceOptions, type MockTool, startMockService} from './tool-service.js';

/**
 * The inventory tool service.
 *
 * It declares the tools it implements and nothing else. There is no shared catalog to keep in step, because the
 * catalog is the tool view the gateway publishes from what every service declares.
 */
export function startInventoryService(world: MockCommerceWorld, options: MockServiceOptions): Promise<ToolService> {
    const tools: MockTool[] = [
        {
            contract: baseContract('inventory.check', {
                description: 'Report stock available after open holds',
                inputSchema: '{"type":"object","properties":{"sku":{"type":"string"}},"required":["sku"],"additionalProperties":false}',
                footprint: ['inventory:{sku}'],
            }),
            run: (args) => ({available: world.inventory.check(String(args.sku))}),
        },
        {
            contract: baseContract('inventory.reserve', {
                description: 'Hold stock for an order until confirm or release',
                inputSchema:
                    '{"type":"object","properties":{"order_id":{"type":"string"},"sku":{"type":"string"},"quantity":{"type":"integer","minimum":1}},' +
                    '"required":["order_id","sku","quantity"],"additionalProperties":false}',
                effectClass: 'reversible',
                mode: 'tcc',
                idempotencyKeyPath: '$.order_id',
                tryTimeoutSeconds: 300,
                confirmTool: 'inventory.confirm',
                cancelTool: 'inventory.release',
                footprint: ['inventory:{sku}'],
                writes: ['inventory:{sku}'],
            }),
            run: (args) => {
                world.inventory.reserve(String(args.order_id), String(args.sku), Number(args.quantity));
            },
        },
        {
            contract: baseContract('inventory.confirm', {
                description: 'Commit exactly the delta its matching reserve held',
                inputSchema: '{"type":"object","properties":{"order_id":{"type":"string"}},"required":["order_id"],"additionalProperties":false}',
                effectClass: 'bufferable',
                idempotencyKeyPath: '$.order_id',
                footprint: ['inventory:{sku}'],
                writes: ['inventory:{sku}'],
            }),
            run: (args) => {
                world.inventory.confirm(String(args.order_id));
            },
        },
        {
            contract: baseContract('inventory.release', {
                description: 'Release exactly the delta its matching reserve held',
                inputSchema: '{"type":"object","properties":{"order_id":{"type":"string"}},"required":["order_id"],"additionalProperties":false}',
                effectClass: 'bufferable',
                idempotencyKeyPath: '$.order_id',
                // Declared compensating, which registers as delta-based. Releasing the hold this try added is the only
                // form that commutes with another branch's committed change (discipline 17).
                compensating: true,
                footprint: ['inventory:{sku}'],
                writes: ['inventory:{sku}'],
            }),
            run: (args) => {
                world.inventory.release(String(args.order_id));
            },
        },
        {
            contract: baseContract('inventory.commit', {
                description: 'Begin physical picking; no status query exists for it',
                inputSchema: '{"type":"object","properties":{"order_id":{"type":"string"}},"required":["order_id"],"additionalProperties":false}',
                // A designated pivot from doc 06 section 3.4, deliberately without a status_tool, so the harness
                // exercises what happens when a pivot's outcome is genuinely unknowable.
                effectClass: 'irreversible',
                idempotencyKeyPath: '$.order_id',
                footprint: ['inventory:{sku}'],
                writes: ['inventory:{sku}'],
            }),
            run: (args) => {
                world.inventory.confirm(String(args.order_id));
            },
        },
    ];
    return startMockService('inventory', tools, options);
}
