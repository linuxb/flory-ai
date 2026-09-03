# Flory

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="doc/animations/architecture-dark.gif">
    <source media="(prefers-color-scheme: light)" srcset="doc/animations/architecture-light.gif">
    <img src="doc/animations/architecture-light.gif" width="100%"
         alt="Animated Flory architecture: a planner proposes a sub-DAG against one frozen tool view; checkSubDag admits it against rules R1-R11 and the frozen subgraph is appended to the append-only event log; the Agent Orchestrator claims the read-only vertices and the Distributed Transaction Coordinator claims every effectful one; through gatewayd a TCC try seals a bracket on the inventory and payment services, a pivot barrier holds until every try is sealed, the irreversible logistics booking runs, txn/pivot-passed closes a one-way gate, and the sealed members confirm.">
  </picture>
</p>

<p align="center">
  <sub>
    one log for the DAG and the transaction brackets &nbsp;·&nbsp; the rules admit a plan, the model never does &nbsp;·&nbsp; past the pivot, recovery only moves forward<br>
    diagram source: <a href="doc/animations/src"><code>doc/animations/src</code></a>
  </sub>
</p>

Flory is a design for an AI harness orchestration engine for AI-driven e-commerce. It supports workflows spanning supplier operations (product selection, procurement, and inventory) and sales channels (pricing, listings, orders, and logistics).

The system is designed for the difficult boundary between probabilistic LLM planning and irreversible business effects. It combines just-in-time DAG planning with append-only event logging, deterministic transaction validation, and recovery-aware execution.

## Status

This repository contains the architecture and design baseline plus an executable core: immutable event storage, canonical projections, offline forks, deterministic Doc 02 check-rules R1-R11, and T-A harness tests in TypeScript on PostgreSQL; the Distributed Transaction Coordinator and the `gatewayd` Tool Registry Gateway in Go 1.25. Test-only inventory, payment, logistics, and channel tool services register with the gateway through the SDK and exercise complex e-commerce DAG admission, barrier placement, and gateway-routed execution. Production business adapters remain out of scope.

## Architecture at a glance

- **TypeScript engine:** owns the planner loop, canonical context-projection pipeline, check rules, prompt assembly, refine loop, model adapters, and replay testing.
- **Distributed Transaction Coordinator:** owns transaction scopes, runtime barriers, timeout handling, tool execution, and business-adapter orchestration. Its current implementation uses Go 1.25.
- **`gatewayd`:** publishes immutable, content-addressed tool views and routes exactly one requested tool call, without taking ownership of planning, retries, or transaction events. It speaks MCP to the executors and gRPC to tool services.
- **Tool-service SDK:** what a tool service embeds to declare its contracts, register them, heartbeat, and serve execution. Available for Go and TypeScript from one generated contract.
- **PostgreSQL:** stores the append-only event log and metadata-only harness state, and allocates the write-order sequence.
- **The event log is the boundary:** the services do not call each other's internals. They coordinate only by appending the event types they own. Execution events belong to the vertex's executor: read-only vertices are the Orchestrator's, everything else is the Coordinator's, and the database enforces the split.

Planner thought calls use a provider-neutral adapter configured through `FLORY_LLM_*`. Set a complete OpenAI Chat Completions-compatible or Anthropic Messages-compatible endpoint, its exact model ID, and either `FLORY_LLM_API_KEY` or the safer local `FLORY_LLM_API_KEY_FILE`. See [.env.example](.env.example) for the full configuration, including optional provider request fields and auditable pricing snapshots. Successful calls record measured duration, normalized provider token usage, and optional estimated cost in `budget/charged`; secrets and raw prompts or completions are not event payloads.

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
go -C gatewayd test ./...
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

### Running the gateway-mediated topology

Every tool call goes through `gatewayd`. `npm run e2e:up` brings the topology up in dependency order — the gateway, then the four mock tool services, which register themselves through the SDK — and finishes once the gateway reports a published tool view:

```sh
npm run e2e:up
```

It defaults to in-memory tool-view storage, which needs nothing installed but loses every published view on restart. To use a GCS-compatible store instead, point it at an emulator:

```sh
docker run -d --rm -p 4443:4443 fsouza/fake-gcs-server -scheme http -public-host localhost:4443
STORAGE_EMULATOR_HOST=http://localhost:4443 GATEWAYD_BLOB_BACKEND=gcs npm run e2e:up
```

`STORAGE_EMULATOR_HOST` must match the emulator's `-public-host`. When it does not, writes land but reads resolve to nothing, which looks like an empty bucket rather than a misconfiguration.

With the topology up, `GATEWAY_BASE_URL=http://127.0.0.1:8092 npx vitest run test/conformance/gateway-e2e.test.ts` exercises the live path, and `npm run record:tool-view` refreshes the recorded view the check-rule fixtures read. Then run the Coordinator with `go -C coordinator run ./cmd/coordinator`; its health endpoints default to `127.0.0.1:8091`. Production business adapters are intentionally not included.

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
| [`gatewayd` Tool Registry Gateway](doc/design/09-tool-registry-gateway.md)                          | Immutable tool views, dynamic registration, the SDK, and one-attempt routing. |

The README hero image is the animated architecture overview; its generator lives in [doc/animations/src](doc/animations/src). Architecture diagrams are available in [doc/diagram/](doc/diagram/). The [deployment architecture](doc/diagram/deployment-architecture.html) is the current deployment view; the [conceptual architecture overview](doc/diagram/architecture.html) remains a higher-level companion. Editable Draw.io diagrams cover [transaction boundaries](doc/diagram/txn-boundary.drawio), [replanning](doc/diagram/replan-flow.drawio), [projections](doc/diagram/projection.drawio), and [Coordinator/Engine interaction](doc/diagram/coordinator-engine-interaction.drawio).

## Repository layout

```text
.
├── .github/               # Repository automation and CI workflows
├── .env.example           # Overrideable local connection and service settings
├── AGENTS.md              # Contributor index, development rules, and review routes
├── coordinator/           # Go 1.25 Distributed Transaction Coordinator service
├── gatewayd/              # Go 1.25 Tool Registry Gateway and its Go tool-service SDK
├── db/                    # PostgreSQL migrations, bootstrap, and migration utilities
├── docker/                # Optional containerized PostgreSQL for local development
├── doc/
│   ├── adr/               # Architecture decision records
│   ├── animations/        # Animated architecture diagram and its generator
│   ├── design/            # Architecture and mechanism specifications
│   ├── diagram/           # HTML and Draw.io diagrams
│   └── plan/              # Implementation and rollout plans
├── spec/                  # TLA+ transaction-protocol model and TLC configurations
├── engine/                # TypeScript event store, projections, forks, and harness
├── idl/                   # Versioned shared contracts: the event-log JSON Schema and the gateway protobufs
├── sdk/                   # TypeScript tool-service SDK
├── package.json           # Node 22 scripts and dependencies
├── test/                  # Test-only mocks, domain fixtures, and validation helpers
├── .editorconfig          # Shared editor behavior
└── .gitignore             # Go and TypeScript generated artifacts
```

## Contributing

Read [AGENTS.md](AGENTS.md) before proposing implementation work. In particular:

- Keep repository documentation in English and use the established document locations.
- Propose and accept an ADR before implementing a large architecture change; then merge the accepted content into the authoritative design documents and remove every reference to the accepted ADR.
- Treat the event log as immutable ground truth.
- Preserve the TypeScript-only canonical projection pipeline.
- Add a replay test whenever planner, projection, or fold behavior changes.
- Preserve rejected alternatives in the design document when an ADR is accepted.
