# ADR-007: Three-Tier Sequence Model for Business Streams and Workflow Runs

## Status
Proposed

## Context
Flory's original event log design relied on a single partial-order sequence (`stream_seq`) scoped to a `run_id` (a single workflow DAG execution), alongside a physical `global_seq`. 

While this perfectly isolates the TypeScript Engine's orchestration control plane, it creates a gap in the business data plane. A single business entity (e.g., an Order, a Customer Service Ticket, a Waybill) may undergo multiple distinct workflow runs over its lifecycle. If events are only grouped by `run_id`, business teams writing semantic folds (e.g., to query "What is the current status of this Order across all its historical workflows?") must manually stitch together multiple runs.

To natively support domain-driven Aggregate Roots and cross-DAG semantic projections, we propose formalizing a three-tier sequence model.

## Proposed Decision
Introduce a `stream_id` to represent the business domain aggregate boundary, separating it from the `run_id` which represents the execution control boundary.

The event log will adopt a **Three-Tier Sequence Model**:
1. **`run_seq` (Orchestration/Control Plane):** The sequence number internal to a `run_id`. The Flory TS Engine uses this strictly to fold the `CurrentDAG` surface for a specific workflow execution. This maintains the exact partial-order orchestration guarantees previously provided by `stream_seq`.
2. **`stream_seq` (Business/Data Plane):** The sequence number internal to a `stream_id` (e.g., `order_id:12345`). This provides a strict partial order of all events that have ever happened to this business entity, spanning across multiple distinct workflow `run_id`s. Business domains use this to fold semantic read models.
3. **`global_seq` (Physical/Storage Plane):** The absolute, database-assigned serial identifier. Used for physical replication, Change Data Capture (CDC) into Data Warehouses, and absolute chronological debugging.

### Implementation Details & Schema Modifications
1. **New `stream` Table:** Create a table structurally identical to the `run` table to manage `stream_id` allocation.
   ```sql
   CREATE TABLE stream (
       stream_id text PRIMARY KEY,
       next_seq bigint NOT NULL DEFAULT 1,
       created_at timestamptz NOT NULL DEFAULT now()
   );
   ```
2. **Schema Renaming:** In `event_log`, rename the existing `stream_seq` to `run_seq`.
3. **Schema Addition:** Add `stream_id` (nullable for purely systemic runs) and `stream_seq` to `event_log`.
4. **Index Strategy:** Create a unique compound index on `(stream_id, stream_seq)` to guarantee business stream integrity and accelerate semantic folds.

## Rationale & PG Lock Overhead Evaluation
**Is it safe to acquire two sequence locks per event append?**
When appending an event, the PostgreSQL transaction must now execute two row-level locks before inserting:
```sql
UPDATE stream SET next_seq = next_seq + 1 WHERE stream_id = $1 RETURNING next_seq;
UPDATE run SET next_seq = next_seq + 1 WHERE run_id = $2 RETURNING next_seq;
INSERT INTO event_log (...) VALUES (...);
```

**Overhead Assessment: Negligible.**
- PostgreSQL row locks (using `UPDATE ... RETURNING`) are highly optimized. The overhead of a second row lock in the same transaction is sub-millisecond.
- **Contention Partitioning:** The 1000 TPS peak load is distributed across tens of thousands of different SKUs/Orders. A row lock only blocks concurrent appends *to the exact same `stream_id`*. 
- **Business Reality:** A single business order (`stream_id`) rarely experiences highly concurrent workflow executions. Workflows on the same entity are typically chronological (e.g., Order Created -> Payment Processed -> Shipped). Therefore, lock contention on `stream_id` will be near zero. It behaves identically to the sharding benefits of `run_id`.

## Consequences
- **Cross-DAG Communication:** The TS Engine can easily inject cross-DAG context. When Workflow B starts for `order_123`, the Engine can fold the `stream_id` history up to the current `stream_seq` and feed it into the `Harness State`.
- **UI & Analytics:** The Console UI can natively offer a "Business Stream Timeline" view, showing an entity's complete lifecycle across all historical workflow DAGs.
- **Migration:** Existing documentation (e.g., `08-database-schema.md`) and implementation plans must be updated to reflect the new `run_seq` vs `stream_seq` terminology before coding begins.
