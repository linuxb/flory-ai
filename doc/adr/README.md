# Architecture Decision Records

Each ADR records one decision: its context, the decision itself, the rationale, the consequences, and the alternatives that were rejected and why. A rejected alternative is as valuable as the chosen one — it stops the same debate from reopening without new information.

Naming: `adr-NNN-short-slug.md`, numbered sequentially and never renumbered. Status is one of `Proposed`, `Accepted`, or `Deprecated`. Amend an accepted ADR only to correct a factual error; a changed decision means a new ADR that supersedes it — the superseded ADR is then removed from the tree (the new ADR restates whatever survives; git history preserves the rest), so numbering gaps are expected.

Write ADRs in English. Design specifications belong in [`../design/`](../design/); plans belong in [`../plan/`](../plan/).

| ADR | Title | Status |
|---|---|---|
| [001](./adr-001-engine-language-split.md) | Engine language split — TypeScript engine, Go coordinator | Accepted |
| [003](./adr-003-formal-verification-of-the-transaction-protocol.md) | Formal verification of the transaction protocol — TLA+ with TLC and Apalache | Accepted |
| [005](./adr-005-lazy-causal-fork-semantics.md) | Forks are lazy causal counterfactuals at any vertex | Accepted |
| [006](./adr-006-tool-registry-gateway.md) | Tool Registry and execution gateway | Accepted |
