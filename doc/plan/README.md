# Planning Documents

Project plans, implementation plans, and rollout plans. A plan says *how and when* something gets built; the decision to build it belongs in an [ADR](../design/adr/), and what it must do belongs in a [design document](../design/).

Naming: `plan-NNN-short-slug.md`, numbered sequentially and never renumbered. Status is one of `Proposed`, `Active`, `Done`, or `Abandoned`. A plan names the ADR it implements, states objective triggers rather than "when we have time", and lists its preconditions explicitly — a plan blocked on a precondition stays `Proposed` until that precondition is resolved.

All planning documents are written in English.

| Plan | Title | Implements | Status |
|---|---|---|---|
| [001](./plan-001-tla-plus-specification.md) | TLA+ specification of the transaction protocol | [ADR-003](../design/adr/adr-003-formal-verification-of-the-transaction-protocol.md) | Active — S1 complete; S2/S3 trigger-gated |
| [002](./plan-002-event-log-storage-and-fork.md) | Event log storage and fork API implementation | [ADR-004](../design/adr/adr-004-case-specific-offline-fork-evaluation.md) | Proposed — Blocked on scaffolding |
