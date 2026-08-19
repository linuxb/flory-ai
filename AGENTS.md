# Repository Guidelines

## Documentation

- Write all repository documentation in English.
- Keep design documents in `doc/design/`, architecture decision records in `doc/design/adr/`, and planning documents in `doc/plan/`.
- Record any decision with rejected alternatives as an ADR: `doc/design/adr/adr-NNN-short-slug.md`, numbered sequentially, never renumbered. A changed decision means a new ADR that supersedes the old one, not an edit to it.
- Store design diagrams in `doc/design/diagrams/`.
- Prefer self-contained HTML for architecture diagrams. Use Draw.io (`.drawio`) for focused mechanism diagrams that need to remain editable.
- **Keep related charts on one Draw.io sheet.** Arrange them as labelled regions (`A. …`, `B. …`) on a single enlarged page instead of opening a new sheet per chart; readers should compare without switching tabs, and cross-region arrows can express how the charts relate. Open a new sheet only for genuinely unrelated subsystems.
- Every diagram must adapt to light and dark themes: no hard-coded background or ink colors, `background="none"` on Draw.io canvases, and a Light/Dark/Auto toggle in standalone HTML.
- Keep diagram labels, captions, and surrounding documentation in English.
- Use relative links between documentation files so the documentation remains portable.

## Design Disciplines

These are invariants, not preferences. A change that violates one is wrong even when its tests pass. Each rule states the reason, because the reason is what tells you how to handle a case the rule does not literally cover. Full rationale lives in [`doc/design/`](doc/design/).

### The vertex log is ground truth

1. **Append only.** Never `UPDATE` or `DELETE` a `vertex_log` row. State transitions, shadowing, and forks are new events. Reason: every derived view, audit trail, replay test, and A/B attribution reads the same rows; mutating one row silently invalidates all of them.
2. **Shadow, never delete.** A replanned-away subtree stays in the log behind a `subgraph/shadowed` event. Reason: it is both the audit record and the evidence that stops a planner from repeating a disproven path.
3. **Materialized projections may be updated, but only by the projector, and must be recomputable** from the complete log with an identical result. A materialization is a cache, never a source.
4. **Atomic append.** A frozen sub-DAG writes `subgraph/frozen` plus all its `vertex/created` events in one database transaction: the whole subgraph is visible or none of it is.
5. **Fail closed on reads.** An unrecognized `event_type` makes the reader reject the whole log unless the event carries an explicit `ignorable` flag. Reason: silently skipping an unknown event corrupts replay in a way no test will catch.
6. **`seq` is write order only and never carries causality.** Causality is `parent_refs`. Adjacent `seq` values in parallel branches imply nothing.
7. **Keep the log vertex-fidelity, not token-fidelity.** Raw model input/output lives in blob storage referenced from `payload`; the log stores summaries. Reason: token-level logs force a compaction subsystem and leak PII into the primary table.

### Projections are pure

8. **`surface`, `slice`, `fold`, `linearize`, and `assemble` are pure functions.** No I/O, no clock, no randomness, no ambient config. Reason: purity is what makes replay testing, prompt caching, and A/B attribution possible at all.
9. **Every layer can dump its intermediate output.** Reason: a wrong prompt must be localizable to one layer instead of bisected across six.
10. **`linearize` sorts parallel branches lexicographically by `vertex_id` — never by `seq`, timestamp, or completion order.** Reason: two reasons, and both matter. Scheduling jitter would break replay determinism, and it would also change the prompt prefix on every turn and destroy the provider prompt-cache hit rate.
11. **Assert planner visibility before every model call**: the context being sent must equal the log projection. Compare projection hashes rather than re-serializing full history.
12. **Fold reducers are registered, versioned, and unit-tested** (`fold://inventory@v3`). A reducer may not call tools, read the clock, or perform I/O. Reason: arithmetic like "which of these 12 inventory results is current" belongs in tested code, never in a prompt.

### Transactions

