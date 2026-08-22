# Go Coordinator Architecture (07)

> Status: Draft v0.1 | Depends on: [01-jit-dag-and-event-log](./01-jit-dag-and-event-log.md), [02-transaction-model](./02-transaction-model.md), [ADR-001](./adr/adr-001-engine-language-split.md)

## 1. Overview

The Flory engine architecture separates the "brain" (planning, policy, and projection) from the "hands" (execution and transaction coordination). While the TypeScript Engine handles the former, the **Go Coordinator** is a timer-dense, long-running background daemon responsible for the latter.

> **Diagram**: See [go-ts-interaction.drawio](./diagrams/go-ts-interaction.drawio) for a visual overview of the interaction between the Go Coordinator and TS Engine.

Its core mission is to guarantee the reliable execution of tool-calling side effects (especially those moving inventory and money) and to enforce the TCC (Try-Confirm-Cancel) and Pivot-Saga state machine safely.

## 2. Core Modules and Responsibilities

The Coordinator is composed of four main internal modules:

### 2.1 Log Reader & Operational Projections
- **Responsibility**: Listens to the PostgreSQL event log and builds partial, operational views of the system.
- **Constraints**: It constructs *only* local folds required for execution (e.g., unmatched `txn/try` scanning, executor readiness checks). It **must never** reimplement the canonical projection pipeline (`surface`, `slice`, `fold`, `linearize`) which strictly belongs to the TS Engine.

### 2.2 Transaction Lifecycle Manager (Bracket Manager)
- **Responsibility**: Manages long-running transaction brackets.
- **Key Operations**:
  - Processes transaction events: `txn/scope`, `txn/try`, `txn/confirm`, `txn/cancel`, `txn/pivot-passed`.
  - **Pivot Barrier Enforcement**: Intercepts the execution flow before a pivot (irreversible) node fires, ensuring all preceding pre-pivot tries in the scope have successfully closed.
  - **Compensation Routing**: In the event of retries exhausting, it routes failure signals to trigger idempotent rollback (delta-based compensation) back to the scope's savepoint.

### 2.3 Timeout Sweeper & Orphan-try Detector
- **Responsibility**: Prevents resource deadlocks and leaks.
- **Key Operations**:
  - Leverages Go's lightweight goroutines and timers to track thousands of in-flight `try_timeout_s` deadlines.
  - Scans live runs for `txn/try` brackets that remain unsealed (no matching confirm/cancel) past their timeout.
  - Appends an idempotent `cancel` to release real holds out from under abandoned or crashed executions.

### 2.4 Tool Executor & Business Adapters
- **Responsibility**: Performs the actual network I/O and interaction with downstream e-commerce/business systems.
- **Key Operations**:
  - Manages the vertex execution lifecycle, emitting `vertex/started`, `vertex/succeeded`, `vertex/failed`, and `vertex/retried`.
  - Executes idempotent retries based on the static `retry_policy` (max attempts, backoff) declared in the tool's registry.
  - Wraps existing infrastructure adapters (e.g., inventory reservation, payment gateways) using standard Go observability and context management.

## 3. Internal Module Interactions

1. **New Task Ingestion**: The **Log Reader** picks up a new `vertex/created` event (appended by TS Engine) containing tool execution metadata and transaction attributes (`effect_class`, `retry_policy`, `try_timeout_s`).
2. **Execution vs. Barrier**:
   - If the vertex is a Try or Saga step, the **Tool Executor** attempts the call. If successful, a `txn/try` is recorded.
   - If the vertex is a Pivot (`irreversible`), the **Transaction Lifecycle Manager** blocks execution at a barrier until it verifies all preceding tries in the scope are securely locked.
3. **Sweeper Intervention**: Simultaneously, the **Timeout Sweeper** monitors all open tries. If the Executor hangs or the node crashes before sealing the try, the Sweeper wakes up and forcibly pushes a `txn/cancel` through the Lifecycle Manager.

## 4. Interaction with the TS Engine

As dictated by ADR-001, the TypeScript Engine and Go Coordinator **never** communicate via internal RPC. They share no mutable memory.

### 4.1 The Boundary is the Log
All interaction happens asynchronously via the PostgreSQL `event_log` table. Handoff is achieved efficiently using `SELECT ... FOR UPDATE SKIP LOCKED` or `LISTEN/NOTIFY`. The physical tables, synchronous operational projections, indexes, and database constraints are specified in [08](./08-database-schema.md).

### 4.2 Exclusive Write Access
To prevent race conditions and enforce clear ownership, each service exclusively owns a subset of event types. A service appending an event type it does not own is treated as a fatal bug.

**TypeScript Engine Owns (Planning & Structure):**
- `run/start`, `run/end`, `run/end-seed`
- `subgraph/proposed`, `subgraph/frozen`, `subgraph/rejected`, `subgraph/shadowed`
- `replan/boundary`, `fork/created`, `vertex/created`, `budget/charged`

**Go Coordinator Owns (Execution & State Machine):**
- `vertex/started`, `vertex/succeeded`, `vertex/failed`, `vertex/retried`
- `txn/scope`, `txn/try`, `txn/confirm`, `txn/cancel`, `txn/pivot-passed`

### 4.3 Error Handling and Replanning
If the Go Coordinator exhausts all retries for a pre-pivot vertex, it executes necessary local compensations (cancels) to return to the savepoint. It then records a `vertex/failed` (and related `txn/cancel`). The TS Engine reads this failure, recognizes the blockage, and responds by issuing a `replan/boundary` (in-place replan) to generate a new subgraph bypassing the failure.
