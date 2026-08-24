# Validation Harness: Sandbox, Scenarios, and Oracles (06)

> Status: Phase 0 implemented; Phase 1 partial | Depends on: [01](./01-jit-dag-and-event-log.md), [02](./02-transaction-model.md), [03](./03-replan-and-recovery.md), [05](./05-context-aggregation-and-offline-evaluation.md)

## 1. What This Document Decides

Flory's claim is that JIT planning can be made transactionally safe. That claim is only worth as much as the evidence behind it, so this document specifies the apparatus that produces the evidence: a simulated e-commerce sandbox, a deterministic fault injector, a scenario library, and — the load-bearing part — the **oracles** that decide whether a run was correct.

The hard problem is not running the engine. It is defining "correct". A run that terminates without an exception can still have sold 130 units out of 100, charged a customer twice, or left a hold frozen forever. None of those are visible from a tool's return value, so the harness is designed around one principle:

> **A test asserts on the state of the world and the shape of the log, never on whether a tool call returned success.**

Four **mechanism** questions must be answerable by the end of Phase 1 (§10):

1. Are distributed-transaction properties preserved under agent orchestration?
2. Does replanning select the correct backtrack point and cancel before replanning?
3. Is the recovery escalation ladder climbed correctly and monotonically?
4. Is planning genuinely just-in-time rather than a single up-front graph?

Each asks whether a policy was *executed* correctly. Whether the policy is the right one — greedy versus wider backtracking, JIT versus up-front planning — is a separate class of question, answered by §8.

## 2. Three-Tier Validation Strategy

Model calls are non-deterministic, so any assertion that depends on a live model is necessarily statistical. Determinism is therefore purchased by tier, not sacrificed globally.

| Tier | Planner | Assertion strength | Covers | Needs API key |
|---|---|---|---|---|
| **T-A pure function** | none | exact equality | check-rules R1–R11, `surface` / `slice` / `fold` / `linearize` / `assemble`, replay log diff (discipline 28) | no |
| **T-B scripted planner** | stub emitting canned sub-DAG proposals | exact equality | transaction brackets, compensation, L0–L4 ladder, in-place replan and lazy causal fork semantics, orphan-try sweep, crash recovery | no |
| **T-C live planner** | real model | statistical thresholds + guardrails | JIT planning quality, plan admissibility rate, token economics | yes |

### 2.1 T-B is the primary tier

Almost every property this document cares about is an engine property, not a model property. A scripted planner makes those properties exactly assertable, which is the difference between a regression suite and a demo.

### 2.2 Negative plans are the point

The scripted planner must be able to emit **deliberately illegal proposals**, not only good ones. Discipline 14 says a planner declares boundaries and the rule engine admits them; the only way to demonstrate that is to feed the rule engine plans that must be rejected:

- two pivots in one scope (R3)
- a non-undoable node before the pivot (R2)
- a side-effecting node belonging to no declared scope (R10)
- a scope narrower than the engine-computed minimum (R11)
- a non-idempotent successor after the pivot (R1)
- a `txn/try` with no reachable cancel exit (R6)
- parallel branches with intersecting write sets, one carrying a pivot (R9)

For each of these the assertion is stronger than "rejected": **no tool in the sandbox may be invoked at all**, because rejection happens before freeze. A rejection that arrives after a side effect is a failed test even though the violation was detected.

### 2.3 T-C is in scope from the start

Planning quality is a first-class product property, so the live tier is designed now rather than retrofitted (§9). It reuses the same sandbox, the same fault injector, and the same oracles; only the assertion form changes.

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

### 3.3 The tool-view contract is under test

Check-rules read an immutable tool view, so the sandbox's registration metadata is part of the validated surface, not scaffolding around it. The local test registry mirrors the publication and admission contract in [09 — gatewayd Tool Registry Gateway](./09-tool-registry-gateway.md#3-registration-and-tool-view-contract); it is a deterministic stand-in for gateway discovery, not a second production registry.

Every sandbox tool declares its real `effect_class`, TCC triple, `compensate_tool`, idempotency-key convention, `try_timeout_s`, and resource footprint (`inventory:{sku}`, `carrier:{carrier_id}`, `payment:{order_id}`). Registration itself is validated: a tool declaring `mode: saga` without a registered idempotent `compensate_tool` fails registration (R4), and a tool with no undo path must be registered `irreversible` rather than `reversible` ([02 §2.1](./02-transaction-model.md)). Tests also assert that a canonical gateway tool view and its local snapshot produce identical admission results. A mislabelled effect class remains the one defect no downstream check-rule can infer.

