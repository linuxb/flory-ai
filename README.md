# Flory

Flory is a design for an AI harness orchestration engine for AI-driven e-commerce. It supports workflows spanning supplier operations (product selection, procurement, and inventory) and sales channels (pricing, listings, orders, and logistics).

The system is designed for the difficult boundary between probabilistic LLM planning and irreversible business effects. It combines just-in-time DAG planning with append-only event logging, deterministic transaction validation, and recovery-aware execution.

## Status

This repository currently contains the architecture and design baseline. Implementation scaffolding has not yet been added.

## Architecture at a glance

- **TypeScript engine:** owns the planner loop, canonical context-projection pipeline, check rules, prompt assembly, refine loop, model adapters, and replay testing.
- **Go coordinator:** owns transaction brackets, timeout handling, tool execution, and adapters that operate within existing Go infrastructure.
- **PostgreSQL:** stores the append-only vertex log and metadata-only harness state, and allocates the write-order sequence.
- **The vertex log is the boundary:** the services do not call each other's internals. They coordinate only by appending the event types they own.

## Design guarantees

- The vertex log is ground truth: rows are append-only, and changed or replanned state is represented by new events.
- Planner-context projections are pure, deterministic, and implemented exactly once in TypeScript.
- Transaction safety is enforced by deterministic check rules; model self-review is never the authority.
- A pivot is a one-way gate: after an irreversible effect, recovery proceeds forward and never automatically compensates backward.
- Harness state stores versioned metadata only. Prompt prose and raw memory live outside it.
- Experiments are attributable by the recorded harness-state version, projector version, and arm identifier.

## Documentation

Start with the [design overview](doc/design/00-overview.md). The design series then covers:

| Document                                                                                            | Focus                                                                        |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [JIT DAG and vertex log](doc/design/01-jit-dag-and-vertex-log.md)                                   | DAG model, event schema, projections, in-place replanning, and dry-run forks. |
| [Transaction model](doc/design/02-transaction-model.md)                                             | TCC, pivot-saga, transaction boundaries, and check rules.                    |
| [Replanning and recovery](doc/design/03-replan-and-recovery.md)                                     | Failure handling, backtracking, rollback, and budget control.                |
| [Refine and harness state](doc/design/04-refine-and-harness-state.md)                               | Structured refinement, metadata-only state, and memory hints.                |
| [Context aggregation and experimentation](doc/design/05-context-aggregation-and-experimentation.md) | Canonical projections, semantic folds, replay, and A/B attribution.          |
| [Validation harness](doc/design/06-validation-harness.md)                                           | Sandbox contract, fault injection, scenario matrix, and correctness oracles. |

Architecture diagrams are available in [doc/design/diagrams/](doc/design/diagrams/): an interactive [architecture overview](doc/design/diagrams/architecture.html) and editable Draw.io diagrams for transaction boundaries, replanning, and projections.

## Repository layout

```text
.
├── .github/               # Repository automation and CI workflows
├── AGENTS.md              # Design invariants and contributor review checklist
├── doc/
│   ├── design/            # Architecture and mechanism specifications
│   │   ├── adr/           # Architecture decision records
│   │   └── diagrams/      # HTML and Draw.io diagrams
│   └── plan/              # Implementation and rollout plans
├── spec/                  # TLA+ transaction-protocol model and TLC configurations
├── .editorconfig          # Shared editor behavior
└── .gitignore             # Go and TypeScript generated artifacts
```

## Contributing

Read [AGENTS.md](AGENTS.md) before proposing implementation work. In particular:

- Keep repository documentation in English and use the established document locations.
- Treat the vertex log as immutable ground truth.
- Preserve the TypeScript-only canonical projection pipeline.
- Add a replay test whenever planner, projection, or fold behavior changes.
- Record decisions with rejected alternatives as a new ADR.
