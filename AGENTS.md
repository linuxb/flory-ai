# Repository Guidelines

## Documentation

- Write all repository documentation in English.
- Keep design documents in `doc/design/`, architecture decision records in `doc/design/adr/`, and planning documents in `doc/plan/`.
- Record any decision with rejected alternatives as an ADR: `doc/design/adr/adr-NNN-short-slug.md`, numbered sequentially, never renumbered. A changed decision means a new ADR that supersedes the old one, not an edit to it.
- Store design diagrams in `doc/design/diagrams/`.
- Prefer self-contained HTML for architecture diagrams. Use Draw.io (`.drawio`) for focused mechanism diagrams that need to remain editable.
- **Keep related charts on one Draw.io sheet.** Arrange them as labelled regions (`A. …`, `B. …`) on a single enlarged page instead of opening a new sheet per chart; readers should compare without switching tabs, and cross-region arrows can express how the charts relate. Open a new sheet only for genuinely unrelated subsystems.
- Every diagram must adapt to light and dark themes: no hard-coded background or ink colors, `background="none"` on Draw.io canvases, and a Light/Dark/Auto toggle in standalone HTML.
- **This is not a licence to remove colour.** "No hard-coded colors" means the *canvas background* and *neutral ink*, never the semantic palette. Every Draw.io shape keeps `fillColor` + `strokeColor` from the shared palette with `fontColor` equal to its stroke, which is what stays legible in both themes; in HTML the palette lives in CSS variables while only the surface tokens follow the theme. A monochrome diagram is a regression, not a theme fix.
- Keep diagram labels, captions, and surrounding documentation in English.
- Use relative links between documentation files so the documentation remains portable.
- **Update documentation by rewriting the affected section, never by patching it.** When a decision changes, replace the whole section with the current design and **delete every superseded sentence** — no "previously we said", no parenthetical corrections, no notes bolted onto a stale paragraph. Rationale that is still true may be carried forward, and a rule set may keep a compact revision table when knowing *why a rule was rejected* prevents its reintroduction, but the body of a document must read as though it were written today. Reason: patch-on-patch documentation makes the reader reconstruct history to find the current rule, which is exactly when the wrong rule gets implemented.
- Keep the root `README.md` repository-layout tree synchronized whenever a top-level directory is added, removed, or repurposed. State the directory's role; the README is the entry point for contributors discovering repository structure.
- Keep `.github/workflows/formal-verification.yml` aligned with the transaction protocol's source documents. When a documentation change adds or changes a transaction discipline, invariant, admission rule, recovery rule, or oracle expectation, add that document to the workflow's `paths` filter in the same change. Include `AGENTS.md` and the workflow file itself so changes to the discipline or its CI contract cannot bypass TLC review.

## Design Disciplines

These are invariants, not preferences. A change that violates one is wrong even when its tests pass. Each rule states the reason, because the reason is what tells you how to handle a case the rule does not literally cover. Full rationale lives in [`doc/design/`](doc/design/).

### The event log is ground truth

1. **Append only.** Never `UPDATE` or `DELETE` an `event_log` row. State transitions, shadowing, and forks are new events. Reason: every derived view, audit trail, replay test, and offline evaluation reads the same rows; mutating one row silently invalidates all of them.
2. **Shadow, never delete.** A replanned-away subtree stays in the log behind a `subgraph/shadowed` event. Reason: it is both the audit record and the evidence that stops a planner from repeating a disproven path.
3. **Materialized projections may be updated, but only by the projector, and must be recomputable** from the complete log with an identical result. A materialization is a cache, never a source.
3b. **Projections that gate a side effect are updated in the same transaction as the event append, never asynchronously.** Pivot admission and replan-boundary legality are safety-critical synchronous reads; a projection lagging by milliseconds can let an irreversible action fire that should have been blocked. Both live in the same database, so this is one ordinary transaction.
3c. **Push an invariant into a database constraint whenever it is expressible there.** Constraints do not forget and the coordinator has many concurrent writers. Required at schema-creation time, because retrofitting any of them onto live data means cleaning history first: no `UPDATE`/`DELETE` grant on `event_log` for the application role (enforces discipline 1); a `BEFORE INSERT` trigger checking `current_user` against event ownership (enforces discipline 29); `UNIQUE (idempotency_key)` on the bracket projection; a partial unique index for one-pivot-per-scope; a state-transition trigger for "no cancel after pivot".
4. **Atomic append.** A frozen sub-DAG writes `subgraph/frozen` plus all its `vertex/created` events in one database transaction: the whole subgraph is visible or none of it is.
5. **Fail closed on reads.** An unrecognized `event_type` makes the reader reject the whole log unless the event carries an explicit `ignorable` flag. Reason: silently skipping an unknown event corrupts replay in a way no test will catch.
6. **Two sequences, one of which may never feed a fold.** `stream_seq` is per-run, strictly increasing, contiguous, rollback-safe, and commit-ordered — it is allocated from a counter column on the run row inside the appending transaction. `global_seq` is a `BIGSERIAL`: gappy, not commit-ordered, for coarse global ordering and operational triage only. **Never fold over `global_seq`.** Reason: a sequence is allocated before commit and observed after it, so concurrent appends can be observed out of order — which does not merely skip an event, it makes the same event set fold differently on different reads, and projection purity collapses along with replay testing, prompt caching, and offline evaluation. Neither sequence carries causality; causality is `parent_refs`.
6b. **Projection purity is scoped to one stream, and that scope is honest.** A run owns exactly one stream. A fold over one stream is pure; a fold over concatenated streams is not. Every projection, and every fork evaluation — which compares two surfaces, each folded from a single stream — is single-stream by construction, so this costs nothing. But cross-run analytics must be computed as **fold per stream, then aggregate**, never as one fold ordered by `global_seq`.
6c. **Reducers must commute over concurrent events.** Serializing appends fixes storage order, not scheduling order: two concurrent siblings may take `stream_seq` in either order across replays. Any reducer that is order-sensitive over events with no `parent_refs` path between them breaks purity even with a perfect sequence. `linearize` satisfies this by sorting on `vertex_id`; semantic folds satisfy it because compensation is delta-based (discipline 17). Asserted by the permutation test in doc 06 O4.
7. **Keep the log vertex-fidelity, not token-fidelity.** Raw model input/output lives in blob storage referenced from `payload`; the log stores summaries. Reason: token-level logs force a compaction subsystem and leak PII into the primary table.

