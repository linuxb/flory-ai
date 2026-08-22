# Transaction Model: TCC and Pivot-Saga (02)

> Status: Draft v0.1 | Depends on: [01-jit-dag-and-event-log](./01-jit-dag-and-event-log.md)

## 1. Why Two Transaction Modes Are Needed

E-commerce side effects fall into the three effect classes adopted from Atomix:

| Effect class   | Definition                                                                | E-commerce examples                                                            | Handling                                       |
| -------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------- |
| `bufferable`   | Can be buffered and released only on commit.                              | Draft listings, notifications                                                  | Buffer until confirm.                          |
| `reversible`   | Takes effect but can be undone through compensation or an inverse action. | Inventory reservation, temporary price changes                                 | TCC cancel or Saga compensation.               |
| `irreversible` | Cannot be undone once performed.                                          | Committed inventory decrement and picking, logistics booking, external payment | May only be a pivot; recovery is forward-only. |

- **TCC** (try-confirm-cancel) fits resource reservation: `try` reserves inventory, `confirm` commits it, and `cancel` releases it. The tool must provide all three operations.
- **Saga compensation** fits operations with a forward action and a compensation action but no reservation semantics.
- **Pivot-saga** is the skeleton: `undoable prefix (TCC try / Saga steps) → pivot (irreversible point) → idempotent-retry suffix (forward recovery only)`.

## 2. Node Transaction Attributes

Each tool-caller vertex includes the following `vertex/created` payload:

```jsonc
{
  "txn": {
    "scope_id": "txn-7f3a",
    "effect_class": "reversible",              // registry; the only side-effect label
    "mode": "tcc",                             // tcc | saga | plain
    "compensate_tool": "inventory.release",    // required when mode = saga
    "idempotent_retryable": true,
    "idempotency_key": "order:{order_id}:reserve",
    "retry_policy": { "max": 3, "backoff": "exp" },
    "try_timeout_s": 300,
    "footprint": ["inventory:SKU-123@{A,B}"]   // sound over-approximation, see §3.1
  }
}
```

All of it comes from tool-registration metadata. Each tool statically declares its effect class, TCC interfaces, compensation tool, idempotency-key convention, and resource footprint. A planner may reference those declarations but may never invent them.

### 2.1 Derived attributes are never declared

Two properties are **computed, not stated**:

```
is_pivot  ≡  effect_class = "irreversible"
undoable  ≡  mode = "tcc"  ∨  compensate_tool ≠ null
```

Earlier drafts carried `is_pivot` and `compensable` as independent payload fields alongside `effect_class`. That allowed three fields to disagree — a node could be declared `irreversible` and `is_pivot: false` at the same time — and it invited a whole class of confusion in which "non-compensable node" and "pivot" were discussed as if they were different things. **They are the same predicate**: an effect with no undo path is irreversible, and an irreversible effect may only be a pivot (§1).

Making them derived removes the disagreement by construction, which is stronger than adding a rule to detect it. The registry-time obligation that remains is: **a tool with no undo path must be registered `irreversible`.** Mislabelling there is a registry defect that no check-rule can catch, which is why registration itself is under test ([06 §3.3](./06-validation-harness.md)).

The three legal shapes of an undoable node are therefore:

| Shape | Attributes | Undo path |
|---|---|---|
| Reversible via TCC | `effect_class: reversible`, `mode: tcc` | `cancel`, part of the tool's triple |
| Reversible via Saga | `effect_class: reversible`, `mode: saga`, `compensate_tool` set | the registered compensation tool |
| Bufferable | `effect_class: bufferable` | never released; discard the buffer |

## 3. Three-Layer Transaction Boundaries

Boundary determination is split by *who can know what*. The planner's required knowledge is deliberately minimised: everything mechanically derivable is derived by the engine, so the planner cannot get it wrong.

### 3.1 Layer 1 — the engine computes the minimum scope

