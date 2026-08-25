import {describe, expect, it} from 'vitest';
import {buildContract, type Contract, contractViolation, defaultRetry} from './contract.js';
import {CompensationStyle, EffectClass, ToolMode} from './gen/flory/gateway/v1/tool_contract_pb.js';

function readContract(): Contract {
    return {
        toolId: 'inventory.check',
        toolVersion: '1.0.0',
        description: 'Report available stock',
        inputSchema: '{"type":"object","properties":{"sku":{"type":"string"}},"required":["sku"],"additionalProperties":false}',
        outputSchema: '{"type":"object"}',
        effectClass: 'none',
        mode: 'plain',
        idempotentRetryable: true,
        footprint: ['inventory:{sku}'],
        timeoutMs: 5000,
        retry: defaultRetry(),
        owner: 'inventory-team',
    };
}

describe('contract projection', () => {
    it('declares the adapter and transaction spec the gateway admits against', () => {
        const built = buildContract(readContract(), 'inventory');
        expect(built.routeId).toBe('inventory');
        expect(built.adapter?.protocol).toBe('grpc');
        expect(built.txn?.effectClass).toBe(EffectClass.NONE);
        expect(built.txn?.mode).toBe(ToolMode.PLAIN);
        expect(built.txn?.idempotentRetryable).toBe(true);
    });

    it('sends idempotentRetryable explicitly, so a false is a statement rather than a default', () => {
        const built = buildContract({...readContract(), idempotentRetryable: false}, 'inventory');
        expect(built.txn?.idempotentRetryable).toBe(false);
    });

    // Only a delta-based release commutes with another branch's committed change, so there is no snapshot spelling to
    // choose: discipline 17 is discharged by the declaration surface rather than by a check a caller could route around.
    it('registers a compensating tool as delta-based, with no way to express a snapshot', () => {
        const built = buildContract({...readContract(), compensating: true}, 'inventory');
        expect(built.compensationStyle).toBe(CompensationStyle.DELTA);
        const plain = buildContract(readContract(), 'inventory');
        expect(plain.compensationStyle).toBe(CompensationStyle.NOT_COMPENSATING);
    });
});

describe('startup validation', () => {
    it('accepts a well-formed contract', () => {
        expect(contractViolation(readContract())).toBeNull();
    });

    // These mirror the gateway's own G4, G2, and G3. A service should fail while someone is watching it start, not on
    // a rejection they have to go read a log to find.
    it.each([
        ['a read with a transaction bracket', {effectClass: 'none', mode: 'tcc', confirmTool: 'a', cancelTool: 'b', tryTimeoutSeconds: 10}],
        ['an irreversible tool with a bracket', {effectClass: 'irreversible', mode: 'tcc', confirmTool: 'a', cancelTool: 'b', tryTimeoutSeconds: 10}],
        ['an irreversible tool with an undo path', {effectClass: 'irreversible', compensateTool: 'inventory.release'}],
        ['a reversible tool with no undo path', {effectClass: 'reversible'}],
        ['a tcc try with no cancel', {effectClass: 'reversible', mode: 'tcc', confirmTool: 'a', tryTimeoutSeconds: 10}],
        ['a tcc try with no timeout', {effectClass: 'reversible', mode: 'tcc', confirmTool: 'a', cancelTool: 'b'}],
        ['a saga with no compensator', {effectClass: 'reversible', mode: 'saga'}],
        ['a self-referential compensator', {effectClass: 'reversible', mode: 'saga', compensateTool: 'inventory.check'}],
        ['a shrinking backoff', {retry: {...defaultRetry(), multiplierMilli: 500}}],
        ['no timeout', {timeoutMs: 0}],
        ['a schema that is not an object', {inputSchema: '[1,2,3]'}],
        ['no owner', {owner: ''}],
    ])('refuses %s', (_name, overrides) => {
        expect(contractViolation({...readContract(), ...(overrides as Partial<Contract>)})).not.toBeNull();
    });
});
