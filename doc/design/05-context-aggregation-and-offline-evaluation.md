# Context Aggregation and Offline Evaluation (05)

> Status: Draft v0.1 | Depends on: [01-jit-dag-and-event-log](./01-jit-dag-and-event-log.md), [04-refine-and-harness-state](./04-refine-and-harness-state.md)
> Diagram: [diagrams/projection.drawio](./diagrams/projection.drawio) — all charts live on one sheet.

## 1. Why the Log Exists

The event log is not primarily a storage decision. Its purpose is that **the input to every decision can be reconstructed exactly**. Three consequences follow, and the third is the one that pays for the whole design:

1. **One truth, many readers.** A planner sees a pruned projection; a human sees the full transcript; an auditor sees everything including shadowed rows; refine sees anchored evidence; tests see a diff baseline. Mutable state can serve exactly one reader.
2. **Time comes for free.** State at any historical point is `fold(prefix)`. Fork, replan, crash recovery, and post-mortem all collapse into one primitive.
3. **Historical comparisons are reproducible.** `evidence_seqs` and fork provenance point at exact inputs rather than recollection. A source/fork difference can be attributed to named substitutions because both histories and every versioned dependency are recorded.

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

- Every layer is **pure** and **independently cacheable**. Cache key = `hash(stream_seq_prefix) + projector_version + harness_state_version`. The prefix is hashed over one run's events ordered by `stream_seq`; `global_seq` is never an input, because it is neither gap-free nor commit-ordered and would make the key non-reproducible ([01 §3.3](./01-jit-dag-and-event-log.md) inv. 3).
- Every layer must be able to **dump its intermediate output**. Multi-layer pure pipelines are cheap to reason about and expensive to debug blind; when a prompt looks wrong, an operator must be able to ask which layer distorted it.
- Layers may be replaced individually, but replacement bumps `projector_version` (see §4.2).

### 2.2 Semantic fold: framework mechanism, domain-owned meaning

This is the layer most likely to be skipped and the one with the highest payoff. The engine provides the pure, versioned reducer registry and deterministic dispatch. The current inventory reducer is an in-process validation mock, so its reducer, view type, and business oracle live under `test/mocks/`; the engine may not import a SKU, carrier, payment, or any other business concept.

For example, the e-commerce test sandbox registers an inventory reducer. A planner deciding a shipping strategy should not read the raw JSON of 12 inventory queries. It receives the mock world's folded business view instead:

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

Registry discipline: a view declares its source event types and a versioned `reducer_ref`; reducers may not call tools, read the clock, or perform I/O. `fold://inventory@v3` is part of `projector_version`. The reducer lives with the e-commerce test mock, not in the engine framework or a production domain package; this is enforced by the framework-boundary rule in [`AGENTS.md`](../../AGENTS.md).

### 2.3 Shadowed events: pruned for visibility, retained as evidence

The same events take two projection paths, and conflating them is a bug in both directions:

- **Toward the DAG:** shadowed subtrees are removed. Otherwise a planner believes a disproven path is still live.
- **Toward evidence:** their conclusions are retained as a structured failure-evidence section. Otherwise the planner repeats the mistake it just made.

So `surface` drops them while `assemble` reintroduces their distilled conclusion. See [03](./03-replan-and-recovery.md) §2.3 for the evidence schema.

### 2.4 Prompt-cache dividend

Because the log is append-only and `linearize` is deterministic, prompt **prefixes are naturally stable**: a later turn's prompt shares a byte-identical prefix with the previous turn's. This maps directly onto provider prompt caching.

This is the second, monetary reason for the rule in [01](./01-jit-dag-and-event-log.md) §4.2 that parallel branches sort by `vertex_id` and never by a sequence number or completion time: scheduling jitter would change the prefix on every turn and destroy the cache-hit rate. Replayability and cost efficiency come from the same constraint.

## 3. Counterfactual Evaluation by Fork

