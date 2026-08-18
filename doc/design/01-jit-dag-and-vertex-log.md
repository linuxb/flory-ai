# JIT-DAG and Vertex Log (01)

> Status: Draft v0.1 | Depends on: [00-overview](./00-overview.md)

## 1. Goals

- The DAG is not a predefined workflow. A planner generates it just in time in the ReAct style, through progressive disclosure: each planner expands only the next batch of certain actions and the next decision point rather than the entire graph.
- Storage and execution history share one **append-only vertex log** in a transactional database: **a vertex is an event and `seq` is its log position**. No separate event-log component is introduced.
- Every derived view (current DAG, planner context, progress, and token accounting) is a pure-function projection of the log, making it auditable, replayable, and forkable.

## 2. Node Roles

### 2.1 Planner node

- Calls a model with linearized execution context, the task goal, and a prompt assembled from harness-state (see [04](./04-refine-and-harness-state.md)).
- Produces a **sub-DAG proposal**: tool-caller nodes, zero or more downstream planner nodes (decision points), and declared transaction-scope boundaries and attributes (see [02](./02-transaction-model.md)).
- A proposal must pass check-rules before it is frozen for execution. Rejection returns the violations to the planner for regeneration.
- The planner is a **replan anchor**: a fork boundary may only be placed at a closed planner vertex.

### 2.2 Tool-caller node

- Performs deterministic tool calls. Parameters are bound when the planner freezes the subgraph, or are explicit references to upstream vertex outputs; it makes no model call during execution.
- Carries transaction attributes such as effect class, compensability, idempotence, and pivot status (see [02](./02-transaction-model.md)).
- Makes no recovery decision on failure: it retries according to those attributes, then triggers replanning when retries are exhausted (see [03](./03-replan-and-recovery.md)).

The role split is a **permission split**. Planners may append sub-DAG proposals; tool callers may append only their own execution results. The append boundary validates which node type may append which event type, following the spirit of dsh surface-transition validation.

## 3. Vertex Log Storage Model

### 3.1 Illustrative schema

The single `vertex_log` table has a globally monotonic `seq` (a database identity column is sufficient) and immutable rows:

```sql
CREATE TABLE vertex_log (
  seq          BIGSERIAL PRIMARY KEY,      -- globally monotonic log position
  run_id       UUID NOT NULL,              -- one end-to-end task
  event_type   TEXT NOT NULL,              -- see 3.2
  vertex_id    UUID,                       -- owning vertex; NULL for some events
  parent_refs  UUID[],                     -- DAG edges: parent vertices define partial order
  planner_id   UUID,                       -- planner that generated this vertex
  payload      JSONB NOT NULL,             -- role, tool, parameters, txn attributes, result summary
  shadowed_by  BIGINT,                     -- never backfill; shadow events declare this relationship
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

If `shadowed_by` exists as a materialization optimization, only the projector may maintain it. Semantically, `subgraph/shadowed` is always authoritative, so a materialized field never weakens the immutable-row discipline.

### 3.2 Core event vocabulary

| Event type | Meaning | Permitted writer |
|---|---|---|
| `run/start`, `run/end` | Run lifecycle | engine |
| `subgraph/proposed` | Complete planner sub-DAG proposal in payload | planner |
| `subgraph/frozen` | Check-rules passed; all vertex rows are atomically appended | engine |
| `subgraph/rejected` | Check-rules rejection and reasons | engine |
| `vertex/created` | Vertex definition: role, tool, parameters, and transaction attributes | engine during freeze |
| `vertex/started`, `vertex/succeeded`, `vertex/failed` | Execution state transitions | executor |
| `vertex/retried` | Idempotent retry number and backoff | executor |
| `subgraph/shadowed` | Replan shadowed a failed subtree; payload names affected seqs | engine |
| `replan/boundary` | In-place replan: selected `boundary_seq`, planner vertex, reason, cancelled scopes. No new run is created (§5.1) | engine |
| `fork/created` | **Dry-run children only** (§5.2): `boundary_seq`, parent run, seed length, `mode: "dry-run"` | engine |
| `run/end-seed` | First own event of a dry-run child; everything before it is inherited and read-only (§5.2) | engine |
| `txn/scope`, `txn/try`, `txn/confirm`, `txn/cancel`, `txn/pivot-passed` | Transaction-bracketing events; see [02](./02-transaction-model.md) | engine/executor |
| `budget/charged` | Token and cost accounting | engine |

Unknown `event_type` values are **fail-closed**: readers reject the complete log rather than silently skipping them. Extensible events require an explicit `ignorable` flag. A schema version is included in `run/start` from day one.

### 3.3 Invariants

1. **Append-only.** Every action appends a new event; state changes, shadowing, and forks never mutate historical rows. Only materialized projection columns or tables may be updated.
2. **Atomic append.** Freezing a proposal appends `subgraph/frozen` and all `vertex/created` events in one database transaction. The entire subgraph is visible or none of it is. This is a control-plane transaction, not a business transaction.
3. **Partial order.** `parent_refs` defines DAG order. `seq` represents write order only and **never carries causal meaning**; adjacent `seq` values in parallel branches do not imply a dependency.
4. **Visibility assertion.** Before every planner model call, runtime asserts that the sent context equals the log projection followed by linearization. A projection-hash comparison may replace full byte comparison to avoid dsh's double-serialization cost.

## 4. Surface Projection and Linearization

### 4.1 Surface

`surface(log) → current_dag` folds all events and removes subtrees shadowed by `subgraph/shadowed`, yielding the currently active DAG. It may be implemented as a materialized view or engine cache, but it **must always be reproducible from the complete log with the same result**. This is the basis of replay testing.

### 4.2 Linearization

Planners consume linear context while the log is partially ordered. Each planner call therefore uses a deterministic function:

```
linearize(surface, planner_vertex) → [ctx_item...]
```

1. Include only the planner's ancestor closure and result summaries, rather than full outputs, from sibling branches.
2. Sort parallel branches lexicographically by `vertex_id`, never by `seq`; scheduling order must not affect replay.
3. Inject failure evidence as an explicit structured section during replanning, rather than scattering it through history.

The function is pure. The same log prefix and harness-state version produce the same prompt, allowing regression assertions without a model.

## 5. Replanning In Place, and Forking Only for Dry Runs

Flory deliberately **splits** what dsh unifies. dsh makes resume, fork, and replay one primitive because a session is a cheap local object whose identity carries no external meaning. A Flory run is a **business process** — one order, one replenishment — so run identity has business meaning, and the two mechanisms must be kept apart. The decision and rejected alternatives are recorded in [ADR-002](./adr/adr-002-in-place-replan-and-dry-run-forks.md).

### 5.1 Online replanning does not fork

Replanning appends to the **same run**: `subgraph/shadowed` hides the disproven subtree from `surface`, then the chosen planner is called again and appends a fresh proposal. A `replan/boundary` event records which boundary was selected and why. No prefix is copied and no new `run_id` is created.

Creating a child run online would buy nothing and cost two real things:

1. **A fragmented audit trail.** "What happened to order 12345" would become a chase across a chain of run ids instead of one readable run. For a business process this is the more serious of the two.
2. **Pure storage waste.** Deep-copying the prefix duplicates events that the shadow mechanism already handles correctly.

Crash recovery is likewise **not** a fork: it is a resume, achieved by re-projecting the same log.

### 5.2 Forking is for dry runs only

`fork(run, boundary_seq) → dry_run_child` exists for the offline, non-executing family: L2 counterfactual A/B, replay testing, recovery-strategy comparison, and operator "what-if" previews ([05 §3](./05-context-aggregation-and-experimentation.md)).

- The boundary must be a succeeded planner vertex that lies outside every open transaction bracket **and at or after the most recent `txn/pivot-passed`** (the backtrack floor, [03 §2.1](./03-replan-and-recovery.md)). Otherwise reject the fork; never silently trim it. Unlike dsh's subagent exception that trims to a completed prefix, Flory has one semantics.
- The child deep-copies the prefix as a seed and is marked `mode: "dry-run"`. Its first owned event is `run/end-seed`.
- **A dry-run child may never act on inherited events.** Everything before `run/end-seed` is read-only: it belongs to a live parent run. In particular the child must never cancel or confirm an inherited `txn/try` — that hold belongs to a real order still in flight. This is the actual job of the end-seed marker; orphan-try detection in a live run needs no such marker and works from timeouts and unmatched brackets ([02 §4.4](./02-transaction-model.md)).
- **A dry-run child executes only `effect_class: none` tools.** Read-only calls are permitted because they have no side effects by definition; every `bufferable`, `reversible`, or `irreversible` node is skipped and recorded as an unverified estimate. Consequently a dry run answers "what would the plan be, and what does it really cost" but never "would the write actually succeed" ([05 §3.2](./05-context-aggregation-and-experimentation.md)).
- Forking never replays the external world. Inventory holds and logistics bookings are untouched by it, in either direction.

## 6. Replay Testing

The log is both a mock script and expected output. Record one real run, replay its recorded model responses, and assert an event-by-event log match while ignoring timestamps. JIT-DAG regression testing then becomes a log diff instead of an API-key-dependent model run.

## 7. Open Questions

- **Log granularity:** dsh records streaming model chunks, which makes logs heavy and requires compression. Flory's current choice is vertex fidelity, not token fidelity: payloads contain summaries plus external blob references for raw model input and output.
- `subgraph/shadowed` positional reasoning needs property-based tests for multi-replan boundary cases.
- Concurrent runs writing one database need partitioning strategy. Partitioning by `run_id` is sufficient because only per-run monotonicity is required.
