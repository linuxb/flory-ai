# Outstanding Implementation Work

> The single backlog for work that is specified but not delivered. Requirements live in the [design documents](../design/); this file records only what remains, why it is not done, and what "done" will look like.

Delivered work is not recorded here. When a work stream finishes, its section is deleted — the design documents keep the requirements and Git history keeps the delivery record.

| # | Work stream | Authoritative design | State |
|---|---|---|---|
| W1 | Formal verification stage S3 | [Doc 06 §12](../design/06-validation-harness.md#12-formal-verification-design) | Trigger-gated: waiting on first production traffic |
| W2 | Duplicate-delivery scenario S12 | [Doc 06 §6](../design/06-validation-harness.md#6-scenario-matrix), [Doc 07](../design/07-distributed-transaction-coordinator.md) | Runtime delivered; this scenario pending |
| W4 | Business-plane consumers: snapshots, fork quarantine, read models | [Doc 01 §3.1](../design/01-jit-dag-and-event-log.md#31-two-planes-and-three-sequences), [Doc 04 §2.1](../design/04-refine-and-harness-state.md#21-business-context-enters-through-task_input-not-harness-state), [Doc 08](../design/08-database-schema.md) | Storage delivered; consumers pending |
| W6 | Console: observability projection, stream, detail endpoints, UI | [Doc 11](../design/11-console-and-observability.md) | Delivered, less two endpoints blocked on retention that does not exist |
| W7 | Recovery ladder L3 and L4: compensation, suspension, and the prices they need | [Doc 03](../design/03-replan-and-recovery.md) | L0-L2 and cancel-before-replan delivered; prices, run-level suspension and L3's terminal replan pending |

W4 stays in the Engine apart from one table, so it does not contend with the remaining streams. W6 is delivered and reads the run plane directly; pointing domain read models at the business plane stays with W4.

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

**S16 is no longer vacuous.** It asserts that a failure inside a rule-authored branch never reaches
a planner, and `engine/src/recovery.ts` now appends `replan/boundary` — so the restraint is
exercised rather than assumed. The oracle `O2.no_deterministic_replan` holds it.

## W4 — Business-plane consumers

The two planes, their sequences, and the dual-allocation append path are built. What remains is everything that *consumes* them: a fork choosing its own quarantined stream, business context pinned into `task_input`, the scenarios that hold those properties, and the read models.

**Contract baseline.** `run_seq` is the only legal input to a surface fold; `stream_seq` is the only legal input to a semantic fold; `global_seq` is never a fold input. A domain event writes both planes in one transaction; a pure orchestration event writes only the run plane. A fork writes domain events to `fork:<fork_run_id>:<source_stream_id>` with `is_counterfactual = true` and never to the source entity.

**Increments.**

1. Add `business_stream_snapshot`, fold-and-pin at run start, carry `{snapshot_id, pinned_stream_seq}` in `task_input`, and resolve business context from the snapshot during assembly and replay.
2. Complete fork quarantine in the Engine: a fork derives its own synthetic `stream_id` rather than a caller passing one, and every semantic fold and operational report applies the `is_counterfactual` filter. The database already refuses a counterfactual that writes a live entity.
3. Add scenarios S21–S23 and their oracle assertions to the validation harness.
4. Point the Console at `run_event_log` and domain read models at `business_event_stream`.

**Exit criteria.**

- One entity's multi-run lifecycle folds to the correct entity view in a single query.
- A run replayed after its entity has advanced produces an identical prompt hash.
- Every semantic fold and report filters `is_counterfactual`, so the flag protects a reader that forgets the namespace.
- No reader folds `global_seq`.

**Exclusions.** Stream-identity assignment policy — which domain concepts deserve an aggregate root, and how `stream_id` is derived from `task_input` — belongs with the domain teams that own the reducers. Snapshot retention and compaction, and CDC consumers of `global_seq`, are deferred.

## W7 — The rest of the recovery ladder

L0, L1 and L2 are delivered in `engine/src/recovery.ts`: boundary selection with a published
candidate set, the backtrack floor, the open-bracket condition, the per-planner and per-episode
counters, and the rule that work a deterministic router authored never reaches a planner. What a
replan produces is verified end to end against a real model.

**Cancel-before-replan is delivered** (migration 017). A pre-pivot failure fences its scope; the
Engine alone requests a failure-driven cancellation (`replan/cancel-requested`), the Coordinator
executes it, and the ladder decides under the run's scope locks and waits for every scope it asked
about to complete — or suspend — before it replans or escalates. The orphan sweep is the one
cancellation the Coordinator still starts, on the same cancel key. This closed the race in which the
ladder escalated a failure a moment before its cancellation made a boundary legal, and the one in
which it replanned between `requested` and `completed`. It is asserted over every interleaving by
`engine/test/unit/recovery-cancel-interleavings.test.ts` (with the old ladder as a negative control),
against real rows at every split point by `engine/test/integration/recovery-cancellation.test.ts`,
and on the Coordinator side by its integration suite. The stalled-planner hole (formerly increment 4)
was closed earlier by `subgraph/unreadable` ([03 §2.6](../design/03-replan-and-recovery.md#26-the-other-way-a-run-stops-a-planner-that-produced-no-work)).

**Increments.**

1. Price the two terms the cost model cannot compute. `compensation_cost` and the tool half of
   `rework_cost` have no source: no tool contract carries a call price or a cancel price. A
   candidate that needs a cancellation is now selectable and carries `requires_cancel`, so the
   omission can bias a comparison between candidates that need different scopes cancelled. This is
   a gateway contract change.
2. L4 suspension as a state rather than a stop: a run that needs a human should be visibly
   suspended in the console and in the run list, not merely idle. The console shows the scope's
   `suspended` state and the ladder's cancellation requests; nothing marks the run itself.
3. L3's terminal replan at the savepoint and its postmortem ([03 §3](../design/03-replan-and-recovery.md#3-rollback-l3)).
   The ladder now cancels the failure's scope before recording L3, and records nothing further.
4. Liveness after a timeout cancel. The orphan sweep deletes a cancelled scope's pending members,
   and nothing appends `vertex/failed` for them, so a run whose scope was swept can stop with nothing
   outstanding for the ladder to find.

**Exit criteria.**

- A post-pivot failure never cancels, and reaches L4 with its committed state and unconfirmed
  tries preserved. (Met for the ladder and the Coordinator; the run-level state is increment 2.)
- Scenario S3c asserts the episode bound end to end.
- Every candidate that needs a cancellation is priced, or the comparison it takes part in says it
  was not.

**Exclusions.** How long forward closure may be attempted before a run is declared L4 stays open
([03 §6](../design/03-replan-and-recovery.md#6-open-questions)); the harness asserts that L4 is
eventually reached, not when.

## W6 — Console

[Doc 11](../design/11-console-and-observability.md) specifies an operator view of one run's graph. It is now built: `console/server` holds the projection, the polling tail, the SSE stream and a `GET`-only HTTP surface read as `console_role`, and `console/client` holds the React canvas and inspector.

**Delivered.**

1. The console projection, beside `surface`. Pure, versioned, reproducible from the log, retaining shadowed vertices and enriching each with label, scope, pivot position, bracket, timing, cost and `depth`. `consoleDag` is defined as a fold of `advanceConsoleDag`, so the snapshot and the deltas cannot diverge.
2. The stream, over SSE with a `<run_seq>.<ordinal>` cursor and a polling tail, plus `resolveResume` covering all five cursor cases.
3. `GET .../payload`, which the log can serve.
4. The client: canvas, cards, scope enclosures with the commit boundary drawn, the inspector's four tabs, light and dark with an explicit override, and a captured-run fixture with a mock server that replays it.

**Blocked, and not on this work stream.** `GET .../prompt` and `GET .../logs` answer `501` with the digests the log does hold. Nothing in the Engine persists a prompt, a completion, or tool execution output, and the Engine has no blob client to persist them with. The endpoints exist so the contract stays whole and the gap stays visible; they light up when a retention write path does ([Doc 11 §7](../design/11-console-and-observability.md#7-open-questions)).

**Now exercisable.** The recovery ladder appends `replan/boundary`, `subgraph/shadowed` and `replan/cancel-requested` in live runs, so the shadowed-branch rendering has a producer; the projection records cancellation requests as `cancel_requests` (projector `v2`).

**Exit criteria, all met.**

- The projection is a pure function of the log: the same prefix produces the same model, and a shadowed subtree survives a replan rather than disappearing.
- A client killed mid-run and reconnected reaches a state identical to one that never disconnected, whether the server resumed or re-snapshotted — asserted over every split point on both sides.
- A router that fell through is visible on the canvas and absent from the downstream planner's prompt in the same run (scenario S24 and the `O4.console_router_visibility` oracle).
- Nothing in the client folds an event or derives a scope.

**Exclusions.** The open questions in [Doc 11 §7](../design/11-console-and-observability.md#7-open-questions) remain out of scope: multi-run fleet views, snapshot retention for completed runs, the retention write path, and which roles may read tool payloads through the detail endpoints. The last one gates any deployment beyond a trusted network; until it is answered the server refuses to bind a non-loopback address without an explicit override.
