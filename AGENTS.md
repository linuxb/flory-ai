# Repository Guidelines

## Documentation

- Write all repository documentation in English.
- Keep design documents in `doc/design/`, architecture decision records in `doc/adr/`, and planning documents in `doc/plan/`.
- Write a `Proposed` ADR before starting a large architecture change. Changes to component boundaries, ownership, protocols, persistence models, or cross-service contracts require the proposal to be accepted before implementation begins.
- An ADR proposal must record its context, proposed decision, rationale, consequences, and rejected alternatives in `doc/adr/adr-NNN-short-slug.md`. Number proposals sequentially, never reuse or renumber an identifier, and write a new proposal when changing an accepted architecture decision.
- When an ADR is accepted, merge every surviving decision, rationale, consequence, and rejected alternative into the existing authoritative design documents in the same change. Replace every reference to the accepted ADR with a design-document reference. Accepted ADRs are no longer authoritative, must not be referenced anywhere in the repository, and may be deleted as soon as the merge is complete; Git history preserves the review record.
- Store design diagrams in `doc/diagram/`.
- Prefer self-contained HTML for architecture diagrams. Use Draw.io (`.drawio`) for focused mechanism diagrams that need to remain editable.
- Keep related charts on one Draw.io sheet as labelled regions (`A. …`, `B. …`) on an enlarged page. Use another sheet only for a genuinely unrelated subsystem.
- Every diagram must adapt to light and dark themes: use `background="none"` on Draw.io canvases and provide a Light/Dark/Auto toggle in standalone HTML. Keep the semantic colour palette; only canvas surfaces and neutral ink adapt to the theme. A monochrome diagram is a regression.
- Keep diagram labels, captions, and surrounding documentation in English.
- Use relative links between documentation files so the documentation remains portable.
- Rewrite an affected documentation section as a coherent current design. Delete superseded statements instead of appending corrections or historical commentary.
- Keep the root `README.md` repository-layout tree synchronized whenever a top-level directory is added, removed, or repurposed, and state the directory's role.
- Keep `.github/workflows/formal-verification.yml` aligned with the transaction protocol's source documents. A change to a transaction discipline, invariant, admission rule, recovery rule, or oracle expectation must add its source document to the workflow's `paths` filter in the same change. Keep `AGENTS.md` and the workflow file itself in that filter.
- Keep this file as a thin contributor index. Architecture details, protocol fields, algorithms, event lists, and rationale belong in the linked design documents and ADRs; do not duplicate them here.

## Architecture Index

The linked design documents are authoritative. Active ADRs are proposals only; the summaries below identify ownership and review routes and are not substitute specifications.

