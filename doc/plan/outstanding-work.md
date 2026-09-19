# Outstanding Implementation Work

> The single backlog for work that is specified but not delivered. Requirements live in the [design documents](../design/); this file records only what remains, why it is not done, and what "done" will look like.

Delivered work is not recorded here. When a work stream finishes, its section is deleted — the design documents keep the requirements and Git history keeps the delivery record.

| # | Work stream | Authoritative design | State |
|---|---|---|---|
| W1 | Formal verification stage S3 | [Doc 06 §12](../design/06-validation-harness.md#12-formal-verification-design) | Trigger-gated: waiting on first production traffic |
| W2 | Duplicate-delivery scenario S12 | [Doc 06 §6](../design/06-validation-harness.md#6-scenario-matrix), [Doc 07](../design/07-distributed-transaction-coordinator.md) | Runtime delivered; this scenario pending |
| W3 | Router scenarios | [Doc 10](../design/10-deterministic-routers.md) | Freeze-time admission delivered; scenario coverage pending |
| W4 | Business-plane consumers: snapshots, fork quarantine, read models | [Doc 01 §3.1](../design/01-jit-dag-and-event-log.md#31-two-planes-and-three-sequences), [Doc 04 §2.1](../design/04-refine-and-harness-state.md#21-business-context-enters-through-task_input-not-harness-state), [Doc 08](../design/08-database-schema.md) | Storage delivered; consumers pending |
| W5 | Coordinator lock order, claim eligibility, and attempt evidence | [Doc 07 §3.1](../design/07-distributed-transaction-coordinator.md#31-work-scheduler), [Doc 02 §4.4](../design/02-transaction-model.md#44-orphan-try-detection), [Doc 08 §3](../design/08-database-schema.md#3-write-time-guards) | Not started; the code contradicts the documented lock order |

W3's remaining work is confined to the validation harness and W4's stays in the Engine apart from one table; W5 is the only stream that rewrites the Coordinator's claim path, so it should not run concurrently with either.

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

## W3 — Router scenarios

A router now decides, and freeze now admits what it may decide. Templates are published under
Q1–Q6, resolved at freeze by reference or slot coordinate, pinned onto the router as a
`pin_version`, and admitted branch by branch at the placement derived from the run's scope state —
so a branch that is illegal where the router sits is refused before any tool runs, whether or not
its condition would ever have held. What remains is the scenario coverage that holds all of it.

**Increment.**

Add scenarios S15–S20 and the router assertions in oracles O2 and O4. Doc 06's scenario format does
not exist in code — `runFixture` is a stub with no callers — so this is partly about building the
harness the rows assume.

**Exit criteria.**

- A fork substituting only a rule-template pin differs from its source in no structural way.
- Oracle O2 asserts the router trajectory and the absence of a deterministic replan on real logs.

**Exclusions.** Slot-collision rebinding and template migration, a nested-router depth bound, and
automatic governance actions on match-rate thresholds are the open questions in
[Doc 10 §13](../design/10-deterministic-routers.md#13-open-questions). Branch inputs are also
deferred: a template branch names tools but binds no parameters, so an emitted vertex carries an
empty input until the template language grows a way to reference upstream output.

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

## W5 — Coordinator lock order, claim eligibility, and attempt evidence

Split out of W3, which had lumped it in: none of it concerns routers. The documents describe a
discipline the code does not keep, so this stream closes a divergence rather than adding a feature.

**The divergence.** [Doc 08 §3](../design/08-database-schema.md#3-write-time-guards) and
`AGENTS.md` state one lock order, `txn_scope` before `work_queue`. The implementation does the
reverse and across transaction boundaries: `claim_ready_work` takes `work_queue FOR UPDATE SKIP
LOCKED` and never touches `txn_scope`, while `admit_pivot` and `request_scope_cancel` take the
scope first and then call `append_events`, which takes the run row. That is a genuine deadlock
cycle, not a stylistic mismatch.

**Increments.**

1. Add the `txn_attempt` table and record an attempt's identity, idempotency key and start durably
   before any side-effecting request leaves the executor. No such table exists today, and nothing
   is written before the adapter call.
2. Enforce one lock order on every state-altering path, and add the claim-eligibility filter by
   scope state to `claim_ready_work`.
3. Rewrite the sweeper around attempt evidence: defer on a live lease, suspend on an unresolved
   attempt, and cancel only a scope with an expired sealed try, no live lease and no unresolved
   attempt.

**Exit criteria.**

- A scope holding an unresolved attempt suspends; no `txn/cancel {phase: requested}` is appended
  for it, and neither automatic cancellation nor redispatch occurs.
- Cancellation and claiming race decisively in both directions.
- Already-admitted post-pivot forward work stays claimable while pre-pivot work and backward
  cancellation are blocked.
- The lock order in the code matches the one the documents state.
