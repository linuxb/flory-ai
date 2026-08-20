# Context Aggregation and Experimentation (05)

> Status: Draft v0.1 | Depends on: [01-jit-dag-and-vertex-log](./01-jit-dag-and-vertex-log.md), [04-refine-and-harness-state](./04-refine-and-harness-state.md)
> Diagram: [diagrams/projection.drawio](./diagrams/projection.drawio) — all charts live on one sheet.

## 1. Why the Log Exists

The vertex log is not primarily a storage decision. Its purpose is that **the input to every decision can be reconstructed exactly**. Three consequences follow, and the third is the one that pays for the whole design:

1. **One truth, many readers.** A planner sees a pruned projection; a human sees the full transcript; an auditor sees everything including shadowed rows; refine sees anchored evidence; tests see a diff baseline. Mutable state can serve exactly one reader.
2. **Time comes for free.** State at any historical point is `fold(prefix)`. Fork, replan, crash recovery, and post-mortem all collapse into one primitive.
3. **Attribution is credible.** `evidence_seqs` and A/B arms point at replayable inputs rather than at recollection. Without this, agent A/B testing is impossible in principle: you cannot prove that a difference between two runs came from the variable you changed rather than from context that happened to differ.

Corollary worth stating explicitly: **the more verbose the log, the more valuable the projection layer**. Aggregating at write time is cheap today and permanently forfeits the freedom to aggregate differently tomorrow.

## 2. Projection Pipeline

Building a prompt is not "query and concatenate." It is a layered pipeline of pure functions, each solving one orthogonal problem.

| Layer | Signature | Problem it solves | Example (task: replenish and list 12 SKUs) |
|---|---|---|---|
| `log` | — | Facts | 48 events: 12 inventory queries, 3 price checks, 1 API failure, 1 shadow |
| `surface` | `log → active_dag` | Which vertices still count | 36 active vertices; the failed branch is invisible to planners |
| `slice` | `(surface, planner) → subgraph` | Relevance | P5 takes its 8-vertex ancestor closure plus 2 sibling digests |
| `fold` | `subgraph → entity_views` | Fidelity reduction | `inventory_view: {SKU-123: avail 20}`, `price_table: 3 confirmed` |
| `linearize` | `(views, planner) → [item]` | Order and budget | lexicographic by `vertex_id`; trimmed to 1.2k tokens |
| `assemble` | `(items, harness_state@vN) → prompt` | Policy and memory | sections per assembly rules, mem-hints resolved ([04](./04-refine-and-harness-state.md)) |

### 2.1 Layer contracts

- Every layer is **pure** and **independently cacheable**. Cache key = `hash(run_seq_prefix) + projector_version + harness_state_version`. The prefix is hashed over one run's events ordered by `run_seq`; `global_seq` is never an input, because it is neither gap-free nor commit-ordered and would make the key non-reproducible ([01 §3.3](./01-jit-dag-and-vertex-log.md) inv. 3).
- Every layer must be able to **dump its intermediate output**. Multi-layer pure pipelines are cheap to reason about and expensive to debug blind; when a prompt looks wrong, an operator must be able to ask which layer distorted it.
- Layers may be replaced individually, but replacement bumps `projector_version` (see §4.2).

### 2.2 Semantic fold: the e-commerce-specific layer

This is the layer most likely to be skipped and the one with the highest payoff.

A planner deciding a shipping strategy should not read the raw JSON of 12 inventory queries. It needs a folded business view:

```jsonc
// fold registry entry
{
  "view": "inventory_view",
  "sources": ["inventory.check", "inventory.reserve", "inventory.release"],
  "reducer_ref": "fold://inventory@v3",   // pure, unit-tested, versioned
  "render_budget_tokens": 120
}
```

Benefits, in order of importance:

1. **Correctness.** "Which of the 12 query results is current" is arithmetic. Delegating arithmetic to the model reliably produces errors; a reducer does not.
2. **Cost.** Thousands of tokens of raw tool output become tens of tokens of state.
3. **Testability.** A reducer is a pure function over a typed event stream, so it is exhaustively unit-testable.

Registry discipline: a view declares its source event types and a versioned `reducer_ref`; reducers may not call tools, read the clock, or perform I/O. `fold://inventory@v3` is part of `projector_version`.

### 2.3 Shadowed events: pruned for visibility, retained as evidence

The same events take two projection paths, and conflating them is a bug in both directions:

- **Toward the DAG:** shadowed subtrees are removed. Otherwise a planner believes a disproven path is still live.
- **Toward evidence:** their conclusions are retained as a structured failure-evidence section. Otherwise the planner repeats the mistake it just made.

So `surface` drops them while `assemble` reintroduces their distilled conclusion. See [03](./03-replan-and-recovery.md) §2.3 for the evidence schema.

### 2.4 Prompt-cache dividend

Because the log is append-only and `linearize` is deterministic, prompt **prefixes are naturally stable**: a later turn's prompt shares a byte-identical prefix with the previous turn's. This maps directly onto provider prompt caching.

This is the second, monetary reason for the rule in [01](./01-jit-dag-and-vertex-log.md) §4.2 that parallel branches sort by `vertex_id` and never by a sequence number or completion time: scheduling jitter would change the prefix on every turn and destroy the cache-hit rate. Replayability and cost efficiency come from the same constraint.

## 3. Three-Tier A/B Testing

