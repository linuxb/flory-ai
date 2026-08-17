# Transaction Model: TCC and Pivot-Saga (02)

> Status: Draft v0.1 | Depends on: [01-jit-dag-and-vertex-log](./01-jit-dag-and-vertex-log.md)

## 1. Why Two Transaction Modes Are Needed

E-commerce side effects fall into the three effect classes adopted from Atomix:

| Effect class   | Definition                                                                | E-commerce examples                                                            | Handling                                       |
| -------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------- |
| `bufferable`   | Can be buffered and released only on commit.                              | Draft listings, notifications                                                  | Buffer until confirm.                          |
| `reversible`   | Takes effect but can be undone through compensation or an inverse action. | Inventory reservation, temporary price changes                                 | TCC cancel or Saga compensation.               |
| `irreversible` | Cannot be undone once performed.                                          | Committed inventory decrement and picking, logistics booking, external payment | May only be a pivot; recovery is forward-only. |

- **TCC** (try-confirm-cancel) fits resource reservation: `try` reserves inventory, `confirm` commits it, and `cancel` releases it. The tool must provide all three operations.
- **Saga compensation** fits operations with a forward action and a compensation action but no reservation semantics.
- **Pivot-saga** is the skeleton: `compensable prefix (TCC try / Saga steps) → pivot (irreversible point) → idempotent-retry suffix (forward recovery only)`.

## 2. Node Transaction Attributes

Each tool-caller vertex includes the following `vertex/created` payload:

```jsonc
{
  "txn": {
    "scope_id": "txn-7f3a",
    "effect_class": "reversible",
    "mode": "tcc",
    "is_pivot": false,
    "compensable": true,
    "compensate_tool": "inventory.release",
    "idempotent_retryable": true,
    "idempotency_key": "order:{order_id}:reserve",
    "retry_policy": { "max": 3, "backoff": "exp" },
    "try_timeout_s": 300
  }
}
```

These attributes come from tool-registration metadata. Each tool statically declares its effect class, TCC interfaces, compensation tool, and idempotency-key convention. A planner may reference those declarations, but may not invent attributes. This makes the two-layer design of planner declaration plus rule-engine validation credible.

## 3. Two-Layer Transaction Boundaries

### 3.1 Planner declaration

A sub-DAG proposal declares `txn/scope`: member vertices, pivot, and scope savepoint. The planner prompt contains a summary of tool metadata so it can make informed choices; for example, inventory lookup and comparison are read-only and outside the scope, while inventory reservation through logistics booking form a scope whose booking is the pivot.

### 3.2 Deterministic check-rules

The rules run before a DAG is frozen. **Any violation produces `subgraph/rejected` with details, and the planner must regenerate.**

| #   | Rule                                                                                                                                                                                               | Reason                                                                                                                                                           |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Every reachable in-scope successor after a pivot must be `idempotent_retryable = true`.                                                                                                            | Guards against **transient failure**: forward recovery advances by retrying, so retries must not duplicate side effects.                                         |
| R2  | Every in-scope node before a pivot must be compensable or use TCC.                                                                                                                                 | Any pre-pivot failure must be able to return to the savepoint.                                                                                                   |
| R3  | Each scope has at most one pivot — counted across sequential successors *and* parallel branches. Multiple irreversible operations require nested or sequential scopes with independent savepoints. | Guards against **permanent failure**: a savepoint must exist between any two irreversible points. Parallel twin pivots are invisible to R1's reachability check. |
| R4  | Every compensation chain is complete: `compensate_tool` is registered and itself idempotent.                                                                                                       | Failed compensation can be retried.                                                                                                                              |
| R5  | Parallel branches may not contain independent pivots before their join without a confirmation barrier.                                                                                             | Prevents one branch passing a pivot while the other must roll back.                                                                                              |
| R6  | Each `txn/try` has reachable confirm and cancel exits and declares `try_timeout_s`.                                                                                                                | Prevents permanently frozen resources.                                                                                                                           |
| R7  | Cross-scope dependencies may read only outputs of confirmed vertices.                                                                                                                              | Prevents dirty reads.                                                                                                                                            |
| R8  | A read-only (`effect_class = none`) node must not be a retry dependency that blocks post-pivot forward recovery.                                                                                   | Keeps recovery path safely retryable.                                                                                                                            |
| R9  | If parallel branches have intersecting resource write sets and either has a pivot, insert a pre-pivot barrier or serialize the branches.                                                           | Prevents a pivot in A from invalidating B's needed rollback.                                                                                                     |