### 3.4 Designated pivots

The sandbox provides exactly three irreversible operations, one per realistic failure mode:

| Tool | Why irreversible | Interesting property |
|---|---|---|
| `logistics.book` | carrier slot consumed, goods handed over | supports `status` query for reconciliation |
| `payment.charge` | external settlement | strong idempotency key, duplicate-safe |
| `inventory.commit` | physical picking begins | no status query — forces the degraded reconciliation path |

`inventory.commit` deliberately lacks a status-query interface so the harness exercises the open question in 02 §6: what the engine does when a pivot's outcome is genuinely unknowable. The expected behaviour is L4 suspension plus a reconciliation task, never a guess.

### 3.5 Phase 1 implementation form

The delivered Phase 1 slice is an **in-process TypeScript mock world** under `test/mocks/`, never production engine code. Inventory, payment, logistics, and sales-channel actors provide deterministic state and oracle-visible ledgers. Their registry metadata and scripted DAGs exercise multi-service scope boundaries, sequential pivots, parallel branches, and confirmation-barrier admission. This slice validates static structure and deterministic actor semantics; it is not a substitute for a coordinator.

The remaining Phase 1 work is the scripted executor, event-owning actor adapter, deterministic fault injector, and the complete O1-O5/S1-S14 scenario set. Two constraints govern that implementation:

1. **Event ownership is enforced even in-process.** The scripted executor stands in for the Distributed Transaction Coordinator and may append only coordinator-owned event types (discipline 29). An in-process harness that lets one component append everything would validate a system that does not exist.
2. **Every tool call crosses a serialization boundary.** Arguments and results are encoded and decoded even though no socket is involved, so no test accidentally depends on shared object identity.

Crash and duplicate-delivery scenarios (S11-S12), plus the temporal assertion that a runtime barrier waits until every participating try is sealed, cannot be honestly claimed by the current static harness. They require the coordinator and real PostgreSQL work handoff, are deferred to Phase 2, and remain marked as such in the matrix.

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
| S1 | carrier returns 429 twice, then succeeds | L0 idempotent retry; **no** `replan/boundary`, **no** `subgraph/shadowed` | O3 | T-B |
| S2 | carrier permanently refuses, pre-pivot | L1 replan at nearest planner; every open `txn/try` cancelled **before** `replan/boundary` | O2, O3 | T-B |
| S2b | replan is triggered while a `txn/try` is still open; the engine is offered a boundary at a planner inside the bracket | **negative test**: `replan/boundary` must not be appended with a `boundary_seq` inside an open bracket. Cancel precedes replan (03 §2.4 rule 1); peak holds never exceed demand | O1.no_amplification, O2.boundary | T-B |
| S2c | any replan scenario above | **negative test**: no `fork/created` and no new `run_id` appears anywhere in an online replan; the business task keeps one run for its whole life (01 §5.1) | O2.no_online_fork | T-B |
| S3 | carrier A refuses; the L1 replan picks carrier B, which also refuses. Backtracking targets the same planner P1 both times | P1 has now failed `N = 2` consecutive replans, so escalate **directly to L3** rollback (03 §3). L2 must **not** be entered: the boundary was legal throughout, and counting does not make it illegal | O3 | T-B |
| S3c | two planners alternate: the replan at P2 produces a subgraph whose failure backtracks to P3, whose replan would otherwise return to P2. No single planner reaches `N` consecutive failures | **oscillation**: the per-planner counter never trips. Permit at most `E = 2` `replan/boundary` events in one failure episode regardless of planner identity; on the next cancellation, escalate to L3 without appending a third boundary. The log records the `P2 -> P3` prefix, the failure that would recur at P2, and the L3 outcome. `E = 2` is derived from the S1 TLC lasso in 03 §6. | O3, O5.detour | T-B |
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
| S11b | **fork** whose divergence vertex sits inside an open txn bracket, inheriting a half-open `txn/try` from a live parent | **negative test**: the divergence is legal, but the inherited try is read-only — the child appends no `txn/confirm` or `txn/cancel` for it, evaluating around the bracket with mocked responses or terminating lazily at `eval_up_to_seq`. A cancel here is a data-plane incident, not a test failure only (01 §5.2, 02 §4.4) | O1, O2.no_inherited_mutation | T-B |
| S11c | fork evaluated at `fold_mode: reads-live` whose plan contains `logistics.book` (`irreversible`) and `logistics.quote` (`none`) | the quote **is** executed and priced into the returned plan; the booking is skipped and recorded as an unverified estimate. Ledger unchanged; evaluation budget charged for the quote only (05 §3.2) | O1, O2 | T-B |
| S12 | `duplicate_delivery` on `payment.charge` | exactly one charge in the ledger | O1 | T-B (Phase 2) |
| S13 | **information dependence**: the same `goal_prompt` scenario run twice, differing only in an injected fact — `inventory.check` returns 20 units in variant 1 and 0 units in variant 2 | the sub-DAGs frozen **after** the planner that consumes that fact must **differ** (variant 2 must source or substitute). Identical plans prove the graph was pre-baked rather than JIT, which the depth assertion alone cannot detect | O4.info_dependence | T-B, promoted to T-C |
| S14 | **clairvoyant parameters**: the scripted planner freezes a subgraph binding `carrier = "fast-co"` before any quote vertex has succeeded | rejected at freeze: every bound parameter must trace to an existing upstream vertex output or to `task_input`. A value that could not yet be known is a premature commitment, violating progressive disclosure even though depth is legal | O4.no_clairvoyance | T-B |

