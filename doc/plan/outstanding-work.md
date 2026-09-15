# Outstanding Implementation Work

> The single backlog for work that is specified but not delivered. Requirements live in the [design documents](../design/); this file records only what remains, why it is not done, and what "done" will look like.

Delivered work is not recorded here. When a work stream finishes, its section is deleted — the design documents keep the requirements and Git history keeps the delivery record.

| # | Work stream | Authoritative design | State |
|---|---|---|---|
| W1 | Formal verification stage S3 | [Doc 06 §12](../design/06-validation-harness.md#12-formal-verification-design) | Trigger-gated: waiting on first production traffic |
| W2 | Duplicate-delivery scenario S12 | [Doc 06 §6](../design/06-validation-harness.md#6-scenario-matrix), [Doc 07](../design/07-distributed-transaction-coordinator.md) | Runtime delivered; this scenario pending |
| W3 | Deterministic routers and rule templates | [Doc 10](../design/10-deterministic-routers.md) | Not started |
| W4 | Two-plane storage and the three-tier sequence model | [Doc 01 §3.1](../design/01-jit-dag-and-event-log.md#31-two-planes-and-three-sequences), [Doc 08](../design/08-database-schema.md) | Not started |

W3 and W4 both change `idl/` and `db/migrations/`. Sequencing them so that one lands before the other avoids two simultaneous migrations of the same tables; the order is otherwise unconstrained.

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

## W3 — Deterministic routers and rule templates

Make a rule-governed transition executable without a model call: a first-class `router` vertex, published rule templates, freeze-time exhaustive admission, and the runtime fencing that keeps a deterministic branch inside the transaction protocol.

**Contract baseline.** Interposition is mandatory, so a run with no template bound has the same topology as one with a template bound. A router is Engine-executed, never queued, and never a scope member. Its placement is derived; its branches are admitted at freeze against the run's role-scoped tool view and an existing-scope snapshot; its failures never reach an LLM replan.

**Increments.**

1. Extend the shared contracts: `router` in the `vertex/created` role union, the `rule_template/published` diff event, and the tool contract's log-fields schema in [`idl/`](../../idl/), regenerating both language consumers.
2. Extend `flory_executor_class` with `router`, exclude routers from `enqueue_vertex_work`, and add the `txn_attempt` evidence table with its migration.
3. Add the Engine-owned configuration stream with its own counter row, and the ownership-trigger case admitting `rule_template/published` from `engine_role` alone.
4. Implement R12, R13, and R14 in `engine/src/check-rules.ts`, including the third `existing_scope_snapshot` argument and exhaustive per-branch, per-placement admission.
5. Implement Engine-side rule-template publication: the management API, Q1–Q6 admission over a role-scoped tool view, derived capability envelope and branch traits, content addressing, and diff events.
6. Implement router evaluation in the Engine: binding resolution by `template_ref` and by `SlotId`, the closed outcome vocabulary, the strict event trajectory, and fall-through invisibility in `linearize`.
7. Enforce the single lock order and claim-eligibility table in the Coordinator, and rewrite the sweeper around durable attempt evidence: defer on a live lease, suspend on an unresolved attempt, cancel only a clean scope.
8. Add scenarios S15–S20 and the router assertions in oracles O2 and O4 to the validation harness.

**Exit criteria.**

- A tool-caller-to-planner edge cannot survive a freeze without a router, whether or not the proposal supplied one.
- A template whose *non-matching* branch is illegal at the bound placement is rejected at freeze, before any tool runs.
- A bound non-matching template produces a byte-identical planner prompt hash to an unbound slot.
- A failed router-emitted branch produces no `replan/boundary` and starts no planner vertex.
- A scope holding an unresolved attempt suspends; no `txn/cancel {phase: requested}` is appended for it.
- A fork substituting only a rule-template pin differs from its source in no structural way.
- `rule_template/published` is appended only by the Engine, only to the configuration stream; `gateway_role` still cannot write the event log at all.

**Exclusions.** Slot-collision rebinding and template migration, a nested-router depth bound, and automatic governance actions on match-rate thresholds are the open questions in [Doc 10 §13](../design/10-deterministic-routers.md#13-open-questions). Automatic reconciliation of an unresolved non-pivot attempt stays out of scope by design: recovery is operator-authorized ([Doc 02 §4.4](../design/02-transaction-model.md#44-orphan-try-detection)).

## W4 — Two-plane storage and the three-tier sequence model

Split storage into an orchestration plane keyed by `(run_id, run_seq)` and a business plane keyed by `(stream_id, stream_seq)`, so that one entity's history folds across all of its runs, counterfactual writes cannot reach production views, and a run's business context stays byte-identical under replay. This supersedes the single-table storage model recorded as v0.2 of [Doc 08](../design/08-database-schema.md); the lazy causal fork semantics built on it survive unchanged.

**Contract baseline.** `run_seq` is the only legal input to a surface fold; `stream_seq` is the only legal input to a semantic fold; `global_seq` is never a fold input. A domain event writes both planes in one transaction; a pure orchestration event writes only the run plane. A fork writes domain events to `fork:<fork_run_id>:<source_stream_id>` with `is_counterfactual = true` and never to the source entity.

**Increments.**

1. Rename the run-scoped sequence to `run_seq` across [`idl/event-log.schema.json`](../../idl/event-log.schema.json) and both generated contract models, then update every consumer: `engine/src/{store,projection,events}.ts`, the harness oracles, `coordinator/internal/{store,trace,eventlog}`, and the conformance fixtures.
2. Migrate `event_log` to `run_event_log`, preserving hash partitioning by `run_id` and the primary key under its new column name, with the existing ownership and transaction triggers carried over.
3. Add `stream`, `business_event_stream` hash partitioned by `stream_id`, and `business_stream_snapshot`, with the append function that allocates both sequences in one transaction.
4. Route domain events through the dual-allocation path and leave pure orchestration events on the single-lock path; assert in tests that an orchestration-only append never touches a `stream` row.
5. Implement fork quarantine: synthetic `stream_id`, `is_counterfactual = true`, and the production read filter in every semantic fold and report.
6. Implement snapshot fold-and-pin at run start, carry `{snapshot_id, pinned_stream_seq}` in `task_input`, and resolve business context from the snapshot during assembly and replay.
7. Add scenarios S21–S23 and their oracle assertions to the validation harness.
8. Point the Console at `run_event_log` and domain read models at `business_event_stream`.

**Exit criteria.**

- A surface fold reads one partition of the run plane; no query in the projection pipeline scans the business plane.
- `(stream_id, stream_seq)` is enforced by a native unique constraint, with no partition-key workaround.
- One entity's four-run lifecycle folds to the correct entity view in a single query, and every business row names the `(run_id, run_seq)` that produced it.
- Forking a run leaves the source entity's head and folded view unchanged.
- A run replayed after its entity has advanced produces an identical prompt hash.
- An orchestration-only append acquires no `stream` row lock.
- No reader folds `global_seq`.

**Exclusions.** Stream-identity assignment policy — which domain concepts deserve an aggregate root, and how `stream_id` is derived from `task_input` — belongs with the domain teams that own the reducers. Snapshot retention and compaction, and CDC consumers of `global_seq`, are deferred.
