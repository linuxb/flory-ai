# ADR-002: Replan in place; reserve forks for dry runs

- **Status:** Superseded by ADR-004
- **Date:** 2026-08-19
- **Deciders:** Flory engine team
- **Supersedes:** the online-fork recovery model described by earlier design drafts

## Context

Flory uses an append-only event log and supports both recovery from failed tool calls and offline evaluation of alternate plans. The original model used `fork(boundary)` for recovery, following deepseek-harness (dsh), where a session fork also supports resume and replay.

That equivalence does not hold for Flory. A run represents one business process, such as an order or replenishment. Its identity is part of the audit trail, and the run may own active inventory holds and other data-plane state. We must distinguish live recovery from a counterfactual evaluation without allowing an offline child to mutate the live process.

## Decision

- An online replan appends `replan/boundary` and `subgraph/shadowed` to the **same** `run_id`, then calls the selected planner again. It never creates a child run or copies a log prefix.
- `fork/created` is reserved for offline child runs: counterfactual evaluation, replay testing, recovery-strategy comparison, and operator what-if previews. The decision recorded here is that forks are offline-only; the mechanism was later elaborated into branch/substitute/merge over `pin_version` with a `fold_mode` ladder, and forks were found unusable as A/B arms — see [01 §5](../01-jit-dag-and-event-log.md), which carries the current design.
- A dry-run child executes only tools with `effect_class: none`. It may read current state, but skips and records estimates for every side-effecting tool.
- Events inherited before a dry-run child's `run/end-seed` are read-only. The child must never cancel or confirm an inherited `txn/try`; an open inherited bracket makes the boundary ineligible for a dry run.
- The legal boundary for either mechanism is a succeeded planner outside every open transaction bracket and at or after the most recent `txn/pivot-passed`.

## Rationale

Keeping online replanning in the original run leaves one complete, readable audit trail for the business process. Shadowing already retains the failed subtree and failure evidence, so a copied prefix adds storage cost without adding recovery value. Crash recovery follows the same principle: re-project and resume the existing log.

Dry runs remain valuable precisely because they are isolated. A forked child can compare a different harness-state arm or recovery boundary without causing writes. The `run/end-seed` marker identifies the parent-owned prefix and prevents the most dangerous mistake: releasing a live order's hold during an offline analysis.

## Consequences

### Gained

- One `run_id` captures the complete lifecycle of one business task.
- Online recovery has no prefix-copy storage cost and no cross-run audit chase.
- Counterfactual evaluation remains available with a mechanically enforceable zero-side-effect boundary.

### Accepted costs

- The engine must implement both in-place replanning and dry-run execution modes.
- Validation fixtures must prove that online replans create no child run and that dry runs cannot mutate inherited brackets.
- Dry-run results cannot establish whether side-effecting calls would succeed; they measure plan quality, not execution success.

## Alternatives considered

**Use forks for online replanning, as dsh does.** Rejected. dsh sessions are cheap local objects without business identity or external holds. In Flory, a child run fragments auditability and duplicates a prefix while retaining the risk of confusing ownership of active transaction brackets.

**Do not support forks at all.** Rejected. Offline counterfactuals are an important, safe way to compare planner arms and recovery strategies for low-frequency task types.

**Let a dry run execute reversible or bufferable tools.** Rejected. “Reversible” means compensable, not side-effect free; a failed compensation can still damage a live business process. The dry-run gate admits only `effect_class: none`.

**Treat an inherited open try as an orphan and cancel it.** Rejected. The bracket belongs to the live parent. Cancelling it from the child would release a real reservation and is a data-plane incident.

## References

- [JIT-DAG and event log](../01-jit-dag-and-event-log.md) §5
- [Replanning and recovery](../03-replan-and-recovery.md) §2
- [Context aggregation and experimentation](../05-context-aggregation-and-offline-evaluation.md) §3
- [Validation harness](../06-validation-harness.md) scenarios S2c and S11b
