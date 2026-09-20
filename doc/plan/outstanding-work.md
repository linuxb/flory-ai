# Outstanding Implementation Work

> The single backlog for work that is specified but not delivered. Requirements live in the [design documents](../design/); this file records only what remains, why it is not done, and what "done" will look like.

Delivered work is not recorded here. When a work stream finishes, its section is deleted — the design documents keep the requirements and Git history keeps the delivery record.

| # | Work stream | Authoritative design | State |
|---|---|---|---|
| W1 | Formal verification stage S3 | [Doc 06 §12](../design/06-validation-harness.md#12-formal-verification-design) | Trigger-gated: waiting on first production traffic |
| W2 | Duplicate-delivery scenario S12 | [Doc 06 §6](../design/06-validation-harness.md#6-scenario-matrix), [Doc 07](../design/07-distributed-transaction-coordinator.md) | Runtime delivered; this scenario pending |
| W4 | Business-plane consumers: snapshots, fork quarantine, read models | [Doc 01 §3.1](../design/01-jit-dag-and-event-log.md#31-two-planes-and-three-sequences), [Doc 04 §2.1](../design/04-refine-and-harness-state.md#21-business-context-enters-through-task_input-not-harness-state), [Doc 08](../design/08-database-schema.md) | Storage delivered; consumers pending |
| W6 | Console: observability projection, stream, detail endpoints, UI | [Doc 11](../design/11-console-and-observability.md) | Not started; no projection, no transport, no client |

W4 stays in the Engine apart from one table, so it does not contend with the remaining streams. W6 reads what W4 writes, so its increment 4 lands after W4's increment 1.

---

## W1 — Formal verification stage S3

Stages S1 and S2 are complete: TLC checks I1, I3, R10 and R11 admission, and L2 over two- and three-branch models, and Apalache closes the inductive invariants for those explicit configurations with the Coordinator validating real logs. The executable specification is [`spec/`](../../spec/README.md).

**Trigger.** First production traffic with real logs. This is an objective event, not an availability window.

**Scope.**

- Alloy structural search for **admissible-but-dead DAG shapes**: plans that every check-rule admits and that can still reach a state with no legal continuation. This is the only remaining attack on the open question in [Doc 02 §6](../design/02-transaction-model.md#6-open-questions) — R1–R14 were derived by hand and have no completeness argument.
- Optionally TLAPS for I1. A half-finished proof adds no assurance over a model check, so this is taken only if a specialist is available to finish it.

**Standing constraints.** The planner stays modelled as demonic nondeterminism bounded only by check-rules; any assumption of reasonable planner behaviour invalidates the result and is rejected in review. A counterexample is read first as a **missing check-rule**, not an engine defect. Every counterexample becomes a numbered scenario in [Doc 06 §6](../design/06-validation-harness.md#6-scenario-matrix), which is what makes the work pay off even if the specification is later abandoned.

**Exit criteria.**

- Either Alloy finds no admissible-but-dead shape within its bound, or each shape found is repaired by a named new check-rule and a regression scenario.
- Doc 02 §6's completeness question records the bound actually searched, and does not claim more than was checked.
- Ownership of `spec/` remains assigned; an unowned specification is write-only documentation that manufactures false confidence.

## W2 — Duplicate-delivery scenario S12

The Coordinator runtime, its PostgreSQL projections, the orphan sweep, and the recovery loop are delivered. Scenario **S12** — `duplicate_delivery` on `payment.charge` — is specified in [Doc 06 §6](../design/06-validation-harness.md#6-scenario-matrix) and still marked pending there.

**Scope.** Drive a duplicated delivery of a pivot call through the sandbox and assert on the ledger, not on the call's return value: exactly one charge exists for the order. The assertion belongs to oracle O1, and the mechanism it protects is the frozen idempotency key plus `UNIQUE (idempotency_key)` on `txn_bracket` ([Doc 08 §2](../design/08-database-schema.md#2-ground-truth-tables)).

**Exit criteria.**

- S12 passes as a runtime integration scenario, and its row in Doc 06 §6 no longer says pending.
- TCC confirm after `txn/pivot-passed` stays safe under duplicate delivery.

**Also waiting on the recovery loop.** Scenario S16 asserts that a failure inside a router-emitted
branch never reaches a planner. Its oracle, `O2.no_deterministic_replan`, is delivered and has a
negative control, but no engine code appends `replan/boundary` yet, so the assertion currently
holds vacuously over a constructed failure rather than over a recovery loop exercising restraint.
It becomes a real scenario the day recovery is implemented, and the oracle is what will hold it.

## W4 — Business-plane consumers

The two planes, their sequences, and the dual-allocation append path are built. What remains is everything that *consumes* them: a fork choosing its own quarantined stream, business context pinned into `task_input`, the scenarios that hold those properties, and the read models.

**Contract baseline.** `run_seq` is the only legal input to a surface fold; `stream_seq` is the only legal input to a semantic fold; `global_seq` is never a fold input. A domain event writes both planes in one transaction; a pure orchestration event writes only the run plane. A fork writes domain events to `fork:<fork_run_id>:<source_stream_id>` with `is_counterfactual = true` and never to the source entity.

**Increments.**

1. Add `business_stream_snapshot`, fold-and-pin at run start, carry `{snapshot_id, pinned_stream_seq}` in `task_input`, and resolve business context from the snapshot during assembly and replay.
2. Complete fork quarantine in the Engine: a fork derives its own synthetic `stream_id` rather than a caller passing one, and every semantic fold and operational report applies the `is_counterfactual` filter. The database already refuses a fork run that writes a live entity.
3. Add scenarios S21–S23 and their oracle assertions to the validation harness.
4. Point the Console at `run_event_log` and domain read models at `business_event_stream`.

**Exit criteria.**

- One entity's multi-run lifecycle folds to the correct entity view in a single query.
- A run replayed after its entity has advanced produces an identical prompt hash.
- Every semantic fold and report filters `is_counterfactual`, so the flag protects a reader that forgets the namespace.
- No reader folds `global_seq`.

**Exclusions.** Stream-identity assignment policy — which domain concepts deserve an aggregate root, and how `stream_id` is derived from `task_input` — belongs with the domain teams that own the reducers. Snapshot retention and compaction, and CDC consumers of `global_seq`, are deferred.

## W6 — Console

[Doc 11](../design/11-console-and-observability.md) specifies an operator view of one run's graph. None of it exists: there is no observability projection, no stream, no detail endpoint, and no client. The design is settled, so what remains is delivery in an order that keeps each step verifiable on its own.

**Increments.**

1. `ConsoleDAGProjection` in the Engine, beside `surface`. Pure, versioned, and reproducible from the log, retaining shadowed vertices and enriching each with scope, pivot position, and timing. Testable with no transport and no browser, which is why it comes first.
2. The stream: `topology_snapshot`, `subgraph_appended`, `subgraph_shadowed`, `vertex_patched`, each carrying the `run_seq` it reflects, plus the resume-or-resnapshot protocol a reconnecting client drives.
3. The three detail endpoints, reading prompts, logs, and oversized payloads from blob storage.
4. The client: canvas, vertex cards, scope enclosures, and the inspector drawer, adapting to light and dark with an explicit override.

**Exit criteria.**

- The projection is a pure function of the log: the same prefix produces the same model, and a shadowed subtree survives a replan rather than disappearing.
- A client killed mid-run and reconnected reaches a state identical to one that never disconnected, whether the server resumed or re-snapshotted.
- A router that fell through is visible on the canvas and absent from the downstream planner's prompt in the same run — the two projections disagreeing here is the point, and a scenario should assert it.
- Nothing in the client folds an event or derives a scope.

**Exclusions.** The open questions in [Doc 11 §7](../design/11-console-and-observability.md#7-open-questions) are out of scope: multi-run fleet views, snapshot retention for completed runs, and which roles may read prompts and tool payloads through the detail endpoints. The last one gates any deployment beyond a trusted network, and should be answered before increment 3 ships rather than after.
