# Replanning and Recovery (03)

> Status: Draft v0.1 | Depends on: [01](./01-jit-dag-and-vertex-log.md), [02](./02-transaction-model.md)

> Diagram: [diagrams/replan-flow.drawio](./diagrams/replan-flow.drawio), including the full flow and the L0–L4 escalation ladder.

## 1. Recovery Escalation Ladder

Failure handling is a strict ladder. Each level costs more than the preceding one, and escalation happens only when the current level is infeasible:

```
L0 idempotent retry       (within one vertex; retry_policy; approximately zero token cost)
L1 greedy replan          (backtrack to the nearest viable planner and regenerate a local subgraph)
L2 escalated replan       (backtrack to an earlier planner and replan a larger scope)
L3 rollback               (compensate to a transaction savepoint, then replan or terminate)
L4 suspend + human action (the only exit when post-pivot forward recovery cannot complete)
```

## 2. Greedy Replanning

### 2.1 Choosing the backtrack target

From a failed vertex, follow `parent_refs` to the **nearest ancestor planner** that is a legal fork boundary: it has succeeded and lies outside an open transaction bracket (see [01 §5](./01-jit-dag-and-vertex-log.md)). The nearest planner regenerates the smallest subgraph and reconstructs the least context, minimizing token cost.

If that planner is illegal because its subgraph has open tries:

1. Attempt to **close** the transaction scope by cancelling it (see §3), making the boundary legal.
2. If cancellation is impossible because the pivot has passed, search upward for an earlier planner before the scope savepoint. This is an L2/L3 composite escalation.

### 2.2 Replan flow

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

### 2.3 Three hard rules for replanning and transactions

1. **Cancel before fork.** A fork never crosses an active `try`; compensation precedes backtracking.
2. **The pivot is a one-way gate.** After `txn/pivot-passed`, failure may not backtrack to a planner before that pivot. It may only retry the suffix (L0) or reach human intervention (L4). R1 guarantees that every forward-path node is safely idempotent.
3. **Shadowing does not delete.** A replan-rejected subtree remains in the log for auditability and as evidence that prevents repeating the same failed approach.

## 3. Rollback (L3)

- Trigger when any of the following occurs: token budget is exhausted (§4); the same planner fails N replans in succession (default `N = 2`, preventing oscillation); or repeated check-rule rejection produces no legal plan.
- Execute Saga compensation or TCC cancel in reverse dependency order and return to the nearest transaction savepoint. Work before the savepoint is retained.
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
| `session fork(boundary_seq)` | Run fork at a succeeded planner `seq`. |
| Reject fork in an open turn. | Reject fork in an open transaction bracket. |
| `session/end-seed` | `run/end-seed`, the orphan-try detection anchor. |
| Replay is a pure-function fold. | Replay recalculates surface plus linearization. |
| Fork does not handle external effects. | Cancel-before-fork explicitly handles side effects. |

## 6. Open Questions

- Detecting replan oscillation across different planners; the current counter tracks only one planner.
- Expressing negative failure evidence so planners do not recreate isomorphic subgraphs. A candidate is to inject disproven `(tool, parameter pattern)` pairs as check-rule constraints rather than mere prompts.
- Merging concurrent failures in parallel branches when both compete to fork at the same ancestor planner: serialize by first arrival and make the later failure wait for the new surface.
