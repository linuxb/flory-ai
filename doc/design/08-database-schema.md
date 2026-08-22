# Database Schema and Storage Model (08)

> Status: Draft v0.1 | Depends on: [01-jit-dag-and-event-log](./01-jit-dag-and-event-log.md), [02-transaction-model](./02-transaction-model.md)

## 1. Goals

This document details the physical storage model for the Flory orchestration engine. The storage model is built on PostgreSQL and is responsible for enforcing the system's most critical invariants at the lowest level:
- **Append-only immutability** for the ground truth event log.
- **Strictly contiguous, rollback-safe sequences** within a single run.
- **Synchronous projections** that gate irreversible business effects.
- **Database-enforced safety** (e.g., event ownership, pivot isolation) via triggers and constraints.

## 2. Sequence Allocation: The `run` Table

A run is a business process (e.g., an end-to-end order fulfillment). The `run` table acts as a sharded sequence generator, allocating `stream_seq` for each event appended to the run.

```sql
CREATE TABLE run (
    run_id       UUID PRIMARY KEY,
    next_seq     BIGINT NOT NULL DEFAULT 1,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### The Allocation Mechanism
To allocate a sequence for an event append, the engine executes this within the appending transaction:
```sql
UPDATE run SET next_seq = next_seq + 1 WHERE run_id = $1 RETURNING next_seq - 1;
```

**Why not use `BIGSERIAL`?**
Native PostgreSQL sequences (`BIGSERIAL`) allocate outside transaction boundaries. If a transaction fails, the sequence value is lost, creating gaps. Furthermore, concurrent commits can be observed out of sequence, breaking the pure-function deterministic folding of the surface. By using a row lock on the `run` table:
1. `stream_seq` is guaranteed contiguous (no gaps).
2. Write order matches commit order strictly.
3. Lock contention is scoped to a single run; millions of independent runs do not contend.

## 3. The Ground Truth: `event_log`

The `event_log` table is the immutable history of all system state.

```sql
CREATE TABLE event_log (
    run_id       UUID NOT NULL REFERENCES run(run_id),
    stream_seq   BIGINT NOT NULL,
    global_seq   BIGSERIAL,
    event_type   TEXT NOT NULL,
    vertex_id    UUID,
    parent_refs  UUID[],                     -- Causal edges
    planner_id   UUID,
    scope_id     UUID,
    pin_version  TEXT,                       -- Pinned contract for fork substitution
    payload      JSONB NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id, stream_seq)
) PARTITION BY HASH (run_id);
```

### Immutability Constraint
The application roles are granted `INSERT` and `SELECT` privileges only. `UPDATE` and `DELETE` are revoked at the database level. Shadowed events remain in the log (with a `subgraph/shadowed` event appended later to signal their state).

### Partitioning
Partitioning by `HASH (run_id)` ensures that hot runs (which receive concurrent appends) are evenly distributed across database partitions.

## 4. Synchronous Projections

Projections are materialized views updated *synchronously* in the same transaction as the event append. These projections serve queries that the Go coordinator needs for execution and timeout sweeping, which a raw log scan cannot efficiently provide.

### 4.1 Transaction Scope
Tracks transaction boundaries and pivot status.
```sql
CREATE TABLE txn_scope (
    scope_id          UUID PRIMARY KEY,
    run_id            UUID NOT NULL,
    state             TEXT NOT NULL,
    pivot_vertex_id   UUID,
    savepoint_seq     BIGINT,
    opened_seq        BIGINT,
    closed_seq        BIGINT,
    is_pivot          BOOLEAN NOT NULL DEFAULT false
);

-- Enforces exactly one pivot per scope
CREATE UNIQUE INDEX idx_txn_scope_pivot ON txn_scope(scope_id) WHERE is_pivot = true;
```

### 4.2 Transaction Bracket (Orphan Sweep)
Tracks individual tries for timeout handling and idempotency.
```sql
CREATE TABLE txn_bracket (
    idempotency_key   TEXT UNIQUE,           -- I1: Idempotency enforcement
    run_id            UUID NOT NULL,
    state             TEXT NOT NULL,
    deadline_at       TIMESTAMPTZ,
    try_vertex_id     UUID NOT NULL
);

