import type {ConsoleDagModel, ConsoleSpend, ConsoleVertex} from '../engine.js';

/** A vertex with everything defaulted, so a test states only what it is about. */
export function vertex(id: string, options: Partial<ConsoleVertex> = {}): ConsoleVertex {
    return {
        vertex_id: id,
        parent_refs: [],
        label: id,
        role: 'tool',
        tool: 'record.read',
        tool_version: '1.0.0',
        status: 'created',
        is_shadowed: false,
        shadowed_at_seq: null,
        decided_by: 'planner',
        pin_version: null,
        input: null,
        log_fields: null,
        created_seq: 1,
        frozen_by_seq: null,
        depth: 0,
        txn: {scope_id: null, is_pivot: false, effect_class: 'none', pivot_passed: false},
        timing: {started_at: null, last_attempt_started_at: null, completed_at: null, duration_ms: null, attempts: 0},
        bracket: null,
        router_outcome: null,
        cost: null,
        stall: null,
        in_planner_prompt: true,
        ...options,
    };
}

export function model(vertices: ConsoleVertex[], options: Partial<ConsoleDagModel> = {}): ConsoleDagModel {
    return {
        run_id: 'run-1',
        kind: 'production',
        at_run_seq: Math.max(0, ...vertices.map((entry) => entry.created_seq)),
        started_at: null,
        vertices,
        scopes: [],
        replans: [],
        proposals: [],
        cancel_requests: [],
        counterfactuals: [],
        spend: {calls: 0, input_tokens: 0, output_tokens: 0, amount: null, currency: null},
        announced: {},
        console_projector_version: 'console-projector@v2',
        ...options,
    };
}

/** The rollup every delta envelope carries, so a test literal can stay about what it is testing. */
export const SPEND: ConsoleSpend = {calls: 0, input_tokens: 0, output_tokens: 0, amount: null, currency: null};