### Forks and evaluation

7b. **The event log is immutable history; a fork is the only way to ask a counterfactual.** Never edit an event to explore an alternative. `fork(source_stream, at_stream_seq, substitutions)` branches into a new run, substitutes `pin_version` on the named events, merges the source tail so its effects replay under the new pins, and folds. Reason: mutating history would destroy the one property everything else rests on, and branching costs nothing because folds are already per-stream.
7c. **A substitution changes only a `pin_version`.** Model endpoint, tool API contract, prompt-assembly strategy, and fold reducer are all pinned, so "what if we used a different model / a different carrier contract / a different assembly" are the same operation on different pins. Nothing else about an inherited event may differ.
7d. **A no-substitution fork must reproduce the source surface exactly.** Any difference means an unpinned dependency leaked into the projection pipeline. This is the cheapest available detector for that defect class, so it runs after every change to a projection layer or a pin default.
7e. **Offline evaluation never crosses into writes.** The `fold_mode` ladder is `recorded` → `model-live` → `reads-live`; `writes-live` is production and is not an evaluation mode. Live reads are permitted precisely because `effect_class: none` means no side effect. The executor enforces the declared mode at the node level, recording an unverified estimate rather than calling a tool above it.
7f. **Fork evidence is case-specific.** A fork is a paired counterfactual on one history. ToB e-commerce runs differ in task, catalog, inventory, prices, and external timing, so unrelated runs are not parallel comparison units. Report the source result, fork result, substitutions, and limitations for each history; never turn a corpus of forks into a causal or population-level claim.

### Projections are pure

8. **`surface`, `slice`, `fold`, `linearize`, and `assemble` are pure functions.** No I/O, no clock, no randomness, no ambient config. Reason: purity is what makes replay testing, prompt caching, and reproducible historical evaluation possible at all.
9. **Every layer can dump its intermediate output.** Reason: a wrong prompt must be localizable to one layer instead of bisected across six.
10. **`linearize` sorts parallel branches lexicographically by `vertex_id` — never by a sequence number, timestamp, or completion order.** Reason: two reasons, and both matter. Scheduling jitter would break replay determinism, and it would also change the prompt prefix on every turn and destroy the provider prompt-cache hit rate.
11. **Assert planner visibility before every model call**: the context being sent must equal the log projection. Compare projection hashes rather than re-serializing full history.
12. **Fold reducers are registered, versioned, and unit-tested** (`fold://inventory@v3`). A reducer may not call tools, read the clock, or perform I/O. Reason: arithmetic like "which of these 12 inventory results is current" belongs in tested code, never in a prompt.

### Transactions