13. **Never mix control-plane and data-plane transactions.** Engine metadata uses database transactions; business side effects use TCC plus pivot-saga. They are separate layers with separate failure handling.
14. **Check-rules are authoritative and deterministic.** A planner declares transaction boundaries; the rule engine admits them. Model self-checking is never a safety guarantee. A rejected proposal is regenerated with the violations attached — never patched through.
15. **A pivot is a one-way gate.** After `txn/pivot-passed`, forward recovery only: retry idempotent successors, then suspend for human intervention. Never automatically compensate backward across a pivot.
16. **Cancel before replan.** Planning may not resume across an open `txn/try`. Compensate first, then move the boundary.
16b. **Replan in place; fork only for dry runs.** An online replan appends `replan/boundary` plus `subgraph/shadowed` to the **same run** — never a child run. `fork/created` is reserved for non-executing dry-run children (counterfactual A/B, replay tests, operator what-ifs), which execute `effect_class: none` tools only and must never cancel or confirm a `txn/try` inherited before their `run/end-seed`. Reason: a run is a business process, so its identity must stay whole for audit, and a dry run must never touch a live order's holds.
17. **Compensation is delta-based and scoped to its own footprint.** Release what this try reserved; never restore an absolute snapshot value. Reason: only delta compensation commutes with another branch's committed change. This is validated at tool registration, and it matters most for value-type resources such as price, where snapshot-restore looks natural and is wrong.
18. **Every retryable tool declares an idempotency key**, and every compensation tool is itself idempotent.

### Harness-state and prompts

19. **Harness-state stores metadata only — no prose.** Prompt text lives in a versioned template library and is referenced by `*_ref`; memory is reached through mem-hints. Reason: raw text in state cannot be A/B-tested, diffed, or governed.
20. **Mem-hint queries come from a whitelist of parameterized, read-only, row-limited templates.** Refine may select and parameterize a template, never emit query code.
21. **A refine proposal is a validated structured edit list, never a prompt rewrite.** The base prompt is immutable in code, not merely in instructions. Each edit records before/after snapshots so rollback is inverse-edit replay.

### Experimentation and attribution

22. **Split A/B traffic by run, never by turn.** Reason: mixing versions inside one run lets earlier turns contaminate later ones and attribution collapses.
23. **Metrics are log projections, not separate telemetry.** Reason: when a metric definition changes, history can be recomputed; with independent telemetry, changing a definition discards the comparison baseline.
24. **Record the attribution triple in `run/start`:** `harness_state_version` + `projector_version` + `arm_id`. Omitting `projector_version` is the subtlest available failure: improving a fold reducer silently changes recomputed historical metrics, so an earlier conclusion quietly stops holding. Purity does not imply stability across versions.
25. **Guardrail metrics can veto a win.** Lower token cost with a higher post-pivot suspension rate is a regression. Safety metrics outrank the target metric in every automatic rollback decision.
26. **Stratify experiments** by task type, SKU-count bucket, and whether the plan contains a pivot. Reason: task heterogeneity spans orders of magnitude, and uniform splitting lets variance swallow the effect.

### Versioning

27. **Bump the relevant version on any behavior change:** log schema version (in `run/start`), `projector_version` (any change to a projection layer or fold reducer), `harness_state_version`, and template refs. Version identifiers are wire format; treat them as such from the first commit.
28. **Any change to the planner loop, a projection layer, or a fold reducer requires a replay test.** Record a real run once; replay asserts an event-by-event log match ignoring timestamps. Regression testing needs no API key.
28b. **Decisions publish their work; harnesses check rather than recompute.** `replan/boundary` carries the candidate set: each selectable candidate's cost, or a closed-vocabulary rejection reason for a non-selectable candidate, plus `estimated_cost` for later comparison against actual. Reason: verifying a choice by recomputing it duplicates the policy and tends to reproduce the author's own misunderstanding, yielding a green test over a wrong engine. A harness may traverse topology (`parent_refs`) freely — that is a fact, not a policy — but must never reimplement legality or cost.

## Review Checklist

Reject a change that does any of the following:

