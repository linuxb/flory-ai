// Generated from idl/event-log.schema.json. Do not edit.
export const EVENT_TYPES = [
    'run/start',
    'run/end',
    'run/end-seed',
    'subgraph/proposed',
    'subgraph/frozen',
    'subgraph/rejected',
    'subgraph/shadowed',
    'replan/boundary',
    'fork/created',
    'vertex/created',
    'vertex/started',
    'vertex/succeeded',
    'vertex/failed',
    'vertex/retried',
    'txn/scope',
    'txn/try',
    'txn/confirm',
    'txn/cancel',
    'txn/pivot-passed',
    'budget/charged',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];
export type FoldMode = 'recorded' | 'model-live' | 'reads-live';
export type EffectClass = 'none' | 'bufferable' | 'reversible' | 'irreversible';
export type TransactionMode = 'plain' | 'tcc' | 'saga';
export interface RetryPolicy {
    max_attempts: number;
    initial_backoff_ms: number;
    multiplier: number;
    max_backoff_ms: number;
}
export interface TransactionSpec {
    effect_class: EffectClass;
    mode: TransactionMode;
    idempotency_key?: string;
    try_timeout_s?: number;
    confirm_tool?: string;
    cancel_tool?: string;
    compensate_tool?: string;
    status_tool?: string;
}
export interface ToolVertexPayload {
    role: 'tool';
    tool: string;
    tool_version: string;
    tool_view_digest: string;
    input: Record<string, unknown>;
    retry_policy: RetryPolicy;
    txn: TransactionSpec;
}
export interface SubgraphProposedPayload {
    tool_view_ref: string;
    tool_view_digest: string;
}
export type LlmProtocol = 'openai-chat-completions' | 'anthropic-messages';
export interface LlmUsage {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    reasoning_tokens: number;
    cache_hit_input_tokens: number;
    cache_miss_input_tokens: number;
}
export interface LlmCostEstimate {
    currency: string;
    amount: number;
    pricing_ref: string;
    pricing_tier?: string;
    rates_per_million: {cache_hit_input: number; cache_miss_input: number; output: number};
}
export interface BudgetChargedPayload {
    category: 'llm';
    provider: string;
    protocol: LlmProtocol;
    endpoint: string;
    requested_model: string;
    response_model: string;
    duration_ms: number;
    usage: LlmUsage;
    estimated_cost?: LlmCostEstimate;
}
export interface ForkSubstitution {
    stream_seq: number;
    pin_version: string;
}
export interface ForkRequest {
    source_run_id: string;
    at_vertex_id: string;
    substitutions: ForkSubstitution[];
    eval_up_to_seq: number;
    fold_mode: FoldMode;
    evaluator_pin: string;
    projector_version: string;
    harness_state_version: string;
}
