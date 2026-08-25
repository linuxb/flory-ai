# JIT-DAG and Event Log (01)

> Status: Draft v0.1 | Depends on: [00-overview](./00-overview.md)

## 1. Goals

- The DAG is not a predefined workflow. A planner generates it just in time in the ReAct style, through progressive disclosure: each planner expands only the next batch of certain actions and the next decision point rather than the entire graph.
- Storage and execution history share one **append-only event log** in a transactional database: **a vertex is an event and `stream_seq` is its position within its DAG**. No separate event-log component is introduced, and there is no separate transaction log either — the `txn/*` brackets are rows in the same table.
- Every derived view (current DAG, planner context, progress, and token accounting) is a pure-function projection of the log, making it auditable, replayable, and forkable. **Purity is guaranteed within one run and deliberately not across runs** (§3.3 invariant 3), which is exactly the scope every projection and every offline evaluation operates in.

## 2. Node Roles

### 2.1 Planner node

- Calls a model with linearized execution context, the task goal, and a prompt assembled from harness-state (see [04](./04-refine-and-harness-state.md)).
- Produces a **sub-DAG proposal**: tool-caller nodes, zero or more downstream planner nodes (decision points), and declared transaction-scope boundaries and attributes (see [02](./02-transaction-model.md)).
- A proposal must pass check-rules before it is frozen for execution. Rejection returns the violations to the planner for regeneration.
- The planner is an **online replan anchor**: a replan boundary may only be placed at a closed planner vertex. Offline forks, however, are not bound by this and may occur at any vertex.

### 2.2 Tool-caller node

- Performs deterministic tool calls. Parameters are bound when the planner freezes the subgraph, or are explicit references to upstream vertex outputs; it makes no model call during execution.
- Carries transaction attributes such as effect class, compensability, idempotence, and pivot status (see [02](./02-transaction-model.md)).
- Makes no recovery decision on failure: it retries according to those attributes, then triggers replanning when retries are exhausted (see [03](./03-replan-and-recovery.md)).

The role split is a **permission split**. Planners may append sub-DAG proposals; tool callers may append only their own execution results. The append boundary validates which node type may append which event type, following the spirit of dsh surface-transition validation.

## 3. Event Log Storage Model

### 3.1 Illustrative schema

The log is named `event_log` rather than `vertex_log` because its rows are not only DAG-vertex transitions. Externally imposed events land in the same stream — a human-triggered refine, an operator what-if request, a reconciliation outcome — and they belong there for exactly the reason vertex events do: they change the context that later decisions fold from. "Stream" names the ordering, "event" names the row; both terms are needed and neither substitutes for the other.

This section defines the logical model. The physical PostgreSQL schema, indexes, triggers, and work-queue tables are specified in [08](./08-database-schema.md).

It carries **two sequence numbers with different guarantees**, and confusing them is the most consequential mistake available in this schema (see §3.3 invariant 3).

```sql
CREATE TABLE event_log (
  run_id       UUID    NOT NULL,           -- one end-to-end task = one DAG
  stream_seq      BIGINT  NOT NULL,           -- per-run: strict, contiguous, rollback-safe
  global_seq   BIGSERIAL,                  -- coarse global order; gappy, NOT commit-ordered
  event_type   TEXT    NOT NULL,           -- see 3.2
  vertex_id    UUID,                       -- owning vertex; NULL for some events
  parent_refs  UUID[],                     -- DAG edges: parent vertices define causal order
  planner_id   UUID,                       -- planner that generated this vertex
  scope_id     UUID,                       -- promoted from payload so it can be indexed
  pin_version  TEXT,                       -- pinned external contract; a fork substitutes this (§5.3)
  ignorable    BOOLEAN NOT NULL DEFAULT false, -- explicit opt-in for forward-compatible events
  payload      JSONB   NOT NULL,           -- role, tool, params, txn attrs, result summary, blob refs
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, stream_seq)
) PARTITION BY HASH (run_id);
```

A run owns exactly one stream, so `run_id` identifies the stream and `stream_seq` is the position within it. `stream_seq` is allocated from a counter column on the run row, inside the appending transaction:

```sql
UPDATE run SET next_seq = next_seq + 1 WHERE run_id = $1 RETURNING next_seq - 1;
```

That single statement buys three properties a sequence cannot provide. The row lock **serializes appends within one stream**, so `stream_seq` is strictly and contiguously increasing within it — the only ordering guarantee the design relies on. The counter lives in a row, so an aborted transaction **un-increments it** — no gaps from rollback, which `BIGSERIAL` explicitly does not offer. And because the lock is per-`run_id`, **different runs never contend**.

The cost is that concurrent appends inside one run serialize on that row. That is acceptable and arguably desirable: a run has at most a handful of concurrent branches, the transactions are short, and the resulting order is what makes per-run reads reproducible.

Not stored here: raw model input and output, which live in blob storage referenced from `payload` (§7). Hot query fields (`run_id`, `event_type`, `vertex_id`, `scope_id`) are real columns; everything else stays in JSONB.

**Every intra-run reference uses `stream_seq`** — `replan/boundary.boundary_seq`, `subgraph/shadowed` ranges, `fork/created.boundary_seq`. Cross-run references, such as `evidence_seqs` in harness-state ([04](./04-refine-and-harness-state.md)), must be `(run_id, stream_seq)` pairs; a bare number is ambiguous.

A fork (§5.2) copies inherited events — the divergence vertex's causal ancestors, plus lazily merged causally independent events — with the source stream's `stream_seq` values unchanged, and numbers its own events above `eval_up_to_seq` so an inherited seq and an own seq can never collide. `PRIMARY KEY (run_id, stream_seq)` stays satisfied because `run_id` differs.

### 3.1.1 Projections and their indexes

The transaction bracket state is **not a separate log** — `txn/*` events are ordinary `event_log` rows. What the coordinator needs beyond the log is a set of projections for queries a raw scan cannot serve. All of them are updated **in the same database transaction as the event append**, never asynchronously: pivot admission is a safety-critical synchronous read, and a projection lagging by even a few hundred milliseconds could let an irreversible action fire that should have been blocked.

| Projection | Key columns and indexes | Query it serves |
|---|---|---|
| `txn_scope` | `scope_id` PK, `state`, `pivot_vertex_id`, `savepoint_seq`, `opened_seq`, `closed_seq`; partial unique `(scope_id) WHERE is_pivot` | "May this scope's pivot fire?" and "is there an open bracket at this replan boundary?" |
| `txn_bracket` | one row per try: `state`, `deadline_at`, `idempotency_key`; **partial index `WHERE state = 'tried'`**; unique `(idempotency_key)` | orphan sweep `WHERE state='tried' AND deadline_at < now()`; timer rebuild after restart |
| `work_queue` | `vertex_id`, `ready_at`, `claimed_by`; claimed with `FOR UPDATE SKIP LOCKED` | the Distributed Transaction Coordinator claiming executable vertices |

The partial index on `txn_bracket` matters operationally: open brackets are a small hot set while closed ones are cold history, so the sweep's cost stays independent of total log size. It is also the crash-recovery mechanism — the coordinator holds no timers in memory, it re-reads open brackets by deadline on restart.

### 3.1.2 Invariants pushed into the database

Constraints do not forget, and the coordinator has many concurrent writers. Anything expressible as a constraint belongs there rather than in review comments — and all of these are cheap now and near-impossible to retrofit once production data exists.