From `effect_class` and `footprint` alone:

> Every reversible node that precedes a pivot **and shares a footprint with it** must belong to that pivot's scope.

This is computed, never asked of the planner. In the example `reserve 3 units → set promo price → book carrier (pivot)`, the booking's footprint includes `inventory:SKU-123`, so the reservation is forced into the scope; the price change touches `price:SKU-123` only, so the minimum does not require it.

**Footprints need only be soundly over-approximated at freeze, not exactly resolved.** If the warehouse has not been chosen yet, `inventory:SKU-123@{A,B}` — the union of candidates — is a valid footprint. Over-approximation can only manufacture *false* conflicts, causing extra barriers or serialization; it can never miss a real one. For a safety rule that is the correct direction to err.

This matters because it dissolves an apparent conflict with progressive disclosure. A node's parameters may be **references to upstream vertex outputs** rather than literals ([01 §2.2](./01-jit-dag-and-event-log.md)), so `warehouse = ref(T1.output.best_warehouse)` freezes cleanly. The "no clairvoyant parameters" assertion ([06 §6](./06-validation-harness.md) S14) forbids *inventing* a value the planner cannot know; it does not forbid *referencing* a value that will exist. A query-then-reserve-then-book flow can therefore be one scope in one frozen subgraph.

The one case where splitting is genuinely forced is an **unenumerable resource identity** — "reserve whatever SKU the supplier recommends", where the candidate set cannot be listed at freeze. The over-approximation degenerates to the entire resource class, which serializes everything that touches it. Splitting is then a correctness-preserving throughput fix, not a rule requirement.

### 3.2 Layer 2 — the planner may widen, never narrow

The planner declares `txn/scope`: member vertices and the scope savepoint. The pivot is not declared, it is derived (§2.1).

**Widening** means declaring a scope larger than the computed minimum, and it is the planner's real contribution. Continuing the example: the business may require that a promotional price only take effect if the goods actually ship, so a booking failure must also revert the price. The engine cannot derive this — the two footprints are disjoint and technically unrelated. This is a **business atomicity** requirement, and its source must be `task_input` or a workflow policy. A planner inferring atomicity from general world knowledge is producing exactly the kind of unverifiable judgement this architecture exists to avoid; if that starts happening, the missing piece is the policy channel, not a better prompt.

Widening is not free: a wider scope has more to compensate on failure, and its R9 barrier suppresses more concurrency. It should be driven by an explicit requirement, never by a vague belief that including more nodes is safer.

**Narrowing** — declaring a scope smaller than the minimum — is always illegal, because it is how a planner would escape the rules by simply not declaring. Omit the reservation from the booking's scope and R2 no longer applies to it: R2 constrains "in-scope nodes before a pivot", and the node is now out of scope. A booking failure then cancels nothing, and three units stay held until `try_timeout_s` expires while other orders see reduced availability.

### 3.3 Layer 3 — the rules admit, and scopes may extend across freezes

A scope **may** gain members in a later freeze. This is not merely tolerated, it is necessary: when a scope's `txn/try` is still open, the point after it is not a savepoint ([§4.1](#41-event-brackets)), so a pivot that must be atomic with that reservation cannot be placed in a fresh scope — it has to join the existing one.

Extension is safe because of the shape the rules take:

| Rule shape | Incrementally decidable | Examples |
|---|---|---|
| **Prohibition** — X must not exist | **Yes.** Monotone: a violation appears at the moment of addition and cannot be repaired by later additions | R1, R2, R3, R7, R10 |
| **Obligation** — Y must exist | Not from graph structure alone | R6 (a try needs exits), R5/R9 (a barrier must be inserted) |

The obligations are nonetheless decidable at each freeze, because they are satisfied by **registry attributes rather than future vertices**: a try's cancel exit is `mode: tcc` or `compensate_tool`, not a planned node, and a barrier only has to precede the pivot, so it is inserted in whichever freeze introduces the pivot.

