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
export interface ForkSubstitution {
    stream_seq: number;
    pin_version: string;
}
export interface ForkRequest {
    source_run_id: string;
    at_stream_seq: number;
    substitutions: ForkSubstitution[];
    fold_mode: FoldMode;
    evaluator_pin: string;
    projector_version: string;
    harness_state_version: string;
}