13. **Never mix control-plane and data-plane transactions.** Engine metadata uses database transactions; business side effects use TCC plus pivot-saga. They are separate layers with separate failure handling.
14. **Check-rules are authoritative and deterministic.** A planner declares transaction boundaries; the rule engine admits them. Model self-checking is never a safety guarantee. A rejected proposal is regenerated with the violations attached — never patched through.
15. **A pivot is a one-way gate.** After `txn/pivot-passed`, forward recovery only: retry idempotent successors, then suspend for human intervention. Never automatically compensate backward across a pivot.
16. **Cancel before replan.** Planning may not resume across an open `txn/try`. Compensate first, then move the boundary.
16b. **Replan in place; fork only offline.** An online replan appends `replan/boundary` plus `subgraph/shadowed` to the **same stream** — never a child run. Reason: a run is a business process, so its identity must stay whole for audit. A fork (disciplines 7b–7f) is offline only and must never cancel or confirm a `txn/try` inherited before its `run/end-seed`, because that hold belongs to a live order.
17. **Compensation is delta-based and scoped to its own footprint.** Release what this try reserved; never restore an absolute snapshot value. Reason: only delta compensation commutes with another branch's committed change. This is validated at tool registration, and it matters most for value-type resources such as price, where snapshot-restore looks natural and is wrong.
18. **Every retryable tool declares an idempotency key**, and every compensation tool is itself idempotent.

### Harness-state and prompts

19. **Harness-state stores metadata only — no prose.** Prompt text lives in a versioned template library and is referenced by `*_ref`; memory is reached through mem-hints. Reason: raw text in state cannot be versioned, diffed, replayed, or governed reliably.
20. **Mem-hint queries come from a whitelist of parameterized, read-only, row-limited templates.** Refine may select and parameterize a template, never emit query code.
21. **A refine proposal is a validated structured edit list, never a prompt rewrite.** The base prompt is immutable in code, not merely in instructions. Each edit records before/after snapshots so rollback is inverse-edit replay.

### Offline evaluation and traceability

22. **Evaluation is historical and paired within one case.** Compare a source stream only with forks derived from that same stream. Production traffic is not divided into comparison groups, and unrelated ToB cases are never treated as exchangeable samples.
23. **Metrics are log projections, not separate telemetry.** Reason: when a metric definition changes, history can be recomputed; with independent telemetry, changing a definition discards the comparison baseline.
24. **Record complete evaluation provenance in `fork/created`:** source `run_id`, `at_stream_seq`, substitutions, `fold_mode`, evaluator pin, `projector_version`, and `harness_state_version`. Omitting any versioned dependency makes the historical result impossible to reproduce.
25. **Safety guardrails outrank apparent improvements.** Lower estimated cost with a worse invariant verdict, post-pivot risk, or unverified write dependency is a rejection. An offline result may recommend promotion for review; it never authorizes production automatically.
26. **Fold each stream before reporting a corpus.** Cross-case summaries are descriptive and stratified by task type, SKU-count bucket, and pivot presence. Preserve every case result and its limitations; do not report a pooled causal effect.

### Versioning

27. **Bump the relevant version on any behavior change:** log schema version (in `run/start`), `projector_version` (any change to a projection layer or fold reducer), `harness_state_version`, and template refs. Version identifiers are wire format; treat them as such from the first commit.
28. **Any change to the planner loop, a projection layer, or a fold reducer requires a replay test.** Record a real run once; replay asserts an event-by-event log match ignoring timestamps. Regression testing needs no API key.
28b. **Decisions publish their work; harnesses check rather than recompute.** `replan/boundary` carries the candidate set: each selectable candidate's cost, or a closed-vocabulary rejection reason for a non-selectable candidate, plus `estimated_cost` for later comparison against actual. Reason: verifying a choice by recomputing it duplicates the policy and tends to reproduce the author's own misunderstanding, yielding a green test over a wrong engine. A harness may traverse topology (`parent_refs`) freely — that is a fact, not a policy — but must never reimplement legality or cost.

## Review Checklist

Reject a change that does any of the following:

- Updates or deletes a `event_log` row, or backfills `shadowed_by` outside the projector.
- Adds I/O, a clock read, randomness, or ambient config to a projection layer or fold reducer.
- Sorts planner context by either sequence number, timestamp, or completion order.
- Folds over `global_seq`, or computes a cross-run metric as a single fold instead of fold-per-stream-then-aggregate.
- Edits an event to explore an alternative instead of forking with a `pin_version` substitution.
- Compares unrelated business cases as parallel samples, or reports a fork corpus as a causal or population-level result.
- Lets an evaluation execute a node above its declared `fold_mode`.
- Patches a documentation section instead of rewriting it, or leaves superseded text in place.
- Adds a reducer that is order-sensitive over concurrent events.
- Updates a side-effect-gating projection asynchronously.
- Silently skips an unknown event type.
- Lets a planner's own assertion substitute for a check-rule.
- Compensates backward across `txn/pivot-passed`, or resumes planning across an open `txn/try`.
- Creates a child run for an online replan, or lets a fork mutate an inherited `txn/try`.
- Writes a compensation that restores an absolute value instead of releasing a delta.
- Puts prompt prose or raw memory text into harness-state.
- Adds a metric as new telemetry rather than as a log projection.
- Changes a projection layer without bumping `projector_version` or adding a replay test.

