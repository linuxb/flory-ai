import type {ToolService} from '../../../sdk/typescript/index.js';
import type {MockCommerceWorld} from './services.js';
import {baseContract, type MockServiceOptions, type MockTool, startMockService} from './tool-service.js';

/** The sales-channel tool service. */
export function startChannelService(world: MockCommerceWorld, options: MockServiceOptions): Promise<ToolService> {
    const tools: MockTool[] = [
        {
            contract: baseContract('channel.draft', {
                description: 'Buffer a listing without publishing it',
                inputSchema:
                    '{"type":"object","properties":{"listing_id":{"type":"string"},"sku":{"type":"string"},"price":{"type":"integer","minimum":0}},' +
                    '"required":["listing_id","sku","price"],"additionalProperties":false}',
                effectClass: 'bufferable',
                idempotencyKeyPath: '$.listing_id',
                footprint: ['channel:{listing_id}'],
                writes: ['channel:{listing_id}'],
            }),
            run: (args) => {
                world.channel.draft(String(args.listing_id), String(args.sku), Number(args.price));
            },
        },
        {
            contract: baseContract('channel.publish', {
                description: 'Publish a previously buffered listing',
                inputSchema: '{"type":"object","properties":{"listing_id":{"type":"string"}},"required":["listing_id"],"additionalProperties":false}',
                effectClass: 'bufferable',
                idempotencyKeyPath: '$.listing_id',
                footprint: ['channel:{listing_id}'],
                writes: ['channel:{listing_id}'],
            }),
            run: (args) => {
                world.channel.publish(String(args.listing_id));
            },
        },
    ];
    return startMockService('channel', tools, options);
}
