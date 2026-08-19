# Replanning and Recovery (03)

> Status: Draft v0.1 | Depends on: [01](./01-jit-dag-and-vertex-log.md), [02](./02-transaction-model.md)

> Diagram: [diagrams/replan-flow.drawio](./diagrams/replan-flow.drawio), including the full flow and the L0–L4 escalation ladder.

## 1. Recovery Escalation Ladder

Failure handling is a strict ladder. Each level costs more than the preceding one, and escalation happens only when the current level is infeasible:

```
L0 idempotent retry       (within one vertex; retry_policy; approximately zero token cost)
L1 greedy replan          (regenerate in place at the nearest legal boundary)
L2 escalated replan       (regenerate in place at an earlier legal boundary, replanning a larger scope)
L3 rollback               (compensate to a transaction savepoint, then replan or terminate)
L4 suspend + human action (the only exit when post-pivot forward recovery cannot complete)
```

## 2. Greedy Replanning

### 2.1 Legal replan boundaries and the backtrack floor

Replanning happens **in place, in the same run**: the failed subtree is shadowed and the chosen planner is called again ([01 §5.1](./01-jit-dag-and-vertex-log.md)). Selecting *where* to resume planning is therefore a choice of boundary, not the creation of a branch. The same boundary rules also govern dry-run forks ([01 §5.2](./01-jit-dag-and-vertex-log.md)), so they are stated once here.

A **legal replan boundary** is a succeeded planner vertex satisfying both conditions:

- **(i) bracket condition** — it lies outside every open transaction bracket;
- **(ii) floor condition** — it lies at or after the most recent `txn/pivot-passed` in the run.

Condition (ii) is the **backtrack floor**. It is a *planning-authority* floor, not a world-state floor, and the distinction is easy to get wrong. Replanning undoes nothing in the external world, so resuming below the floor would not un-charge a payment. The hazard is subtler: a planner below the floor is handed a context in which the irreversible action has not yet happened, so "issue that action" is still a live premise. It can legally propose a subgraph containing a second `payment.charge`, and check-rules will admit it — R3 bounds pivots *within one scope* and cannot see that this pivot already executed elsewhere. The floor exists to keep the planner out of that position.

L1 and L2 differ only in how far above the floor the boundary lands. L3 lowers the *world* to a savepoint (§3) but never lowers the floor; savepoints sit after every preceding pivot ([02 §4.1](./02-transaction-model.md)), so the two floors coincide rather than conflict.

### 2.2 Choosing the backtrack target

From a failed vertex, follow `parent_refs` to the **nearest ancestor planner** that is a legal replan boundary. The nearest legal planner regenerates the smallest subgraph and reconstructs the least context, minimizing cost (§4.1).

If the nearest ancestor planner fails condition (i) because its subgraph has open tries:

1. If the scope's pivot has **not** passed, **close the bracket by cancelling the scope** (see §3). Cancellation returns the world to the scope savepoint and closes the bracket, after which boundaries at or after the savepoint satisfy both conditions. This stays L1 when the newly legal boundary is still the nearest planner, and becomes L2 when the savepoint precedes it and an earlier planner must be used.
2. If the scope's pivot **has** passed, cancellation is impossible and backtracking may not be used to make the boundary legal — searching further back would cross the floor. Drive the scope **forward** to closure instead: idempotently retry its post-pivot successors (L0), which R1 guarantees are safe to retry. Once the bracket closes, the nearest planner at or after `txn/pivot-passed` becomes legal and normal replanning resumes. If forward closure cannot succeed, the only exit is **L4**.

### 2.3 Replan flow

```
vertex/failed (retries exhausted)
  → select backtrack planner P*                          (§4.1 cost model)
  → cancel-before-replan: cancel every open txn/try between P* and the failure
  → replan/boundary {boundary_seq = P* succeeded seq, reason, cancelled_scopes}
  → subgraph/shadowed marks the failed subtree            (same run; nothing is deleted)
  → call P* again with linearize() and structured failure evidence
  → propose new sub-DAG → check-rules → freeze and execute
```

Every step appends to the **same run**. No child run is created and no prefix is copied; `run_id` is stable for the life of the business task ([01 §5.1](./01-jit-dag-and-vertex-log.md)).

Failure evidence is a structured section rather than a raw log dump:

```
{failed_vertex, tool, error_class, attempts, cancelled_scopes, budget_remaining}
```

This controls replan input cost and clearly identifies paths already disproven.

### 2.4 Three hard rules for replanning and transactions

