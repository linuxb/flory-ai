# Replanning and Recovery (03)

> Status: Draft v0.1 | Depends on: [01](./01-jit-dag-and-vertex-log.md), [02](./02-transaction-model.md)

> Diagram: [diagrams/replan-flow.drawio](./diagrams/replan-flow.drawio), including the full flow and the L0–L4 escalation ladder.

## 1. Recovery Escalation Ladder

Failure handling is a strict ladder. Each level costs more than the preceding one, and escalation happens only when the current level is infeasible:

```
L0 idempotent retry       (within one vertex; retry_policy; approximately zero token cost)
L1 greedy replan          (fork at the nearest legal boundary and regenerate a local subgraph)
L2 escalated replan       (fork at an earlier legal boundary and replan a larger scope)
L3 rollback               (compensate to a transaction savepoint, then replan or terminate)
L4 suspend + human action (the only exit when post-pivot forward recovery cannot complete)
```

## 2. Greedy Replanning

### 2.1 Legal fork boundaries and the backtrack floor

A **legal fork boundary** is a succeeded planner vertex satisfying both conditions:

- **(i) bracket condition** — it lies outside every open transaction bracket (see [01 §5](./01-jit-dag-and-vertex-log.md));
- **(ii) floor condition** — it lies at or after the most recent `txn/pivot-passed` in the run.

Condition (ii) is the **backtrack floor**. It is a *planning-authority* floor, not a world-state floor, and the distinction is easy to get wrong. A fork undoes nothing in the external world (01 §5), so backtracking below the floor would not un-charge a payment. The hazard is subtler: a planner below the floor is handed a context in which the irreversible action has not yet happened, so "issue that action" is still a live premise. It can legally propose a subgraph containing a second `payment.charge`, and check-rules will admit it — R3 bounds pivots *within one scope* and cannot see that this pivot already executed elsewhere. The floor exists to keep the planner out of that position.

L1 and L2 differ only in how far above the floor the boundary lands. L3 lowers the *world* to a savepoint (§3) but never lowers the floor; savepoints sit after every preceding pivot ([02 §4.1](./02-transaction-model.md)), so the two floors coincide rather than conflict.

### 2.2 Choosing the backtrack target

From a failed vertex, follow `parent_refs` to the **nearest ancestor planner** that is a legal fork boundary. The nearest legal planner regenerates the smallest subgraph and reconstructs the least context, minimizing token cost.

If the nearest ancestor planner fails condition (i) because its subgraph has open tries:

1. If the scope's pivot has **not** passed, **close the bracket by cancelling the scope** (see §3). Cancellation returns the world to the scope savepoint and closes the bracket, after which boundaries at or after the savepoint satisfy both conditions. This stays L1 when the newly legal boundary is still the nearest planner, and becomes L2 when the savepoint precedes it and an earlier planner must be used.
2. If the scope's pivot **has** passed, cancellation is impossible and backtracking may not be used to make the boundary legal — searching upward would cross the floor. Drive the scope **forward** to closure instead: idempotently retry its post-pivot successors (L0), which R1 guarantees are safe to retry. Once the bracket closes, the nearest planner at or after `txn/pivot-passed` becomes legal and normal replanning resumes. If forward closure cannot succeed, the only exit is **L4**.

### 2.3 Replan flow

```
vertex/failed (retries exhausted)
  → select backtrack planner P*
  → cancel-before-fork: cancel every open txn/try between P* and the failure
  → fork/created {boundary = P* succeeded seq}
  → subgraph/shadowed marks the failed subtree in the original run
  → call P* again with linearize() and structured failure evidence
  → propose new sub-DAG → check-rules → freeze and execute
```

Failure evidence is a structured section rather than a raw log dump:

```
{failed_vertex, tool, error_class, attempts, cancelled_scopes, budget_remaining}
```

This controls replan input cost and clearly identifies paths already disproven.

### 2.4 Three hard rules for replanning and transactions

1. **Cancel before fork.** A fork never crosses an active `try`; compensation precedes backtracking.
2. **The pivot is a one-way gate.** Once `txn/pivot-passed` is appended, that seq becomes the backtrack floor (§2.1): no fork boundary may be selected below it, for the remainder of the run. Within the pivot's own scope, a subsequent failure may only retry the suffix idempotently (L0) or reach human intervention (L4). The prohibition is on *planner position*, not on business action — a refund issued from a boundary above the floor is a new forward action and is permitted ([02 §3.3](./02-transaction-model.md)). R1 guarantees that every forward-path node is safely idempotent.
3. **Shadowing does not delete.** A replan-rejected subtree remains in the log for auditability and as evidence that prevents repeating the same failed approach.

## 3. Rollback (L3)

- Trigger when any of the following occurs: token budget is exhausted (§4); the same planner fails N replans in succession (default `N = 2`, preventing oscillation); or repeated check-rule rejection produces no legal plan.
- Execute Saga compensation or TCC cancel in reverse dependency order and return to the nearest transaction savepoint. Work before the savepoint is retained — including every previously committed pivot, since a savepoint by construction lies after all of them ([02 §4.1](./02-transaction-model.md)). Rollback therefore never lowers the backtrack floor (§2.1); it lowers only the world state, and only as far as the current scope's entry.
- At the savepoint, make one terminal replan with accumulated failure evidence if budget permits. Otherwise, end the run as failed and generate a human-readable postmortem from the log projection.

## 4. Token-Budget Accounting

- Each run carries `{plan_tokens, replan_tokens, total_cost}`. Every model call appends a `budget/charged` event, and the projection yields the remaining balance.
- Perform a budget preflight before replanning. Estimate the target planner's linearized context plus expected output; if the estimate exceeds remaining budget, go directly to L3 or L4 rather than attempting a predictably unaffordable replan.
- Start with the following heuristic cost model:

```
score(P) = α · linearize_len(P) + β · expected_subgraph_size(P) + γ · cancel_cost(P)
```

Greedy replanning selects the legal planner with the smallest score. Greedy failure followed by escalation is an annealing-like search with fully auditable steps.

## 5. Mapping to dsh Replay

| dsh | Flory |
|---|---|
| `session fork(boundary_seq)` | Run fork at a succeeded planner `seq` that is a legal fork boundary (§2.1). |
| Reject fork in an open turn. | Reject fork in an open transaction bracket, or below the backtrack floor (§2.1). |
| `session/end-seed` | `run/end-seed`, the orphan-try detection anchor. |
| Replay is a pure-function fold. | Replay recalculates surface plus linearization. |
| Fork does not handle external effects. | Cancel-before-fork explicitly handles side effects. |

## 6. Open Questions

- Detecting replan oscillation across different planners; the current counter tracks only one planner.
- Expressing negative failure evidence so planners do not recreate isomorphic subgraphs. A candidate is to inject disproven `(tool, parameter pattern)` pairs as check-rule constraints rather than mere prompts.
- Merging concurrent failures in parallel branches when both compete to fork at the same ancestor planner: serialize by first arrival and make the later failure wait for the new surface.
- How long forward closure (§2.2 step 2) may be attempted on a post-pivot scope before the run is declared L4. Too short suspends a recoverable run for a human; too long holds resources indefinitely. The validation harness currently asserts only that L4 is eventually reached, not when ([06 §11](./06-validation-harness.md)).
- Whether L2 should also be reachable by a failure count rather than only by structural infeasibility of the fork boundary. As specified, consecutive replan failures route L1 directly to L3 (§3), because a count does not make a legal boundary illegal.