## 7. Oracles

Four independent classes. A run must satisfy all applicable oracles; a single violation fails the scenario regardless of the terminal status.

### O1 — World conservation (reads the ledger view)

| Assertion | Catches |
|---|---|
| `on_hand + Σ open_holds + Σ shipped == initial_total` for every SKU, at every quiescent point | oversell, phantom units |
| `Σ open_holds == 0` at `run/end` | frozen resources, missing cancel |
| **no hold amplification**: at every quiescent point, `Σ open_holds(sku) ≤ Σ demanded(sku)` over non-cancelled scopes | a replan boundary taken across an open `txn/try`, which duplicates a hold. The end-of-run assertion above cannot catch this: the orphan sweep eventually cancels the inherited try, so the run ends clean while a parallel order was starved for `try_timeout_s` |
| `count(charges by order_id) == 1` | double charging from retry or unknown outcome |
| `count(bookings by order_id) <= 1` | duplicate shipment |
| every ledger delta is attributable to exactly one `scope_id` | compensation that touched another scope's footprint |

### O2 — Log invariants (reads the event log)

| Assertion | Discipline |
|---|---|
| every `txn/try` has exactly one matching `txn/confirm` or `txn/cancel` | 02 §4.1 |
| no `txn/cancel` appears after `txn/pivot-passed` in the same scope | 15 |
| every `replan/boundary` sits at a succeeded planner outside all open brackets (**bracket condition**, 03 §2.1 (i)); offline forks are exempt (01 §5.2) | 16 |
| no `replan/boundary` precedes the most recent `txn/pivot-passed` (**floor condition**, 03 §2.1 (ii)); forks are likewise exempt | 15 |
| **witness completeness**: every ancestor planner of the failed vertex, enumerated by `parent_refs` traversal, appears in the `replan/boundary` candidate list with either a published cost or a closed-vocabulary rejection reason | 03 §4.2 |
| **witness minimality**: the selected boundary has the lowest **published** cost among candidates not marked rejected; the oracle never recalculates the cost | 03 §4.2 |
| **witness honesty**: each rejection reason is factually true of the log — `open_bracket` requires an unmatched `txn/try` before that vertex, `below_floor` requires a later `txn/pivot-passed`, `savepoint_precedes` requires the cancelled scope's savepoint to precede the candidate | 03 §4.2 |
| **no online fork**: an online replan appends `replan/boundary` in the same stream; `fork/created` appears only for offline evaluation (01 §5) | 1, 2 |
| **no inherited mutation**: a fork appends no `txn/*` event referencing an inherited scope — one whose `txn/try` is a copy from the source stream | 02 §4.4 |
| **causal inheritance**: a fork inherits no causal descendant (via `parent_refs`) of its divergence vertex, and every merged event is causally independent of it | 01 §5.2 |
| a fork evaluation invokes no tool above its declared `fold_mode`, and never a write | 01 §5.4, discipline 7e |
| a no-substitution fork reproduces the source surface exactly | discipline 7d |
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
| L1 → L3 | 03 §3 | The same planner has failed `N` consecutive replans (default 2). L2 is reached by structural infeasibility of the replan boundary, and a failure count does not make a legal boundary illegal, so L2 is not on this path. |
| L1 or L2 → L3 / L4 | 03 §4 | Budget preflight estimates the replan above the remaining balance. Attempting a predictably unaffordable replan only burns budget and leaves less for rollback. |

