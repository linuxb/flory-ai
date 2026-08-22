# Plan 002: Event Log Storage and Fork API Implementation

> Status: Proposed | Implements: [ADR-004](../design/adr/adr-004-case-specific-offline-fork-evaluation.md) | Specifications: [01-jit-dag-and-event-log](../design/01-jit-dag-and-event-log.md), [08-database-schema](../design/08-database-schema.md)

## 1. Objective

Implement the physical storage model for the Flory event log in PostgreSQL and the TypeScript engine APIs for projecting the surface state and running counterfactual evaluations (forks).

## 2. Preconditions

- The TypeScript engine scaffolding (`engine/` directory) and Go coordinator scaffolding are initialized.
- A database migration framework (e.g., Flyway, dbmate, or raw SQL deployment mechanism) is chosen and configured.

## 3. Implementation Phases

### Phase 1: Database Schema Deployment

- Create `db/schema/` or use the configured migration tool structure.
- Define the `run`, `event_log`, `txn_scope`, `txn_bracket`, and `work_queue` tables.
- Add triggers for `allocate_stream_seq()`, event ownership validation, and the "no-cancel-after-pivot" invariant.
- Grant `INSERT` and `SELECT` to application roles while denying `UPDATE` and `DELETE` on `event_log`.

### Phase 2: Core Read/Write Projections (TypeScript)

- Implement `appendEvents(runId, events)` which wraps the sequence allocation and `INSERT` statements in a single transaction.
- Implement `surface(run_id, at_stream_seq) -> CurrentDAG` to fold the active DAG up to a specific stream sequence, handling `subgraph/shadowed` events locally.
- Implement the read-models that assert projection purity by testing the folded outputs of identical inputs.

### Phase 3: Fork API implementation (TypeScript)

- Implement the interface for fork counterfactuals:
```typescript
interface ForkSubstitution {
    stream_seq: number;
    pin_version: string;
}

interface ForkRequest {
    source_run_id: string;
    at_stream_seq: number;
    substitutions: ForkSubstitution[];
    fold_mode: 'recorded' | 'model-live' | 'reads-live';
    evaluator_pin: string;
    projector_version: string;
    harness_state_version: string;
}
```
- Implement the branch/substitute/merge transaction:
  1. Capture `source_tail_end_seq`, generate a new `run_id`, and append `fork/created` to the source stream with the child id, frozen tail endpoint, and complete provenance tuple from `ForkRequest` in one transaction.
  2. Copy the source prefix through `at_stream_seq`, changing only the requested `pin_version` fields.
  3. Merge source events from `at_stream_seq + 1` through `source_tail_end_seq` into the child in source order without reissuing external writes.
  4. Append `run/end-seed` as the child's first own event; reject any attempt by the child to confirm or cancel a bracket inherited before that marker.
  5. Continue evaluation under the declared `fold_mode`; skip and mark every node above that mode as unverified.

### Phase 4: Verification and Replay Testing

- **Replay tests:** Validate that a fork without substitutions (`fold_mode: recorded`) produces the exact same surface bytes as the source run.
- **SQL trigger tests:** Write fixture tests in Go or TS that intentionally violate event ownership or pivot rules, asserting that the database rejects the transaction.
