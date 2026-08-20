# JIT-DAG and Vertex Log (01)

> Status: Draft v0.1 | Depends on: [00-overview](./00-overview.md)

## 1. Goals

- The DAG is not a predefined workflow. A planner generates it just in time in the ReAct style, through progressive disclosure: each planner expands only the next batch of certain actions and the next decision point rather than the entire graph.
- Storage and execution history share one **append-only vertex log** in a transactional database: **a vertex is an event and `run_seq` is its position within its DAG**. No separate event-log component is introduced, and there is no separate transaction log either — the `txn/*` brackets are rows in the same table.
- Every derived view (current DAG, planner context, progress, and token accounting) is a pure-function projection of the log, making it auditable, replayable, and forkable. **Purity is guaranteed within one run and deliberately not across runs** (§3.3 invariant 3), which is exactly the scope every projection and every dry-run analysis operates in.

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

`vertex_log` carries **two sequence numbers with different guarantees**, and confusing them is the most consequential mistake available in this schema (see §3.3 invariant 3).

```sql
CREATE TABLE vertex_log (
  run_id       UUID    NOT NULL,           -- one end-to-end task = one DAG
  run_seq      BIGINT  NOT NULL,           -- per-run: strict, contiguous, rollback-safe
  global_seq   BIGSERIAL,                  -- coarse global order; gappy, NOT commit-ordered
  event_type   TEXT    NOT NULL,           -- see 3.2
  vertex_id    UUID,                       -- owning vertex; NULL for some events
  parent_refs  UUID[],                     -- DAG edges: parent vertices define causal order
  planner_id   UUID,                       -- planner that generated this vertex
  scope_id     UUID,                       -- promoted from payload so it can be indexed
  payload      JSONB   NOT NULL,           -- role, tool, params, txn attrs, result summary, blob refs
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, run_seq)
) PARTITION BY HASH (run_id);
```

`run_seq` is allocated from a counter column on the run row, inside the appending transaction:

```sql
UPDATE run SET next_seq = next_seq + 1 WHERE run_id = $1 RETURNING next_seq;
```

That single statement buys three properties a sequence cannot provide. The row lock **serializes appends within one run**, so a run's log is strictly ordered. The counter lives in a row, so an aborted transaction **un-increments it** — no gaps from rollback, which `BIGSERIAL` explicitly does not offer. And because the lock is per-`run_id`, **different runs never contend**.

The cost is that concurrent appends inside one run serialize on that row. That is acceptable and arguably desirable: a run has at most a handful of concurrent branches, the transactions are short, and the resulting order is what makes per-run reads reproducible.

Not stored here: raw model input and output, which live in blob storage referenced from `payload` (§7). Hot query fields (`run_id`, `event_type`, `vertex_id`, `scope_id`) are real columns; everything else stays in JSONB.

**Every intra-run reference uses `run_seq`** — `replan/boundary.boundary_seq`, `subgraph/shadowed` ranges, `fork/created.boundary_seq`. Cross-run references, such as `evidence_seqs` in harness-state ([04](./04-refine-and-harness-state.md)), must be `(run_id, run_seq)` pairs; a bare number is ambiguous.