> **Meta-rule for rule authors.** New check-rules should be written in prohibition form. An obligation that can only be discharged by a vertex in some *later* subgraph would make incremental extension undecidable, and would force scopes to be planned in one shot — surrendering progressive disclosure for no invariant gain.

When extension is impossible, the remedy is not a dead end: if the scope has no open try, that point **is** a savepoint by definition, and the next pivot simply opens a new scope. This is the same mechanism R3 already prescribes for multiple irreversible operations (§3.5).

### 3.4 Deterministic check-rules

The rules run before a DAG is frozen. **Any violation produces a closed-vocabulary result that the future planner integration records as `subgraph/rejected`; the planner must regenerate rather than bypass the result.** The executable TypeScript implementation is `engine/src/check-rules.ts`. It accepts only a proposal and an immutable tool registry, performs no I/O, and returns `{accepted, violations}` with stable R1-R11 rule codes and implicated vertex IDs.

| # | Rule | Reason |
|---|---|---|
| R1 | Every reachable in-scope successor after a pivot must be `idempotent_retryable = true`. | Guards against **transient failure**: forward recovery advances by retrying, so retries must not duplicate side effects. |
| R2 | Every in-scope node before a pivot must be `undoable` (§2.1). | Any pre-pivot failure must be able to return to the savepoint. |
| R3 | Each scope has at most one pivot — counted across sequential successors *and* parallel branches. Multiple irreversible operations require nested or sequential scopes with independent savepoints. | Guards against **permanent failure**: a savepoint must exist between any two irreversible points. Parallel twin pivots are invisible to R1's reachability check. |
| R4 | Every compensation chain is complete: `compensate_tool` is registered and itself idempotent. | Failed compensation can be retried. |
| R5 | Parallel branches may not contain independent pivots before their join without a confirmation barrier. | Prevents one branch passing a pivot while the other must roll back. |
| R6 | Each `txn/try` has reachable confirm and cancel exits and declares `try_timeout_s`. | Prevents permanently frozen resources. |
| R7 | Cross-scope dependencies may read only outputs of confirmed vertices. | Prevents dirty reads. |
| R8 | A read-only (`effect_class = none`) node must not be a retry dependency that blocks post-pivot forward recovery. | Keeps recovery path safely retryable. |
| R9 | If parallel branches have intersecting resource write sets and either has a pivot, insert a pre-pivot barrier or serialize the branches. | Prevents a pivot in A from invalidating B's needed rollback. |
| R10 | Every node with `effect_class ≠ none` must belong to a declared scope. | Without it, every scope-level rule is escapable by not declaring: a bare `logistics.book` with no scope passes R1–R9 because each of them constrains *in-scope* nodes. |
| R11 | A declared scope must contain at least the engine-computed minimum for its pivot (§3.1). Wider is legal; narrower is rejected. | Closes the narrowing escape in §3.2. R10 forces membership to exist; R11 forces it to be sufficient. |

The current implementation boundary is deliberately split:

1. `ToolRegistry.validate()` enforces registration obligations R4 and R6 before proposal admission.
2. `checkSubDag(proposal, registry)` computes ancestry, descendants, scope membership, pivots, conflicting write footprints, and confirmation-barrier coverage, then enforces proposal rules R1-R3 and R5-R11.
3. The checker only admits or rejects structure. It does not append events, schedule a ready vertex, or open and close a transaction bracket; those runtime actions belong to the engine integration and Distributed Transaction Coordinator.

The test suite supplies one admitted proposal plus an explicit violating fixture for every rule. Test-only e-commerce fixtures additionally prove both sides of the barrier contract: parallel conflicting writes or independent pivots are rejected without a pre-pivot confirmation barrier and admitted when the barrier dominates the pivots. These are structural tests; the runtime guarantee that a barrier waits for every branch to seal still requires the coordinator.

