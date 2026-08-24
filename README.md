# Flory

Flory is a design for an AI harness orchestration engine for AI-driven e-commerce. It supports workflows spanning supplier operations (product selection, procurement, and inventory) and sales channels (pricing, listings, orders, and logistics).

The system is designed for the difficult boundary between probabilistic LLM planning and irreversible business effects. It combines just-in-time DAG planning with append-only event logging, deterministic transaction validation, and recovery-aware execution.

## Status

This repository contains the architecture and design baseline plus an executable TypeScript/PostgreSQL core: immutable event storage, canonical projections, offline forks, deterministic Doc 02 check-rules R1-R11, and T-A harness tests. Test-only inventory, payment, logistics, and channel actors exercise complex e-commerce DAG admission and barrier placement. The Distributed Transaction Coordinator is implemented in Go 1.25; production business adapters remain out of scope.

## Architecture at a glance

- **TypeScript engine:** owns the planner loop, canonical context-projection pipeline, check rules, prompt assembly, refine loop, model adapters, and replay testing.
- **Distributed Transaction Coordinator:** owns transaction scopes, runtime barriers, timeout handling, tool execution, and business-adapter orchestration. Its current implementation uses Go 1.25.
- **`gatewayd` (proposed, Go 1.25 planned):** publishes immutable tool views and routes exact MCP tool calls without taking ownership of planning, retries, or transaction events.
- **PostgreSQL:** stores the append-only event log and metadata-only harness state, and allocates the write-order sequence.
- **The event log is the boundary:** the services do not call each other's internals. They coordinate only by appending the event types they own.

## Local development

Flory needs one PostgreSQL 16-or-newer server and does not care where it comes from. All connections
are derived from `DATABASE_URL`, so choose whichever path matches your machine; the remaining steps
are identical.

### Using a PostgreSQL server you already run

`npm run db:bootstrap` provisions the Flory roles and database inside an existing server, which keeps
a server shared with other projects untouched apart from those roles and that database. It needs
administrative credentials once: either the standard `PGUSER`/`PGPASSWORD` environment, or an
explicit `FLORY_ADMIN_DATABASE_URL`.

```sh
cp .env.example .env   # set DATABASE_URL if your server is not on 127.0.0.1:5432
npm ci
FLORY_ADMIN_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres npm run db:setup
```

`db:setup` runs `db:bootstrap` and then `db:migrate`. Both are idempotent. Only `db:bootstrap` uses
the administrative connection, because roles and databases are cluster-level objects; migrations run
as the owner role from `DATABASE_URL` and write only inside the Flory database.

### Using the optional container

Contributors without a local server can start one from [`docker/compose.yml`](docker/compose.yml).
The container creates the database and owner role itself, and because that owner is a superuser,
`db:setup` needs no administrative credentials here. Data lives in the `postgres_data` named volume,
and PostgreSQL is published only on `127.0.0.1`.

```sh
cp docker/.env.example docker/.env   # optional: change the container credentials or port
npm ci
npm run db:up
npm run db:setup
```

Stop it with `npm run db:down`, which preserves the volume. To discard the local data as well, run
`docker compose -f docker/compose.yml down -v`.

### Verifying

```sh
npm run verify
go -C coordinator test ./...
```

`npm run verify` reads `.env` automatically. Go does not, so export the two service connections when
running the Coordinator integration tests:

```sh
FLORY_INTEGRATION=1 ENGINE_DATABASE_URL=postgresql://engine_role:engine-dev-password@127.0.0.1:5432/flory COORDINATOR_DATABASE_URL=postgresql://coordinator_role:coordinator-dev-password@127.0.0.1:5432/flory go -C coordinator test ./...
```

Both integration suites claim from the same work queue — which is global by design, because one
worker pool serves every run — and both leave unfinished work behind. Each therefore expects an
empty database and fails after the other has run, or after a second consecutive run of itself. CI
never notices, because every job gets a fresh container. On a persistent local server, run
`npm run db:refresh` before each integration suite to drop and re-migrate the Flory schema:

```sh
npm run db:refresh && npm run verify
npm run db:refresh && go -C coordinator test ./...   # with the two URLs exported as above
```

For an end-to-end local execution, start the deterministic adapter sandbox with `npm run sandbox`, then run the Coordinator with `go -C coordinator run ./cmd/coordinator`. Its health endpoints default to `127.0.0.1:8091`; production business adapters are intentionally not included.

The default connection string is `postgresql://flory:flory-dev-password@127.0.0.1:5432/flory`. Confirm access with:

```sh
psql postgresql://flory:flory-dev-password@127.0.0.1:5432/flory -c 'SELECT version();'
```

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
| [Distributed Transaction Coordinator](doc/design/07-distributed-transaction-coordinator.md)         | Scope lifecycle, event-log interactions, barriers, execution, and recovery.      |
| [Database schema and storage model](doc/design/08-database-schema.md)                               | Event log immutability, sequence allocation, and synchronous projections.   |
| [`gatewayd` Tool Registry Gateway](doc/design/09-tool-registry-gateway.md)                          | Immutable tool views, dynamic registration, and one-attempt MCP routing.     |

Architecture diagrams are available in [doc/design/diagrams/](doc/design/diagrams/). The [deployment architecture](doc/design/diagrams/deployment-architecture.html) is the current deployment view; the [conceptual architecture overview](doc/design/diagrams/architecture.html) remains a higher-level companion. Editable Draw.io diagrams cover [transaction boundaries](doc/design/diagrams/txn-boundary.drawio), [replanning](doc/design/diagrams/replan-flow.drawio), [projections](doc/design/diagrams/projection.drawio), and [Coordinator/Engine interaction](doc/design/diagrams/coordinator-engine-interaction.drawio).

## Repository layout

```text
.
├── .github/               # Repository automation and CI workflows
├── .env.example           # Overrideable local connection and service settings
├── AGENTS.md              # Design invariants and contributor review checklist
├── coordinator/           # Go 1.25 Distributed Transaction Coordinator service
├── db/                    # PostgreSQL migrations, bootstrap, and migration utilities
├── docker/                # Optional containerized PostgreSQL for local development
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
