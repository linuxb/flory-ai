# ADR-005: Forks are lazy causal counterfactuals at any vertex

- **Status:** Accepted
- **Date:** 2026-08-24
- **Deciders:** Flory engine team
- **Supersedes:** ADR-004, which had superseded ADR-002 (both removed from the tree; git history preserves them). Every decision of theirs that survives is restated below — this record stands alone.

## Context

ADR-004 established that forks serve offline historical evaluation only, and defined the mechanics inherited from dsh: branch at a `stream_seq`, restricted to a legal replan boundary (a succeeded planner vertex outside every open bracket and above the backtrack floor), substitute pins, then merge the **entire source tail** so its effects replay under the new pins.

Two problems emerged. First, the boundary restriction imports online recovery constraints into a mechanism that never touches the external world: a pivot floor exists to stop a *live* planner from re-issuing an irreversible action, which is meaningless for an evaluation that executes no writes — and it forbids exactly the counterfactuals evaluation most wants, such as substituting a tool pin at a mid-bracket tool-caller. Second, replaying the whole tail is causally wrong: events downstream of the substituted vertex were *caused* by the original pin, so replaying them under a new pin evaluates an incoherent history in which the cause changed but its effects did not.

## Decision

- `fork(source_stream, at_vertex_id, substitutions[], eval_up_to_seq) → new run`. The divergence point is a **vertex**, and it may be **any vertex** — planner or tool-caller, inside or outside a transaction bracket, above or below the pivot floor. Boundary rules ([03 §2.1](../design/03-replan-and-recovery.md)) govern online replanning only.
- **Causal invalidation.** Substituting the divergence vertex invalidates all its causal descendants, derived via `parent_refs`. They are never inherited; the fork regenerates that chain — new sub-DAG, new tool calls, new transaction events — under the substituted pins.
- **Causal merge.** Events with no causal path from the divergence vertex (sibling branches, external inputs, webhooks) remain valid and are merged into the fork as inherited copies.
- **Lazy evaluation.** A fork does not run to completion. Execution and merging proceed only as far as `eval_up_to_seq`, producing a fold comparable with the source at that position. `fold_mode` bounds liveness as before; blocked folds and mocked tool responses stand in for whatever the mode forbids.
- **Inherited copies are read-only wherever they sit** — in the seed before `run/end-seed` or merged later. A fork never cancels or confirms an inherited `txn/try`; an inherited open bracket is mocked around or lazily terminated at, never mutated ([02 §4.4](../design/02-transaction-model.md)).
- `fork/created` provenance becomes `(source run_id, at_vertex_id, eval_up_to_seq, substitutions, fold_mode, evaluator pin, projector_version, harness_state_version)`.
- **Retained from ADR-004, unchanged:** forks are offline-only; online replanning stays in place on the original stream and never creates a run ([01 §5.1](../design/01-jit-dag-and-event-log.md)); evidence is case-specific and never pooled into causal or population-level claims; the offline ladder is `recorded` → `model-live` → `reads-live` and `writes-live` is production; corpora are versioned explicit lists; offline evidence recommends, an operator decides.

## Rationale

A counterfactual is a causal question, so its mechanics must follow the causal graph rather than the storage order. Invalidate-descendants/merge-independents is the minimal semantics under which "what if this one pin had differed" has a coherent answer. Decoupling forks from online boundaries is safe precisely because the safety they enforced lives elsewhere: forks execute no writes by construction, and the inherited-try prohibition is positional in neither direction — it attaches to provenance, not to a boundary choice. Laziness makes the comparison honest (both folds stop at the same source position) and bounds evaluation cost.

## Consequences

### Gained

- Counterfactuals at tool-callers and mid-bracket vertices, previously unreachable.
- Causally coherent fork histories; no replayed effects whose cause was substituted.
- A natural cost bound (`eval_up_to_seq`) and a natural prompt-diff mode (blocked folds).

### Accepted costs

- The fork storage transaction computes a causal slice instead of copying a frozen prefix, and inherited-try locking keys on provenance rather than `run/end-seed` position; [08 §4](../design/08-database-schema.md#4-fork-storage-transaction) specifies the implemented transaction.
- Causal-independence detection is only as good as `parent_refs`; an under-declared dependency silently merges an event that should have been invalidated.
- A no-substitution fork must still reproduce the source surface exactly ([01 §5.3](../design/01-jit-dag-and-event-log.md#53-pin_version-what-a-substitution-actually-changes)): with nothing substituted, nothing is invalidated and everything merges.

## Alternatives considered

**Keep boundary-restricted forks (ADR-004 mechanics).** Rejected: imports online constraints with no offline safety value, and forbids the most useful substitution sites.

**Full-tail merge under new pins.** Rejected: causally incoherent — effects survive the substitution of their cause, so the comparison measures a history that could never have occurred.

**Eager evaluation to run completion.** Rejected: unbounded cost, and the source ran to a different length; comparability requires stopping both folds at one declared position.

## References

- [JIT-DAG and event log](../design/01-jit-dag-and-event-log.md) §5.2
- [Transaction model](../design/02-transaction-model.md) §4.4
- [Replanning and recovery](../design/03-replan-and-recovery.md) §§2.1, 2.4, 5
- [Context aggregation and offline evaluation](../design/05-context-aggregation-and-offline-evaluation.md) §3
