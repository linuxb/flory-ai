# Planning Documents

Project plans, implementation plans, and rollout plans. A plan says *how and when* something gets built; the decision to build it belongs in an [ADR](../adr/), and what it must do belongs in a [design document](../design/).

Naming: `plan-NNN-short-slug.md`, numbered sequentially and never renumbered. Status is one of `Proposed`, `Active`, `Done`, or `Abandoned`. A plan names the ADR it implements, states objective triggers rather than "when we have time", and lists its preconditions explicitly — a plan blocked on a precondition stays `Proposed` until that precondition is resolved.

All planning documents are written in English.

| Plan | Title | Implements | Status |
|---|---|---|---|
| [001](./plan-001-tla-plus-specification.md) | TLA+ specification of the transaction protocol | [ADR-003](../adr/adr-003-formal-verification-of-the-transaction-protocol.md) | Active — S1 and S2 complete; S3 trigger-gated |
| [002](./plan-002-event-log-storage-and-fork.md) | Event log storage and fork API implementation | [ADR-005](../adr/adr-005-lazy-causal-fork-semantics.md) | Done |
| [003](./plan-003-distributed-transaction-coordinator.md) | Distributed Transaction Coordinator | [ADR-001](../adr/adr-001-engine-language-split.md), [ADR-003](../adr/adr-003-formal-verification-of-the-transaction-protocol.md) | Active — runtime delivered; complete S12 scenario pending |
| [004](./plan-004-tool-registry-gateway.md) | Tool Registry Gateway | [ADR-006](../adr/adr-006-tool-registry-gateway.md) | Done |