| Tier | Method | Cost | Measures | Cannot measure | Use |
|---|---|---|---|---|---|
| **L1 Replay A/B** | Pin the log prefix, swap only the assemble version, diff the resulting prompts | No model call, no side effects | Prompt size, presence of key facts, rule activation | Any model-behavior change | CI gate on every refine |
| **L2 Counterfactual fork** | Fork at a real planner boundary, replan with arm B, **dry-run without executing tools** | One model call, still no side effects | Check-rule pass rate, plan size, mis-declared pivots, LLM-judge score | Real execution failure rates | Primary method for low-frequency task types |
| **L3 Live A/B** | Split traffic **by run**; `run/start` records the arm | Real traffic, real side effects | Replan rate, tokens per task, post-pivot suspension rate, business success rate | — | High-frequency task types only |

L2 is a capability unique to a log-structured engine: at any historical decision point one can ask "what plan would arm B have produced," with zero side effects. The same mechanism compares **recovery strategies** — fork twice from one failure `run_seq`, once greedy and once wider — an unplanned dividend of boundary selection being separable from execution ([03 §2.1](./03-replan-and-recovery.md)). Note that forking is reserved for exactly this offline family; online replanning appends in place and never forks ([01 §5](./01-jit-dag-and-vertex-log.md)).

### 3.1 What "dry run" means

Dry run means **zero side effects**, not zero tool calls. The distinction matters, because a plan whose tool calls were all stubbed would be worthless for the question operators actually ask. The line is drawn by `effect_class` from [02 §1](./02-transaction-model.md):

| `effect_class` | Dry run may execute | Carrier example |
|---|---|---|
| `none` (read-only) | **Yes** | Quote and transit-time queries: what would this cost, how fast |
| `bufferable`, `reversible`, `irreversible` | **No** | Booking a shipment, reserving inventory, changing a price |

A planner's output is a **structure** — a sub-DAG proposal of nodes, tools, bound parameters, and declared transaction scopes — and producing it costs one model call, not a single write. So an operator asking "what if we shipped from warehouse B instead" gets back: which carrier and warehouse, how many steps, the real quoted cost, whether check-rules pass, and where the pivot sits (that is, after which step the plan can no longer be abandoned). All of that without creating one shipment.

What a dry run **cannot** tell you is whether the writes would succeed — whether the booking API rejects the address format, whether the reservation loses a concurrency race. Dry runs measure plan quality, never execution success rate, which is why the L2 row above lists real failure rates as unmeasurable.

Two implementation constraints follow. A dry run needs its **own budget**, because read calls still cost money and consume rate limits; and its reads should preferentially hit a cache of the live run's recent reads. The executor enforces this through a **dry-run policy gate**: on encountering a non-`none` node it skips execution and records an unverified estimate, rather than calling the tool.

### 3.2 Discipline

**Split by run, never by turn.** Mixing harness-state versions inside one run lets earlier turns contaminate later ones, and attribution collapses.

**Metrics are projections, not telemetry.** Replan rate, tokens per task, and suspension rate are folded from the log. Payoff: when a metric definition changes, **history can be recomputed**. With separate telemetry, changing a definition throws away the comparison baseline.

**Fold per run, then aggregate — never one fold over the global stream.** Projection purity is guaranteed within a run and explicitly not across runs ([01 §3.3](./01-jit-dag-and-vertex-log.md) inv. 3). A metric computed by folding `global_seq` order is not reproducible, so two recomputations of the same historical window can disagree; computing each run's value and then aggregating is deterministic and parallelises by `run_id` as a side benefit.

**The attribution anchor is a triple.** `run/start` records `harness_state_version` + `projector_version` + `arm_id`. Omitting `projector_version` causes the subtlest failure available here: improving the `fold` implementation silently changes recomputed historical metrics, so last month's A/B conclusion quietly stops holding. A projector being pure does not make it stable across versions.

**Stratify.** E-commerce tasks are wildly heterogeneous — repricing one SKU versus bulk-listing 200 differs by two orders of magnitude in tokens. Uniform splitting lets variance swallow the effect. Stratify on (task type × SKU-count bucket × contains-pivot) from `task_input` metadata, or apply CUPED-style variance reduction using historical means.

**Guardrails outrank the target metric.** A refine that cuts tokens while raising the post-pivot suspension rate is a catastrophe, not a win. Safety metrics have veto power over the automatic rollback decision in [04](./04-refine-and-harness-state.md) §4.3.

## 4. Costs and Risks

1. **Write amplification and storage.** Mitigated by the [01](./01-jit-dag-and-vertex-log.md) §7 decision to keep the log vertex-fidelity rather than token-fidelity; raw model I/O lives in blob storage referenced from the payload.
2. **Projector drift.** Any change to `surface`, `fold`, or `linearize` changes recomputed history. Mitigation: `projector_version` is recorded alongside the log schema version, and metric recomputation always states which projector version produced it.
3. **Debuggability of pure pipelines.** Mitigation: per-layer dump plus a golden-file test per layer, so a bad prompt is localized in one step rather than bisected across six.
4. **Statistical power.** L3 needs volume that low-frequency tasks never reach; L1/L2 carry those cases instead. This is the concrete answer to the `window_runs` open question in [04](./04-refine-and-harness-state.md) §6.

## 5. Open Questions

- Cache invalidation for `fold` views when a reducer is upgraded mid-run: recompute the whole run, or pin the run to its original reducer version?
- Whether `slice` should ever include non-ancestor context on explicit planner request (an escape hatch risks breaking prefix stability).
- LLM-judge calibration for L2 scoring, and whether the judge itself needs versioning in the attribution triple.