Forking is Flory's **offline historical-evaluation** mechanism. It answers "what would have happened on *this* history if one pinned contract had been different" ([01 §5.2](./01-jit-dag-and-event-log.md)). The answer remains scoped to that history.

### 3.1 The evaluation API

Because the log is immutable and any `stream_seq` folds into a surface, an evaluation is a small, uniform call:

```
evaluate({
  source_stream:  run_id,
  at_vertex_id:   "v-4109",                   // divergence point — any vertex (01 §5.2)
  substitutions:  [{ stream_seq: 4109, pin_version: "model://claude-sonnet-5@2026-08" }],
  eval_up_to_seq: 4172,                       // lazy: execute and merge no further than this
  fold_mode:      "model-live",               // 01 §5.4 ladder
  evaluator:      "eval://plan-admissibility@v2"
}) → evaluation_result
```

The engine forks at the divergence vertex, substitutes the pins, invalidates the vertex's causal descendants, regenerates that chain while lazily merging causally independent events up to `eval_up_to_seq`, then hands the evaluator **two surfaces** — one folded from the source stream, one from the fork — at comparable positions. The evaluator is scenario-specific and owns the entire notion of "better":

| Evaluator | Compares | Typical use |
|---|---|---|
| `plan-admissibility` | check-rule verdicts and rejection reasons | did a prompt change make plans more admissible |
| `cost-delta` | folded budget views | what would a different model have cost on real history |
| `boundary-choice` | `replan/boundary` candidate witnesses | would a different policy have picked a different boundary ([03 §4.2](./03-replan-and-recovery.md)) |
| `surface-identity` | the two surfaces byte-for-byte | regression: a fork with no substitutions must produce an identical surface |

The engine supplies surfaces and never opinions. Keeping the comparison logic in a named, versioned evaluator is what allows a result to be re-derived later. `fork/created` records `(source_stream, at_vertex_id, eval_up_to_seq, substitutions, fold_mode, evaluator, projector_version, harness_state_version)`.

### 3.2 Fold modes govern the cost and the risk

The `fold_mode` ladder is defined in [01 §5.4](./01-jit-dag-and-event-log.md): `recorded`, `model-live`, `reads-live`, and the production-only `writes-live`. Two consequences matter here.

**Reads being live is a feature, not a leak.** A `reads-live` evaluation calls real quote and availability APIs, because `effect_class: none` means no side effect by definition. That is what lets an operator ask "what would shipping from warehouse B cost" and get a real number rather than a stale one. Every `bufferable`, `reversible`, or `irreversible` node is skipped and recorded as an unverified estimate.

**What no offline mode can tell you** is whether a write would have succeeded — whether the booking API would reject the address, whether the reservation would lose a concurrency race. Offline evaluation measures plan quality and cost, never execution success rate.

Two implementation constraints follow: an evaluation needs **its own budget**, since live reads cost money and consume rate limits, and its reads should prefer a cache of the source run's recent reads. The ladder is enforced through a **fold-mode gate** — on encountering a node above the declared mode the executor records an unverified estimate instead of calling the tool.

That gate lives in the Agent Orchestrator's read executor, which is the component that runs this class of node: a tool-caller vertex with `effect_class: none` and no scope is Orchestrator-executed ([01 §3.2.1](./01-jit-dag-and-event-log.md)). It is a second guard behind the database's, which already refuses to let the Orchestrator record an execution event for any other class of vertex. Live reads reach their tools through `gatewayd`, against the pinned contract the evaluation recorded, so a `reads-live` run calls the same version the source run did rather than whatever is current.

### 3.3 What forks are genuinely good for

- **Explaining one outcome.** Why did this order end in L4 suspension? Fork before the decision, substitute the pin you suspect, compare surfaces.
- **Reviewing a candidate change.** Evaluate it on an explicit corpus of historical episodes, preserving each source/fork pair and its limitations.
- **Regression-checking the pipeline.** A no-substitution fork must reproduce the source surface exactly. A difference means an unpinned dependency leaked into the projection pipeline — the single cheapest detector of that class of defect.
- **Operator what-ifs as a product feature.** "Show me the plan if we shipped from B" is the same call with a different substitution, and it is safe against production history because forks never touch the external world.

