# Planning Documents

Project plans, implementation plans, and rollout plans. A plan says *how and when* something gets built; an architecture change begins as a proposal in [`doc/adr/`](../adr/) and, once accepted, its authoritative requirements live only in the [design documents](../design/).

Naming: `plan-NNN-short-slug.md`, numbered sequentially and never renumbered. Status is one of `Proposed`, `Active`, `Done`, or `Abandoned`. A plan names the ADR it implements, states objective triggers rather than "when we have time", and lists its preconditions explicitly — a plan blocked on a precondition stays `Proposed` until that precondition is resolved.

All planning documents are written in English.

| Plan | Title | Authoritative design | Status |
|---|---|---|---|
| [001](./plan-001-tla-plus-specification.md) | TLA+ specification of the transaction protocol | [Doc 06 §12](../design/06-validation-harness.md#12-formal-verification-design) | Active — S1 and S2 complete; S3 trigger-gated |
| [002](./plan-002-event-log-storage-and-fork.md) | Event log storage and fork API implementation | [Doc 01 §5](../design/01-jit-dag-and-event-log.md#5-replanning-in-place-and-forking-for-offline-evaluation), [Doc 05 §3](../design/05-context-aggregation-and-offline-evaluation.md#3-counterfactual-evaluation-by-fork) | Done |
| [003](./plan-003-distributed-transaction-coordinator.md) | Distributed Transaction Coordinator | [Doc 00 §3.1](../design/00-overview.md#31-service-and-language-boundaries), [Doc 02](../design/02-transaction-model.md), [Doc 07](../design/07-distributed-transaction-coordinator.md) | Active — runtime delivered; complete S12 scenario pending |
| [004](./plan-004-tool-registry-gateway.md) | Tool Registry Gateway | [Doc 09](../design/09-tool-registry-gateway.md) | Done |