`check(sub_dag_proposal, tool_registry) → pass | violations[]` is a pure function and can be exhaustively unit tested. R9 derives write sets from registered resource footprints, such as `inventory:{sku}`, after parameter binding.

> **Revision v0.2 (R1/R3 orthogonalization).** R1 originally also required `effect_class ≠ irreversible`, which overlapped with R3 in the sequential case: a pivot following a pivot violated both rules at once. The rules are now orthogonal. **R1 guards transient failure** — retry safety of post-pivot successors, a local reachability-based property check. **R3 guards permanent failure** — scope-level pivot cardinality and savepoint granularity, a global check that also covers parallel twin pivots, which R1 cannot express (no path exists between them). The repair actions differ too: an R1 violation means "make this node idempotent or move it out of the post-pivot region"; an R3 violation means "split the scope." Side effect of the tightening: irreversible-but-idempotent low-stakes nodes (e.g. notification send with a dedup key) are now legal after a pivot.

### 3.3 Why R3 permits at most one pivot

Two irreversible operations in one scope create a dead zone:

```
inventory reserve (try) → P1: supplier payment (irreversible) → picking order → P2: logistics booking (irreversible)
```

If P2 permanently fails after P1 succeeds, payment cannot be rolled back and forward recovery cannot complete the permanently failing P2. The run is stuck in a half-committed state: paid but unshippable.

Split it into two scopes instead:

```
Scope A: inventory reserve (try) → P1 payment
         savepoint S1 = "paid, inventory confirmed"
Scope B: create picking order (compensable) → P2 logistics booking
```

On P2 failure, compensate Scope B back to S1. The planner then has authority at a coherent savepoint: it can choose another carrier, another warehouse, or a refund workflow. A refund is a new forward business action, not transaction rollback. The single-pivot rule guarantees a planner-usable savepoint between irreversible actions.

See page 1 of [diagrams/txn-boundary.drawio](./diagrams/txn-boundary.drawio).

## 4. Runtime Protocol

### 4.1 Event brackets

Runtime transaction state is expressed entirely by log brackets:

```
txn/scope {scope_id, member_vertices, pivot_vertex, savepoint}
  txn/try {scope_id, vertex_id, idempotency_key}
  ... all tries close ...
  txn/pivot-passed {scope_id, pivot_vertex}
  txn/confirm {scope_id, vertex_id} ...
txn/(committed | cancelled) {scope_id}
```

The pivot admission condition is that every preceding try has closed successfully and has not timed out. This is a practical simplification of Atomix's frontier-confirmation idea: the pivot is Flory's commit point.

### 4.2 Failure matrix

| Failure location                            | Handling                                                                                                                                                         |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Before pivot; retry can resolve it          | Append `vertex/retried` and retry idempotently.                                                                                                                  |
| Before pivot; retries exhausted             | Cancel all tried members, return the scope to its savepoint, and replan.                                                                                         |
| Pivot execution failed with unknown outcome | Reconcile using the pivot's required status-query interface. Treat confirmed absence as pre-pivot and confirmed success as post-pivot.                           |
| After pivot                                 | Forward recovery only: retry suffix nodes idempotently; if this cannot succeed, suspend and require human intervention. Never automatically compensate backward. |

### 4.3 Parallel branches and shared resources — worked example

Setup: shared resource `inventory:SKU-123`. Branch A (flash-sale order): `A1 reserve 80 (try) → A2 ship (PIVOT)`. Branch B (wholesale hold): `B1 reserve 50 (try) → B2 confirm`. Both write `inventory:SKU-123` and run in parallel. Four defense lines make the state "A passed pivot while B still needs rollback" unreachable; each one kills a distinct accident:

