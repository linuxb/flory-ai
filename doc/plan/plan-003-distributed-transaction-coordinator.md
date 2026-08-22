# Plan 003: Distributed Transaction Coordinator

- **Status:** Done
- **Date:** 2026-08-22
- **Implements:** [ADR-001](../design/adr/adr-001-engine-language-split.md), [ADR-003](../design/adr/adr-003-formal-verification-of-the-transaction-protocol.md)
- **Specifies:** [02 transaction model](../design/02-transaction-model.md), [07 Coordinator architecture](../design/07-distributed-transaction-coordinator.md)

## 1. Objective

Deliver the PostgreSQL-backed Distributed Transaction Coordinator, implemented with Go 1.25, plus an out-of-process deterministic HTTP sandbox. The component name is language-neutral; Go is an implementation choice.

## 2. Protocol Baseline

A successful `txn/try` is sealed and half-open. A pivot waits for every required try to become sealed, records `txn/pivot-passed`, and only then confirms the TCC members. Any pre-pivot failure fences the whole scope and starts one scope-level cancellation that reverses every sealed TCC member and completed Saga member.

## 3. Delivery Increments

1. Rewrite the protocol descriptions and extend Stage S2 formal checks before relying on the runtime implementation.
2. Version the runtime payloads in the shared IDL and add synchronous PostgreSQL scope, bracket, queue, and lease transitions.
3. Implement the scheduler, lifecycle manager, HTTP executor, retry policy, orphan sweep, and recovery loop.
4. Promote the deterministic commerce world to an HTTP sandbox and complete Phase 2 integration scenarios.
5. Run TypeScript, Go race, PostgreSQL, TLC, Apalache, link, XML, and workflow validation in CI.

## 4. Exit Criteria

- A pivot never starts while a required try is unsealed or while cancellation is active.
- Scope cancellation is idempotent and recoverable across process crashes.
- TCC confirm occurs only after `txn/pivot-passed` and remains safe under duplicate delivery.
- S11, S11b, S12, runtime barrier, delta compensation, and cross-language conformance tests pass.
- No Coordinator path writes an Engine-owned event or implements a canonical projection.

## 5. Exclusions

Production inventory, payment, logistics, and channel adapters are not included. PostgreSQL 17 remains the only coordination store, and no message broker or internal Engine/Coordinator RPC is introduced.
