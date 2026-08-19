# Architecture Decision Records

Each ADR records one decision: its context, the decision itself, the rationale, the consequences, and the alternatives that were rejected and why. A rejected alternative is as valuable as the chosen one — it stops the same debate from reopening without new information.

Naming: `adr-NNN-short-slug.md`, numbered sequentially and never renumbered. Status is one of `Proposed`, `Accepted`, `Superseded by ADR-NNN`, or `Deprecated`. Amend an accepted ADR only to correct a factual error; a changed decision means a new ADR that supersedes it.

Write ADRs in English. Design specifications belong in [`../`](../); plans belong in [`../../plan/`](../../plan/).

| ADR | Title | Status |
|---|---|---|
| [001](./adr-001-engine-language-split.md) | Engine language split — TypeScript engine, Go coordinator | Accepted |
| [002](./adr-002-in-place-replan-and-dry-run-forks.md) | Replan in place; reserve forks for dry runs | Accepted |
| [003](./adr-003-formal-verification-of-the-transaction-protocol.md) | Formal verification of the transaction protocol — TLA+ with TLC and Apalache | Accepted |