| #   | Defense                                                                                                 | Accident it kills                                                                                                                                                                                                                                          | Concrete trace                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Resource isolation** — a try is a real hold; `available = on_hand − Σ holds`                          | Oversell: both branches believe stock suffices.                                                                                                                                                                                                            | `on_hand = 100`. A1 holds 80 → avail 20. B1 needs 50 > 20 → **B1 fails at try, pre-pivot**, and B replans (20 units, or another warehouse). Without real holds both "reserve" against 100, and 130 units are sold from 100 — discovered only after A has shipped.                                                                                                                              |
| D2  | **Delta-based compensation** — cancel releases only its own increment, never restores an absolute value | A committed change trampled by B's compensation. Trivial for hold-type resources (a hold release cannot touch A's units); the rule's real target is **value-type resources** such as price or listing state, whose naive compensation is snapshot-restore. | Independent scopes, `on_hand = 200`. A1 hold 80, B1 hold 50, A2 ships + confirms → `on_hand = 120`. B then fails: delta cancel releases B's 50 → consistent 120. A state-restoring cancel ("set stock back to the 200 I saw") would resurrect 80 phantom units; a price analogue ("restore 19.9") would trample A's committed 24.9. Tool registration validates compensations are delta-based. |
| D3  | **Static detection (R9)** at freeze time                                                                | A conflict-prone structure reaching runtime at all.                                                                                                                                                                                                        | `footprint(A1) ∩ footprint(B1) = {inventory:SKU-123} ≠ ∅` and branch A has a pivot → freeze is rejected unless a barrier is inserted or B is serialized after A. Branches with disjoint footprints (SKU-999) stay fully parallel at zero cost.                                                                                                                                                 |
| D4  | **Pivot barrier** at runtime                                                                            | Temporal race **within one scope**: A and B were declared to succeed or fail together, yet A's pivot fires while B's try is still unsealed.                                                                                                                | A2 ready → barrier asks "is B1 sealed?". Outcome 1: B1 seals → barrier opens, A2 fires, scope confirms. Outcome 2: B1 exhausts retries → scope cancel releases A's hold of 80, returns to the savepoint, and **A2 never fired**.                                                                                                                                                               |

Scope note — the main source of confusion in earlier drafts: D2's scenario has A and B in **independent scopes** (B's failure rolls back only B, so A proceeding is harmless); D4 applies when A and B share **one scope** (B's failure demands rolling back A too, which is exactly what the barrier makes safe). D1/D2 are resource-layer contracts validated at tool registration; D3/D4 are engine-layer structure enforced by check-rules and the executor. If a channel API cannot implement real holds (no D1), D3 degrades that branch to serialized execution as the fallback.

If an external system breaks isolation itself — e.g. an oversell makes physical stock lower than recorded holds — that is a reconciliation failure, not a transaction failure: Flory emits an L4 suspension plus a reconciliation task to the log.

See [diagrams/txn-boundary.drawio](./diagrams/txn-boundary.drawio): page 2 "Parallel pivot walkthrough" (this worked example with data).

### 4.4 Orphan try detection

During crash recovery or after a fork, scan the log for `txn/try` events inherited before `run/end-seed`, or events with no matching confirm/cancel after `try_timeout_s`. Treat them as orphans and append an idempotent `cancel`. This is why [01](./01-jit-dag-and-vertex-log.md) requires the end-seed marker.

## 5. Relation to Existing Work

- Compared with **SagaLLM**, Flory moves validation from an independent validation agent to deterministic pre-freeze check-rules. The model is never the safety backstop.
- Compared with **Atomix**, Flory does not track a general frontier per resource, which would require intercepting all reads and writes. Instead, it requires all pre-pivot tries to close: coarser but statically checkable and practical for JIT planning.
- Compared with classic Saga orchestrators such as Temporal, Flory's DAG is JIT-generated and its transaction boundaries are planner-declared but rule-admitted. This is Flory's key distinction.

## 6. Open Questions

- Parent/child savepoint semantics and partial-commit visibility for nested transaction scopes.
- A fallback for channel APIs that cannot reserve resources, such as locally recording a simulated try and delaying execution.
- The reconciliation fallback protocol when a pivot status-query interface is unavailable.