-- Partial index keeps the sweeping query cheap by ignoring closed history
CREATE INDEX idx_txn_bracket_open ON txn_bracket(deadline_at) WHERE state = 'tried';
```

### 4.3 Work Queue
Coordinates execution handoff to the Go coordinator.
```sql
CREATE TABLE work_queue (
    vertex_id    UUID PRIMARY KEY,
    run_id       UUID NOT NULL,
    ready_at     TIMESTAMPTZ NOT NULL,
    claimed_by   TEXT
);
-- Claimed via SELECT ... FOR UPDATE SKIP LOCKED
```

## 5. Database-Enforced Invariants (Triggers)

Safety logic that must never be bypassed is pushed down to PostgreSQL triggers.

### 5.1 Event Ownership (Discipline 29)
The TypeScript engine and Go coordinator own mutually exclusive event sets.
```sql
CREATE FUNCTION check_event_ownership() RETURNS TRIGGER AS $$
BEGIN
    IF current_user = 'engine_role' AND NEW.event_type NOT SIMILAR TO '(run|subgraph|replan|fork|budget)/%|vertex/created' THEN
        RAISE EXCEPTION 'Engine role cannot append event type %', NEW.event_type;
    ELSIF current_user = 'coordinator_role' AND NEW.event_type NOT SIMILAR TO 'txn/%|vertex/(started|succeeded|failed|retried)' THEN
        RAISE EXCEPTION 'Coordinator role cannot append event type %', NEW.event_type;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_event_ownership
    BEFORE INSERT ON event_log FOR EACH ROW EXECUTE FUNCTION check_event_ownership();
```

### 5.2 No Cancel After Pivot (Discipline I3)
Once a pivot succeeds, forward recovery is mandatory.
```sql
CREATE FUNCTION check_no_cancel_after_pivot() RETURNS TRIGGER AS $$
BEGIN
    IF OLD.state = 'pivot-passed' AND NEW.state IN ('cancelled', 'compensating') THEN
        RAISE EXCEPTION 'Cannot cancel after pivot passed';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_no_cancel_after_pivot
    BEFORE UPDATE ON txn_bracket FOR EACH ROW EXECUTE FUNCTION check_no_cancel_after_pivot();
```

## 6. Fork API Storage Considerations

A fork operation (`fork(source_stream, at_stream_seq, substitutions)`) materializes an offline counterfactual without mutating the source stream:

1. **Freeze the source snapshot and create the child.** Capture the source's current terminal `stream_seq` as `source_tail_end_seq`, insert a new `run` row, and append `fork/created` to the source stream. The event records the child `run_id`, `at_stream_seq`, `source_tail_end_seq`, substitutions, `fold_mode`, evaluator pin, `projector_version`, and `harness_state_version`. These actions share one database transaction, so later source appends cannot leak into the child.
2. **Seed the source prefix.** Copy source events through `at_stream_seq`, preserving their `stream_seq` values and all fields except the explicitly substituted `pin_version` values.
3. **Merge the frozen source tail.** Copy source events from `at_stream_seq + 1` through `source_tail_end_seq` into the child in source order so their recorded effects can be folded under the substituted pins. Merging replays log semantics, not external writes.
4. **Seal inherited ownership.** Append `run/end-seed` after the merged tail as the child's first own event. Everything before it is inherited and read-only; the child may never append `txn/confirm` or `txn/cancel` for an inherited bracket.
5. **Continue the child sequence.** Set the child's `next_seq` after `run/end-seed`, then append only evaluation events permitted by its declared `fold_mode`.

The source stream remains immutable throughout. `recorded`, `model-live`, and `reads-live` may read or recompute according to their gates, but every side-effecting node is skipped and marked unverified. `writes-live` is production and is never accepted by the fork API. Locking remains isolated by `run_id`, so concurrent historical evaluations do not block unrelated production runs.