- every escalation and every skip is preceded by **evidence in the log** that the intermediate levels were infeasible — retries exhausted, no legal replan boundary, consecutive-failure counter at `N`, `txn/pivot-passed`, or a failed budget preflight. This bullet is the load-bearing one: it forbids the engine from skipping levels for reasons the harness has to infer.

### O4 — JIT and purity properties

Structural assertions alone are **necessary but not sufficient**: an engine whose first planner emits a shallow-but-complete graph covering every step satisfies a depth bound while deferring no decision at all. That is pre-baked planning wearing a JIT costume, so the first two assertions below carry most of the weight.

| Assertion | Why |
|---|---|
| **information dependence**: for a scenario pair differing only in an injected fact, the subgraphs frozen after the planner consuming that fact must differ (S13) | the only assertion that distinguishes genuine JIT from a pre-baked shallow graph. It tests that planning *consumed* runtime information, not merely that it was chunked |
| **no clairvoyant parameters**: every parameter bound at freeze traces to an existing upstream vertex output or to `task_input` (S14) | a planner binding a value it cannot yet know has committed prematurely, violating progressive disclosure while satisfying every depth bound |
| every `subgraph/frozen` has depth ≤ K (default 3) | chunking is present — necessary, and weak on its own |
| the run contains ≥ 2 planner vertices whenever the goal requires a decision point | the DAG grew incrementally |
| every frozen subgraph passed check-rules; no freeze without a preceding admission | discipline 14 |
| identical `hash(log_prefix)` + `projector_version` + `harness_state_version` ⇒ identical prompt hash; changing any one of the three must change it | disciplines 8, 11, 24 |
| replaying a recorded run reproduces the log event-for-event, timestamps ignored | discipline 28 |
| `linearize` output **and every semantic-fold view** are unchanged when parallel branch completion order is permuted | discipline 10; [01 §3.3](./01-jit-dag-and-event-log.md) inv. 3 |

The permutation assertion deserves emphasis: the harness runs selected scenarios twice with **deliberately permuted branch scheduling** and asserts an identical prompt hash *and* identical fold views. Scheduling jitter silently destroying replay determinism and prompt-cache hit rate is exactly the bug class that no ordinary test catches.

It is also the only assertion that tests **reducer commutativity over concurrent events**. Serializing appends fixes storage order but not scheduling order, so two concurrent siblings may receive `stream_seq` in either order across replays. A reducer that is order-sensitive over events with no `parent_refs` path between them breaks projection purity even with a perfect sequence ([01 §3.3](./01-jit-dag-and-event-log.md) inv. 3).

### O5 — Cost-model fidelity (reads the log plus the recorded tool view)

The boundary-selection cost model ([03 §4.1](./03-replan-and-recovery.md)) prices candidates in currency, and [03 §4.2](./03-replan-and-recovery.md) requires the engine to publish `estimated_cost`. Nothing in O1–O4 checks whether those prices resemble reality, which would leave `expected_plan_tokens` an unexamined guess forever.

| Assertion | Why |
|---|---|
| for every completed replan, `|estimated_cost − actual_cost| ÷ actual_cost ≤ 1.0` (within 2×) | actual cost is measured from `budget/charged` plus registered tool prices. A wildly miscalibrated estimate makes the budget preflight (03 §4) meaningless, since it gates L3 and L4 |
| estimation error has no systematic sign across a scenario suite | a consistently optimistic estimator turns the preflight into a rubber stamp; a pessimistic one starves affordable replans |
| **detour cost** per resolved episode: path length from first failure to final success, minus the retrospectively shortest path | quantifies what greedy's cheap-but-repeated attempts actually cost. Far more informative than replan rate, and it is the metric S3c oscillation shows up in |

Estimation error is recorded per replan so it can be projected over history, which is what turns `expected_plan_tokens` from a heuristic into a learned quantity (03 §4.1).

## 8. Offline Historical Policy Evaluation

O1–O5 validate **mechanism**: given a policy, was it executed correctly. They cannot answer whether the policy is suitable for a particular historical case. Greedy backtracking and JIT planning can be examined without production writes because the log makes paired counterfactuals possible.

