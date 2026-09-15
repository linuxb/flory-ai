# Planning Documents

Project plans, implementation plans, and rollout plans. A plan says *how and when* something gets built; an architecture change begins as a proposal in [`doc/adr/`](../adr/) and, once accepted, its authoritative requirements live only in the [design documents](../design/).

Naming: `plan-NNN-short-slug.md`, numbered sequentially and never renumbered. Status is one of `Proposed`, `Active`, `Done`, or `Abandoned`. A plan names the ADR it implements, states objective triggers rather than "when we have time", and lists its preconditions explicitly — a plan blocked on a precondition stays `Proposed` until that precondition is resolved.

A plan is a schedule, not a specification: once its work is delivered, the requirements live in the design documents it implements and the plan itself is removed. This index therefore lists only plans with outstanding work. Numbering is never reused, so gaps are expected; Git history holds the delivered plans.

All planning documents are written in English.

| Plan | Title | Authoritative design | Status |
|---|---|---|---|
| [001](./plan-001-tla-plus-specification.md) | TLA+ specification of the transaction protocol | [Doc 06 §12](../design/06-validation-harness.md#12-formal-verification-design) | Active — S1 and S2 complete; S3 trigger-gated |
| [003](./plan-003-distributed-transaction-coordinator.md) | Distributed Transaction Coordinator | [Doc 00 §3.1](../design/00-overview.md#31-service-and-language-boundaries), [Doc 02](../design/02-transaction-model.md), [Doc 07](../design/07-distributed-transaction-coordinator.md) | Active — runtime delivered; complete S12 scenario pending |
| [006](./plan-006-deterministic-routers.md) | Deterministic Routers and Rule Templates | [Doc 10](../design/10-deterministic-routers.md) | Proposed |
| [007](./plan-007-two-plane-storage.md) | Two-plane storage and the three-tier sequence model | [Doc 01 §3.1](../design/01-jit-dag-and-event-log.md#31-two-planes-and-three-sequences), [Doc 08](../design/08-database-schema.md) | Proposed |
