# Validation Harness: Sandbox, Scenarios, and Oracles (06)

> Status: Draft v0.1 | Depends on: [01](./01-jit-dag-and-vertex-log.md), [02](./02-transaction-model.md), [03](./03-replan-and-recovery.md), [05](./05-context-aggregation-and-experimentation.md)

## 1. What This Document Decides

Flory's claim is that JIT planning can be made transactionally safe. That claim is only worth as much as the evidence behind it, so this document specifies the apparatus that produces the evidence: a simulated e-commerce sandbox, a deterministic fault injector, a scenario library, and — the load-bearing part — the **oracles** that decide whether a run was correct.

The hard problem is not running the engine. It is defining "correct". A run that terminates without an exception can still have sold 130 units out of 100, charged a customer twice, or left a hold frozen forever. None of those are visible from a tool's return value, so the harness is designed around one principle:

> **A test asserts on the state of the world and the shape of the log, never on whether a tool call returned success.**

Four questions must be answerable by the end of Phase 1 (§9):

1. Are distributed-transaction properties preserved under agent orchestration?
2. Does replanning select the correct backtrack point and cancel before forking?
3. Is the recovery escalation ladder climbed correctly and monotonically?
4. Is planning genuinely just-in-time rather than a single up-front graph?

## 2. Three-Tier Validation Strategy

Model calls are non-deterministic, so any assertion that depends on a live model is necessarily statistical. Determinism is therefore purchased by tier, not sacrificed globally.

| Tier | Planner | Assertion strength | Covers | Needs API key |
|---|---|---|---|---|
| **T-A pure function** | none | exact equality | check-rules R1–R9, `surface` / `slice` / `fold` / `linearize` / `assemble`, replay log diff (discipline 28) | no |
| **T-B scripted planner** | stub emitting canned sub-DAG proposals | exact equality | transaction brackets, compensation, L0–L4 ladder, fork semantics, orphan-try sweep, crash recovery | no |
| **T-C live planner** | real model | statistical thresholds + guardrails | JIT planning quality, plan admissibility rate, token economics | yes |

### 2.1 T-B is the primary tier

Almost every property this document cares about is an engine property, not a model property. A scripted planner makes those properties exactly assertable, which is the difference between a regression suite and a demo.

### 2.2 Negative plans are the point

The scripted planner must be able to emit **deliberately illegal proposals**, not only good ones. Discipline 14 says a planner declares boundaries and the rule engine admits them; the only way to demonstrate that is to feed the rule engine plans that must be rejected:

- two pivots in one scope (R3)
- a non-compensable, non-TCC node before the pivot (R2)
- a non-idempotent successor after the pivot (R1)
- a `txn/try` with no reachable cancel exit (R6)
- parallel branches with intersecting write sets, one carrying a pivot (R9)

For each of these the assertion is stronger than "rejected": **no tool in the sandbox may be invoked at all**, because rejection happens before freeze. A rejection that arrives after a side effect is a failed test even though the violation was detected.

### 2.3 T-C is in scope from the start

Planning quality is a first-class product property, so the live tier is designed now rather than retrofitted (§8). It reuses the same sandbox, the same fault injector, and the same oracles; only the assertion form changes.

## 3. Sandbox Contract

### 3.1 Two views, one world

The sandbox exposes two strictly separated interfaces. Conflating them is the single easiest way to build a harness that proves nothing.

| View | Reader | Contents |
|---|---|---|
| **Actor view** | the engine under test | tool calls only: `inventory.reserve` / `confirm` / `release` / `commit`, `logistics.book` / `status`, `payment.charge` / `refund`, `channel.list` / `unlist` — each returning what a real API would return, including nothing useful on timeout |
| **Ledger view** | oracles only | full history: on-hand quantities, every hold with its owning `scope_id` and signed delta, every charge with its idempotency key, every booking with its status transitions |

The engine may never read the ledger view. The oracles may never call the actor view. This asymmetry is what allows an oracle to detect an oversell that the engine has no way to observe.

### 3.2 Ledger semantics

Resources are modelled as **signed deltas with an owner**, never as absolute values, mirroring discipline 17.

```
available(sku) = on_hand(sku) − Σ open_holds(sku)
```

A `release` subtracts exactly the delta its own `try` added. A sandbox that implements release as snapshot restore would silently pass a test suite that a delta-based implementation is supposed to fail, so the sandbox itself is written delta-first and additionally rejects any registered compensation declared as snapshot-restore.

Value-type resources (price, listing state) follow the same rule and matter more, because snapshot restore looks natural there and is wrong (02 §4.3, D2).

### 3.3 The tool registry is under test