A dry-run child ([§5.2](#52-forking-is-for-dry-runs-only)) inherits the prefix with the parent's `run_seq` values unchanged and continues numbering after `seed_length`. `PRIMARY KEY (run_id, run_seq)` stays satisfied because `run_id` differs.

### 3.1.1 Projections and their indexes

The transaction bracket state is **not a separate log** — `txn/*` events are ordinary `vertex_log` rows. What the coordinator needs beyond the log is a set of projections for queries a raw scan cannot serve. All of them are updated **in the same database transaction as the event append**, never asynchronously: pivot admission is a safety-critical synchronous read, and a projection lagging by even a few hundred milliseconds could let an irreversible action fire that should have been blocked.

| Projection | Key columns and indexes | Query it serves |
|---|---|---|
| `txn_scope` | `scope_id` PK, `state`, `pivot_vertex_id`, `savepoint_seq`, `opened_seq`, `closed_seq`; partial unique `(scope_id) WHERE is_pivot` | "May this scope's pivot fire?" and "is there an open bracket at this replan boundary?" |
| `txn_bracket` | one row per try: `state`, `deadline_at`, `idempotency_key`; **partial index `WHERE state = 'tried'`**; unique `(idempotency_key)` | orphan sweep `WHERE state='tried' AND deadline_at < now()`; timer rebuild after restart |
| `work_queue` | `vertex_id`, `ready_at`, `claimed_by`; claimed with `FOR UPDATE SKIP LOCKED` | the Go coordinator claiming executable vertices |

The partial index on `txn_bracket` matters operationally: open brackets are a small hot set while closed ones are cold history, so the sweep's cost stays independent of total log size. It is also the crash-recovery mechanism — the coordinator holds no timers in memory, it re-reads open brackets by deadline on restart.

### 3.1.2 Invariants pushed into the database

Constraints do not forget, and the coordinator has many concurrent writers. Anything expressible as a constraint belongs there rather than in review comments — and all of these are cheap now and near-impossible to retrofit once production data exists.

| Discipline | Database mechanism |
|---|---|
| Append-only (§3.3 inv. 1) | The application role receives `INSERT, SELECT` on `vertex_log` and no `UPDATE`/`DELETE` grant at all |
| Event ownership ([AGENTS.md](../../AGENTS.md) #29) | `BEFORE INSERT` trigger checking `current_user` against the event-type ownership table, so the TS engine cannot append `txn/*` and the Go coordinator cannot append `subgraph/*` |
| Idempotency ([02 §2](./02-transaction-model.md)) | `UNIQUE (idempotency_key)` on `txn_bracket` — a duplicate try becomes a constraint violation instead of a duplicated side effect |
| One pivot per scope (R3) | partial unique index on the pivot column; a second line of defence behind the freeze-time check |
| No cancel after pivot (I3) | `BEFORE UPDATE` trigger validating the `txn_bracket` state-transition graph |

`vertex_log` has no `shadowed_by` column. Shadowing is declared only by `subgraph/shadowed` events; a materialized shadow flag may exist inside a projection table, where the projector owns it.

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
3. **Partial order, and purity scoped to one DAG.** `parent_refs` defines causal order. Neither sequence number carries causal meaning: adjacent values in parallel branches imply no dependency. The two sequences carry deliberately different guarantees, and **purity of the projection is defined only against `run_seq`**:

   | | `run_seq` | `global_seq` |
   |---|---|---|
   | Scope | one run = one DAG | whole table |
   | Strictly increasing | yes | yes |
   | Contiguous, no gaps | **yes** | no |
   | Survives rollback without skipping | **yes** (counter in a row) | no (sequences do not roll back) |
   | Commit-ordered | **yes** (serialized by the run row lock) | **no** |
   | Legal input to a fold | **yes** | **never** |
   | Use | projections, replay, all intra-run references | coarse global ordering, operational triage only |

   The reason for the split is that a `BIGSERIAL` is allocated before commit but observed after it. Two concurrent appends may take 100 and 101 while 101 commits first, so an incremental reader can advance past 100 and skip it permanently. Worse than a skipped event, **the same set of events can fold in two different orders on two different reads, and the projection stops being a pure function** — which would take down replay testing, prompt caching, and A/B attribution together, since all three rest on that purity.

   `run_seq` removes the hazard within the boundary that matters, and the boundary is honestly declared:

   - **Guaranteed:** a fold over one run is a pure function of that run's events. `surface`, `slice`, `fold`, `linearize`, and `assemble` all operate inside one run, and a dry-run analysis is likewise always scoped to one DAG. Nothing in the projection pipeline reaches across runs.
   - **Not guaranteed:** a fold over the global stream. Cross-run analytics must therefore be computed as **fold per run, then aggregate** — never as one fold over `global_seq`. This is a rule, not a preference: the second form is not reproducible ([05 §3.2](./05-context-aggregation-and-experimentation.md)).

   One more requirement follows, and it is easy to miss. Serializing appends fixes the *storage* order but not the *scheduling* order: two concurrent siblings may be assigned `run_seq` in either order across replays. Purity therefore also demands that **every reducer be commutative over concurrent events** — events with no `parent_refs` path between them. `linearize` satisfies this by sorting on `vertex_id` (§4.2), and semantic-fold reducers satisfy it because compensation is delta-based rather than state-restoring ([02 §4.3](./02-transaction-model.md) D2), which makes their operations commute. A reducer that is order-sensitive over concurrent events breaks purity even with a perfect sequence, so this is asserted by the permutation test in [06 §7](./06-validation-harness.md) O4.
4. **Visibility assertion.** Before every planner model call, runtime asserts that the sent context equals the log projection followed by linearization. A projection-hash comparison may replace full byte comparison to avoid dsh's double-serialization cost.

## 4. Surface Projection and Linearization

### 4.1 Surface

`surface(run_log) → current_dag` folds one run's events in `run_seq` order and removes subtrees shadowed by `subgraph/shadowed`, yielding the currently active DAG. Its input is always a single run; no projection reaches across runs. It may be implemented as a materialized view or engine cache, but it **must always be reproducible from the complete log with the same result**. This is the basis of replay testing.

### 4.2 Linearization

Planners consume linear context while the log is partially ordered. Each planner call therefore uses a deterministic function:

```
linearize(surface, planner_vertex) → [ctx_item...]
```

1. Include only the planner's ancestor closure and result summaries, rather than full outputs, from sibling branches.
2. Sort parallel branches lexicographically by `vertex_id`, never by either sequence number or completion time; scheduling order must not affect replay. `run_seq` fixes storage order but not the order in which concurrent siblings were scheduled, so sorting on it would still be non-reproducible.
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
- **Append contention inside one very wide run.** `run_seq` serializes appends on the run row (§3.1). A run with unusually high branch fan-out would queue on that lock. No measurement exists yet; if it becomes real, the options are batching several events per transaction or sharding the counter per branch — the latter costs the contiguity that made the design worth having, so it should not be reached for early.
- **Offline readers still see `global_seq` gaps.** Purity is guaranteed per run (§3.3 inv. 3), which covers the projection pipeline, but trace validation and metric recomputation read across runs. They must either fold per run and then aggregate, or consume Postgres logical decoding, which delivers events in commit order. Which of the two becomes the standard path is unresolved.
