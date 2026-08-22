# Database Schema and Storage Model (08)

> Status: Implemented storage and Coordinator projections v0.2 | Depends on: [01](./01-jit-dag-and-event-log.md), [02](./02-transaction-model.md), [05](./05-context-aggregation-and-offline-evaluation.md), [07](./07-distributed-transaction-coordinator.md)

## 1. Executable Boundary

The executable storage core lives in [`db/migrations/`](../../db/migrations/), with its canonical wire schema in [`idl/event-log.schema.json`](../../idl/event-log.schema.json). The schema is the only event contract. TypeScript and Go contract models are generated from it; neither language owns an independent event definition.

PostgreSQL has three development roles. `flory` owns migrations. `engine_role` creates runs and appends engine-owned events. `coordinator_role` appends coordinator-owned events. Both application roles can read projections, but neither can insert, update, or delete base tables directly. They call security-definer append functions, whose triggers inspect `session_user` so the original service identity remains enforceable through the controlled write path.

## 2. Ground-Truth Tables

`run(run_id, next_seq, created_at)` is the per-stream sequence allocator. `event_log` is hash partitioned by `run_id`, with `(run_id, stream_seq)` as its primary key and a non-foldable generated `global_seq` for operations only. Each row contains the event type, causal and scope columns, `pin_version`, explicit `ignorable`, JSON payload, and creation time.

`append_events(run_id, events)` locks the run row, increments `next_seq`, and inserts every supplied event inside the caller's transaction. A failed batch rolls back the counter and every row, so `stream_seq` stays contiguous and commit ordered within one stream. `global_seq` remains intentionally gappy and must never drive a fold.

The migrations create synchronous safety projections and recoverable operational queues:

| Table | Enforced purpose |
| --- | --- |
| `txn_scope` | Required try members plus `open`, `cancelling`, `pivot-inflight`, `pivot-passed`, `committed`, `cancelled`, and `suspended` lifecycle states |
| `txn_bracket` | Globally unique idempotency key, sealed half-open state, deadline, inverse/confirm operations, frozen input, and retry policy |
| `work_queue` | Parent references, deterministic readiness time, attempt count, and recoverable Coordinator lease claimed with `FOR UPDATE SKIP LOCKED` |
| `scope_cancel_member` | Recoverable inverse-operation work materialized for one requested scope cancellation; dependency depth makes descendants reverse before ancestors without using sequence order |

No application role receives `UPDATE` or `DELETE` access to `event_log`. Shadowing is represented only by a new `subgraph/shadowed` event.

## 3. Write-Time Guards

Before an event is inserted, ownership validation rejects an engine attempt to append coordinator events, a coordinator attempt to append engine events, and an unknown event without `ignorable: true`. The inherited-copy function is engine-only and sets a transaction-local marker solely while reproducing a source stream into a fork; it is not a general ownership bypass.

An insert trigger locks the scope and rejects `txn/cancel` after pivot admission or pivot passage. It also rejects a child `txn/confirm` or `txn/cancel` when the scope's `txn/try` was inherited before `run/end-seed`. After-insert triggers update `txn_scope` and `txn_bracket` in the same transaction, so the database state used for transaction safety cannot lag the log.

`admit_pivot` locks an open scope, verifies that every required try is sealed, moves the scope to `pivot-inflight`, and appends `vertex/started` atomically. `resolve_pivot_absent` is the only transition back to `open`, and is called only after an adapter status query proves that the irreversible effect did not happen. Once `txn/pivot-passed` is appended, only forward confirmation and retry remain.

Scope cancellation uses two `txn/cancel` phases. `requested` fences the whole scope and materializes inverse work for all sealed members. Workers claim those members idempotently; `completed` is accepted only when none remain. No per-try cancel event exists.

## 4. Fork Storage Transaction

The TypeScript engine performs a fork in one database transaction:

1. Lock the source `run` row and record its terminal sequence as `source_tail_end_seq`.
2. Validate that the requested boundary is a succeeded planner, outside an open bracket, and not below a prior pivot.
3. Create the child, append source-side `fork/created` provenance, then copy source events through the frozen tail in source sequence order. A substitution changes only the named copied event's `pin_version`.
4. Append `run/end-seed` as the child's first own event. Everything preceding it is inherited and read-only.

The fork copies recorded semantics only. It does not call a tool or replay an external effect. The accepted modes are `recorded`, `model-live`, and `reads-live`; `writes-live` is not a fork API mode.

## 5. Verification Surface

[`engine/`](../../engine/) contains the only canonical TypeScript projection framework: active-DAG `surface`, ancestor `slice`, reducer registration and dispatch, lexicographic `linearize`, and deterministic assembly hashes. [`coordinator/`](../../coordinator/) contains the Go 1.25 Coordinator runtime and trace validator, while [`test/sandbox/`](../../test/sandbox/) exposes the deterministic commerce actors through the HTTP adapter contract. Integration tests verify runtime barrier admission, post-pivot confirm ordering, scope-level cancellation, fail-closed trace decoding, and duplicate-safe adapters against PostgreSQL 17.
