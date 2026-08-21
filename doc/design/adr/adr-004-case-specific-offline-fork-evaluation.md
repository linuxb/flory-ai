# ADR-004: Forks provide case-specific offline historical evaluation

- **Status:** Accepted
- **Date:** 2026-08-22
- **Deciders:** Flory engine team
- **Supersedes:** [ADR-002](./adr-002-in-place-replan-and-dry-run-forks.md)

## Context

Flory serves ToB e-commerce workflows whose cases differ materially in task shape, catalog, inventory, price, channel policy, external timing, and irreversible business effects. Two production runs are therefore not parallel comparison units. Treating their outcomes as exchangeable would attribute differences to a planner or harness change when the business inputs themselves may explain them.

The append-only event log can reconstruct one run at any `stream_seq`. A fork can branch that history, substitute named `pin_version`s, merge the recorded tail, and fold the result without mutating the source or executing writes. This supports a controlled comparison within one historical case.

## Decision

- Forks are used only for offline historical evaluation, replay regression, explanation, and operator what-if analysis.
- An evaluation compares a source stream with one or more forks derived from that same stream. Its conclusion is scoped to that case.
- Production traffic is not divided into comparison groups. Unrelated business runs are not treated as independent samples of one common population, and corpus summaries are descriptive rather than causal.
- `fork/created` records the source `run_id`, `at_stream_seq`, substitutions, `fold_mode`, evaluator pin, `projector_version`, and `harness_state_version`.
- The offline ladder is `recorded` → `model-live` → `reads-live`. `writes-live` is production and is never an evaluation mode.
- Every corpus is a versioned list of explicit histories with documented inclusion criteria. Each source/fork result and its unverified writes remain visible even when results are grouped by task or failure class.
- Offline evidence may recommend a change for operator review. It never authorizes production automatically. Absolute safety guardrails and operator judgement govern rollback and promotion.
- Online replanning remains in place on the original stream, as decided by ADR-002; this ADR changes the purpose and reporting semantics of forks, not the in-place recovery rule.

## Rationale

Within one source history, named pin substitutions isolate the design variable while preserving the task and recorded observations. This is the strongest comparison the repository can support without replaying business writes. Complete provenance makes the result reproducible, while the case boundary prevents heterogeneous ToB runs from being presented as if they were statistically interchangeable.

Keeping writes outside evaluation also preserves the ownership of inventory holds, bookings, and other irreversible effects. `reads-live` can improve current cost or availability estimates, but those reads are labelled as present-time observations rather than historical facts.

## Consequences

### Gained

- One coherent evaluation mechanism covers prompt changes, model pins, tool contracts, fold reducers, recovery policies, and operator what-ifs.
- Every result is traceable to an exact history, substitution set, evaluator, and projection version.
- Evaluation cannot mutate a live business process or cancel an inherited transaction bracket.
- Reports state their real evidence boundary instead of implying cross-case causality.

### Accepted costs

- Offline evaluation cannot establish whether a side-effecting call would have succeeded.
- A corpus cannot produce a population effect estimate; reviewers must inspect case-level evidence and contradictory cases.
- Corpus selection and evaluator versioning require explicit governance.
- Production promotion remains an operator decision backed by absolute safety gates.

## Alternatives considered

**Split production traffic between configuration arms.** Rejected. ToB e-commerce cases are too heterogeneous for unrelated runs to serve as parallel units, and real writes expose business processes to evaluation risk.

**Treat a corpus of forks as independent samples.** Rejected. Forks selected from historical incidents share selection bias, and multiple forks of one source share the same prefix. Pooling them would overstate the evidence.

**Use before-and-after production windows for automatic rollback.** Rejected. Different task mix, inventory, prices, and external conditions confound the comparison. Production rollback uses absolute safety guardrails or operator judgement.

**Remove forks and rely only on replay tests.** Rejected. Exact replay detects drift but cannot answer a controlled what-if involving a different pinned model, prompt assembly, policy, or read-only tool contract.

## References

- [JIT-DAG and event log](../01-jit-dag-and-event-log.md) §5
- [Refine and harness-state](../04-refine-and-harness-state.md) §4.3
- [Context aggregation and offline evaluation](../05-context-aggregation-and-offline-evaluation.md) §§3–4
- [Validation harness](../06-validation-harness.md) §§8–10
