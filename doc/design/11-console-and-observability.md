# Console and Observability (11)

> Status: Draft v0.1 | Depends on: [01](./01-jit-dag-and-event-log.md), [02](./02-transaction-model.md), [05](./05-context-aggregation-and-offline-evaluation.md), [10](./10-deterministic-routers.md)

> Mockup: [ui-mockups/flory_dag_console.jpg](../ui-mockups/flory_dag_console.jpg) — the canvas, the vertex cards, and the inspector drawer.

## 1. Why a Console Exists

A Flory DAG has no shape until it runs. A planner freezes one chunk, a router decides whether a branch exists at all, a scope opens and later commits or compensates, and a replan shadows a subtree that stays in the log forever. Every one of those is recorded, and none of them is legible by reading an append-only log in `run_seq` order: the reader has to fold the log in their head to answer "what is the graph right now", and then fold it again at an earlier position to answer "what did it look like before that replan".

That fold already exists and is authoritative ([01 §4](./01-jit-dag-and-event-log.md#4-surface-projection-and-linearization)). What is missing is a reader for it. The Console is that reader: an operator-facing view of one run's graph as it grows, with the transaction structure and the discarded history drawn rather than inferred.

It is deliberately not a second engine. The browser never touches raw events and never runs a graph algorithm, for the same reason no second projector exists in Go ([00 §3.1](./00-overview.md#31-service-and-language-boundaries)): two implementations of projection semantics cannot be kept in agreement, and the disagreement would be invisible until an operator acted on a picture the engine does not believe.

## 2. Design Language

The Console follows the layout conventions of a machine-learning pipeline console — Material Design cards on a pannable canvas, a persistent left navigation, and a right slide-out drawer for detail — because that vocabulary is already proven for branched, long-running pipelines and carries no novel interaction for an operator to learn under incident pressure.

It **must adapt to light and dark automatically and offer an explicit override**, matching the convention every diagram in this repository follows. Neutral ink, canvas background, and node fill alpha change with the theme; status colours do not, so a red edge means the same thing in both.

## 3. The Console Projection

### 3.1 Why the planner's projection cannot be reused

`surface()` exists to build a prompt, and everything it discards is discarded to save context tokens or to protect replay determinism:

| Discarded by `surface`/`linearize` | Why the planner must not see it | Why the Console must |
|---|---|---|
| Shadowed subtrees | A replanned-away branch is not part of the current plan, and showing it would invite the model to reason about work that no longer exists | Replanning history is the single most common thing an operator is trying to understand |
| Timestamps and durations | Wall-clock time is not reproducible, so a prompt that contained it could not be replayed | Latency is most of what monitoring is for |
| Scope membership and pivot position | The planner declares transaction structure; feeding it back would let it reason from its own declaration | Where the commit point is, is the first question during an incident |
| A fall-through router | Rendering it would add a line at every junction of every prompt ([10 §8](./10-deterministic-routers.md#8-prompt-invisibility)) | An operator needs to see that the junction exists and that no rule matched |

The two audiences want opposite things, so they get two projections of one log rather than one projection stretched across both.

### 3.2 The read model

The Engine exposes a versioned **`ConsoleDAGProjection`** beside the canonical surface projection. It is a projection in the same sense: a pure function of one run's events, reproducible from the log, carrying its own version so a rendering can be attributed. It retains what §3.1 lists, and enriches each vertex:

```jsonc
{
  "vertex_id": "v-1234",
  "role": "tool",
  "status": "succeeded",
  "is_shadowed": false,
  "txn": {
    "scope_id": "txn-7f3a",
    "is_pivot": true,
    "effect_class": "irreversible"
  },
  "timing": {
    "started_at": "2026-09-08T12:00:00.120Z",
    "completed_at": "2026-09-08T12:00:00.340Z",
    "duration_ms": 220
  },
  "router_outcome": { "matched_condition": "amount > 100" }
}
```

A shadowed vertex is flagged rather than removed, and the canvas draws it greyed with dashed edges. `is_pivot` is derived here exactly as it is everywhere else ([02 §2.1](./02-transaction-model.md#21-derived-attributes-are-never-declared)) — the Console displays the derivation and never accepts a declaration of it.

### 3.3 Streaming

A DAG that grows cannot be streamed as status patches alone: the client would receive an update for a vertex it has never heard of. The stream therefore carries structural deltas as well, over Server-Sent Events or a WebSocket:

| Event | Emitted when | What the canvas does |
|---|---|---|
| `topology_snapshot` | On connect, and on any recovery the server cannot close with deltas | Replaces its whole model: every active and shadowed vertex, every edge, and the current `run_seq` watermark |
| `subgraph_appended` | A planner or router freezes a sub-DAG (`subgraph/frozen`) | Animates the parent unfolding into its new branches |
| `subgraph_shadowed` | A replan discards a subtree (`subgraph/shadowed`) | Greys out the named vertices in place, rather than removing them |
| `vertex_patched` | `vertex/started`, `vertex/succeeded`, `vertex/failed`, and timing updates | Updates one card |

**Sequence fencing.** Every event carries the `run_seq` it reflects, and a reconnecting client presents the last one it received. The server resumes from there when it still holds the intervening events, and otherwise issues a fresh `topology_snapshot`. A client is therefore never asked to reconcile a gap, which is what keeps it a renderer: reconciling would mean folding, and folding in the browser is the thing this design exists to prevent.

### 3.4 Detail is fetched, not streamed

An assembled prompt, a raw completion, and a tool's full output are each larger than the graph they belong to, and an operator looks at one of them at a time. Embedding them in the stream would make the canvas pay, on every update, for data almost never read. The drawer fetches them on demand instead:

| Endpoint | Returns |
|---|---|
| `GET /api/v1/runs/:runId/vertices/:vertexId/prompt` | The assembled prompt and the raw model completion |
| `GET /api/v1/runs/:runId/vertices/:vertexId/logs` | Execution output for that vertex, from blob storage |
| `GET /api/v1/runs/:runId/vertices/:vertexId/payload` | Full inputs and outputs, including those too large for the event log |

## 4. The Views

**Canvas.** Vertices are cards with a left-edge status colour and a role icon, laid out as the DAG. Transaction scopes are drawn as dashed enclosures, and a pivot is marked as the boundary it is: everything before it can still be compensated, everything after it cannot ([02 §4.1](./02-transaction-model.md#41-event-brackets)). Standard pipeline controls apply — zoom, pan, fit, and a collapsible mini-map.

**Inspector.** Clicking a vertex opens a right slide-out drawer rather than a modal, so the graph stays visible beside the detail. It carries three tabs: **Details** (status, duration, metadata), **Payload** (for a planner, the prompt and completion; for a tool caller, the frozen input and the returned result; for a router, the condition that matched), and **Logs** (that vertex's execution output).

The router tab is worth stating explicitly: a matched router shows the condition that fired, and a fall-through router shows that nothing matched. That is visible here and nowhere else, because the planner's prompt omits it by design.

## 5. Boundaries

- **The Console folds nothing.** Structural folding, scope derivation, and shadow tracking stay in the Engine. The browser renders a model it is handed.
- **The Console writes nothing.** It reads the log through a projection; it is not a control surface, and no operator action flows back through it.
- **The projection is versioned.** A rendering can be attributed to a projector version exactly as a prompt can, which is what makes a disputed screenshot answerable.

## 6. Rejected Alternatives

- **A CLI alone.** Adequate for triggering a run and reading a log tail, and not adequate for a branched graph whose shape changed three times during the incident being diagnosed. The shape is the thing under investigation.
- **An existing workflow UI (Argo, Airflow).** Both assume the graph is known at submission. Flory's is not: it is decided during the run by a model and by rule templates, and progressive disclosure is the property being observed rather than an inconvenience to work around. Mapping a JIT-DAG into a static visualiser would either flatten the growth or misrepresent it.
- **Folding events in the browser.** It would remove the need for a second backend projection, and it would create a second implementation of projection semantics whose disagreement with the Engine would surface as an operator acting on a graph that never existed.
- **Reusing the planner's `surface()` output.** Cheapest of all, and it omits precisely what monitoring needs: shadowed history, timing, scope structure, and fall-through routers (§3.1).

## 7. Open Questions

- Multi-run views. This design covers one run's graph; an operator watching a fleet needs a list and a health rollup, and neither is specified here.
- Retention. How far back a `topology_snapshot` can be served for a completed run depends on log retention, which is unspecified.
- Authorization. The detail endpoints return prompts and tool payloads, which may carry business data; which roles may read them is not yet decided.