Check-rules read `tool_registry`, so the sandbox's registration metadata is part of the surface being validated, not scaffolding around it. Every sandbox tool declares its real `effect_class`, TCC triple, `compensate_tool`, `idempotency_key` convention, `try_timeout_s`, and resource footprint (`inventory:{sku}`, `carrier:{carrier_id}`, `payment:{order_id}`). Registration itself is validated: a tool declaring `compensable: true` without a registered idempotent `compensate_tool` fails registration (R4), which is a test in its own right.

### 3.4 Designated pivots

The sandbox provides exactly three irreversible operations, one per realistic failure mode:

| Tool | Why irreversible | Interesting property |
|---|---|---|
| `logistics.book` | carrier slot consumed, goods handed over | supports `status` query for reconciliation |
| `payment.charge` | external settlement | strong idempotency key, duplicate-safe |
| `inventory.commit` | physical picking begins | no status query — forces the degraded reconciliation path |

`inventory.commit` deliberately lacks a status-query interface so the harness exercises the open question in 02 §6: what the engine does when a pivot's outcome is genuinely unknowable. The expected behaviour is L4 suspension plus a reconciliation task, never a guess.

### 3.5 Phase 1 implementation form

Phase 1 implements the sandbox as an **in-process TypeScript fake** with an in-memory ledger. It is the fastest path to green assertions and keeps every oracle synchronous.

Two constraints keep the Phase 2 upgrade (§9) honest rather than a rewrite:

1. **Event ownership is enforced even in-process.** The scripted executor stands in for the Go coordinator and may append only coordinator-owned event types (discipline 29). An in-process harness that lets one component append everything would validate a system that does not exist.
2. **Every tool call crosses a serialization boundary.** Arguments and results are encoded and decoded even though no socket is involved, so no test accidentally depends on shared object identity.

Crash and duplicate-delivery scenarios (S11–S12) are the ones an in-process fake cannot honestly cover; they are deferred to Phase 2 and marked as such in the matrix.

## 4. Fault Injector

Faults are a **pure function of `(seed, tool, attempt_no)`**, resolved from a table. No wall clock, no randomness at call time. A failing run is therefore reproducible from its scenario ID alone, and a fault schedule can be committed alongside its expected log.

| Fault class | Actor view sees | Ledger view records | Kills |
|---|---|---|---|
| `transient` | 429 / 503 / timeout, retryable | nothing | L0 retry path |
| `permanent` | business rejection (out of stock, carrier refuses) | nothing | L1 / L2 replan |
| `unknown_outcome` | timeout with no response | **the operation actually succeeded** | reconciliation, duplicate side effects |
| `duplicate_delivery` | one call, applied twice by the world | two attempts, one effect if keys work | idempotency keys |
| `slow` | response after `try_timeout_s` | hold expires mid-flight | R6, orphan-try sweep |
| `crash` | process terminated between append and effect | partial state | orphan detection, timeout sweep |

`unknown_outcome` is the highest-value class in the whole harness. It is the only one that separates an engine that reconciles from an engine that assumes, and it is the fault that produces double-charging in production systems.

## 5. Scenario Specification

A scenario is a declarative record, not a script. The runner is generic; scenarios are data.

```jsonc
{
  "id": "S2-carrier-refuses-pre-pivot",
  "seed": 20260818,
  "goal_prompt": "Replenish 50 units of SKU-123 and ship them to postcode 3210.",
  "world_init": {
    "inventory": { "SKU-123": { "on_hand": 100 } },
    "carriers": ["fast-co", "slow-co"]
  },
  "planner": { "mode": "scripted", "script_ref": "scripts/replenish-then-ship.json" },
  "faults": [
    { "tool": "logistics.book", "carrier": "fast-co", "attempt": "*", "class": "permanent" }
  ],
  "budget": { "plan_tokens": 20000 },
  "expect": {
    "terminal": "run/end:success",
    "episodes": [{ "trigger": "logistics.book", "ladder": ["L1"] }],
    "oracles": ["O1.all", "O2.all", "O3.monotone", "O4.jit_depth"]
  }
}
```

`expect.episodes` is a list, not a flat ladder sequence, because monotonicity is a per-episode property (§7, O3). A scenario that produces two independent failures declares two entries.

The `goal_prompt` is the initial workflow prompt that drives orchestration. In T-B it is context for the scripted planner's branch selection; in T-C it is the real model input. Keeping one field for both means a scenario can be promoted from T-B to T-C by changing `planner.mode` and nothing else.

## 6. Scenario Matrix

Each row exists to kill one specific accident. A scenario that cannot fail if a named discipline is removed is not pulling its weight.

