# Architecture Decision Records

This directory holds architecture proposals while they are under review. Each proposal records one prospective decision: its context, proposed decision, rationale, consequences, and the alternatives rejected and why.

Naming is `adr-NNN-short-slug.md`. Number proposals sequentially and never reuse or renumber an identifier. A large architecture change must begin as `Proposed`, and implementation may begin only after acceptance.

Acceptance is a migration, not a permanent document status. In the accepting change, merge every surviving decision, rationale, consequence, and rejected alternative into the existing authoritative documents in [`../design/`](../design/), update plans and contributor routes to cite those documents, and remove every repository reference to the accepted ADR. The merged ADR may then be deleted immediately; Git history remains the review record and numbering gaps are expected.

Write proposals in English. Implementation and rollout plans belong in [`../plan/`](../plan/). The index below lists only active proposals; accepted decisions are discoverable through the design documents and Git history.

| ADR | Title | Status |
|---|---|---|
| [005](./adr-005-progressive-jit-dag-morphology.md) | Progressive JIT-DAG Workflow Morphology and Deterministic Routers | Proposed |
| [006](./adr-006-console-ui-for-jit-dag.md) | Console UI for JIT-DAG Visualization and Monitoring | Proposed |
| [007](./adr-007-business-stream-sequences.md) | Three-Tier Sequence Model for Business Streams | Proposed |
