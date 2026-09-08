# ADR-007: Three-Tier Sequence Model, Two-Plane Storage Architecture, and Stream Snapshots

## Status
Proposed

## Context
Flory's original event log design was centered around a single execution run (`run_id`). Within a run, events followed a single partial-order sequence (`stream_seq`, which in reality functioned as `run_seq`), alongside a physical `global_seq`. 

While this model cleanly isolated the TypeScript Engine's orchestration control plane, it left significant gaps in the business domain and storage architecture:
1. **Cross-Run Business Continuity:** In real-world enterprise operations (e.g., e-commerce, customer service, postage), a single domain entity (such as an Order, Support Ticket, or Waybill) undergoes multiple distinct workflow runs over its lifecycle (e.g., Order Placed $\to$ Payment Processed $\to$ Return Requested $\to$ Refund Issued). Without a first-class business stream sequence, domain teams writing semantic projections (folds) must manually correlate disparate runs.
2. **PostgreSQL Partitioning Conflict:** The original `event_log` was hash-partitioned by `run_id`. Under PostgreSQL's declarative partitioning rules, a unique constraint on a partitioned table must include all partition key columns. A naive unique constraint on `(stream_id, stream_seq)` is physically impossible on a table partitioned by `run_id` without including `run_id`, which would destroy cross-run uniqueness enforcement.
3. **Offline Fork Contamination:** Flory's lazy causal forks create child runs for counterfactual evaluations. If forked runs write events to the real business stream, they either collide with sequence uniqueness or contaminate live business folds.
4. **Harness State Boundary Violation:** Storing raw business entity context directly in Harness State violates Doc 04, which mandates that Harness State contain only assembly metadata, policy references, and memory-query hints. Furthermore, dynamically re-folding business state during historical replay causes prompt drift as the entity stream advances over time.

This ADR completely redesigns the physical database schema and sequence model to resolve all four architectural gaps.

## Proposed Decision

### 1. Three-Tier Sequence Model
We formalize a three-tier sequence hierarchy that strictly decouples the orchestration control plane from the business data plane:

| Sequence | Scope & Plane | Authority & Usage |
|---|---|---|
| **`run_seq`** | Run Scope (Orchestration Plane) | Maintained strictly by the TypeScript Engine per `run_id`. Enforces partial order for DAG surface folding, JIT node creation, and transaction bracket tracking within a single workflow. |
| **`stream_seq`** | Business Entity Scope (Data Plane) | Maintained per `stream_id` (e.g., `order:12345`). Provides an immutable, monotonically increasing partial order of all domain events across all historical workflow runs for that business entity. Used for domain semantic projections. |
| **`global_seq`** | Storage Scope (Physical Plane) | Database-assigned global serial sequence. Used exclusively for physical replication, Change Data Capture (CDC) to data warehouses, and physical debugging. |

### 2. Two-Plane Database Storage Architecture
Rather than patching the legacy schema with conflicting partition keys, we redesign the database architecture into two complementary storage planes:

```
                  ┌─────────────────────────────────────────────────────────┐
                  │                 PostgreSQL Database                     │
                  │                                                         │
  Orchestration   │  ┌───────────────────────────────────────────────────┐  │
  Plane           │  │ run_event_log (PARTITION BY HASH run_id)          │  │
  (Engine)        │  │ - Primary key: (run_id, run_seq)                  │  │
                  │  │ - Stores: subgraph/*, vertex/*, replan/*          │  │
                  │  └───────────────────────────────────────────────────┘  │
                  │                                                         │
  Business        │  ┌───────────────────────────────────────────────────┐  │
  Plane           │  │ business_event_stream (PARTITION BY HASH stream_id)│ │
  (Domain Fold)   │  │ - Primary key: (stream_id, stream_seq)            │  │
                  │  │ - Stores: Domain payloads, is_counterfactual      │  │
                  │  └───────────────────────────────────────────────────┘  │
                  │                                                         │
  Snapshot        │  ┌───────────────────────────────────────────────────┐  │
  Plane           │  │ business_stream_snapshot                          │  │
  (Replay Anchor) │  │ - Primary key: (snapshot_id)                      │  │
                  │  │ - Unique: (stream_id, pinned_stream_seq, version) │  │
                  │  └───────────────────────────────────────────────────┘  │
                  └─────────────────────────────────────────────────────────┘
```

#### 2.1 Orchestration Plane (`run_event_log`)
- Dedicated to the TypeScript Engine's execution of a single DAG.
- **Partitioning:** Hash partitioned by `run_id`.
- **Primary Key:** `(run_id, run_seq)`.
- Eliminates cross-workflow database contention. Scatter-gather is completely eliminated for run execution queries (`WHERE run_id = $1 ORDER BY run_seq ASC`).

#### 2.2 Business Plane (`business_event_stream`)
- Dedicated to domain aggregate roots and cross-DAG semantic projections.
- **Partitioning:** Hash partitioned by `stream_id`.
- **Primary Key:** `(stream_id, stream_seq)`.
- **PostgreSQL Partitioning Solved:** Because `stream_id` is the partition key, PostgreSQL natively enforces global uniqueness on `(stream_id, stream_seq)` with zero partition-key conflicts.
- Records reference their originating `run_id` and `run_seq` for cross-plane traceability.