### 3.5 Why R3 permits at most one pivot

Two irreversible operations in one scope create a dead zone:

```
inventory reserve (try) → P1: supplier payment (irreversible) → picking order → P2: logistics booking (irreversible)
```

If P2 permanently fails after P1 succeeds, payment cannot be rolled back and forward recovery cannot complete the permanently failing P2. The run is stuck in a half-committed state: paid but unshippable.

Split it into two scopes instead:

```
Scope A: inventory reserve (try) → P1 payment
Scope B: savepoint S1 (scope entry) = "paid, inventory confirmed"
         → create picking order (undoable) → P2 logistics booking
```

On P2 failure, compensate Scope B back to S1. The planner then has authority at a coherent savepoint: it can choose another carrier, another warehouse, or a refund workflow. A refund is a new forward business action, not transaction rollback. The single-pivot rule guarantees a planner-usable savepoint between irreversible actions.

See page 1 of [diagrams/txn-boundary.drawio](./diagrams/txn-boundary.drawio).

### 3.6 Rule-set revision history

| Revision | Change | Reason |
|---|---|---|
| v0.2 | **R1 narrowed.** It originally also required `effect_class ≠ irreversible`, overlapping R3 in the sequential case, so a pivot after a pivot violated both at once. R1 now guards **transient failure** only — retry safety of post-pivot successors, a local reachability check — while R3 guards **permanent failure** — scope-level pivot cardinality, which also covers parallel twin pivots that R1 cannot express because no path exists between them. Repairs differ too: R1 means "make the node idempotent or move it out of the post-pivot region", R3 means "split the scope". Side effect: irreversible-but-idempotent low-stakes nodes, such as a notification with a dedup key, are legal after a pivot. |
| v0.3 | **R10 and R11 added; `is_pivot` and `compensable` demoted to derived (§2.1).** R1–R9 are all *in-scope* constraints, so a planner could evade every one of them by declaring no scope, or a too-small one. R10 forces membership to exist and R11 forces it to be sufficient. |
| v0.3 | **Two proposed rules rejected before entry.** (a) *"A scope's members must all be contained in one frozen subgraph."* Rejected: pivot uniqueness is a monotone prohibition and is decidable incrementally, and forbidding extension would break the case in §3.3 where a pivot must join a scope whose try is still open. (b) *"A pivot-less scope may not contain a non-compensable node."* Rejected as incoherent: a node with no undo path *is* a pivot (§2.1), so the configuration it describes is unreachable once R10 exists. |

## 4. Runtime Protocol

### 4.1 Event brackets

Runtime transaction state is expressed entirely by log brackets. A successful try is **sealed and half-open**: the resource is reserved, but TCC confirm has not run.

```
txn/scope {scope_id, member_vertices, pivot_vertex, savepoint}
  txn/try {scope_id, vertex_id, idempotency_key}
  ... every required try becomes sealed ...
  txn/pivot-passed {scope_id, pivot_vertex}
  txn/confirm {scope_id, vertex_id} ...
txn/(committed | cancelled) {scope_id}
```

The pivot admission condition is that every required predecessor try is sealed, none has timed out, and scope cancellation has not started. The pivot is Flory's commit point. Only after `txn/pivot-passed` is durably appended does the Coordinator run the idempotent TCC confirms.

If any pre-pivot try fails, the Coordinator fences the entire scope and appends `txn/cancel` with phase `requested`. It then cancels every sealed TCC member and compensates every completed Saga member in reverse dependency order. `txn/cancel` is a scope action, never a per-try action. Its `completed` phase is appended only after the entire scope has returned to its savepoint.

**Savepoint definition.** A scope's `savepoint` is the committed world state at **scope entry**. By construction it therefore lies *after* every preceding scope's pivot: a scope is entered only once its predecessors have committed. Two consequences follow, and both are load-bearing elsewhere:

1. "Compensate back to the savepoint" undoes only the current scope's pre-pivot work. It never crosses any pivot, including this scope's own.
2. A savepoint is never a point before an irreversible action. Any procedure phrased as "return to a state before the savepoint" is therefore ill-formed, because such a state may contain committed pivots that no compensation can reach. See [03 §2.1](./03-replan-and-recovery.md) for how this constrains replan-boundary selection.

### 4.2 Failure matrix

| Failure location                            | Handling                                                                                                                                                         |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Before pivot; retry can resolve it          | Append `vertex/retried` and retry idempotently.                                                                                                                  |
| Before pivot; retries exhausted             | Fence the scope, run one scope-level cancel over all sealed TCC and completed Saga members, return to the savepoint, and replan.                                  |
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

**In a live run**, scan for sealed `txn/try` events with no later scope confirm or completed scope cancel after `try_timeout_s`. Request one idempotent cancellation for the owning scope. Crash recovery uses the same sweep — it needs no marker of its own, because a resumed run re-projects its own log and every bracket in it belongs to that run ([01 §5.1](./01-jit-dag-and-event-log.md)).

**In a fork**, the sweep is inverted into a prohibition. Every `txn/try` inherited before `run/end-seed` belongs to a live parent run, so the fork must **never** cancel or confirm it: doing so would release a real hold out from under a real order. This is the actual purpose of the end-seed marker — it separates "inherited, read-only" from "mine" ([01 §5.2](./01-jit-dag-and-event-log.md)). A fork that finds an inherited open bracket at its boundary must refuse the boundary rather than clear it.

## 5. Relation to Existing Work

- Compared with **SagaLLM**, Flory moves validation from an independent validation agent to deterministic pre-freeze check-rules. The model is never the safety backstop.
- Compared with **Atomix**, Flory does not track a general frontier per resource, which would require intercepting all reads and writes. Instead, it requires all pre-pivot tries to close: coarser but statically checkable and practical for JIT planning.
- Compared with classic Saga orchestrators such as Temporal, Flory's DAG is JIT-generated and its transaction boundaries are planner-declared but rule-admitted. This is Flory's key distinction.

## 6. Open Questions

- **Conditional compensation, and pivots that appear at runtime.** The `effect_class` taxonomy assumes an undo path is either present or absent. Some are present *only within a window*: `channel.list` can be undone by `channel.unlist`, but only until a customer orders — afterwards, unlisting does not undo the sale obligation. Such a tool will be registered `reversible`, and that label becomes a lie once the window closes: the compensation chain is complete on paper while broken in fact. A fix needs a new dimension (`compensation_validity: unconditional | window(T) | conditional(pred)`) and an R4 upgraded to "the compensation is still valid at the moment it is needed". It also challenges a load-bearing assumption: **a node whose compensation has expired is effectively a pivot**, so pivot status would become "statically labelled plus runtime promotion" rather than a static property. That is a material model change and should be decided deliberately rather than patched in.
- Parent/child savepoint semantics and partial-commit visibility for nested transaction scopes.
- A fallback for channel APIs that cannot reserve resources, such as locally recording a simulated try and delaying execution.
- The reconciliation fallback protocol when a pivot status-query interface is unavailable.
- **Check-rule completeness.** R1–R11 were derived by hand, so the rule set has no completeness argument: a plan admitted by all eleven may still reach a dead state. [ADR-003](./adr/adr-003-formal-verification-of-the-transaction-protocol.md) attacks this from two directions — modeling the planner as an adversary bounded only by check-rules, so any invariant violation names a missing rule, and a bounded Alloy search for admissible-but-dead DAG shapes.
- **Parameter-general proof of parallel-pivot safety (§4.3).** Stage S2 checks invariant I1 inductively for explicit two- and three-branch configurations, removing the execution-length bound for those finite parameter sets. A proof quantified over arbitrary branch counts remains open; scenario and model checks must not be reported as that stronger result.