### 8.1 Case study: would wider have helped this failure?

**wider** is the L2 strategy used deliberately: rather than the nearest legal boundary, select an earlier ancestor planner and replan a larger scope.

Method. Select an explicit historical failure episode identified by `(run_id, stream_seq)`. From that same point, run two **counterfactual evaluations** ([05 §3](./05-context-aggregation-and-offline-evaluation.md)): one substituting the pin that forces the nearest legal boundary, one forcing an earlier boundary. `fold_mode: reads-live`, so the model is called fresh and `effect_class: none` tools are actually called while writes are skipped.

What an evaluation can compare: model cost actually charged, plan size, real quoted tool prices, the check-rules verdict, an LLM-judge score, and — the sharpest cheap signal — whether the new plan **reuses a `(tool, parameter pattern)` already recorded as disproven**. That last one is the best available proxy for "this would fail again", and it needs no writes.

Two limits must be reported alongside any result, and neither is a detail.

**The comparison is asymmetric.** The greedy side's cost is *measured* — it actually happened, so `budget/charged` plus tool prices give the real number — while the wider side's cost is *estimated* and its success is *assumed*. The honest conclusion is "wider would probably have been cheaper on this episode", never a proof.

**The conclusion is case-specific.** The two forks share one source history, and a different business run is not a parallel sample ([05 §3.4](./05-context-aggregation-and-offline-evaluation.md), discipline 7f). The report states whether wider appears preferable for this episode, which writes remain unverified, and why the result may not transfer.

**Denominator: cost per resolved episode, never per replan attempt.** Greedy's failure mode is many cheap attempts, so per-attempt pricing structurally favours it and inverts the conclusion. Pair this with O5's detour-cost metric.

The winner is unlikely to be global. Failures whose true cause lies inside the nearest planner's remit — payload format, validation — may favour greedy, while failures that invalidate an upstream premise — supplier out of stock, warehouse unavailable — may favour wider. A recurring pattern may motivate a **candidate routing rule keyed on `error_class`**, but every supporting case and limitation remains attached. The rule becomes a `policy_hint` only after operator review and carries `evidence_seqs` back to the histories that motivated it (04 §2).

### 8.2 Case study: would up-front planning have helped this task?

S13 proves planning *is* JIT; it does not show JIT helped a particular run. Fork a selected history before its first planning decision, substitute a planner pin that emits one complete graph, and compare it with the recorded JIT path. Report prompt and model cost, check-rule verdicts, plan size, runtime-information use, and unverified writes for that case. Repeating the procedure over a corpus produces a set of case reports, not a global ranking.

### 8.3 Corpus reporting

A corpus is a versioned list of explicit `(run_id, at_vertex_id, eval_up_to_seq)` tuples with documented inclusion criteria. Fold each source and fork independently, then publish the case table and descriptive groupings by task type, SKU-count bucket, pivot presence, and `error_class`. Never hide contradictory cases behind one aggregate number, and never use a corpus result as automatic production authorization.

## 9. Live-Model Qualification Tier (T-C)

T-C runs a live model only inside the sandbox against a fixed, versioned scenario corpus. It is still offline evaluation: no production traffic is divided, and no production write is executed. O1 and O2 remain **hard** assertions, while O3 and O4 may be reported as scenario-level distributions and additional quality metrics are recorded.

### 9.1 Metrics are log projections

Per discipline 23, no separate telemetry. Every metric below is a projection over the event log and the ledger, so a changed definition can be recomputed over history.

| Metric | Definition | Direction |
|---|---|---|
| task success rate | runs ending `run/end:success` | target |
| admissible-plan rate | `subgraph/frozen ÷ subgraph/proposed` | target |
| replan depth | mean highest ladder level reached | target |
| tokens per success | `Σ budget/charged ÷ successes` | target |
| **L4 suspension rate** | runs reaching human intervention | **guardrail** |
| **post-pivot failure rate** | failures after `txn/pivot-passed` | **guardrail** |
| **orphan-hold incidents** | O1 violations of any severity | **guardrail, zero tolerance** |

Per discipline 25, a guardrail failure vetoes an apparent target-metric improvement. A configuration that uses fewer tokens but violates an invariant or raises risk in a paired scenario is rejected.

### 9.2 Reporting and provenance