### 3. Dual Sequence Allocation & Lock Overhead
When a workflow appends a domain business event, the transaction acquires two row locks:
```sql
BEGIN;
-- 1. Allocate business sequence
UPDATE stream SET next_seq = next_seq + 1 WHERE stream_id = $1 RETURNING next_seq;
-- 2. Allocate orchestration sequence
UPDATE run SET next_seq = next_seq + 1 WHERE run_id = $2 RETURNING next_seq;
-- 3. Insert events into respective planes
INSERT INTO run_event_log (run_id, run_seq, ...) VALUES ($2, run_seq, ...);
INSERT INTO business_event_stream (stream_id, stream_seq, run_id, run_seq, ...) VALUES ($1, stream_seq, $2, run_seq, ...);
COMMIT;
```
- **Contention Partitioning:** Lock overhead is sub-millisecond. High concurrency (1k TPS) is partitioned across tens of thousands of distinct business entities (`stream_id`) and workflow runs (`run_id`). Contention on the same `stream_id` is virtually zero under real-world sequential order lifecycles.

### 4. Offline Fork Isolation & Counterfactual Safety
To ensure offline causal counterfactuals (Doc 01 §5, Doc 05 §3) never corrupt live business projections:
1. **Synthetic Namespace:** When an offline fork is created for counterfactual evaluation, its events are assigned a synthetic stream identity:
   $$\text{ForkStreamId} = \text{fork}:\langle\text{fork\_run\_id}\rangle:\langle\text{source\_stream\_id}\rangle$$
2. **Physical Hard Isolation Flag:** The `business_event_stream` table includes an `is_counterfactual boolean NOT NULL DEFAULT false` column.
3. **Projection Filtering:** All production semantic folds and operational reports query:
   ```sql
   SELECT * FROM business_event_stream 
   WHERE stream_id = $1 AND is_counterfactual = false 
   ORDER BY stream_seq ASC;
   ```
   This guarantees that simulated what-if events can never alter production ledger balances or real-world order states.

### 5. Dedicated Business State Snapshot Table & Replay Determinism
To preserve the metadata-only boundary of Harness State (Doc 04 §1) while enabling cross-DAG context injection:
1. **Dedicated Snapshot Table:**
   ```sql
   CREATE TABLE business_stream_snapshot (
       snapshot_id text PRIMARY KEY,
       stream_id text NOT NULL REFERENCES stream(stream_id),
       pinned_stream_seq bigint NOT NULL,
       reducer_version text NOT NULL,
       state_payload jsonb NOT NULL,
       created_at timestamptz NOT NULL DEFAULT now(),
       CONSTRAINT uq_stream_pinned_seq UNIQUE (stream_id, pinned_stream_seq, reducer_version)
   );
   ```
2. **Context Passing via `task_input`:** When Workflow B starts for `order:123`, the system folds the business history up to the current sequence (e.g., `pinned_stream_seq = 42`), stores or retrieves the snapshot, and passes `{ snapshot_id, pinned_stream_seq }` as an explicit run argument in `task_input`.
3. **Preserving Harness State Purity:** Harness State stores only policy rules, assembly parameters, and memory retrieval hints. It never holds concrete business JSON blobs.
4. **Replay Determinism:** If `order:123` later advances to `stream_seq = 100`, replaying Workflow B strictly retrieves the snapshot pinned at `pinned_stream_seq = 42`. The prompt context remains 100% byte-identical over time, eliminating prompt drift.

---

## Rationale
- **Clean Separation of Concerns:** The engine needs run-level speed; domain folds need entity-level sequence integrity. Splitting the storage into two specialized planes respects both requirements without compromise.
- **Zero PostgreSQL Constraint Workarounds:** By partitioning `business_event_stream` on `stream_id`, PostgreSQL natively enforces global uniqueness across partitions, eliminating the partitioning conflict identified in Issue #1.
- **Audit & Replay Fidelity:** Pinning the business sequence in snapshots guarantees historical replayability even as long-lived business entities evolve indefinitely.

## Consequences
- **Database Migrations:** Replaces the single monolithic `event_log` table with the two-plane schema (`run_event_log`, `business_event_stream`, `stream`, and `business_stream_snapshot`).
- **Engine Coordination:** Appending a business event requires dual-sequence allocation inside the PostgreSQL transaction. Pure orchestration events (e.g., `subgraph/proposed`, `vertex/started`) skip the business stream lock and append only to `run_event_log`.
- **API Updates:** Domain read models query `business_event_stream`, while the Flory Console queries `run_event_log`.

---

## Rejected Alternatives

### 1. Unified Table Partitioned by `run_id` with `(stream_id, stream_seq)` Index
*Why rejected:* PostgreSQL's declarative partitioning strictly requires all partition key columns to be included in unique constraints. The DDL fails unless `run_id` is added, which defeats the purpose of cross-run business uniqueness.

### 2. Storing Raw Business Context in Harness State
*Why rejected:* Violates Doc 04 §1. Harness State is designed for long-term prompt policies and retrieval metadata, not raw entity state. Storing dynamic business blobs there breaks historical replay determinism.

### 3. Sharing the Live `stream_id` in Offline Counterfactual Forks
*Why rejected:* Causes unique sequence collisions during inherited event copying and risks contaminating production read models with simulated what-if writes.