1. **Cancel before replan.** Planning never resumes across an active `try`; compensation precedes backtracking. The rule applies identically to a dry-run fork boundary, with one inversion: a dry-run child must never cancel an inherited try, because that hold belongs to the live parent ([01 §5.2](./01-jit-dag-and-vertex-log.md)). Live runs cancel to make a boundary legal; dry runs must instead refuse the boundary.
2. **The pivot is a one-way gate.** Once `txn/pivot-passed` is appended, that seq becomes the backtrack floor (§2.1): no replan boundary may be selected below it, for the remainder of the run. Within the pivot's own scope, a subsequent failure may only retry the suffix idempotently (L0) or reach human intervention (L4). The prohibition is on *planner position*, not on business action — a refund issued from a boundary above the floor is a new forward action and is permitted ([02 §3.3](./02-transaction-model.md)). R1 guarantees that every forward-path node is safely idempotent.
3. **Shadowing does not delete.** A replan-rejected subtree remains in the log for auditability and as evidence that prevents repeating the same failed approach.

## 3. Rollback (L3)

- Trigger when any of the following occurs: token budget is exhausted (§4); the same planner fails N replans in succession (default `N = 2`, preventing oscillation); or repeated check-rule rejection produces no legal plan.
- Execute Saga compensation or TCC cancel in reverse dependency order and return to the nearest transaction savepoint. Work before the savepoint is retained — including every previously committed pivot, since a savepoint by construction lies after all of them ([02 §4.1](./02-transaction-model.md)). Rollback therefore never lowers the backtrack floor (§2.1); it lowers only the world state, and only as far as the current scope's entry.
- At the savepoint, make one terminal replan with accumulated failure evidence if budget permits. Otherwise, end the run as failed and generate a human-readable postmortem from the log projection.

## 4. Token-Budget Accounting

- Each run carries `{plan_tokens, replan_tokens, total_cost}`. Every model call appends a `budget/charged` event, and the projection yields the remaining balance.
- Perform a budget preflight before replanning. Estimate the target planner's linearized context plus expected output; if the estimate exceeds remaining budget, go directly to L3 or L4 rather than attempting a predictably unaffordable replan.

### 4.1 Boundary selection cost model

Candidate boundaries are priced directly in currency, and greedy replanning selects the legal boundary with the lowest cost:

```
cost(P) = context_cost(P) + rework_cost(P) + compensation_cost(P) × risk_premium
```

| Term | Definition | Determinacy |
|---|---|---|
| `context_cost(P)` | `input_token_price × uncached_tokens(linearize(P))` | **Exact.** `linearize` is pure and needs no model call, so its length is computed, not estimated. Count *uncached* tokens only: a stable prefix is usually already in the provider's prompt cache ([05 §2.4](./05-context-aggregation-and-experimentation.md)). |
| `rework_cost(P)` | `output_token_price × expected_plan_tokens(P)` plus the registered call price of every tool node discarded between `P` and the failure | **Mixed.** Tool prices come from the tool registry; `expected_plan_tokens` is the one genuine heuristic. Start with the size of the shadowed subtree as its proxy, then learn it from log projections of what past replans at the same backtrack depth actually cost. |
| `compensation_cost(P)` | Sum of registered compensation prices for every open scope between `P` and the failure | **Computable** from the log plus tool-registration metadata: count open `txn/try` brackets and sum their declared cancel costs. |
| `risk_premium` | A scalar `≥ 1` applied to compensation only | **Policy.** The only real weight in the model. Compensation touches the external world, and a failed cancel is worse than an equal amount of wasted tokens, so this encodes risk aversion rather than price. |

Two properties matter more than the exact numbers.

**Everything is one unit — money.** Earlier drafts wrote `score(P) = α · linearize_len + β · expected_subgraph_size + γ · cancel_cost`, where the coefficients were doing nothing but converting tokens, node counts, and compensation actions into a common unit, since adding those quantities directly is dimensionally meaningless. Pricing each term in currency removes the coefficients, and it makes the output reviewable: "this replan is estimated at ¥0.8" can be sanity-checked by a human, while "score = 1200" cannot.

**The two leading terms pull in opposite directions**, which is why a formula is needed rather than the rule "pick the nearest." Backtracking further gives a *shorter* context to feed the planner (fewer ancestors), lowering `context_cost`, but discards *more* completed work, raising `rework_cost`, and crosses more transaction boundaries, raising `compensation_cost`. Greedy usually wins because the second and third terms dominate: re-running six tool calls and releasing a real inventory hold costs far more than a few thousand extra input tokens, most of which are cache hits.