| Discipline | Database mechanism |
|---|---|
| Append-only (§3.3 inv. 1) | Application roles have no `UPDATE`/`DELETE` grant on `event_log`; controlled security-definer append functions are their only write path |
| Event ownership ([AGENTS.md](../../AGENTS.md) #29) | `BEFORE INSERT` trigger checks the connection's `session_user` against the event-type ownership table, so the TS engine cannot append `txn/*` and the Coordinator cannot append `subgraph/*` |
| Idempotency ([02 §2](./02-transaction-model.md)) | `UNIQUE (idempotency_key)` on `txn_bracket` — a duplicate try becomes a constraint violation instead of a duplicated side effect |
| One pivot per scope (R3) | partial unique index on the pivot column; a second line of defence behind the freeze-time check |
| No cancel after pivot (I3) | `BEFORE INSERT` trigger rejects a `txn/cancel` when the scope projection records `pivot-passed` |

`event_log` has no `shadowed_by` column. Shadowing is declared only by `subgraph/shadowed` events; a materialized shadow flag may exist inside a projection table, where the projector owns it.

### 3.2 Core event vocabulary

| Event type | Meaning | Permitted writer |
|---|---|---|
| `run/start`, `run/end` | Run lifecycle | engine |
| `subgraph/proposed` | Complete planner sub-DAG proposal; the proposed gateway contract adds the immutable `tool_view_ref` and `tool_view_digest` used for admission ([09 §3](./09-tool-registry-gateway.md)) | engine (planner output) |
| `subgraph/frozen` | Check-rules passed; all vertex rows are atomically appended | engine |
| `subgraph/rejected` | Check-rules rejection and reasons | engine |
| `vertex/created` | Vertex definition: role, tool, parameters, and transaction attributes | engine during freeze |
| `vertex/started`, `vertex/succeeded`, `vertex/failed` | Execution state transitions | the vertex's executor (§3.2.1) |
| `vertex/retried` | Idempotent retry number and backoff | the vertex's executor (§3.2.1) |
| `subgraph/shadowed` | Replan shadowed a failed subtree; payload names affected seqs | engine |
| `replan/boundary` | In-place replan: selected `boundary_seq`, planner vertex, reason, cancelled scopes. No new run is created (§5.1) | engine |
| `fork/created` | **Offline evaluation only** (§5.2): source run, `at_vertex_id`, `eval_up_to_seq`, seed length, substitutions, `fold_mode`, evaluator pin, `projector_version`, and `harness_state_version` | engine |
| `run/end-seed` | First own event of a fork, closing its inherited seed; every inherited copy — in the seed or merged later — is read-only (§5.2) | engine |
| `txn/scope`, `txn/try`, `txn/confirm`, `txn/cancel`, `txn/pivot-passed` | Transaction-bracketing events; see [02](./02-transaction-model.md) | engine/executor |
| `budget/charged` | Token and cost accounting | engine |

### 3.2.1 Which executor owns a vertex

Execution events belong to whichever executor ran the vertex, and the partition is by effect class. A tool-caller vertex is **Orchestrator-executed** if and only if its pinned contract declares `effect_class: none` *and* it carries no `scope_id`; every other queued vertex is **Coordinator-executed**.

A read has no transaction bracket, no compensation, and no pivot interaction, so there is nothing for a transaction coordinator to own — and the `reads-live` fold mode ([05 §3.2](./05-context-aggregation-and-offline-evaluation.md)) already assumes the Orchestrator executes exactly that class of tool live. Check-rule R10 requires every side-effecting node to belong to a scope, so the two classes partition the queued vertices with no overlap and no gap.

The class is derived from the vertex payload and never declared, exactly as `is_pivot` is derived from `effect_class`. Both the work queue and the event-log ownership trigger compute it the same way, so a service cannot append an execution event for a vertex it does not own even if its own guard is bypassed.

Unknown `event_type` values are **fail-closed**: readers reject the complete log rather than silently skipping them. Extensible events require an explicit `ignorable` flag. A schema version is included in `run/start` from day one.

### 3.3 Invariants

1. **Append-only.** Every action appends a new event; state changes, shadowing, and forks never mutate historical rows. Only materialized projection columns or tables may be updated.
2. **Atomic append.** Freezing a proposal appends `subgraph/frozen` and all `vertex/created` events in one database transaction. The entire subgraph is visible or none of it is. This is a control-plane transaction, not a business transaction.
3. **Partial order, and purity scoped to one stream.** `parent_refs` defines causal order. Neither sequence number carries causal meaning: adjacent values in parallel branches imply no dependency. The two sequences carry deliberately different guarantees, and **purity of the projection is defined only against `stream_seq`**:

   | | `stream_seq` | `global_seq` |
   |---|---|---|
   | Scope | one stream = one run = one DAG | whole table |
   | Strictly increasing | yes | yes |
   | Contiguous, no gaps | **yes** | no |
   | Survives rollback without skipping | **yes** (counter in a row) | no (sequences do not roll back) |
   | Commit-ordered | **yes** (serialized by the stream's run row lock) | **no** |
   | Legal input to a fold | **yes** | **never** |
   | Use | projections, folds, forks, replay, all intra-stream references | coarse global ordering, operational triage only |

   The reason for the split is that a `BIGSERIAL` is allocated before commit but observed after it. Two concurrent appends may take 100 and 101 while 101 commits first, so an incremental reader can advance past 100 and skip it permanently. Worse than a skipped event, **the same set of events can fold in two different orders on two different reads, and the projection stops being a pure function** — which would take down replay testing, prompt caching, and reproducible historical evaluation together, since all three rest on that purity.

   `stream_seq` removes the hazard within the boundary that matters, and the boundary is honestly declared:

   - **Guaranteed:** a fold over one stream is a pure function of that stream's events. `surface`, `slice`, `fold`, `linearize`, and `assemble` all operate inside one stream, and so does every fork evaluation — a counterfactual compares two surfaces, each folded from a single stream (§5.2). Nothing in the projection pipeline reaches across streams.
   - **Not guaranteed:** a fold over the concatenation of streams. Cross-run analytics must therefore be computed as **fold per stream, then aggregate** — never as one fold ordered by `global_seq`. This is a rule, not a preference: the second form is not reproducible ([05 §4](./05-context-aggregation-and-offline-evaluation.md)).

   One more requirement follows, and it is easy to miss. Serializing appends fixes the *storage* order but not the *scheduling* order: two concurrent siblings may be assigned `stream_seq` in either order across replays. Purity therefore also demands that **every reducer be commutative over concurrent events** — events with no `parent_refs` path between them. `linearize` satisfies this by sorting on `vertex_id` (§4.2), and semantic-fold reducers satisfy it because compensation is delta-based rather than state-restoring ([02 §4.3](./02-transaction-model.md) D2), which makes their operations commute. A reducer that is order-sensitive over concurrent events breaks purity even with a perfect sequence, so this is asserted by the permutation test in [06 §7](./06-validation-harness.md) O4.
4. **Visibility assertion.** Before every planner model call, runtime asserts that the sent context equals the log projection followed by linearization. A projection-hash comparison may replace full byte comparison to avoid dsh's double-serialization cost.

## 4. Surface Projection and Linearization

### 4.1 Surface

`surface(stream, at_stream_seq) → current_dag` folds one stream's events up to that position in `stream_seq` order and removes subtrees shadowed by `subgraph/shadowed`, yielding the currently active DAG. Any `stream_seq` may be folded, which is what makes historical inspection and fork comparison the same operation (§5.2). Its input is always a single stream; no projection reaches across streams. It may be implemented as a materialized view or engine cache, but it **must always be reproducible from the complete log with the same result**. This is the basis of replay testing.

### 4.2 Linearization

Planners consume linear context while the log is partially ordered. Each planner call therefore uses a deterministic function:

```
linearize(surface, planner_vertex) → [ctx_item...]
```

1. Include only the planner's ancestor closure and result summaries, rather than full outputs, from sibling branches.
2. Sort parallel branches lexicographically by `vertex_id`, never by either sequence number or completion time; scheduling order must not affect replay. `stream_seq` fixes storage order but not the order in which concurrent siblings were scheduled, so sorting on it would still be non-reproducible.
3. Inject failure evidence as an explicit structured section during replanning, rather than scattering it through history.

The function is pure. The same log prefix and harness-state version produce the same prompt, allowing regression assertions without a model.

## 5. Replanning In Place, and Forking for Offline Evaluation

Flory deliberately **splits** what dsh unifies. dsh makes resume, fork, and replay one primitive because a session is a cheap local object whose identity carries no external meaning. A Flory run is a **business process** — one order, one replenishment — so run identity has business meaning, and the mechanisms must be kept apart. The current decision and rejected alternatives are recorded in [ADR-005](./adr/adr-005-lazy-causal-fork-semantics.md).

Three mechanisms, three purposes:

| Mechanism | Purpose | Creates a run? |
|---|---|---|
| **Resume** | crash recovery | no — re-project the same stream |
| **In-place replan** | online recovery from a tool failure (§5.1) | no — append to the same stream |
| **Fork** | offline counterfactual evaluation (§5.2) | yes — a new run with its own stream |

### 5.1 Online replanning does not fork

Replanning appends to the **same run**: `subgraph/shadowed` hides the disproven subtree from `surface`, then the chosen planner is called again and appends a fresh proposal. A `replan/boundary` event records which boundary was selected and why. No prefix is copied and no new `run_id` is created.

Creating a child run online would buy nothing and cost two real things:

1. **A fragmented audit trail.** "What happened to order 12345" would become a chase across a chain of run ids instead of one readable run. For a business process this is the more serious of the two.
2. **Pure storage waste.** Deep-copying the prefix duplicates events that the shadow mechanism already handles correctly.

Crash recovery is likewise **not** a fork: it is a resume, achieved by re-projecting the same stream.

### 5.2 Fork is a lazy causal counterfactual on an immutable history

The event log is **immutable history**. Its purpose is that the context state at any moment can be folded from it. To ask a counterfactual question, we do not mutate history; we branch it into a new run. 

Because forks are strictly for **offline evaluation**, they are completely decoupled from online transaction constraints. A fork is **not** bound by pivot floors, nor is it restricted to planner vertices. It can occur at *any* vertex to evaluate any counterfactual—whether swapping a model in a planner, changing a tool version at a tool-caller node, or injecting a mock response for dry-run simulation.

```
fork(source_stream, at_vertex_id, substitutions[], eval_up_to_seq) → new run
```

The mechanics of a fork operate on the principle of **Causal Chain Evaluation**:

1. **Branch at any vertex.** A new run is created. The targeted node `at_vertex_id` becomes the divergence point. 
2. **Substitute and Invalidate Causality.** One or more events at or after the divergence point have their **`pin_version` replaced** (e.g., tool version, model endpoint). By changing the divergence vertex, **all its causal descendants (derived via `parent_refs`) are strictly invalidated**. They will not be inherited because the cause has changed, so the new run must generate a new resulting sub-DAG, new tool calls, and new transaction events to replace them.
3. **Merge Causally Independent Events.** Not all events after the divergence point are causal descendants. Events that have no causal link to the forked vertex (e.g., sibling parallel branches, external user inputs, out-of-band webhook events) are still valid. These causally independent events are merged and replayed onto the new run up to the requested evaluation sequence.
4. **Lazy Evaluation.** A fork is **lazy**. It does not automatically run to completion. Evaluation happens by specifying a target `seq` from the source run (`eval_up_to_seq`), and the engine only executes the new causal chain and replays independent events up to that sequence. This produces a comparable fold.
5. **Mocking and Blocked Folds.** Because different fork strategies require different levels of execution, `fold_mode` determines how far execution proceeds. A strategy might dictate "no live LLM calls." In this case, the fold executes only up to context assembly and blocks, producing just the context prompt (ideal for prompt diff evaluation). For deeper simulations, the system can inject **mocked tool responses** to continue dry-running the new causal chain without hitting real endpoints.

Inherited events are **read-only copies** wherever they sit: in particular a fork never cancels or confirms an inherited `txn/try`, because that hold belongs to a live source run — an inherited open bracket is history to mock around or terminate lazily at, never to mutate ([02 §4.4](./02-transaction-model.md), [03 §2.4](./03-replan-and-recovery.md)).

See region E of [diagrams/projection.drawio](./diagrams/projection.drawio) for the causal branch-and-merge graph.

This architecture ensures that forks perfectly isolate the causal impact of a single counterfactual change, without being artificially constrained by production recovery boundaries like pivots.

### 5.3 `pin_version`: what a substitution actually changes

Every event that depends on an external contract carries a **`pin_version`** identifying that contract:

| Pinned thing | Example |
|---|---|
| Model endpoint and parameters | `model://claude-sonnet-5@2026-06/temp=0` |
| Tool API contract | `tool://logistics.book@v4` |
| Prompt assembly strategy | `assemble://v7 + harness_state@v12` |
| Fold reducer | `fold://inventory@v3` |

A substitution is nothing more elaborate than **changing one of these pins and replaying**. That is why the mechanism needs no special cases for "what if we used a different model", "what if the carrier API had behaved as in v5", or "what if the prompt had been assembled differently" — all three are the same operation on a different pin.

The pin is also what makes a fork reproducible: a fork with no substitutions must fold to a surface identical to the source, and any difference means an unpinned dependency leaked into the pipeline.

### 5.4 Fold modes: the side-effect ladder

A fork's fold may be evaluated at four increasing levels of liveness. The ladder is defined by `effect_class` ([02 §1](./02-transaction-model.md)), so it needs no separate vocabulary:

| `fold_mode` | Model | `effect_class: none` tools | Writes | Answers |
|---|---|---|---|---|
| `recorded` | recorded outputs | recorded outputs | never | "does the projection pipeline still produce the same surface" — pure, free, deterministic |
| `model-live` | called fresh | recorded outputs | never | "what would this model version have planned, given the same observations" |
| `reads-live` | called fresh | **actually called** | never | "what would it plan, and what does it really cost at today's prices" |
| `writes-live` | called fresh | actually called | **actually performed** | nothing offline — this *is* production, and is listed only to name the boundary that offline evaluation must not cross |

`recorded` through `reads-live` are the offline family; `writes-live` is not an evaluation mode at all. Each name states what is live, and `reads-live` states the safety property: reads are live precisely because a read has no side effect by definition.

### 5.5 Fork evidence is scoped to one history

A fork produces a **paired counterfactual on one history**: the same task and observations with named pins changed. Its result explains that case and nothing broader. ToB e-commerce runs differ in catalog, inventory, prices, channel rules, and external timing, so two unrelated runs are not parallel comparison units.

Corpus evaluation therefore preserves the individual source/fork pair and its provenance. It may group case-level results descriptively by task type or failure class after folding each stream independently, but it must not pool them into a causal estimate or claim that one configuration is globally better. Forks support historical explanation, regression detection, operator what-ifs, and evidence for a human promotion decision; they do not authorize production changes automatically ([05 §4](./05-context-aggregation-and-offline-evaluation.md)).

## 6. Replay Testing

The log is both a mock script and expected output. Record one real run, replay it in `fold_mode: recorded` (§5.4), and assert an event-by-event stream match while ignoring timestamps. JIT-DAG regression testing then becomes a stream diff instead of an API-key-dependent model run.

Replay is a fork with **no substitutions**: same stream, same pins, `recorded` mode. Its expected result is therefore an identical surface, which makes it the cheapest possible check that the projection pipeline has not drifted — and the first thing to run after any change to a projection layer or a `pin_version` default.

## 7. Open Questions

- **Log granularity:** dsh records streaming model chunks, which makes logs heavy and requires compression. Flory's current choice is vertex fidelity, not token fidelity: payloads contain summaries plus external blob references for raw model input and output.
- `subgraph/shadowed` positional reasoning needs property-based tests for multi-replan boundary cases.
- **Append contention inside one very wide run.** `stream_seq` serializes appends on the run row (§3.1). A run with unusually high branch fan-out would queue on that lock. No measurement exists yet; if it becomes real, the options are batching several events per transaction or sharding the counter per branch — the latter costs the contiguity that made the design worth having, so it should not be reached for early.
- **Offline readers still see `global_seq` gaps.** Purity is guaranteed per run (§3.3 inv. 3), which covers the projection pipeline, but trace validation and metric recomputation read across runs. They must either fold per run and then aggregate, or consume Postgres logical decoding, which delivers events in commit order. Which of the two becomes the standard path is unresolved.
