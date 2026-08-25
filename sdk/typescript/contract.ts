import {create} from '@bufbuild/protobuf';
import {
    AdapterSpecSchema,
    CompensationStyle,
    EffectClass as WireEffectClass,
    RetryConstraintsSchema,
    type ToolContract,
    ToolContractSchema,
    ToolMode as WireToolMode,
    TransactionSpecSchema,
} from './gen/flory/gateway/v1/tool_contract_pb.js';

/** Side-effect classification from design document 02. */
export type EffectClass = 'none' | 'bufferable' | 'reversible' | 'irreversible';
/** Transaction integration supported by a registered tool. */
export type Mode = 'plain' | 'tcc' | 'saga';

/** The retry envelope an executor may not exceed for a tool. */
export interface Retry {
    maxAttempts: number;
    initialBackoffMs: number;
    /** Thousandths, so the whole contract stays integer-valued and the tool-view digest has a canonical text form. */
    multiplierMilli: number;
    maxBackoffMs: number;
}

/** A conservative envelope for a service that has no opinion. */
export function defaultRetry(): Retry {
    return {maxAttempts: 3, initialBackoffMs: 100, multiplierMilli: 2000, maxBackoffMs: 5000};
}

/**
 * One tool a service offers, in the terms a service author thinks in.
 *
 * There is deliberately no field for `isPivot` or `compensable`: both are derived from `effectClass` and the declared
 * undo path (02 section 2.1), so there is nothing here that could disagree with what they are derived from.
 */
export interface Contract {
    toolId: string;
    toolVersion: string;
    description?: string;
    /** JSON Schema text. Tool payloads stay JSON Schema because that is what MCP inputSchema and the planner consume. */
    inputSchema: string;
    outputSchema: string;
    effectClass: EffectClass;
    mode: Mode;
    idempotencyKeyPath?: string;
    idempotentRetryable: boolean;
    tryTimeoutSeconds?: number;
    confirmTool?: string;
    cancelTool?: string;
    compensateTool?: string;
    statusTool?: string;
    /**
     * Marks a tool that reverses another's effect. It always registers as delta-based: releasing exactly what the
     * matching try added is the only form that commutes with another branch's committed change, and the gateway
     * refuses snapshot restore outright.
     */
    compensating?: boolean;
    footprint?: readonly string[];
    writes?: readonly string[];
    timeoutMs: number;
    retry?: Retry;
    owner: string;
}

const EFFECT_CLASSES: Record<EffectClass, WireEffectClass> = {
    none: WireEffectClass.NONE,
    bufferable: WireEffectClass.BUFFERABLE,
    reversible: WireEffectClass.REVERSIBLE,
    irreversible: WireEffectClass.IRREVERSIBLE,
};

const MODES: Record<Mode, WireToolMode> = {
    plain: WireToolMode.PLAIN,
    tcc: WireToolMode.TCC,
    saga: WireToolMode.SAGA,
};

/**
 * Projects a declared contract onto the wire form for one route.
 *
 * The projection must match the Go SDK's byte for byte: a view containing tools from both languages has to have one
 * digest, so the language a service happens to be written in cannot be part of a contract's identity.
 */
export function buildContract(contract: Contract, routeId: string): ToolContract {
    const retry = contract.retry ?? defaultRetry();
    return create(ToolContractSchema, {
        toolId: contract.toolId,
        toolVersion: contract.toolVersion,
        description: contract.description ?? '',
        inputSchema: contract.inputSchema,
        outputSchema: contract.outputSchema,
        routeId,
        adapter: create(AdapterSpecSchema, {protocol: 'grpc', operation: 'flory.gateway.v1.ToolExecutionService/Execute'}),
        txn: create(TransactionSpecSchema, {
            effectClass: EFFECT_CLASSES[contract.effectClass],
            mode: MODES[contract.mode],
            idempotencyKeyPath: contract.idempotencyKeyPath ?? '',
            idempotentRetryable: contract.idempotentRetryable,
            tryTimeoutS: contract.tryTimeoutSeconds ?? 0,
            confirmTool: contract.confirmTool ?? '',
            cancelTool: contract.cancelTool ?? '',
            compensateTool: contract.compensateTool ?? '',
            statusTool: contract.statusTool ?? '',
        }),
        compensationStyle: contract.compensating ? CompensationStyle.DELTA : CompensationStyle.NOT_COMPENSATING,
        footprint: [...(contract.footprint ?? [])],
        writes: [...(contract.writes ?? [])],
        timeoutMs: contract.timeoutMs,
        retryConstraints: create(RetryConstraintsSchema, {
            maxAttempts: retry.maxAttempts,
            initialBackoffMs: retry.initialBackoffMs,
            multiplierMilli: retry.multiplierMilli,
            maxBackoffMs: retry.maxBackoffMs,
        }),
        owner: contract.owner,
    });
}

/**
 * Reports why a contract cannot be registered, or null if it can.
 *
 * This is a startup check against the rules the gateway will apply, so a service fails while someone is watching it
 * start rather than on a rejection they have to go read a log to find. The gateway remains the authority: this
 * mirrors only the rules decidable from one contract alone, and never reports a contract registrable that the gateway
 * would refuse.
 */
export function contractViolation(contract: Contract): string | null {
    for (const [field, value] of Object.entries({toolId: contract.toolId, toolVersion: contract.toolVersion, owner: contract.owner})) {
        if (!value.trim()) return `${field} is required`;
    }
    if (!schemaIsObject(contract.inputSchema)) return 'input_schema must be a JSON object';
    if (!schemaIsObject(contract.outputSchema)) return 'output_schema must be a JSON object';
    if (contract.timeoutMs <= 0) return 'timeout_ms is required';
    const retry = contract.retry ?? defaultRetry();
    if (retry.maxAttempts < 1) return 'retry.maxAttempts must be at least 1';
    if (retry.multiplierMilli < 1000) return 'retry.multiplierMilli must be at least 1000';
    if (contract.effectClass === 'none' && contract.mode !== 'plain') {
        return 'effect_class none has no side effect to bracket, so mode must be plain';
    }
    if (contract.effectClass === 'irreversible') {
        if (contract.mode !== 'plain') return 'effect_class irreversible has no undo path, so mode must be plain';
        if (contract.compensateTool || contract.confirmTool || contract.cancelTool) {
            return 'effect_class irreversible declares an undo path; a compensable effect is not irreversible';
        }
    }
    if (contract.effectClass === 'reversible' && contract.mode === 'plain' && !contract.compensateTool) {
        return 'effect_class reversible declares no undo path; a tool with no undo path must be registered irreversible';
    }
    if (contract.mode === 'tcc') {
        if (!contract.confirmTool || !contract.cancelTool) return 'mode tcc requires both confirmTool and cancelTool';
        if (!contract.tryTimeoutSeconds) return 'mode tcc requires a positive tryTimeoutSeconds';
    }
    if (contract.mode === 'saga' && !contract.compensateTool) return 'mode saga requires a compensateTool';
    for (const [field, companion] of Object.entries({
        confirmTool: contract.confirmTool,
        cancelTool: contract.cancelTool,
        compensateTool: contract.compensateTool,
        statusTool: contract.statusTool,
    })) {
        if (companion && companion === contract.toolId) return `${field} refers to the tool itself`;
    }
    return null;
}

function schemaIsObject(text: string): boolean {
    if (!text) return false;
    try {
        const parsed: unknown = JSON.parse(text);
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
    } catch {
        return false;
    }
}