The model prices *attempts*, not correctness. If a failure's true cause invalidates the nearest planner's premise, that planner stays the cheapest candidate and keeps failing; the consecutive-failure counter in §3 is what removes it from the candidate set. Cost decides efficiency, the ladder decides correctness — the same division of labour as check-rules versus refine in [02](./02-transaction-model.md).

### 4.2 The engine must publish its candidate set

`replan/boundary` records the whole decision, not just its outcome:

```jsonc
{
  "boundary_seq": 418,
  "candidates": [
    { "planner": "v-p3", "cost": 0.95, "currency": "CNY", "rejected": "open_bracket" },
    { "planner": "v-p2", "cost": 1.70, "currency": "CNY" },
    { "planner": "v-p1", "cost": 4.42, "currency": "CNY" }
  ],
  "selected": "v-p2",
  "estimated_cost": 1.70
}
```

Rejection reasons come from a closed vocabulary: `open_bracket`, `below_floor`, `savepoint_precedes`, `budget_exceeded`, `failure_counter_exhausted`.

Every considered candidate carries its computed cost, whether it is selectable or rejected. This exists for verifiability. A harness cannot check "did the engine pick the right boundary" by recomputing the answer, because legality and cost *are* the policy, so a second implementation would both duplicate the policy and — worse — is likely to repeat the original author's misunderstanding, producing a green test over a wrong engine. Publishing the candidate set converts the problem from *generating* an answer into *checking* one: the harness enumerates ancestor planners by pure `parent_refs` traversal (topology, not policy), then asserts completeness, minimality among non-rejected candidates using the published costs, and that each cited rejection reason is factually true of the log. See [06 §7](./06-validation-harness.md) oracle O2 for the three assertions, and O5 for comparing `estimated_cost` against what the replan actually cost.

## 5. Mapping to dsh Replay

dsh unifies resume, fork, and replay into one primitive because a session is a cheap local object. Flory **splits** them, because a run is a business process whose identity must stay intact ([01 §5](./01-jit-dag-and-vertex-log.md)).

| dsh | Flory |
|---|---|
| `session fork(boundary_seq)` for continuing work | **In-place replan**: `replan/boundary` + `subgraph/shadowed`, same `run_id`, no prefix copy (§2.3). |
| `session fork(boundary_seq)` for branching | **Dry-run fork only**: offline counterfactuals, replay tests, operator what-ifs; never executes writes ([01 §5.2](./01-jit-dag-and-vertex-log.md)). |
| Reject fork in an open turn. | Reject a boundary in an open transaction bracket, or below the backtrack floor (§2.1). |
| Resume equals fork. | **Resume is not a fork**: crash recovery re-projects the same log. |
| `session/end-seed` marks an inherited prefix. | `run/end-seed` marks a dry-run child's inherited, read-only prefix. Live-run orphan-try detection uses timeouts and unmatched brackets instead ([02 §4.4](./02-transaction-model.md)). |
| Replay is a pure-function fold. | Replay recalculates surface plus linearization. |
| Fork does not handle external effects. | Cancel-before-replan explicitly handles side effects; dry-run forks are barred from touching them at all. |

## 6. Open Questions

- **Oscillation across planners.** The consecutive-failure counter in §3 is per planner, so two planners that alternate failing never trip it and the run loops until the budget dies. The fix is an **episode-level** replan cap independent of which planner was targeted, with the detour-cost metric as its detector. The cap's value is not to be guessed: [ADR-003](./adr/adr-003-formal-verification-of-the-transaction-protocol.md) derives it from the shortest non-terminating cycle found while checking liveness property L2. Scenario S3c exists to fail until that bound lands ([06 §6](./06-validation-harness.md)).
- Expressing negative failure evidence so planners do not recreate isomorphic subgraphs. A candidate is to inject disproven `(tool, parameter pattern)` pairs as check-rule constraints rather than mere prompts.
- Merging concurrent failures in parallel branches when both compete for the same ancestor planner as a boundary: serialize by first arrival and make the later failure wait for the new surface.
- How long forward closure (§2.2 step 2) may be attempted on a post-pivot scope before the run is declared L4. Too short suspends a recoverable run for a human; too long holds resources indefinitely. The validation harness currently asserts only that L4 is eventually reached, not when ([06 §12](./06-validation-harness.md)).
- Whether L2 should also be reachable by a failure count rather than only by structural infeasibility of the replan boundary. As specified, consecutive replan failures route L1 directly to L3 (§3), because a count does not make a legal boundary illegal.
