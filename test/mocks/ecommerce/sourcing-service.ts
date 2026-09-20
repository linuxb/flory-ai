import type {ToolService} from '../../../sdk/typescript/index.js';
import type {MockCommerceWorld} from './services.js';
import {baseContract, type MockServiceOptions, type MockTool, startMockService} from './tool-service.js';

/**
 * The sourcing tool service: the wholesale catalogue and the demand signal a retailer reads before
 * it commits to anything.
 *
 * Every tool here is `effect_class: none`, which is what makes them the natural upstream of a
 * deterministic router: a rule may decide on their summary fields at a savepoint without any
 * transaction being open. Each declares its `log_fields`, and that declaration is the whole
 * contract a rule template is written against — a field not declared here cannot be referenced by
 * any rule, however plainly it appears in the result.
 */
export function startSourcingService(world: MockCommerceWorld, options: MockServiceOptions): Promise<ToolService> {
    const tools: MockTool[] = [
        {
            contract: baseContract('supplier.search', {
                description: 'List wholesale suppliers offering a category, cheapest unit cost first',
                inputSchema: '{"type":"object","properties":{"category":{"type":"string"}},"required":["category"],"additionalProperties":false}',
                footprint: ['supplier:{category}'],
                logFields: ['candidate_count', 'best_unit_cost'],
            }),
            run: (args) => {
                const candidates = world.supplier.search(String(args.category));
                return {
                    candidates,
                    candidate_count: candidates.length,
                    best_unit_cost: candidates[0]?.unit_cost ?? 0,
                };
            },
        },
        {
            contract: baseContract('supplier.quote', {
                description: 'Ask one supplier for terms at a quantity; answers quotable=false below their minimum order',
                inputSchema:
                    '{"type":"object","properties":{"supplier_id":{"type":"string"},"quantity":{"type":"integer","minimum":1}},' +
                    '"required":["supplier_id","quantity"],"additionalProperties":false}',
                footprint: ['supplier:{supplier_id}'],
                logFields: ['quotable', 'unit_cost', 'moq', 'lead_time_days', 'total_cost'],
            }),
            run: (args) => ({...world.supplier.quote(String(args.supplier_id), Number(args.quantity))}),
        },
        {
            contract: baseContract('market.demand', {
                description: 'Report the platform demand signal for a category: trend, achievable sell price, competition',
                inputSchema: '{"type":"object","properties":{"category":{"type":"string"}},"required":["category"],"additionalProperties":false}',
                footprint: ['market:{category}'],
                logFields: ['trend', 'sell_price', 'competitor_count', 'monthly_units'],
            }),
            run: (args) => ({...world.market.demand(String(args.category))}),
        },
        {
            contract: baseContract('supplier.order', {
                description: 'Place a wholesale purchase order; the goods land in our warehouse as sellable stock',
                inputSchema:
                    '{"type":"object","properties":{"purchase_order_id":{"type":"string"},"supplier_id":{"type":"string"},"sku":{"type":"string"},"quantity":{"type":"integer","minimum":1}},' +
                    '"required":["purchase_order_id","supplier_id","sku","quantity"],"additionalProperties":false}',
                // Buffered rather than irreversible: a purchase order is withdrawable until the
                // supplier dispatches, so it is undoable and must not be treated as a pivot.
                effectClass: 'bufferable',
                idempotencyKeyPath: '$.purchase_order_id',
                footprint: ['inventory:{sku}'],
                writes: ['inventory:{sku}'],
                logFields: ['on_hand'],
            }),
            run: (args) => ({on_hand: world.inventory.receive(String(args.purchase_order_id), String(args.sku), Number(args.quantity))}),
        },
    ];
    return startMockService('sourcing', tools, options);
}
