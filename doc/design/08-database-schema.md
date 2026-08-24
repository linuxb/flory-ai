# Database Schema and Storage Model (08)

> Status: Implemented storage and Coordinator projections v0.2 | Depends on: [01](./01-jit-dag-and-event-log.md), [02](./02-transaction-model.md), [05](./05-context-aggregation-and-offline-evaluation.md), [07](./07-distributed-transaction-coordinator.md)

## 1. Executable Boundary

The executable storage core lives in [`db/migrations/`](../../db/migrations/), with its canonical wire schema in [`idl/event-log.schema.json`](../../idl/event-log.schema.json). The schema is the only event contract. TypeScript and Go contract models are generated from it; neither language owns an independent event definition.

PostgreSQL has three development roles. `flory` owns migrations. `engine_role` creates runs and appends engine-owned events. `coordinator_role` appends coordinator-owned events. Both application roles can read projections, but neither can insert, update, or delete base tables directly. They call security-definer append functions, whose triggers inspect `session_user` so the original service identity remains enforceable through the controlled write path.

## 2. Ground-Truth Tables

`run(run_id, next_seq, seed_floor, created_at)` is the per-stream sequence allocator; `seed_floor` is non-null only for fork runs, where it equals `eval_up_to_seq` and pins own-event numbering above it. `event_log` is hash partitioned by `run_id`, with `(run_id, stream_seq)` as its primary key and a non-foldable generated `global_seq` for operations only. Each row contains the event type, causal and scope columns, `pin_version`, explicit `ignorable`, an `inherited` provenance marker (true only on read-only copies from a fork's source stream), JSON payload, and creation time.

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

An insert trigger locks the scope and rejects `txn/cancel` after pivot admission or pivot passage. It also rejects a `txn/confirm` or `txn/cancel` whenever the scope's `txn/try` carries the `inherited` provenance marker — the check keys on provenance, not position, so a bracket merged lazily after `run/end-seed` is protected identically to one copied in the seed. Reproducing inherited history through the copy function is exempt: an inherited copy of a historical cancel is not a fork-authored mutation. After-insert triggers update `txn_scope` and `txn_bracket` in the same transaction, so the database state used for transaction safety cannot lag the log.

`admit_pivot` locks an open scope, verifies that every required try is sealed, moves the scope to `pivot-inflight`, and appends `vertex/started` atomically. `resolve_pivot_absent` is the only transition back to `open`, and is called only after an adapter status query proves that the irreversible effect did not happen. Once `txn/pivot-passed` is appended, only forward confirmation and retry remain.

Scope cancellation uses two `txn/cancel` phases. `requested` fences the whole scope and materializes inverse work for all sealed members. Workers claim those members idempotently; `completed` is accepted only when none remain. No per-try cancel event exists.

## 4. Fork Storage Transaction

The TypeScript engine implements the lazy causal fork of [ADR-005](./adr/adr-005-lazy-causal-fork-semantics.md) and [01 §5.2](./01-jit-dag-and-event-log.md) — `fork(source_stream, at_vertex_id, substitutions[], eval_up_to_seq)` — in one database transaction:

1. Lock the source `run` row and validate that `eval_up_to_seq` names a recorded source position.
2. Resolve the divergence vertex `at_vertex_id` — **any** vertex, with no planner, bracket, or pivot-floor restriction — and validate that every substitution names one of its pinned events.
3. Compute the causal slice. With substitutions present, every causal descendant of the divergence vertex (derived via `parent_refs`) and the divergence vertex's own execution events are invalidated: their cause changed, so they are never copied and the fork regenerates that chain. With no substitutions nothing is invalidated and everything merges, which is what lets a no-substitution fork reproduce the source surface exactly.
4. Create the child run with its counter preset to `eval_up_to_seq + 1` and `seed_floor = eval_up_to_seq`, append source-side `fork/created` provenance, then copy the seed — the inherited events at or before the divergence vertex — **preserving each source `stream_seq`** and marking every row `inherited`. A substitution changes only the named copy's `pin_version`.
5. Append `run/end-seed` at `eval_up_to_seq + 1` as the child's first own event, carrying the fork provenance (`source_run_id`, `at_vertex_id`, `eval_up_to_seq`, substitutions) that later merges re-derive.

Causally independent events after the divergence vertex are not copied eagerly. `mergeIndependentEvents(child_run_id, through_seq)` merges them lazily — re-deriving the same causal slice from the `run/end-seed` provenance, skipping sequences already present, and never merging past `eval_up_to_seq`. Merged rows are inherited copies like the seed: they keep their source `stream_seq` (always at or below `seed_floor`, so an inherited and an own sequence can never collide) and carry the `inherited` marker the §3 guard keys on. Inherited copies also never materialize live state: the transaction projections and the work queue skip them, so a fork can neither operate an inherited bracket nor schedule inherited vertices as coordinator work.

The fork copies recorded semantics only. It does not call a tool or replay an external effect. The accepted modes are `recorded`, `model-live`, and `reads-live`; `writes-live` is not a fork API mode.

## 5. Verification Surface

[`engine/`](../../engine/) contains the only canonical TypeScript projection framework: active-DAG `surface`, ancestor `slice`, reducer registration and dispatch, lexicographic `linearize`, and deterministic assembly hashes. [`coordinator/`](../../coordinator/) contains the Go 1.25 Coordinator runtime and trace validator, while [`test/sandbox/`](../../test/sandbox/) exposes the deterministic commerce actors through the HTTP adapter contract. Integration tests verify runtime barrier admission, post-pivot confirm ordering, scope-level cancellation, fail-closed trace decoding, and duplicate-safe adapters against PostgreSQL 17.