| Area | Contributor summary | Authoritative sources |
|---|---|---|
| System overview | The system combines a JIT-DAG engine, an append-only event log, transaction coordination, tool discovery, and replayable evaluation. | [Design overview](doc/design/00-overview.md) |
| Event log and storage | The log is immutable ground truth; projections are recomputable, safety-critical guards are synchronous, and database constraints enforce expressible invariants. | [Doc 01 §3](doc/design/01-jit-dag-and-event-log.md#3-event-log-storage-model), [Doc 08](doc/design/08-database-schema.md) |
| Projection pipeline | Canonical context projection is deterministic, pure, versioned, and implemented once in TypeScript. | [Doc 01 §4](doc/design/01-jit-dag-and-event-log.md#4-surface-projection-and-linearization), [Doc 05 §2](doc/design/05-context-aggregation-and-offline-evaluation.md#2-projection-pipeline) |
| Transactions and recovery | Deterministic admission rules govern TCC and pivot-saga execution; recovery and replanning preserve transaction boundaries. | [Doc 02](doc/design/02-transaction-model.md), [Doc 03](doc/design/03-replan-and-recovery.md), [Doc 07](doc/design/07-distributed-transaction-coordinator.md) |
| Replanning and forks | Online replanning stays in the source stream; forks are offline, causal counterfactuals evaluated against one history. | [Doc 01 §5](doc/design/01-jit-dag-and-event-log.md#5-replanning-in-place-and-forking-for-offline-evaluation), [Doc 05 §3](doc/design/05-context-aggregation-and-offline-evaluation.md#3-counterfactual-evaluation-by-fork) |
| Harness state and refine | Harness state contains versioned metadata and references; refine produces validated structured edits. | [Doc 04](doc/design/04-refine-and-harness-state.md) |
| Validation and formal verification | Scenario oracles, replay properties, and formal models define the protocol's verification surface. | [Doc 06](doc/design/06-validation-harness.md) |
| Tool registry gateway | `gatewayd` publishes immutable tool views and routes one pinned attempt; registration and execution use the repository SDK and IDL contracts. | [Doc 09](doc/design/09-tool-registry-gateway.md) |
| Language and service boundaries | The TypeScript engine, Go coordinator, Go gateway, and PostgreSQL store remain separate components with schema-first shared contracts. | [Doc 00 §3](doc/design/00-overview.md#3-overall-architecture), [Doc 07](doc/design/07-distributed-transaction-coordinator.md), [Doc 09](doc/design/09-tool-registry-gateway.md) |

### Component and contract routes

| Component or contract | Repository location | Design route |
|---|---|---|
| TypeScript engine | `engine/` | [Doc 00 §3.1](doc/design/00-overview.md#31-service-and-language-boundaries), [Doc 01](doc/design/01-jit-dag-and-event-log.md), [Doc 05](doc/design/05-context-aggregation-and-offline-evaluation.md) |
| Distributed Transaction Coordinator (Go 1.25) | `coordinator/` | [Doc 00 §3.1](doc/design/00-overview.md#31-service-and-language-boundaries), [Doc 02](doc/design/02-transaction-model.md), [Doc 07](doc/design/07-distributed-transaction-coordinator.md) |
| `gatewayd` (Go 1.25) | `gatewayd/` | [Doc 09](doc/design/09-tool-registry-gateway.md) |
| Tool-service SDKs and shared IDLs | `gatewayd/sdk/`, `sdk/typescript/`, `idl/` | [Doc 09 §3](doc/design/09-tool-registry-gateway.md#3-registration-and-the-tool-view-contract), [Doc 08 §1](doc/design/08-database-schema.md#1-executable-boundary) |
| PostgreSQL schema and migrations | `db/` | [Doc 08](doc/design/08-database-schema.md) |

Do not add a third engine language without a new ADR. Components must use their documented public boundaries rather than importing or calling another component's internals. Shared contract changes start in `idl/`; regenerate every consumer and update required conformance fixtures in the same change.

## Review Gates

Use these as routing checks, then review the linked specification. Reject a change that:

- Mutates event history, folds over the global operational sequence, silently accepts an unknown event type, or updates a side-effect-gating projection asynchronously. See [Doc 01 §3](doc/design/01-jit-dag-and-event-log.md#3-event-log-storage-model) and [Doc 08](doc/design/08-database-schema.md).
- Adds I/O, clock reads, randomness, or ambient configuration to canonical projection code; reimplements that pipeline outside TypeScript; or makes a reducer order-sensitive over concurrent events. See [Doc 01 §4](doc/design/01-jit-dag-and-event-log.md#4-surface-projection-and-linearization) and [Doc 05 §2](doc/design/05-context-aggregation-and-offline-evaluation.md#2-projection-pipeline).
- Creates a child run for online replanning, lets an offline fork mutate inherited work or execute writes, or treats unrelated business cases as causal comparison samples. See [Doc 01 §5](doc/design/01-jit-dag-and-event-log.md#5-replanning-in-place-and-forking-for-offline-evaluation), [Doc 03](doc/design/03-replan-and-recovery.md), and [Doc 05](doc/design/05-context-aggregation-and-offline-evaluation.md).
- Bypasses deterministic transaction admission, compensates backward across a pivot, replans across an open try, or restores absolute snapshots during compensation. See [Doc 02](doc/design/02-transaction-model.md), [Doc 03](doc/design/03-replan-and-recovery.md), and [Doc 07](doc/design/07-distributed-transaction-coordinator.md).
- Stores prompt prose or raw memory in harness state, or turns refine into an unstructured prompt rewrite. See [Doc 04](doc/design/04-refine-and-harness-state.md).
- Violates derived executor or event ownership, lets `gatewayd` append events or own retries, or hand-rolls the gateway registration protocol instead of using its SDK. See [Doc 01 §3.2.1](doc/design/01-jit-dag-and-event-log.md#321-which-executor-owns-a-vertex), [Doc 08 §3](doc/design/08-database-schema.md#3-write-time-guards), and [Doc 09](doc/design/09-tool-registry-gateway.md).
- Changes generated shared types instead of their IDL source, or omits a conformance fixture for shared cross-language semantics. See [Doc 00 §3.2](doc/design/00-overview.md#32-boundary-rationale-costs-and-alternatives), [Doc 08 §1](doc/design/08-database-schema.md#1-executable-boundary), and [Doc 09 §7](doc/design/09-tool-registry-gateway.md#7-the-two-routes-and-their-fixtures).
- Moves business semantics or verification mocks into the production engine. See [Doc 05 §2.2](doc/design/05-context-aggregation-and-offline-evaluation.md#22-semantic-fold-framework-mechanism-domain-owned-meaning) and [Doc 06 §3.5](doc/design/06-validation-harness.md#35-current-implementation-form).
- Changes planner, projection, reducer, protocol, or harness behaviour without the required version update and replay or oracle coverage. See [Doc 01 §6](doc/design/01-jit-dag-and-event-log.md#6-replay-testing), [Doc 05](doc/design/05-context-aggregation-and-offline-evaluation.md), and [Doc 06](doc/design/06-validation-harness.md).
- Patches a documentation section instead of rewriting it, leaves superseded content behind, or fails to update the formal-verification path filter when transaction semantics change.

## TypeScript and JavaScript Style

- Hand-written TypeScript and JavaScript must follow the [Google TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html). Generated sources are exempt except for identifiers consumed by hand-written code.
- Use UTF-8, LF line endings, four spaces for indentation, single-quoted strings, trailing commas, and no trailing whitespace. Apply the repository Prettier configuration; do not hand-format around it.
- The project line limit is **200 columns**. Wrap expressions, parameter lists, object literals, test fixtures, and JSON Schema declarations so every TypeScript, JavaScript, and IDL schema line stays within this limit. An unbreakable external URL or required wire literal is the only exception and must be documented locally.
- Use lowerCamelCase for TypeScript identifiers and UpperCamelCase for types. Preserve snake_case only for externally defined protocol, JSON, SQL, or generated field names.
- Use `import type` and `export type` for type-only references. Document every top-level export in non-generated source with JSDoc; also document any property or method whose purpose is not immediately obvious from its name and type.
- Run `npm run format:check` before review. It checks both Prettier conformance and the 200-column limit.