### 3.4 Case boundary

A fork yields a **paired counterfactual on one history**. Repeated forks of that source remain alternative readings of one case, not additional samples. A different run may differ in catalog, inventory, price, channel policy, task shape, or external timing, so it is not a parallel unit that can establish a population-level result.

Every report therefore keeps the case as its primary unit: source position, substitutions, source result, fork result, unverified writes, evaluator verdict, and limitations. A corpus may reveal recurring patterns and support a human promotion decision, but it does not turn heterogeneous histories into causal evidence.

## 4. Offline Evaluation Discipline

### 4.1 Gates and evidence

| Gate | Method | Authority |
|---|---|---|
| **Prompt diff** | pin the source, substitute only the assembly or harness-state version, and diff prompts | exact CI gate for prompt size, required facts, and rule activation |
| **Recorded replay** | no substitutions, `fold_mode: recorded` | exact regression gate; surfaces must be identical |
| **Historical fork** | named substitutions at `model-live` or `reads-live` | case-specific evidence for model, policy, cost, and plan-quality changes |
| **Production guardrail** | absolute invariant and safety thresholds on normal runs | rollback signal, never a cross-case comparison |

An offline result may recommend a candidate for operator review. It cannot authorize production automatically because write success is unverified and cross-case comparability is absent.

### 4.2 Provenance and aggregation

**Metrics are projections, not telemetry.** Replan depth, token cost, check-rule verdicts, and suspension state are folded from the log. When a metric definition changes, history can be recomputed under a named projector version.

**Fold per stream, then summarize — never fold concatenated streams.** Projection purity is guaranteed within one stream and explicitly not across them ([01 §3.3](./01-jit-dag-and-event-log.md) inv. 3). Descriptive corpus summaries may be grouped by task type, SKU-count bucket, pivot presence, or failure class, but every underlying case result remains available and no pooled causal claim is made.

**Provenance is complete or the result is invalid.** Record the source run and position, substitutions, `fold_mode`, evaluator pin, `projector_version`, and `harness_state_version`. Live-read results also record observation time and cache status because current quotes and inventory are not historical facts.

**Safety dominates.** A lower estimated cost cannot overcome a failed check-rule, a worse post-pivot risk, or reliance on an unverified write. Production rollback uses absolute safety guardrails or operator judgement, not a comparison between heterogeneous task windows.

## 5. Costs and Risks

1. **Write amplification and storage.** Mitigated by the [01](./01-jit-dag-and-event-log.md) §7 decision to keep the log vertex-fidelity rather than token-fidelity; raw model I/O lives in blob storage referenced from the payload.
2. **Projector drift.** Any change to `surface`, `fold`, or `linearize` changes recomputed history. Mitigation: `projector_version` is recorded alongside the log schema version, and metric recomputation always states which projector version produced it.
3. **Debuggability of pure pipelines.** Mitigation: per-layer dump plus a golden-file test per layer, so a bad prompt is localized in one step rather than bisected across six.
4. **Corpus selection bias.** Historical cases are selected rather than randomly assigned. Mitigation: version each corpus, publish inclusion rules, retain every case-level result, and state that the summary is descriptive.
5. **External-state drift.** `reads-live` observes today's read-only world, not the historical world. Mitigation: label each live read, retain recorded-read results beside it, and never present the live-read fork as an exact reconstruction.

## 6. Open Questions

- Cache invalidation for `fold` views when a reducer is upgraded mid-run: recompute the whole run, or pin the run to its original reducer version?
- Whether `slice` should ever include non-ancestor context on explicit planner request (an escape hatch risks breaking prefix stability).
- LLM-judge calibration for historical scoring; the judge is an evaluator pin and must be versioned in fork provenance.
- Corpus governance: minimum case diversity, inclusion rules, and retirement policy for histories whose external contracts can no longer be replayed.