| ID | Setup and injection | Expected behaviour | Primary oracle | Tier |
|---|---|---|---|---|
| S1 | carrier returns 429 twice, then succeeds | L0 idempotent retry; **no** `fork/created`, **no** `subgraph/shadowed` | O3 | T-B |
| S2 | carrier permanently refuses, pre-pivot | L1 replan at nearest planner; every open `txn/try` cancelled **before** `fork/created` | O2, O3 | T-B |
| S2b | replan is triggered while a `txn/try` is still open; the engine is offered a fork at a planner inside the bracket | **negative test**: `fork/created` must not be appended with a `boundary_seq` inside an open bracket. Cancel precedes fork (03 §2.4 rule 1); peak holds never exceed demand | O1.no_amplification, O2.fork_boundary | T-B |
| S3 | carrier A refuses; the L1 replan picks carrier B, which also refuses. Backtracking targets the same planner P1 both times | P1 has now failed `N = 2` consecutive replans, so escalate **directly to L3** rollback (03 §3). L2 must **not** be entered: the boundary was legal throughout, and counting does not make it illegal | O3 | T-B |
| S3b | no pivot has passed in the run, so the backtrack floor is the run start. The failure's nearest ancestor planner P2 sits **inside** an open `txn/scope` bracket whose savepoint precedes P2 | P2 fails the bracket condition (03 §2.1 (i)). Cancelling returns the world to a savepoint before P2, so P2's premises are undone: escalate to **L2** and select the **nearest** legal boundary at or after both the floor and the cancelled scope's savepoint, here P1 (03 §2.2 step 1) | O2, O3 | T-B |
| S4 | budget preflight fails for the target planner | go straight to L3 rollback to savepoint; no unaffordable replan is attempted | O3 | T-B |
| S5 | pivot passes, then a suffix node fails permanently | L4 suspension; **zero** `txn/cancel` events after `txn/pivot-passed` | O2, O3 | T-B |
| S5b | scope A commits `payment.charge` (pivot passed); scope B's `logistics.book` then fails pre-pivot | L3 compensates B to savepoint S1. The selected boundary must be **at or after** A's `txn/pivot-passed`; a boundary below the floor is a failure even though the run may still terminate successfully. Ledger shows exactly one charge | O1, O2.floor | T-B |
| S6 | scripted planner proposes two pivots in one scope | `subgraph/rejected` citing R3; **no sandbox tool invoked** | O2 | T-B |
| S7 | branches A and B both write `inventory:SKU-123`, A has a pivot | freeze rejected by R9, or branches serialized; ledger shows no phantom units | O1, O2 | T-B |
| S8 | `logistics.book` returns `unknown_outcome` | reconcile via `logistics.status`; exactly one booking in the ledger | O1 | T-B |
| S9 | compensation registered as snapshot restore | rejected at tool registration, before any run starts | O1 | T-A |
| S10 | `inventory.commit` returns `unknown_outcome`, no status query exists | L4 suspension plus a reconciliation task; no guess, no automatic compensation | O2, O3 | T-B |
| S11 | crash between `vertex/created` and effect, then restart | orphan `txn/try` detected by the unmatched-try sweep after `try_timeout_s` (02 §4.4) and idempotently cancelled | O1, O2 | T-B (partial in Phase 1, full in Phase 2) |
| S11b | fork at a boundary that inherits a half-open `txn/try` | the inherited try is identified relative to `run/end-seed` and cancelled before the child run proceeds | O2 | T-B |
| S12 | `duplicate_delivery` on `payment.charge` | exactly one charge in the ledger | O1 | T-B (Phase 2) |

## 7. Oracles

Four independent classes. A run must satisfy all applicable oracles; a single violation fails the scenario regardless of the terminal status.

### O1 — World conservation (reads the ledger view)

| Assertion | Catches |
|---|---|
| `on_hand + Σ open_holds + Σ shipped == initial_total` for every SKU, at every quiescent point | oversell, phantom units |
| `Σ open_holds == 0` at `run/end` | frozen resources, missing cancel |
| **no hold amplification**: at every quiescent point, `Σ open_holds(sku) ≤ Σ demanded(sku)` over non-cancelled scopes | a fork taken across an open `txn/try`, which duplicates a hold. The end-of-run assertion above cannot catch this: the orphan sweep eventually cancels the inherited try, so the run ends clean while a parallel order was starved for `try_timeout_s` |
| `count(charges by order_id) == 1` | double charging from retry or unknown outcome |
| `count(bookings by order_id) <= 1` | duplicate shipment |
| every ledger delta is attributable to exactly one `scope_id` | compensation that touched another scope's footprint |