## TypeScript and JavaScript Style

- Hand-written TypeScript and JavaScript must follow the [Google TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html). Generated sources are exempt except for identifiers that are consumed by hand-written code.
- Use UTF-8, LF line endings, four spaces for indentation, single-quoted strings, trailing commas, and no trailing whitespace. Apply the repository Prettier configuration; do not hand-format around it.
- The project line limit is **200 columns**. Wrap expressions, parameter lists, object literals, test fixtures, and JSON Schema declarations so every TypeScript, JavaScript, and IDL schema line stays within this limit. An unbreakable external URL or required wire literal is the only exception and must be documented locally.
- Use lowerCamelCase for TypeScript identifiers and UpperCamelCase for types. Preserve snake_case only for externally defined protocol, JSON, SQL, or generated field names.
- Use `import type` and `export type` for type-only references. Document every top-level export in non-generated source with JSDoc; also document any property or method whose purpose is not immediately obvious from its name and type.
- Run `npm run format:check` before review. It checks both Prettier conformance and the 200-column limit.

## Stack and Language Boundary

Two services, one database. Rationale and rejected alternatives: [ADR-001](doc/design/adr/adr-001-engine-language-split.md).

- **TypeScript** — engine service: planner loop, event vocabulary as discriminated unions, the canonical projection pipeline, check-rules, prompt assembly, refine loop, model adapters, and replay testing.
- **Go** — coordinator service: transaction brackets, timeout sweeping, orphan-try detection, the tool executor, and tool adapters that must live inside existing Go infrastructure.
- **PostgreSQL** — the event log and harness-state. It allocates `seq`, so the two services need no coordination protocol. Work handoff uses `SELECT … FOR UPDATE SKIP LOCKED` or `LISTEN/NOTIFY`; do not introduce a message broker before there is load that requires one.
- No third language in the engine without a new ADR.

### The boundary is the log

The two services never call each other's internals. They communicate only by appending events, and each owns an exclusive set of event types:

| Owner | Exclusive write access |
|---|---|
| TS engine | `run/start`, `run/end`, `run/end-seed`, `subgraph/proposed`, `subgraph/frozen`, `subgraph/rejected`, `subgraph/shadowed`, `replan/boundary`, `fork/created`, `vertex/created`, `budget/charged` |
| Go coordinator | `vertex/started`, `vertex/succeeded`, `vertex/failed`, `vertex/retried`, `txn/scope`, `txn/try`, `txn/confirm`, `txn/cancel`, `txn/pivot-passed` |

29. **Enforce event ownership at the append boundary** in both services. A service appending an event type it does not own is a bug, not a shortcut.
30. **Canonical projections have exactly one implementation, in TypeScript.** `surface`, `slice`, `fold`, `linearize`, and `assemble` may never be reimplemented in Go. Reason: a second implementation of the projection semantics produces the worst available bug class — two projectors that disagree on an edge case — and it makes discipline 3 (identical recomputation) and discipline 24 (`projector_version` attribution) unverifiable.
30a. **The engine is domain-neutral, and mocks are test-only.** The canonical pipeline owns generic reducer registration, deterministic dispatch, and projection mechanics only. A mock business world, mock reducer, mock view, or mock oracle belongs under `test/mocks/`, not under `engine/` or a production `domain/` package. Reason: importing a SKU, carrier, payment, or any other business concept into the engine turns a reusable safety boundary into an e-commerce-specific implementation; promoting a verification fake to `domain/` makes tests look like production business behavior.
31. **Operational projections may live in either service.** Narrow, local folds that serve execution or operations — unmatched `txn/try` scanning, timeout sweeps, executor readiness checks — are not canonical projections. They do not feed a prompt, do not participate in attribution, and are independently testable. Discipline 30 restricts planner-context projection, not log reading in general; the Go coordinator is expected to read the log.
32. **Replay testing lives wherever the projector lives**, i.e. in TypeScript, because it must exercise the same code as production. Batch historical recomputation is also driven by the canonical projector: scale it by sharding on `run_id` across worker processes, or push a fold down into SQL. Never by porting the projector.
33. **The event schema is a shared, versioned artifact** — a schema-first IDL in the repository with generated types for both languages. A field change means editing the schema and regenerating, never editing one side's types.
34. **Cross-language conformance tests are required** for any log-reading semantics both services implement: golden log fixtures plus expected outcomes that both readers must satisfy. Fail-closed behavior on an unknown `event_type` without an `ignorable` flag is a mandatory fixture.

Add to the review checklist:

- Appends an event type owned by the other service.
- Reimplements a canonical projection layer outside TypeScript.
- Imports a business semantic into the engine framework, or places a mock business semantic outside `test/mocks/`.
- Changes the event schema in one language's types instead of in the shared IDL.
- Adds log-reading semantics shared by both services without a conformance fixture.
