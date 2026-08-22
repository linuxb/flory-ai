# Distributed Transaction Coordinator Architecture (07)

> Status: Active v0.2 | Depends on: [01-jit-dag-and-event-log](./01-jit-dag-and-event-log.md), [02-transaction-model](./02-transaction-model.md), [ADR-001](./adr/adr-001-engine-language-split.md)

## 1. Overview

The Distributed Transaction Coordinator is Flory's execution and transaction-safety service. The TypeScript Engine plans and projects; the Coordinator claims executable vertices, calls adapters, and enforces TCC and pivot-saga rules. Go 1.25 is an implementation choice recorded in ADR-001, not part of the component's identity or public protocol.

See [coordinator-engine-interaction.drawio](./diagrams/coordinator-engine-interaction.drawio) for the service boundary and event flow.

## 2. Runtime Contract

A successful TCC try appends `txn/try` and creates a **sealed, half-open bracket**. Sealed means that the resource is reserved or frozen and the try may participate in a pivot barrier. It does not mean that TCC confirm has run.

The pivot barrier admits an irreversible vertex only when every required predecessor try in the scope is sealed and no scope cancellation has started. The pivot then runs. After `txn/pivot-passed` is durably appended, the Coordinator confirms the sealed TCC members with idempotent, retryable confirm operations.

If any pre-pivot try fails, the Coordinator fences the whole scope against pivot admission and starts one scope-level cancellation. It cancels every sealed TCC member and compensates every completed Saga member in reverse dependency order. `txn/cancel` describes that scope action with `requested` and `completed` phases; it never means "cancel one try". The completed phase is appended only after every required inverse operation succeeds.

## 3. Modules

### 3.1 Work Scheduler

The scheduler claims ready work through PostgreSQL `FOR UPDATE SKIP LOCKED`, maintains recoverable leases, and evaluates parent completion. Confirmation barriers are runtime vertices: they wait for all required tries to become sealed, abort when the scope starts cancelling, and never call a business adapter.

### 3.2 Transaction Lifecycle Manager

The lifecycle manager owns scope states `open`, `cancelling`, `pivot-inflight`, `pivot-passed`, `committed`, `cancelled`, and `suspended`. Safety-critical transitions use database functions that lock the synchronous projection and append the corresponding event in one transaction.

### 3.3 Tool Executor

The executor calls adapters with a frozen idempotency key and deterministic retry policy. An unknown pivot outcome is resolved only through the pivot's registered status-query operation. After a pivot, retries are forward-only; exhausting the frozen policy suspends the scope for human intervention.

### 3.4 Orphan Sweeper

The sweeper finds sealed brackets past their deadline and requests cancellation for the owning scope. It races safely with confirm through row-locked compare-and-set functions. Restart recovery reads projections and expired leases; no correctness-critical timer exists only in memory.

## 4. Adapter Boundary

Adapters implement one JSON operation contract over HTTP. Requests carry the run, vertex, attempt number, tool reference, idempotency key, and immutable input. Responses are one of `succeeded`, `retryable-failure`, `permanent-failure`, or `unknown`. Production adapters may use any downstream protocol behind that boundary.

The test sandbox is an out-of-process adapter service with deterministic fault injection keyed by `(seed, tool, attempt_no)`. It exposes reset and oracle snapshots only in tests.

## 5. Interaction with the Engine

The event log remains the only Engine/Coordinator boundary. The Coordinator owns `vertex/started`, `vertex/succeeded`, `vertex/failed`, `vertex/retried`, and `txn/*`; the Engine owns planning and structure events. The Coordinator may build operational projections for execution, but it must not implement `surface`, `slice`, `fold`, `linearize`, or `assemble`.

On a pre-pivot terminal failure, scope cancellation completes before the Engine may append a legal `replan/boundary`. On a post-pivot terminal failure, the Coordinator records suspension; it never compensates backward across `txn/pivot-passed`.