### O2 — Log invariants (reads the vertex log)

| Assertion | Discipline |
|---|---|
| every `txn/try` has exactly one matching `txn/confirm` or `txn/cancel` | 02 §4.1 |
| no `txn/cancel` appears after `txn/pivot-passed` in the same scope | 15 |
| every `fork/created` boundary sits at a succeeded planner outside all open brackets (**bracket condition**, 03 §2.1 (i)) | 16 |
| no `fork/created` boundary precedes the most recent `txn/pivot-passed` (**floor condition**, 03 §2.1 (ii)) | 15 |
| no row is ever updated or deleted; shadowing is an event | 1, 2 |
| an unknown `event_type` without `ignorable` makes the reader reject the whole log | 5 |
| each event type was appended only by its owning service | 29 |
| `subgraph/frozen` and its `vertex/created` events share one transaction boundary | 4 |

### O3 — Ladder trace

**Failure episode.** An episode opens at a `vertex/failed` event that is not already inside an open episode, and closes at the first `vertex/succeeded` on the recovery path (forward progress resumed) or at run termination (`run/end`, or L4 suspension). Both boundaries are log projections; the engine declares nothing.

Project the recovery actions **of each episode separately** into a sequence over `{L0, L1, L2, L3, L4}` and assert:

- within one episode the sequence is **monotonically non-decreasing**: a level is never re-entered after escalating past it;
- across episodes nothing is asserted. A run whose global sequence reads `L0, L1, L0` is correct: a successful L1 replan produces a fresh, undisproven subgraph, and an unrelated transient failure inside it must be allowed to start again at the cheapest level. A run-global monotonicity assertion would forbid retrying a 503 merely because an earlier, unrelated failure once needed a replan;
- no level is skipped **within** an episode, with three legal exceptions, each of which exists because the intermediate levels are infeasible rather than merely expensive:

| Skip | Basis | Why no intermediate rung exists |
|---|---|---|
| any level → L4 | 03 §2.4 rule 2 | `txn/pivot-passed` has been appended for the failing scope and forward closure (L0) cannot succeed. Compensation cannot cross the committed pivot, so L3 is unavailable; the scope's bracket can therefore never close, so no boundary satisfies the bracket condition and L1 and L2 have no legal target. |
| L1 → L3 | 03 §3 | The same planner has failed `N` consecutive replans (default 2). L2 is reached by structural infeasibility of the fork boundary, and a failure count does not make a legal boundary illegal, so L2 is not on this path. |
| L1 or L2 → L3 / L4 | 03 §4 | Budget preflight estimates the replan above the remaining balance. Attempting a predictably unaffordable replan only burns budget and leaves less for rollback. |

- every escalation and every skip is preceded by **evidence in the log** that the intermediate levels were infeasible — retries exhausted, no legal fork boundary, consecutive-failure counter at `N`, `txn/pivot-passed`, or a failed budget preflight. This bullet is the load-bearing one: it forbids the engine from skipping levels for reasons the harness has to infer.

### O4 — JIT and purity properties

| Assertion | Why |
|---|---|
| every `subgraph/frozen` has depth ≤ K (default 3) | proves progressive disclosure rather than an up-front full graph |
| the run contains ≥ 2 planner vertices whenever the goal requires a decision point | proves the DAG grew incrementally |
| every frozen subgraph passed check-rules; no freeze without a preceding admission | discipline 14 |
| identical `hash(log_prefix)` + `projector_version` + `harness_state_version` ⇒ identical prompt hash; changing any one of the three must change it | disciplines 8, 11, 24 |
| replaying a recorded run reproduces the log event-for-event, timestamps ignored | discipline 28 |
| `linearize` output is unchanged when parallel branch completion order is permuted | discipline 10 |

The last assertion deserves emphasis: the harness should run selected scenarios twice with **deliberately permuted branch scheduling** and assert an identical prompt hash. Scheduling jitter silently destroying replay determinism and prompt-cache hit rate is exactly the bug class that no ordinary test catches.

## 8. Live-Model Tier (T-C)

Same sandbox, same faults, same oracles. What changes is that O1 and O2 remain **hard** assertions — a live model must never be allowed to break world conservation or log invariants — while O3 and O4 relax into distributions, and new quality metrics appear.

### 8.1 Metrics are log projections

Per discipline 23, no separate telemetry. Every metric below is a projection over the vertex log and the ledger, so a changed definition can be recomputed over history.

