# Plan 002: Event Log Storage and Fork API Implementation

> Status: Implemented storage-core v0.1 | Implements: [ADR-004](../design/adr/adr-004-case-specific-offline-fork-evaluation.md) | Specifications: [01](../design/01-jit-dag-and-event-log.md), [05](../design/05-context-aggregation-and-offline-evaluation.md), [06](../design/06-validation-harness.md), [08](../design/08-database-schema.md)

## Delivered Scope

The repository now has a Node 22 TypeScript storage core and Docker PostgreSQL 17 development environment. Its IDL is [`idl/event-log.schema.json`](../../idl/event-log.schema.json), with generated TypeScript and Go contract models. Migrations create the append-only event log, per-run sequence allocator, transaction projections, work queue, application roles, and database guards.

`EventStore` exposes run creation, atomic append, atomic frozen-subgraph append, ordered stream reads, and offline fork. A fork locks and freezes the source tail, records full provenance, copies only recorded events, substitutes only `pin_version`, and seals inherited history with `run/end-seed`.

The TypeScript framework supplies pure surface, slice, generic reducer registration and dispatch, linearization, and assembly-hash stages. The E2E harness registers its test-only `fold://inventory@v1` mock from `test/mocks/ecommerce/`; no production domain implementation is included. The core harness implements Doc 06's storage-relevant O2/O4 checks and fixtures, including replay identity and inherited-bracket protection.

## Verification Contract

`npm run verify` checks generated artifacts, TypeScript compilation, unit projections, and PostgreSQL integration tests. `.github/workflows/event-log.yml` runs the same path with PostgreSQL 17 in CI. Local setup is `docker compose up -d --wait postgres`, `npm ci`, then `npm run db:migrate`.

## Deferred Work

This increment does not implement the Distributed Transaction Coordinator, business-tool sandbox, scripted planner, recovery/check-rule engine, live-model tier, or the full Doc 06 S1–S14 scenario matrix. Those components must consume the existing IDL and append only through their assigned database role; they may not reimplement the TypeScript canonical projection pipeline.
