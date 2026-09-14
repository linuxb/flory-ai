# Plan 007: Two-Plane Storage and the Three-Tier Sequence Model

- **Status:** Proposed
- **Date:** 2026-09-15
- **Implements:** [01 §3.1](../design/01-jit-dag-and-event-log.md#31-two-planes-and-three-sequences), [08](../design/08-database-schema.md)
- **Specifies:** [01](../design/01-jit-dag-and-event-log.md), [04 §2.1](../design/04-refine-and-harness-state.md#21-business-context-enters-through-task_input-not-harness-state), [05](../design/05-context-aggregation-and-offline-evaluation.md), [08](../design/08-database-schema.md)
- **Supersedes:** the single-table storage model delivered by [Plan 002](./plan-002-event-log-storage-and-fork.md); its fork semantics survive unchanged.

## 1. Objective

Split storage into an orchestration plane keyed by `(run_id, run_seq)` and a business plane keyed by `(stream_id, stream_seq)`, so that one entity's history folds across all of its runs, counterfactual writes cannot reach production views, and a run's business context stays byte-identical under replay.

## 2. Contract Baseline

`run_seq` is the only legal input to a surface fold; `stream_seq` is the only legal input to a semantic fold; `global_seq` is never a fold input. A domain event writes both planes in one transaction; a pure orchestration event writes only the run plane. A fork writes domain events to `fork:<fork_run_id>:<source_stream_id>` with `is_counterfactual = true` and never to the source entity.

## 3. Delivery Increments

1. Rename the run-scoped sequence to `run_seq` across [`idl/event-log.schema.json`](../../idl/event-log.schema.json) and both generated contract models, then update every consumer: `engine/src/{store,projection,events}.ts`, the harness oracles, `coordinator/internal/{store,trace,eventlog}`, and the conformance fixtures.
2. Migrate `event_log` to `run_event_log`, preserving hash partitioning by `run_id` and the primary key under its new column name, with the existing ownership and transaction triggers carried over.
3. Add `stream`, `business_event_stream` hash partitioned by `stream_id`, and `business_stream_snapshot`, with the append function that allocates both sequences in one transaction.
4. Route domain events through the dual-allocation path and leave pure orchestration events on the single-lock path; assert in tests that an orchestration-only append never touches a `stream` row.
5. Implement fork quarantine: synthetic `stream_id`, `is_counterfactual = true`, and the production read filter in every semantic fold and report.
6. Implement snapshot fold-and-pin at run start, carry `{snapshot_id, pinned_stream_seq}` in `task_input`, and resolve business context from the snapshot during assembly and replay.
7. Add scenarios S21–S23 and their oracle assertions to the validation harness.
8. Point the Console at `run_event_log` and domain read models at `business_event_stream`.

## 4. Exit Criteria

- A surface fold reads one partition of the run plane; no query in the projection pipeline scans the business plane.
- `(stream_id, stream_seq)` is enforced by a native unique constraint, with no partition-key workaround.
- One entity's four-run lifecycle folds to the correct entity view in a single query, and every business row names the `(run_id, run_seq)` that produced it.
- Forking a run leaves the source entity's head and folded view unchanged.
- A run replayed after its entity has advanced produces an identical prompt hash.
- An orchestration-only append acquires no `stream` row lock.
- No reader folds `global_seq`.

## 5. Exclusions

Stream-identity assignment policy — which domain concepts deserve an aggregate root, and how `stream_id` is derived from `task_input` — is out of scope and belongs with the domain teams that own the reducers. Snapshot retention and compaction, and CDC consumers of `global_seq`, are likewise deferred.
