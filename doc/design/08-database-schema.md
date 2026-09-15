# Database Schema and Storage Model (08)

> Status: Two-plane schema specified (v0.3); the single-table storage of v0.2 is implemented and its migration is tracked as [outstanding work W4](../plan/outstanding-work.md#w4--two-plane-storage-and-the-three-tier-sequence-model) | Depends on: [01](./01-jit-dag-and-event-log.md), [02](./02-transaction-model.md), [05](./05-context-aggregation-and-offline-evaluation.md), [07](./07-distributed-transaction-coordinator.md)

## 1. Executable Boundary

The executable storage core lives in [`db/migrations/`](../../db/migrations/), with its canonical wire schema in [`idl/event-log.schema.json`](../../idl/event-log.schema.json). The schema is the only event contract. TypeScript and Go contract models are generated from it; neither language owns an independent event definition.

PostgreSQL has four development roles. `flory` owns migrations. `engine_role` creates runs and streams, appends engine-owned events in both planes, and writes snapshot rows. `coordinator_role` appends coordinator-owned events. `gateway_role` reads and mutates only the Gateway-owned RBAC schema through security-definer functions and has no event-log write privilege. The Engine and Coordinator can read the run authorization projection but cannot mutate RBAC data. Application roles cannot insert, update, or delete event-log base tables directly; controlled append functions and their triggers inspect `session_user` so the original service identity remains enforceable through the write path.

## 2. Ground-Truth Tables

Storage has two planes, because a run and a business entity are different lifetimes ([01 §3.1](./01-jit-dag-and-event-log.md#31-two-planes-and-three-sequences)).

`run(run_id, next_seq, seed_floor, created_at)` allocates `run_seq`; `seed_floor` is non-null only for fork runs, where it equals `eval_up_to_seq` and pins own-event numbering above it. `stream(stream_id, next_seq, created_at)` allocates `stream_seq` for one aggregate root.

`run_event_log` is the orchestration plane: hash partitioned by `run_id`, primary key `(run_id, run_seq)`, with a non-foldable generated `global_seq` for operations only. Each row contains the event type, causal and scope columns, `pin_version`, explicit `ignorable`, an `inherited` provenance marker (true only on read-only copies from a fork's source run), JSON payload, and creation time.

`business_event_stream` is the data plane: hash partitioned by `stream_id`, primary key `(stream_id, stream_seq)`. Partitioning on `stream_id` is what makes that key enforceable — PostgreSQL requires every partition-key column to appear in a unique constraint, so the same key on a `run_id`-partitioned table would have to include `run_id` and would stop being unique per entity, which is the whole point. Each row carries `(run_id, run_seq)` provenance and `is_counterfactual`, and the reserved configuration `stream_id` lives here too ([10 §3.3](./10-deterministic-routers.md#33-templates-are-pins-and-pin-changes-are-events)).

`append_events(run_id, events)` locks the run row, increments `next_seq`, and inserts every supplied event inside the caller's transaction. A domain event additionally locks its `stream` row and writes both planes in the same transaction; a pure orchestration event never takes the stream lock. A failed batch rolls back both counters and every row, so each sequence stays contiguous and commit ordered within its own ordering. `global_seq` remains intentionally gappy and must never drive a fold.

`business_stream_snapshot(snapshot_id, stream_id, pinned_stream_seq, reducer_version, state_payload, created_at)` stores one folded entity state, unique on `(stream_id, pinned_stream_seq, reducer_version)`. It is the anchor that lets a later run consume business context without the context drifting under replay ([04 §2.1](./04-refine-and-harness-state.md#21-business-context-enters-through-task_input-not-harness-state)).

The migrations create synchronous safety projections and recoverable operational queues:

| Table | Enforced purpose |
| --- | --- |
| `txn_scope` | Required try members plus `open`, `cancelling`, `pivot-inflight`, `pivot-passed`, `committed`, `cancelled`, and `suspended` lifecycle states |
| `txn_bracket` | Globally unique idempotency key, sealed half-open state, deadline, inverse/confirm operations, frozen input, and retry policy |
| `work_queue` | Parent references, deterministic readiness time, attempt count, and recoverable Coordinator lease claimed with `FOR UPDATE SKIP LOCKED`. `enqueue_vertex_work` skips router vertices: they perform no call, so they are evaluated synchronously by the Engine and never materialize claimable work |
| `txn_attempt` | Durable evidence for one side-effecting request: attempt identity, idempotency key, recorded start, and the definitive outcome when one exists. A row with a start and no outcome is **unresolved**, and only a recorded outcome resolves it — never queue deletion, lease expiry, or a transport timeout ([02 §4.4](./02-transaction-model.md#44-orphan-try-detection)) |
| `scope_cancel_member` | Recoverable inverse-operation work materialized for one requested scope cancellation; dependency depth makes descendants reverse before ancestors without using sequence order |
| `gateway_rbac_role` | Gateway-owned, revisioned role catalogue and enabled state; `*` is reserved and never stored |
| `gateway_rbac_subject` | Enabled state and CAS revision for an OIDC `(issuer, subject)` identity |
| `gateway_rbac_subject_role` | Append-preserved binding history with explicit grant and revoke times; only non-revoked bindings authorize new work |
| `gateway_rbac_audit` | Append-only, idempotency-keyed administrative audit committed in the same transaction as each role mutation |
| `run_authorization` | Synchronous projection of the signed authorization identity in `run/start`, readable by executors for later Gateway calls |

No application role receives `UPDATE` or `DELETE` access to either event plane. Shadowing is represented only by a new `subgraph/shadowed` event. A snapshot row is immutable once written: a changed reducer produces a new `reducer_version`, never an update in place.

## 3. Write-Time Guards

Before an event is inserted, ownership validation rejects an engine attempt to append coordinator events, a coordinator attempt to append engine events, and an unknown event without `ignorable: true`. The inherited-copy function is engine-only and sets a transaction-local marker solely while reproducing a source stream into a fork; it is not a general ownership bypass.

An insert trigger locks the scope and rejects `txn/cancel` after pivot admission or pivot passage. It also rejects a `txn/confirm` or `txn/cancel` whenever the scope's `txn/try` carries the `inherited` provenance marker — the check keys on provenance, not position, so a bracket merged lazily after `run/end-seed` is protected identically to one copied in the seed. Reproducing inherited history through the copy function is exempt: an inherited copy of a historical cancel is not a fork-authored mutation. After-insert triggers update `txn_scope` and `txn_bracket` in the same transaction, so the database state used for transaction safety cannot lag the log.

`admit_pivot` locks an open scope, verifies that every required try is sealed, moves the scope to `pivot-inflight`, and appends `vertex/started` atomically. `resolve_pivot_absent` is the only transition back to `open`, and is called only after an adapter status query proves that the irreversible effect did not happen. Once `txn/pivot-passed` is appended, only forward confirmation and retry remain.

Scope cancellation uses two `txn/cancel` phases. `requested` fences the whole scope and materializes inverse work for all sealed members. Workers claim those members idempotently; `completed` is accepted only when none remain. No per-try cancel event exists. `request_scope_cancel` re-validates under `txn_scope FOR UPDATE` rather than trusting the sweeper's earlier query, and refuses the transition while any member holds a live lease or any `txn_attempt` row is unresolved; that scope is suspended instead ([07 §3.4](./07-distributed-transaction-coordinator.md#34-orphan-sweeper)).

Every state-altering path — router branch admission, `claim_ready_work`, and `request_scope_cancel` — locks in the order `txn_scope FOR UPDATE`, then `work_queue FOR UPDATE SKIP LOCKED`. A single lock order is what makes the claim-versus-cancel race decisive instead of deadlock-prone, and candidate discovery therefore must not lock the queue first.

`flory_executor_class` has three values: `router`, `orchestrator`, and `coordinator`. The class is derived from the vertex payload, and both the queue and the ownership trigger derive it identically ([01 §3.2.1](./01-jit-dag-and-event-log.md#321-which-executor-owns-a-vertex)).

The configuration stream is a reserved, Engine-owned `stream_id` in `business_event_stream`, carrying only `rule_template/published` events. It has a `stream` counter row like any entity, so `stream_seq` is allocated and ordered there under the ordinary rules, and the ownership trigger admits that event type from `engine_role` alone. Recording each publication, update, and slot binding as a diff event is what lets replay and counterfactual evaluation resolve the exact template bound to a router at a historical position without consulting a live registry ([10 §3.3](./10-deterministic-routers.md#33-templates-are-pins-and-pin-changes-are-events)).

Gateway RBAC mutations use security-definer functions with advisory transaction locks and `expected_revision` compare-and-swap. The same transaction appends the actor SPIFFE ID, request ID, idempotency key, target, and before/after revisions to `gateway_rbac_audit`; repeating an idempotency key returns the recorded result. Live subject lookup joins only enabled roles and active bindings. `run/start` synchronously projects its Gateway-signed `authorization_identity` into `run_authorization`, so a Coordinator restart can resume using the frozen role set without receiving the original JWT and without consulting current bindings.

## 4. Fork Storage Transaction

The TypeScript engine implements the lazy causal fork of [01 §5.2](./01-jit-dag-and-event-log.md) — `fork(source_run, at_vertex_id, substitutions[], eval_up_to_seq)` — in one database transaction. A fork lives entirely in the orchestration plane except for the quarantined stream described at the end of this section:

1. Lock the source `run` row and validate that `eval_up_to_seq` names a recorded source position.
2. Resolve the divergence vertex `at_vertex_id` — **any** vertex, with no planner, bracket, or pivot-floor restriction — and validate that every substitution names one of its pinned events.
3. Compute the causal slice. With substitutions present, every causal descendant of the divergence vertex (derived via `parent_refs`) and the divergence vertex's own execution events are invalidated: their cause changed, so they are never copied and the fork regenerates that chain. With no substitutions nothing is invalidated and everything merges, which is what lets a no-substitution fork reproduce the source surface exactly.
4. Create the child run with its counter preset to `eval_up_to_seq + 1` and `seed_floor = eval_up_to_seq`, append source-side `fork/created` provenance, then copy the seed — the inherited events at or before the divergence vertex — **preserving each source `run_seq`** and marking every row `inherited`. A substitution changes only the named copy's `pin_version`.
5. Append `run/end-seed` at `eval_up_to_seq + 1` as the child's first own event, carrying the fork provenance (`source_run_id`, `at_vertex_id`, `eval_up_to_seq`, substitutions) that later merges re-derive.

Causally independent events after the divergence vertex are not copied eagerly. `mergeIndependentEvents(child_run_id, through_seq)` merges them lazily — re-deriving the same causal slice from the `run/end-seed` provenance, skipping sequences already present, and never merging past `eval_up_to_seq`. Merged rows are inherited copies like the seed: they keep their source `run_seq` (always at or below `seed_floor`, so an inherited and an own sequence can never collide) and carry the `inherited` marker the §3 guard keys on. Inherited copies also never materialize live state: the transaction projections and the work queue skip them, so a fork can neither operate an inherited bracket nor schedule inherited vertices as coordinator work.

A fork that produces domain events writes them to a synthetic stream, `fork:<fork_run_id>:<source_stream_id>`, with `is_counterfactual = true` and its own `stream` counter row. It never appends to the source entity's stream: that would collide with the entity's sequence during inherited copying and would leave simulated facts inside the view production reducers fold. Production folds and reports filter `is_counterfactual = false`, so a query that forgets the namespace still cannot read a counterfactual as fact.

The fork copies recorded semantics only. It does not call a tool or replay an external effect. The accepted modes are `recorded`, `model-live`, and `reads-live`; `writes-live` is not a fork API mode.

## 5. Verification Surface

[`engine/`](../../engine/) contains the only canonical TypeScript projection framework: active-DAG `surface`, ancestor `slice`, reducer registration and dispatch, lexicographic `linearize`, and deterministic assembly hashes. [`coordinator/`](../../coordinator/) contains the Go 1.25 Coordinator runtime and trace validator, while [`test/sandbox/`](../../test/sandbox/) exposes the deterministic commerce actors through the HTTP adapter contract. Integration tests verify runtime barrier admission, post-pivot confirm ordering, scope-level cancellation, fail-closed trace decoding, and duplicate-safe adapters against PostgreSQL 17.