- Updates or deletes a `vertex_log` row, or backfills `shadowed_by` outside the projector.
- Adds I/O, a clock read, randomness, or ambient config to a projection layer or fold reducer.
- Sorts planner context by `seq`, timestamp, or completion order.
- Silently skips an unknown event type.
- Lets a planner's own assertion substitute for a check-rule.
- Compensates backward across `txn/pivot-passed`, or resumes planning across an open `txn/try`.
- Creates a child run for an online replan, or lets a dry-run child execute a non-`none` tool or mutate an inherited `txn/try`.
- Writes a compensation that restores an absolute value instead of releasing a delta.
- Puts prompt prose or raw memory text into harness-state.
- Adds a metric as new telemetry rather than as a log projection.
- Changes a projection layer without bumping `projector_version` or adding a replay test.

## Stack and Language Boundary

Two services, one database. Rationale and rejected alternatives: [ADR-001](doc/design/adr/adr-001-engine-language-split.md).

- **TypeScript** — engine service: planner loop, event vocabulary as discriminated unions, the canonical projection pipeline, check-rules, prompt assembly, refine loop, model adapters, and replay testing.
- **Go** — coordinator service: transaction brackets, timeout sweeping, orphan-try detection, the tool executor, and tool adapters that must live inside existing Go infrastructure.
- **PostgreSQL** — the vertex log and harness-state. It allocates `seq`, so the two services need no coordination protocol. Work handoff uses `SELECT … FOR UPDATE SKIP LOCKED` or `LISTEN/NOTIFY`; do not introduce a message broker before there is load that requires one.
- No third language in the engine without a new ADR.

### The boundary is the log

The two services never call each other's internals. They communicate only by appending events, and each owns an exclusive set of event types:

| Owner | Exclusive write access |
|---|---|
| TS engine | `run/start`, `run/end`, `run/end-seed`, `subgraph/proposed`, `subgraph/frozen`, `subgraph/rejected`, `subgraph/shadowed`, `replan/boundary`, `fork/created`, `vertex/created`, `budget/charged` |
| Go coordinator | `vertex/started`, `vertex/succeeded`, `vertex/failed`, `vertex/retried`, `txn/scope`, `txn/try`, `txn/confirm`, `txn/cancel`, `txn/pivot-passed` |

29. **Enforce event ownership at the append boundary** in both services. A service appending an event type it does not own is a bug, not a shortcut.
30. **Canonical projections have exactly one implementation, in TypeScript.** `surface`, `slice`, `fold`, `linearize`, and `assemble` may never be reimplemented in Go. Reason: a second implementation of the projection semantics produces the worst available bug class — two projectors that disagree on an edge case — and it makes discipline 3 (identical recomputation) and discipline 24 (`projector_version` attribution) unverifiable.
31. **Operational projections may live in either service.** Narrow, local folds that serve execution or operations — unmatched `txn/try` scanning, timeout sweeps, executor readiness checks — are not canonical projections. They do not feed a prompt, do not participate in attribution, and are independently testable. Discipline 30 restricts planner-context projection, not log reading in general; the Go coordinator is expected to read the log.
32. **Replay testing lives wherever the projector lives**, i.e. in TypeScript, because it must exercise the same code as production. Batch historical recomputation is also driven by the canonical projector: scale it by sharding on `run_id` across worker processes, or push a fold down into SQL. Never by porting the projector.
33. **The event schema is a shared, versioned artifact** — a schema-first IDL in the repository with generated types for both languages. A field change means editing the schema and regenerating, never editing one side's types.
34. **Cross-language conformance tests are required** for any log-reading semantics both services implement: golden log fixtures plus expected outcomes that both readers must satisfy. Fail-closed behavior on an unknown `event_type` without an `ignorable` flag is a mandatory fixture.

Add to the review checklist:

- Appends an event type owned by the other service.
- Reimplements a canonical projection layer outside TypeScript.
- Changes the event schema in one language's types instead of in the shared IDL.
- Adds log-reading semantics shared by both services without a conformance fixture.
