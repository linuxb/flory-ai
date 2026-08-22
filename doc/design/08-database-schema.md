# Database Schema and Storage Model (08)

> Status: Implemented storage-core v0.1 | Depends on: [01](./01-jit-dag-and-event-log.md), [02](./02-transaction-model.md), [05](./05-context-aggregation-and-offline-evaluation.md)

## 1. Executable Boundary

The executable storage core lives in [`db/migrations/`](../../db/migrations/), with its canonical wire schema in [`idl/event-log.schema.json`](../../idl/event-log.schema.json). The schema is the only event contract. TypeScript and Go contract models are generated from it; neither language owns an independent event definition.

PostgreSQL has three development roles. `flory` owns migrations. `engine_role` creates runs and appends engine-owned events. `coordinator_role` appends coordinator-owned events. Both application roles can read projections, but neither can insert, update, or delete base tables directly. They call security-definer append functions, whose triggers inspect `session_user` so the original service identity remains enforceable through the controlled write path.

## 2. Ground-Truth Tables

`run(run_id, next_seq, created_at)` is the per-stream sequence allocator. `event_log` is hash partitioned by `run_id`, with `(run_id, stream_seq)` as its primary key and a non-foldable generated `global_seq` for operations only. Each row contains the event type, causal and scope columns, `pin_version`, explicit `ignorable`, JSON payload, and creation time.

`append_events(run_id, events)` locks the run row, increments `next_seq`, and inserts every supplied event inside the caller's transaction. A failed batch rolls back the counter and every row, so `stream_seq` stays contiguous and commit ordered within one stream. `global_seq` remains intentionally gappy and must never drive a fold.

The same migration creates synchronous operational projections:

| Table | Enforced purpose |
| --- | --- |
| `txn_scope` | Scope lifecycle, savepoint, and one pivot state per scope |
| `txn_bracket` | Idempotency key, open/closed try state, deadline, and orphan-sweep index |
| `work_queue` | Coordinator work claiming with `FOR UPDATE SKIP LOCKED` |

No application role receives `UPDATE` or `DELETE` access to `event_log`. Shadowing is represented only by a new `subgraph/shadowed` event.

## 3. Write-Time Guards

Before an event is inserted, ownership validation rejects an engine attempt to append coordinator events, a coordinator attempt to append engine events, and an unknown event without `ignorable: true`. The inherited-copy function is engine-only and sets a transaction-local marker solely while reproducing a source stream into a fork; it is not a general ownership bypass.

An insert trigger rejects `txn/cancel` after the same scope has passed its pivot. It also rejects a child `txn/confirm` or `txn/cancel` when the scope's `txn/try` was inherited before `run/end-seed`. An after-insert trigger updates `txn_scope` and `txn_bracket` in the same transaction, so the database state used for transaction safety cannot lag the log.

## 4. Fork Storage Transaction

The TypeScript engine performs a fork in one database transaction:

1. Lock the source `run` row and record its terminal sequence as `source_tail_end_seq`.
2. Validate that the requested boundary is a succeeded planner, outside an open bracket, and not below a prior pivot.
3. Create the child, append source-side `fork/created` provenance, then copy source events through the frozen tail in source sequence order. A substitution changes only the named copied event's `pin_version`.
4. Append `run/end-seed` as the child's first own event. Everything preceding it is inherited and read-only.

The fork copies recorded semantics only. It does not call a tool or replay an external effect. The accepted modes are `recorded`, `model-live`, and `reads-live`; `writes-live` is not a fork API mode.

## 5. Verification Surface

[`engine/`](../../engine/) contains the only canonical TypeScript projection framework: active-DAG `surface`, ancestor `slice`, reducer registration and dispatch, lexicographic `linearize`, and deterministic assembly hashes. [`test/mocks/ecommerce/`](../../test/mocks/ecommerce/) contains the current delta-based `fold://inventory@v1` validation mock and inventory conservation oracle; it is not production domain behavior. The harness uses framework functions and explicitly registered test mocks to check fail-closed decoding, event ownership, atomic append behavior, replay identity, inherited-bracket protection, and commutative folds. Full Go execution, the business-world sandbox, and recovery scenarios are deliberately deferred.
