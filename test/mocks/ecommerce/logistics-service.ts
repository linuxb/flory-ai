import type {ToolService} from '../../../sdk/typescript/index.js';
import type {MockCommerceWorld} from './services.js';
import {baseContract, type MockServiceOptions, type MockTool, startMockService} from './tool-service.js';

/** The logistics tool service, including the carrier-booking pivot from doc 06 section 3.4. */
export function startLogisticsService(world: MockCommerceWorld, options: MockServiceOptions): Promise<ToolService> {
    const tools: MockTool[] = [
        {
            contract: baseContract('logistics.quote', {
                description: 'Price a shipment without reserving anything',
                inputSchema: '{"type":"object","properties":{"carrier":{"type":"string"},"postcode":{"type":"string"}},' + '"required":["carrier","postcode"],"additionalProperties":false}',
                footprint: ['carrier:{carrier}'],
            }),
            run: (args) => ({price: world.logistics.quote(String(args.carrier), String(args.postcode))}),
        },
        {
            contract: baseContract('logistics.book', {
                description: 'Consume a carrier slot and hand over the goods',
                inputSchema:
                    '{"type":"object","properties":{"order_id":{"type":"string"},"carrier":{"type":"string"},"postcode":{"type":"string"}},' +
                    '"required":["order_id","carrier","postcode"],"additionalProperties":false}',
                // The slot is consumed and the goods are gone, so there is no undo path and the contract says so.
                effectClass: 'irreversible',
                idempotencyKeyPath: '$.order_id',
                statusTool: 'logistics.status',
                footprint: ['carrier:{carrier}'],
                writes: ['carrier:{carrier}'],
            }),
            run: (args) => {
                world.logistics.book(String(args.order_id), String(args.carrier), String(args.postcode));
            },
        },
        {
            contract: baseContract('logistics.status', {
                description: 'Report whether a booking exists, for reconciliation',
                inputSchema: '{"type":"object","properties":{"order_id":{"type":"string"}},"required":["order_id"],"additionalProperties":false}',
                footprint: ['carrier:{carrier}'],
            }),
            run: (args) => ({occurred: world.logistics.bookings.has(String(args.order_id))}),
        },
    ];
    return startMockService('logistics', tools, options);
}
