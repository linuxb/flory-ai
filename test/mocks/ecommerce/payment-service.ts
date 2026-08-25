import type {ToolService} from '../../../sdk/typescript/index.js';
import type {MockCommerceWorld} from './services.js';
import {baseContract, type MockServiceOptions, type MockTool, startMockService} from './tool-service.js';

/** The payment tool service, including one of the designated pivots from doc 06 section 3.4. */
export function startPaymentService(world: MockCommerceWorld, options: MockServiceOptions): Promise<ToolService> {
    const orderSchema = '{"type":"object","properties":{"order_id":{"type":"string"}},"required":["order_id"],"additionalProperties":false}';
    const tools: MockTool[] = [
        {
            contract: baseContract('payment.authorize', {
                description: 'Hold funds for an order until capture or void',
                inputSchema: '{"type":"object","properties":{"order_id":{"type":"string"},"amount":{"type":"integer","minimum":1}},' + '"required":["order_id","amount"],"additionalProperties":false}',
                effectClass: 'reversible',
                mode: 'tcc',
                idempotencyKeyPath: '$.order_id',
                tryTimeoutSeconds: 300,
                confirmTool: 'payment.capture',
                cancelTool: 'payment.void',
                footprint: ['payment:{order_id}'],
                writes: ['payment:{order_id}'],
            }),
            run: (args) => {
                world.payment.authorize(String(args.order_id), Number(args.amount));
            },
        },
        {
            contract: baseContract('payment.capture', {
                description: 'Settle an authorization externally',
                inputSchema: orderSchema,
                // External settlement cannot be taken back, so it is irreversible and therefore a pivot. It supports a
                // status query, which is what lets an unknown outcome be reconciled rather than guessed.
                effectClass: 'irreversible',
                idempotencyKeyPath: '$.order_id',
                statusTool: 'payment.status',
                footprint: ['payment:{order_id}'],
                writes: ['payment:{order_id}'],
            }),
            run: (args) => {
                world.payment.capture(String(args.order_id));
            },
        },
        {
            contract: baseContract('payment.void', {
                description: 'Release exactly the authorization its matching authorize held',
                inputSchema: orderSchema,
                effectClass: 'bufferable',
                idempotencyKeyPath: '$.order_id',
                compensating: true,
                footprint: ['payment:{order_id}'],
                writes: ['payment:{order_id}'],
            }),
            run: (args) => {
                world.payment.void(String(args.order_id));
            },
        },
        {
            contract: baseContract('payment.status', {
                description: 'Report whether a capture actually settled',
                inputSchema: orderSchema,
                footprint: ['payment:{order_id}'],
            }),
            run: (args) => ({occurred: world.payment.charges.has(String(args.order_id))}),
        },
    ];
    return startMockService('payment', tools, options);
}
