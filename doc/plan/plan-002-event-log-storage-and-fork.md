# Plan 002: Event Log Storage and Fork API Implementation

> Status: Done | Implements: [ADR-005](../adr/adr-005-lazy-causal-fork-semantics.md) | Specifications: [01](../design/01-jit-dag-and-event-log.md), [05](../design/05-context-aggregation-and-offline-evaluation.md), [06](../design/06-validation-harness.md), [08](../design/08-database-schema.md)

## Delivered Scope

The repository now has a Node 22 TypeScript storage core that runs against any PostgreSQL 16-or-newer server, provisioned either by `npm run db:bootstrap` on an existing server or by the optional [`docker/compose.yml`](../../docker/compose.yml) container. Its IDL is [`idl/event-log.schema.json`](../../idl/event-log.schema.json), with generated TypeScript and Go contract models. Migrations create the append-only event log, per-run sequence allocator, transaction projections, work queue, application roles, and database guards.

`EventStore` exposes run creation, atomic append, atomic frozen-subgraph append, ordered stream reads, and the lazy causal fork of [ADR-005](../adr/adr-005-lazy-causal-fork-semantics.md). A fork diverges at any vertex, records full provenance, invalidates the divergence vertex's causal descendants so the fork regenerates that chain, copies the causal seed as read-only inherited events that keep their source `stream_seq`, substitutes only `pin_version`, and merges causally independent events lazily no further than `eval_up_to_seq`. Inherited-bracket protection keys on that provenance rather than on `run/end-seed` position ([08 §4](../design/08-database-schema.md)).

The TypeScript framework supplies pure surface, slice, generic reducer registration and dispatch, linearization, and assembly-hash stages. The E2E harness registers its test-only `fold://inventory@v1` mock from `test/mocks/ecommerce/`; no production domain implementation is included. The core harness implements Doc 06's storage-relevant O2/O4 checks and fixtures, including replay identity and inherited-bracket protection.

## Verification Contract

`npm run verify` checks generated artifacts, TypeScript compilation, unit projections, and PostgreSQL integration tests. `.github/workflows/event-log.yml` runs the same path with PostgreSQL 17 in CI. Local setup is `npm ci` plus `npm run db:setup`, against either an existing server or the optional `npm run db:up` container.

## Completion Boundary

This completed plan owns the event-log storage core, canonical TypeScript projections, and lazy causal fork API. The Distributed Transaction Coordinator was delivered under [Plan 003](./plan-003-distributed-transaction-coordinator.md), and the tool-service execution route under [Plan 004](./plan-004-tool-registry-gateway.md). The generic scripted runner, complete oracle implementation, live-model qualification, and remaining S1–S14 runtime scenarios stay tracked by [Doc 06](../design/06-validation-harness.md); none may reimplement the canonical projection pipeline or bypass the assigned database roles.
