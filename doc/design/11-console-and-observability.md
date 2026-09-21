# Console and Observability (11)

> Status: Draft v0.2 | Depends on: [01](./01-jit-dag-and-event-log.md), [02](./02-transaction-model.md), [05](./05-context-aggregation-and-offline-evaluation.md), [10](./10-deterministic-routers.md)

> Mockup: [ui-mockups/flory_dag_console.jpg](../ui-mockups/flory_dag_console.jpg) — directional only. It is a generated sketch: it carries another vendor's branding and several garbled labels, and none of that is part of this design. What it usefully settles is the layout language — a top-to-bottom layered canvas with cross edges, cards carrying a status colour and a progress indicator, a glow on the selected node, and a right drawer. It also shows a collapsible dependency tree, which is noted and not adopted.

## 1. Why a Console Exists

A Flory DAG has no shape until it runs. A planner freezes one chunk, a router decides whether a branch exists at all, a scope opens and later commits or compensates, and a replan shadows a subtree that stays in the log forever. Every one of those is recorded, and none of them is legible by reading an append-only log in `run_seq` order: the reader has to fold the log in their head to answer "what is the graph right now", and then fold it again at an earlier position to answer "what did it look like before that replan".

That fold already exists and is authoritative ([01 §4](./01-jit-dag-and-event-log.md#4-surface-projection-and-linearization)). What is missing is a reader for it. The Console is that reader: an operator-facing view of one run's graph as it grows, with the transaction structure and the discarded history drawn rather than inferred.

It is deliberately not a second engine. The browser never touches raw events and never runs a graph algorithm, for the same reason no second projector exists in Go ([00 §3.1](./00-overview.md#31-service-and-language-boundaries)): two implementations of projection semantics cannot be kept in agreement, and the disagreement would be invisible until an operator acted on a picture the engine does not believe.

## 2. Design Language

The Console follows the layout conventions of a machine-learning pipeline console — cards on a pannable canvas and a right slide-out drawer for detail — because that vocabulary is already proven for branched, long-running pipelines and carries no novel interaction for an operator to learn under incident pressure.

It **must adapt to light and dark automatically and offer an explicit override**, matching the convention every diagram in this repository follows. Neutral ink, canvas background, and node fill alpha change with the theme; status colours do not, so a red edge means the same thing in both. That invariance is structural rather than conventional: the `--status-*` tokens are declared once, outside every theme block, so no theme block *can* override one, and a card composes an invariant hue with a theme-dependent alpha instead of branching on the theme.

**One deliberate deviation from the repository's diagram conventions.** AGENTS.md mandates a font stack beginning with `LXGW WenKai TC`, which the diagrams fetch from a CDN. The Console does not. An operator console may be opened on an isolated network during exactly the incident it exists for, and a font request that hangs delays first paint of the thing being read. The Console uses the system UI stack for chrome and `ui-monospace` for identifiers and JSON; the palette and surface tokens are shared with the diagrams exactly, which is the part that makes it look like the rest of the repository.

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

The one rule the two must agree on is shared rather than restated: `rendersInPlannerPrompt` lives in the canonical projection, `linearize` filters with it, and the Console reports its answer per vertex. A second copy of a rule whose disagreement nothing could detect is worse than the mild boundary smell of sharing one.

### 3.2 The read model

`console/server/src/projection.ts` holds a versioned fold beside the canonical surface projection. It is a projection in the same sense: a pure function of one run's events in `run_seq` order, reproducible from the log, carrying its own version (`console-projector@v1`) so a rendering can be attributed.

It performs no I/O and **queries no projection table**. `txn_scope` and `txn_bracket` are themselves triggers over these same events, so reading them would be reading a derived copy; they are additionally wrong for a counterfactual, whose inherited rows the trigger skips under `flory.inherit_copy`. Everything below therefore comes from the log:

| Field group | Derived from |
|---|---|
| `label`, `role` | the `vertices: [{author_id, vertex_id, role}]` list on `subgraph/frozen` — an author's own name for a vertex, so a card reads `reserve` or `fulfil#router` rather than a UUID |
| `status`, `timing`, `attempts` | the `created_at` of `vertex/started` and of the terminal event, and nothing else |
| `txn.scope_id` | the `scope_id` **column** on `vertex/created` |
| `txn.is_pivot` | `effect_class === 'irreversible'` on the tool vertex's own `vertex/created` payload |
| `txn.pivot_passed`, `scopes[].pivot_passed_seq` | `txn/pivot-passed` |
| `bracket` | `txn/try`, `txn/confirm`, `txn/cancel` |
| `decided_by` | the `source` field on `subgraph/proposed`, which the router executor sets to `'router'` |
| `cost`, `spend` | `budget/charged`, which carries the model, duration, full token usage and an optional priced estimate |
| `depth` | the fold, assigned once when a vertex is created |
| `in_planner_prompt` | `rendersInPlannerPrompt`, shared with `linearize` |

Four additions beyond what a first sketch of this document listed, each because the canvas is unreadable without it:

- **Bracket state.** Without it a scope enclosure is an empty rectangle. With it, `sealed` → `confirmed` is visible on the card that holds it.
- **Proposals.** A refused proposal appends `subgraph/rejected` and nothing else, so without projecting it "why did nothing appear here" is unanswerable.
- **Cost.** For a console watching a model-driven system this is among the most valuable things on a card, and it costs nothing to project.
- **`pivot_declaration_mismatch`.** This turns "the Console never accepts a declaration" from a claim into a visible signal.

`is_pivot` is derived exactly as it is everywhere else ([02 §2.1](./02-transaction-model.md#21-derived-attributes-are-never-declared)) — displayed as a derivation, never accepted as a declaration. A shadowed vertex is flagged rather than removed, and the canvas draws it faded with dashed edges.

**Router outcome is a discriminated union, not a matched condition.** A single `{matched_condition}` field cannot express the states an operator actually opens the drawer for:

| Outcome | Means |
|---|---|
| `pending` | has not evaluated yet |
| `matched` | a rule fired and emitted a branch, with no model call; carries the condition and the branch index |
| `fell_through` | no rule matched, so no branch was created — legitimate by design, and indistinguishable on the canvas from a rule set that no longer covers its data |
| `evaluation_error` | a condition could not be evaluated; the graph is missing work its author intended to exist |
| `proposal_rejected` | a rule fired and admission refused what it proposed; carries the violations |

**The snapshot and the deltas come from one code path.** `consoleDag(events)` is *defined as* a fold of `advanceConsoleDag(model, batch)`. Two implementations could let a resumed client and a fresh client diverge, which is exactly what the reconnect criterion tests; with one, that criterion cannot fail, and a property test over every split point proves it.

**The batch, not the event, is the delta unit.** `run_seq` is allocated under the run row lock and `freezeUnderScopeLock` commits a freeze with all of its `vertex/created` rows in one transaction, so one `subgraph_appended` carries a whole branch rather than one delta per vertex.

The fold is a `switch` over `EventType` with a `never`-typed default, so adding an event type to the IDL breaks the build.

### 3.3 Streaming

A DAG that grows cannot be streamed as status patches alone: the client would receive an update for a vertex it has never heard of. The stream therefore carries structural deltas as well.

**Server-Sent Events, not WebSocket.** Node 22 has no WebSocket *server*, so a WebSocket would cost a runtime dependency for a read-only feed. SSE is `res.write()`. It is also one-directional by construction, which makes "the Console writes nothing" structural rather than a rule someone can break in four lines. And `Last-Event-ID` *is* the resume protocol described below, implemented by the browser.

**A polling tail, not `LISTEN`/`NOTIFY`.** The repository's existing handoff mechanism is already a poll with `SKIP LOCKED`. Against `NOTIFY` specifically: it fires for every event of every run, watched or not; its queue is bounded, so a stuck listener can fail *committing transactions*, and putting a read-only feature on a path that can break engine writes is wrong at any load; it is not durable, so a poll must back it up anyway. `TailSource` is an interface with one implementation, so a `NotifyTailSource` can drop in later behind its own measurement. One `RunTailer` per run is shared by every subscriber, with an adaptive interval, and stops when the last subscriber leaves.

| Event | Emitted when | What the canvas does |
|---|---|---|
| `topology_snapshot` | on connect, and on any recovery deltas cannot close | Replaces its whole model — but not the session: selection, open tab and viewport survive |
| `subgraph_appended` | a planner or a router freezes a sub-DAG | Grows the parent into its new branches, without moving the viewport |
| `subgraph_shadowed` | a replan discards a subtree | Fades the named vertices in place rather than removing them |
| `vertex_patched` | a lifecycle, bracket, pivot or cost event touches a vertex | Replaces one card |

Every delta carries the complete replacement vertex, the complete closed set of shadowed ids, or the new vertices and scopes in full — never a sparse patch and never a subtree root. A sparse patch would push merge semantics into the browser, and a subtree root would force it to walk edges to find the members, which is shadow tracking in the browser. Each delta also carries the run-level `spend` rollup, because a client forbidden to recompute rollups has no other way to keep one current.

**Cursor fencing.** The SSE `id` is `<at_run_seq>.<ordinal>`, and a subscriber fences on the pair. Both halves are load-bearing:

- The **ordinal** distinguishes the several deltas one committed batch produces, which all share that batch's watermark. Fencing on the sequence alone applies the first delta of a batch and silently discards the rest.
- The **watermark** is the batch's, never the sequence of the event that motivated the delta. A freeze's own `run_seq` sits *below* the `vertex/created` rows committed with it, so an append fenced at the freeze carries a cursor that runs backwards the moment a reader splits the two — which a poll boundary or a read limit may do, since atomicity stops a partial commit being visible and nothing more. Which freeze produced a vertex is not lost by this: it is on the vertex, as `frozen_by_seq`.

**Resume is always possible.** An earlier draft of this document said the server resumes "when it still holds the intervening events", which implied an in-memory buffer and a window outside it. The log is in PostgreSQL: the server can always re-read from `run_seq > last` and re-derive the deltas a client missed. A snapshot is therefore a first-connect concern, and the other paths to one are genuine rarities — a malformed cursor, a cursor ahead of the watermark (a warm client after a server restart), or a subscriber so slow it was dropped. `resolveResume` is a pure function covering all five cases, and every ambiguous one falls back to a snapshot, because handing a client a gap would be asking it to fold.

**A client never attempts gap detection, and cannot.** `run_seq` counts log events, most of which produce no console event, so two consecutive stream events are not consecutive in `run_seq`. Contiguity is entirely the server's contract; monotonicity is the only sequence rule a client is entitled to.

**A counterfactual streams like any other run.** That is a consequence of eager inheritance ([01 §5.2](./01-jit-dag-and-event-log.md)) rather than something the Console arranges. While inheritance was lazy, a counterfactual's back-filled events landed *below* the watermark its own events had already passed, so a tail asking for `run_seq > last` could never see them — structurally, not by accident. Everything a counterfactual will inherit is now present before its first own event, so a watermark is sound for it exactly as for any other run and the Console needs no special case.

**A run has no terminal state.** `run/end` is in the event vocabulary and nothing emits it. The stream therefore never ends on its own and the server applies an idle policy instead; a run list can show last activity but not "finished".

### 3.4 Detail is fetched, not streamed

An assembled prompt, a raw completion, and a tool's full output are each larger than the graph they belong to, and an operator looks at one of them at a time. Embedding them in the stream would make the canvas pay, on every update, for data almost never read. The drawer fetches them on demand instead.

**Two of these three cannot be served, and the reason is not a Console problem.** Nothing in the Engine persists a prompt or a completion — `planner-executor.ts` records `input_digest` and `output_digest` and discards the text — and the Engine has no blob client at all: every mention of "blob" under `engine/src` is a comment, and blob storage is a Go-only concern serving exactly one namespace, `tool-views/sha256-<hex>.json`.

| Endpoint | Status | Returns |
|---|---|---|
| `GET .../vertices/:vertexId/payload` | served | the frozen input, the result or the failure, the lifted log fields, and the attempt count |
| `GET .../vertices/:vertexId/prompt` | `501` | why raw model input and output are not retained, plus `input_digest` and `output_digest` |
| `GET .../vertices/:vertexId/logs` | `501` | why tool execution output is not collected, plus the same digests |

`501` and not `404`, deliberately: a 404 asserts that *this vertex has no prompt*, which is false for a planner. 501 says the server does not implement retention, which is exactly true, and lets the drawer render a "not retained" tab rather than an error. The digests are genuinely useful on their own — an operator comparing two runs can tell whether the same prompt was sent, even though neither was kept. A `404` still means "no such vertex" and a `204` would mean "nothing produced yet", so the drawer can say three different true things.

**The prompt must not be synthesised by re-running `assemble()`.** It produces the canonical context, not the messages the planner loop actually sent, and its digest may not equal the recorded one. Presenting a read-time recomputation as history is the "picture of a graph that never existed" §6 rejects. The missing write path is an open question (§7), not something to paper over here.

## 4. The Views

**Canvas.** Vertices are cards with a left-edge status colour, a role icon, and the author's own name for the vertex. Transaction scopes are drawn as enclosures, and a pivot is marked as the boundary it is: everything above it can still be compensated, everything below it cannot ([02 §4.1](./02-transaction-model.md#41-event-brackets)). Zoom, pan, fit and a mini-map apply.

**Layout is stable under growth, and that is a correctness property rather than a polish one.** No vertex is ever re-layered or reordered: a freeze attaches children to an existing parent and nothing ever *gains* a parent, so a vertex's layer is fixed once assigned, and the server supplies both `depth` and a total order. What is given up is crossing minimisation, which is a legibility annoyance; what is bought is that motion on the canvas always means "something happened here". A node that drifts because an unrelated branch appeared teaches an operator to stop trusting motion, and that is a correctness-of-perception failure.

**Viewport ownership.** `fitView` runs once, when a run is opened, capped at 1:1 so a one-vertex run is not magnified to fill the pane. After that an append **never** moves the viewport — an operator who has panned to a failing branch must not be yanked away by unrelated work finishing. Growth is announced with a `+N new` pill that pans on click.

**A scope enclosure can lie, and when it would, it is not drawn.** A rectangle encloses a scope's members without also enclosing non-members only when nothing else falls inside its bounding box. Ordering scope members ahead of unscoped work buys that in the common case — it holds a scope in one column across every layer it spans — and not in every case, and [02](./02-transaction-model.md) leaves nested scopes open. When containment fails the rectangle is dropped in favour of a per-card scope chip and a tint. A rectangle around a vertex that is not in the scope is worse than no rectangle, because the operator will believe it.

**A discarded subtree is drawn faded, with dashed edges and a `discarded` chip.** This is the Console's headline feature and, for a while, the one it could not demonstrate: nothing appended `subgraph/shadowed`, so the path was unit-tested and invisible in every live run. The recovery ladder now produces it ([03 §2.3](./03-replan-and-recovery.md)), and a run that replanned shows both the work that was abandoned and the boundary it was abandoned at, side by side with what replaced it.

**A live duration is a client clock read and is marked as one.** The projection has `started_at` and no `duration_ms` until completion. Reading the clock in a view is legitimate — the purity rule governs projections — but the result carries the operator's own clock skew against the server's timestamps, so it renders as visibly approximate and must never be quoted in a postmortem as measured latency.

**Inspector.** Clicking a vertex opens a right slide-out drawer rather than a modal, so the graph stays visible beside the detail. Four tabs: **Details** (role, status, what created it, transaction position, cost, and whether a downstream planner sees it), **Payload** (frozen input, result or failure, and the lifted log fields shown apart from the result so it is visible that a rule saw a summary rather than the whole payload), **Prompt** and **Logs** (§3.4).

A router's Details tab is worth stating explicitly, because it is the one vertex whose *absence of effect* is the interesting case: three of its four outcomes mean no branch appeared here, for very different reasons, and the tab says which. A branch a rule emitted also carries a `by rule` chip on its card — the distinction routers exist for is invisible in the graph's shape, and on the canvas a rule-made branch must not read as work a model chose.

## 5. Boundaries

- **The Console folds no events.** Stated precisely, because "the Console folds nothing" is too strong to survive contact with a client that applies a `vertex_patched` and therefore maintains a model: **no event folding, no scope derivation, and no shadow tracking in the browser.** The operational rule a reviewer can apply mechanically is that the client may write a field only when the server named both the field and its value in the event, and may never compute a value from the graph. Layout position is the one thing the client computes, and it is presentation rather than projection.
- **The Console writes nothing.** It reads the log as `console_role`, whose entire privilege set is `SELECT` on `run_event_log`. That is enforcement in the database rather than in the type system, and the server is `GET`-only — every other method is `405`, which is the cheapest possible statement of the same thing.
- **The projection is versioned, and the version is on screen.** A rendering can be attributed to a projector version exactly as a prompt can. The version is rendered in the header rather than hidden in a tooltip, because attribution only works if a screenshot contains the answer.
- **A counterfactual is never presented as a production run.** The data plane already enforces this — counterfactual writes carry `is_counterfactual` and land in a separate stream namespace so no production fold can mistake a simulation for a fact — and the presentation layer had no counterpart. The model exposes `kind: 'production' | 'counterfactual'` rather than a raw `seed_floor`, and the run list and run header label a counterfactual unmistakably. Handing the client a nullable sequence number and asking it to know what that means is one more thing it could get wrong.
- **A counterfactual is linked to, never drawn into, the run it forked from.** `toInheritedCopy` preserves both `run_seq` and `vertex_id` deliberately, so that a fork can be compared position-by-position with its source; merging the two onto one canvas would need an invented disambiguation rule, which is itself proof that the picture is not one run. More importantly, drawing a branch line on the production graph says "this also happened", undoing at the presentation layer what the storage layer was careful to separate. The divergence vertex carries a badge, and following it opens that counterfactual's own canvas, labelled as one. The comparison an operator actually wants is two graphs side by side at the same position, which belongs with the multi-run views §7 defers.

## 6. Rejected Alternatives

- **A CLI alone.** Adequate for triggering a run and reading a log tail, and not adequate for a branched graph whose shape changed three times during the incident being diagnosed. The shape is the thing under investigation.
- **An existing workflow UI (Argo, Airflow).** Both assume the graph is known at submission. Flory's is not: it is decided during the run by a model and by rule templates, and progressive disclosure is the property being observed rather than an inconvenience to work around. Mapping a JIT-DAG into a static visualiser would either flatten the growth or misrepresent it.
- **Folding events in the browser.** It would remove the need for a second backend projection, and it would create a second implementation of projection semantics whose disagreement with the Engine would surface as an operator acting on a graph that never existed.
- **Reusing the planner's `surface()` output.** Cheapest of all, and it omits precisely what monitoring needs: shadowed history, timing, scope structure, and fall-through routers (§3.1). It also *deletes* shadowed vertices from its map, which is the one thing this projection must not do.
- **WebSocket instead of SSE.** A runtime dependency for a read-only feed, on a runtime whose standard library has no WebSocket server, and a bidirectional channel for something that must never accept a write (§3.3).
- **`LISTEN`/`NOTIFY` instead of a poll.** It puts a read-only feature on the append path, where a stuck listener can fail committing transactions, and it is not durable, so a poll would back it up regardless (§3.3).
- **Hosting the surface in `gatewayd`.** It already has OIDC and RBAC, which is the one thing the Console lacks, and it is the wrong process: `gatewayd` is on the tool-invocation path and owns contract identity, and giving it a second responsibility that re-implements a TypeScript projection in Go is exactly the duplication [00 §3.1](./00-overview.md#31-service-and-language-boundaries) forbids.
- **A layout library (`dagre`, `elkjs`).** `dagre` ranks stably under append but its ordering phase is global, so adding one leaf can permute siblings several layers up with no way to pin the previous order — precisely the reshuffling §4 rules out. `elkjs` does solve it, at roughly ten times the bundle of everything else in the client plus a configuration surface nobody here would own. Neither knows about transaction scopes, so with either one the ordering would have to be fought to make an enclosure drawable.

## 7. Open Questions

- **Authorization**, with an interim answer. The detail endpoints return tool payloads, which may carry business data, and no authentication exists in TypeScript — `gatewayd`'s OIDC and RBAC are Go-only. Until this is decided the Console **binds to loopback and refuses any other address** unless `CONSOLE_ALLOW_REMOTE=true`, which logs a line naming this section. That turns an open question into something an operator must consciously override. Note that the answer constrains the transport: a session cookie keeps native `EventSource`, whose `Last-Event-ID` is the resume protocol already; a bearer token forces a `fetch`-stream rewrite, because `EventSource` cannot set headers.
- **The retention write path**, which is the prerequisite for §3.4's two unserved endpoints. Nothing persists prompts, completions, or tool execution output, and the Engine has no blob client to persist them with. This is a storage decision with its own cost and its own privacy questions, and it is not one this work stream should make on the way past.
- **Multi-run views.** This design covers one run's graph. A minimal recent-runs list exists as an entry point, because the alternative is pasting a UUID; a fleet health rollup and the side-by-side counterfactual comparison §5 describes are not specified here.
- **Retention of history.** How far back a `topology_snapshot` can be served for a completed run depends on log retention, which is unspecified.