Per discipline 26, every result remains addressable by scenario and is grouped descriptively by task type, SKU-count bucket, and pivot presence. Aggregate-only comparisons are not reported because task heterogeneity spans orders of magnitude.

Every T-C fork records source scenario and position, substitutions, `fold_mode`, evaluator pin, `projector_version`, and `harness_state_version` (discipline 24). Scenario ID and fault seed are recorded alongside so every reported observation reduces to one reproducible source/fork pair.

## 10. Phased Rollout

| Phase | Delivery status | Scope | Exit criterion |
|---|---|---|---|
| **0** | Implemented | T-A table-driven R1-R11 checks, projection purity, event-store and fork replay tests; no sandbox or key | every R1-R11 code has an admitted baseline and an explicit violating fixture; projection and replay suites are green |
| **1** | Partial | Test-only in-process inventory, payment, logistics, and channel actors plus complex DAG and static barrier fixtures are delivered; scripted execution, fault injection, O1-O5, and the remaining scenario corpus are pending | all S1-S10 variants and partial S11 scenarios are green; the four mechanism questions in §1 are answered without an API key |
| **2** | Active | Sandbox promoted to an out-of-process service; Distributed Transaction Coordinator on real PostgreSQL | temporal barrier behavior, S11, and S12 are green; cross-language conformance fixtures pass (discipline 34) |
| **3** | Not started | Historical fork evaluation (§8): greedy versus wider and JIT versus up-front on a versioned corpus, at declared `fold_mode`s | complete case reports, explicit unverified writes, and any candidate rule linked to its supporting and contradicting evidence |
| **4** | Not started | T-C live-model sandbox qualification on the fixed scenario corpus | all hard oracles pass; scenario-level quality and cost evidence is published with complete fork provenance; an operator makes the production decision |

Phases 0 through 2 require no API key and no model access, which is the point: regression testing must not depend on a model provider (discipline 28). Phases 3 and 4 may need model calls and live reads but never writes, so policy evaluation remains isolated from production business effects.

## 11. Relation to Existing Work

- **dsh** treats a recorded session as both mock script and expected output. Flory inherits this as T-A replay testing and extends it: dsh replays model responses, whereas Flory must additionally replay a *world*, because its tool calls have irreversible effects that a log alone cannot reconstruct.
- **SagaLLM** validates plans with an independent validation agent. The harness deliberately does the opposite: §2.2 exists to prove the deterministic rule engine catches what a model reviewer would be trusted to catch, so that no test result ever depends on a model's self-discipline.
- Chaos-engineering practice contributes the fault taxonomy, but with one inversion: production chaos is random by design, whereas this injector is seeded and table-driven, because a transaction bug that cannot be reproduced cannot be fixed.

## 12. Open Questions

- **Forward-closure bound (resolved contradiction, new question).** [03 §2.2](./03-replan-and-recovery.md) step 2 now requires driving a post-pivot scope forward to closure rather than searching upward past the floor. Unresolved: how long forward closure may be attempted before the run is declared L4. Too short and a recoverable run is suspended for a human; too long and an unrecoverable run holds resources indefinitely. The harness currently asserts only that L4 is eventually reached, not when, so S10 cannot yet distinguish a correct bound from an arbitrary one.
- **L2 reachability.** As specified, L2 is reachable only through structural infeasibility of the replan boundary; consecutive replan failures route L1 directly to L3 (03 §3). Whether an intermediate count-based L1 → L2 step was intended is unresolved. The harness asserts the literal specification, so if the intent was different, S3 will fail and expose it — the desired outcome, but it should be a deliberate decision rather than a surprise.
- **Judge calibration.** §8.1 uses an LLM judge to score counterfactual plans. The judge is itself a model, so its `pin_version` belongs in fork provenance; whether judge drift can masquerade as a policy improvement is unexamined.
- **Scenario coverage measurement.** Rule and discipline coverage is currently tracked by hand in §6. A generated coverage report — which disciplines have no killing scenario — would be more honest.
- **Property-based scenario generation.** S1–S14 are hand-written. Randomly generated DAG shapes with generated fault schedules, checked against O1 and O2 only, would likely find the multi-replan shadowing boundary cases flagged as an open question in [01 §7](./01-jit-dag-and-event-log.md).
- **Sandbox fidelity ceiling.** A fake carrier that always answers `status` correctly is more cooperative than any real one. Deciding how much real-API pathology to simulate, and where simulating it stops teaching anything, is unresolved.