| Metric | Definition | Direction |
|---|---|---|
| task success rate | runs ending `run/end:success` | target |
| admissible-plan rate | `subgraph/frozen ÷ subgraph/proposed` | target |
| replan depth | mean highest ladder level reached | target |
| tokens per success | `Σ budget/charged ÷ successes` | target |
| **L4 suspension rate** | runs reaching human intervention | **guardrail** |
| **post-pivot failure rate** | failures after `txn/pivot-passed` | **guardrail** |
| **orphan-hold incidents** | O1 violations of any severity | **guardrail, zero tolerance** |

Per discipline 25, a guardrail regression vetoes a target-metric win. A configuration that cuts tokens per success by 30% while raising the L4 rate is a regression, and the harness reports it as one.

### 8.2 Stratification

Per discipline 26, results are stratified by task type, SKU-count bucket, and whether the plan contains a pivot; aggregate-only comparisons are not reported. Task heterogeneity here spans orders of magnitude, and uniform pooling lets variance swallow the effect.

### 8.3 Attribution

Every T-C run records the attribution triple in `run/start`: `harness_state_version` + `projector_version` + `arm_id` (discipline 24). Traffic is split by run, never by turn (discipline 22). Scenario ID and fault seed are recorded alongside so a statistical result can always be reduced to a reproducible individual run.

## 9. Phased Rollout

| Phase | Scope | Exit criterion |
|---|---|---|
| **0** | T-A only: table-driven check-rule tests, projection purity tests, replay diff. No sandbox, no key. | every rule R1–R9 has ≥ 1 passing and ≥ 1 violating fixture; every projection layer dumps its intermediate output |
| **1** | In-process TS sandbox, scripted planner, fault injector, oracles O1–O4, scenarios S1–S10 plus S2b, S3b, S5b, S11 (partial) and S11b | all green; S11 partial; the four questions in §1 are answered without an API key |
| **2** | Sandbox promoted to an out-of-process service; Go coordinator on real Postgres | S11 and S12 green; cross-language conformance fixtures pass (discipline 34) |
| **3** | T-C live planner, stratified arms, guardrail gating | a baseline arm with published metrics that a change must beat |

Phases 0 and 1 require no API key and no model access, which is the point: regression testing must not depend on a model provider (discipline 28).

## 10. Relation to Existing Work

- **dsh** treats a recorded session as both mock script and expected output. Flory inherits this as T-A replay testing and extends it: dsh replays model responses, whereas Flory must additionally replay a *world*, because its tool calls have irreversible effects that a log alone cannot reconstruct.
- **SagaLLM** validates plans with an independent validation agent. The harness deliberately does the opposite: §2.2 exists to prove the deterministic rule engine catches what a model reviewer would be trusted to catch, so that no test result ever depends on a model's self-discipline.
- Chaos-engineering practice contributes the fault taxonomy, but with one inversion: production chaos is random by design, whereas this injector is seeded and table-driven, because a transaction bug that cannot be reproduced cannot be fixed.

## 11. Open Questions

- **Forward-closure bound (resolved contradiction, new question).** [03 §2.2](./03-replan-and-recovery.md) step 2 now requires driving a post-pivot scope forward to closure rather than searching upward past the floor. Unresolved: how long forward closure may be attempted before the run is declared L4. Too short and a recoverable run is suspended for a human; too long and an unrecoverable run holds resources indefinitely. The harness currently asserts only that L4 is eventually reached, not when, so S10 cannot yet distinguish a correct bound from an arbitrary one.
- **L2 reachability.** As specified, L2 is reachable only through structural infeasibility of the fork boundary; consecutive replan failures route L1 directly to L3 (03 §3). Whether an intermediate count-based L1 → L2 step was intended is unresolved. The harness asserts the literal specification, so if the intent was different, S3 will fail and expose it — the desired outcome, but it should be a deliberate decision rather than a surprise.
- **Ladder ground truth.** O3 asserts that escalation was justified, but "L1 was infeasible" is currently inferred from logged evidence. A stronger form would have the harness independently compute the set of legal fork boundaries and compare it against the engine's choice — this requires a second implementation of boundary selection, which risks the two-implementations-disagree failure mode that discipline 30 exists to prevent.
- **Scenario coverage measurement.** Rule and discipline coverage is currently tracked by hand in §6. A generated coverage report — which disciplines have no killing scenario — would be more honest.
- **Property-based scenario generation.** S1–S12 are hand-written. Randomly generated DAG shapes with generated fault schedules, checked against O1 and O2 only, would likely find the multi-replan shadowing boundary cases flagged as an open question in [01 §7](./01-jit-dag-and-vertex-log.md).
- **Sandbox fidelity ceiling.** A fake carrier that always answers `status` correctly is more cooperative than any real one. Deciding how much real-API pathology to simulate, and where simulating it stops teaching anything, is unresolved.
