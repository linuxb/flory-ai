# Flory

Flory is a design for an AI harness orchestration engine for AI-driven e-commerce. It supports workflows spanning supplier operations (product selection, procurement, and inventory) and sales channels (pricing, listings, orders, and logistics).

The system is designed for the difficult boundary between probabilistic LLM planning and irreversible business effects. It combines just-in-time DAG planning with append-only event logging, deterministic transaction validation, and recovery-aware execution.

## Status

This repository contains the architecture and design baseline plus an executable TypeScript/PostgreSQL core: immutable event storage, canonical projections, offline forks, deterministic Doc 02 check-rules R1-R11, and T-A harness tests. Test-only inventory, payment, logistics, and channel actors exercise complex e-commerce DAG admission and barrier placement. The Go coordinator, runtime barrier scheduler, fault injector, and full business-execution sandbox are not implemented yet.

## Architecture at a glance

- **TypeScript engine:** owns the planner loop, canonical context-projection pipeline, check rules, prompt assembly, refine loop, model adapters, and replay testing.
- **Go coordinator:** owns transaction brackets, timeout handling, tool execution, and adapters that operate within existing Go infrastructure.
- **PostgreSQL:** stores the append-only event log and metadata-only harness state, and allocates the write-order sequence.
- **The event log is the boundary:** the services do not call each other's internals. They coordinate only by appending the event types they own.

## Local development

Docker Compose provides a local PostgreSQL 17 service. It stores its data in the `postgres_data` named volume and exposes PostgreSQL only on `127.0.0.1`.

```sh
cp .env.example .env  # optional: change the local development credentials or port
docker compose up -d postgres
docker compose ps
npm ci
npm run db:migrate
npm run verify
```

The default connection string is `postgresql://flory:flory-dev-password@127.0.0.1:5432/flory`. Confirm access with:

```sh
docker compose exec postgres psql -U flory -d flory -c 'SELECT version();'
```

Stop the service with `docker compose down`. This preserves the named volume. To remove the local database as well, run `docker compose down -v`.

## Design guarantees

- The event log is ground truth: rows are append-only, and changed or replanned state is represented by new events.
- Planner-context projections are pure, deterministic, and implemented exactly once in TypeScript.
- Transaction safety is enforced by deterministic check rules; model self-review is never the authority.
- A pivot is a one-way gate: after an irreversible effect, recovery proceeds forward and never automatically compensates backward.
- Harness state stores versioned metadata only. Prompt prose and raw memory live outside it.
- Offline evaluations are reproducible from the recorded source position, substitutions, fold mode, evaluator pin, projector version, and harness-state version.

## Documentation

Start with the [design overview](doc/design/00-overview.md). The design series then covers:

| Document                                                                                            | Focus                                                                        |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [JIT DAG and event log](doc/design/01-jit-dag-and-event-log.md)                                   | DAG model, event schema, projections, in-place replanning, and offline forks. |
| [Transaction model](doc/design/02-transaction-model.md)                                             | TCC, pivot-saga, transaction boundaries, and check rules.                    |
| [Replanning and recovery](doc/design/03-replan-and-recovery.md)                                     | Failure handling, backtracking, rollback, and budget control.                |
| [Refine and harness state](doc/design/04-refine-and-harness-state.md)                               | Structured refinement, metadata-only state, and memory hints.                |
| [Context aggregation and offline evaluation](doc/design/05-context-aggregation-and-offline-evaluation.md) | Canonical projections, semantic folds, replay, and historical evaluation. |
| [Validation harness](doc/design/06-validation-harness.md)                                           | Sandbox contract, fault injection, scenario matrix, and correctness oracles. |
| [Go Coordinator Architecture](doc/design/07-go-coordinator.md)                                      | Go Coordinator responsibilities, event log interactions, and execution modules. |
| [Database schema and storage model](doc/design/08-database-schema.md)                               | Event log immutability, sequence allocation, and synchronous projections.   |

Architecture diagrams are available in [doc/design/diagrams/](doc/design/diagrams/): an interactive [architecture overview](doc/design/diagrams/architecture.html) and editable Draw.io diagrams for [transaction boundaries](doc/design/diagrams/txn-boundary.drawio), [replanning](doc/design/diagrams/replan-flow.drawio), [projections](doc/design/diagrams/projection.drawio), and [Go/TypeScript interaction](doc/design/diagrams/go-ts-interaction.drawio).

## Repository layout

```text
.
├── .github/               # Repository automation and CI workflows
├── .env.example           # Overrideable local PostgreSQL development settings
├── AGENTS.md              # Design invariants and contributor review checklist
├── coordinator/           # Generated Go event-contract model; no coordinator service yet
├── compose.yml            # Local PostgreSQL development service
├── db/                    # PostgreSQL migrations and local migration utilities
├── doc/
│   ├── design/            # Architecture and mechanism specifications
│   │   ├── adr/           # Architecture decision records
│   │   └── diagrams/      # HTML and Draw.io diagrams
│   └── plan/              # Implementation and rollout plans
├── spec/                  # TLA+ transaction-protocol model and TLC configurations
├── engine/                # TypeScript event store, projections, forks, and harness
├── idl/                   # Versioned event-log schema, shared by TypeScript and Go
├── package.json           # Node 22 scripts and dependencies
├── test/                  # Test-only mocks, domain fixtures, and validation helpers
├── .editorconfig          # Shared editor behavior
└── .gitignore             # Go and TypeScript generated artifacts
```

## Contributing

Read [AGENTS.md](AGENTS.md) before proposing implementation work. In particular:

- Keep repository documentation in English and use the established document locations.
- Treat the event log as immutable ground truth.
- Preserve the TypeScript-only canonical projection pipeline.
- Add a replay test whenever planner, projection, or fold behavior changes.
- Record decisions with rejected alternatives as a new ADR.
