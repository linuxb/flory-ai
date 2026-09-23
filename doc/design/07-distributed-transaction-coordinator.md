# Distributed Transaction Coordinator Architecture (07)

> Status: Active v0.2 | Depends on: [00-overview](./00-overview.md), [01-jit-dag-and-event-log](./01-jit-dag-and-event-log.md), [02-transaction-model](./02-transaction-model.md)

## 1. Overview

The Distributed Transaction Coordinator is Flory's execution and transaction-safety service. The TypeScript Engine plans and projects; the Coordinator claims executable vertices, calls adapters, and enforces TCC and pivot-saga rules. Go 1.25 is the implementation choice specified in [00 §3.1](./00-overview.md#31-service-and-language-boundaries), not part of the component's identity or public protocol.

See [coordinator-engine-interaction.drawio](../diagram/coordinator-engine-interaction.drawio) for the service boundary and event flow.

## 2. Runtime Contract

A successful TCC try appends `txn/try` and creates a **sealed, half-open bracket**. Sealed means that the resource is reserved or frozen and the try may participate in a pivot barrier. It does not mean that TCC confirm has run.

The pivot barrier admits an irreversible vertex only when every required predecessor try in the scope is sealed and no scope cancellation has started. The pivot then runs. After `txn/pivot-passed` is durably appended, the Coordinator confirms the sealed TCC members with idempotent, retryable confirm operations.

If any pre-pivot member fails, the append that records the failure also fences the scope: it hands out no more work and admits no pivot. The Coordinator starts no cancellation because of it. The Engine decides whether the scope must cancel, as part of deciding the replan, and says so with `replan/cancel-requested`; the Coordinator polls pending requests and executes each as one scope-level cancellation, cancelling every sealed TCC member and compensating every completed Saga member in reverse dependency order. The one cancellation the Coordinator still starts itself is the orphan sweep's (§3.4). `txn/cancel` describes that scope action with `requested` and `completed` phases; it never means "cancel one try". The completed phase is appended only after every required inverse operation succeeds.

## 3. Modules

### 3.1 Work Scheduler

The scheduler claims ready work through PostgreSQL `FOR UPDATE SKIP LOCKED`, maintains recoverable leases, and evaluates parent completion. Confirmation barriers are runtime vertices: they wait for all required tries to become sealed, abort when the scope starts cancelling, and never call a business adapter.

**One lock order.** Router branch admission, recovery decisions, worker claiming, and cancellation all serialize through the same scope row, and all acquire locks in the order `txn_scope FOR UPDATE`, then `run` (every append), then `work_queue FOR UPDATE SKIP LOCKED`. A scoped Coordinator append goes through `append_scope_events`, which takes the scope row before appending: the append triggers fence, reference, or rewrite that row after `append_events` has locked the run, so appending the other way round deadlocks against the Engine's recovery, which locks the run's scopes and then appends. Candidate discovery must never lock the queue before the scope. Branch admission checks `state = 'open'`, rejects a scope holding an expired sealed try, and appends the branch and queues its work in that one transaction. A worker validates scope state and establishes its bounded lease in one transaction, which makes the race decisive in either direction: if cancellation commits first, ordinary queued work can no longer be claimed; if the claim commits first, the live lease blocks sweeper cancellation.

**A fenced scope hands out nothing.** An `open` scope whose member failed, or whose cancellation the Engine has requested, is claimed as though it were already cancelling, and `admit_pivot` refuses it. The fence closes the window between a failure and the Engine's request, in which the scope would otherwise keep taking reservations that the cancellation will have to undo.

**Claim eligibility follows the operation's frozen phase**, not merely the existence of a scope:

| Work | Eligible scope state |
|---|---|
| New pre-pivot member work | `open` |
| Already-admitted post-pivot forward work | `pivot-passed`, and `committed` where the frozen graph permits work after confirmation |
| Confirm or forward-recovery operation | The recovery path of §3.3; never a new pre-pivot claim |
| Cancel or compensate | `cancelling`, through the cancellation-member queue |
| Unscoped read | No scope lock; the executor ownership rule of [01 §3.2.1](./01-jit-dag-and-event-log.md#321-which-executor-owns-a-vertex) applies unchanged |

`pivot-inflight` is reserved for the admitted pivot and its outcome resolution. `suspended` blocks automatic business dispatch until explicit recovery. Ordinary work never runs in `cancelling` or `cancelled`. Eligibility is a filter in front of the existing checks, not a replacement for them: parent dependencies, pivot admission, and the prohibition on backward compensation after a pivot all still apply.

Router vertices are not scheduled here at all. They call nothing, so the Engine evaluates them synchronously on parent completion and no queue row is ever created ([10 §7](./10-deterministic-routers.md#7-runtime-execution-and-event-lifecycle)).

### 3.2 Transaction Lifecycle Manager

The lifecycle manager owns scope states `open`, `cancelling`, `pivot-inflight`, `pivot-passed`, `committed`, `cancelled`, and `suspended`. Safety-critical transitions use database functions that lock the synchronous projection and append the corresponding event in one transaction.

### 3.3 Tool Executor

The executor calls an adapter with a frozen idempotency key and deterministic retry policy. Before dispatching a try, it checks that no other vertex's bracket already holds the key: if one does, the try is recorded as a permanent failure and its row completed, never dispatched — dispatching it would be a second operation under one key whose bracket could never be recorded. A try whose own bracket already exists (its completion was lost after the append) is completed without running again. If another try takes the key while this one is in flight, the call is recorded once as a failure that needs reconciliation, rather than retried into the same conflict on every lease expiry. An unknown pivot outcome is resolved only through the pivot's registered status-query operation. After a pivot, retries are forward-only; exhausting the frozen policy suspends the scope for human intervention. Every call carries the frozen tool-view digest and the exact tool version, and `gatewayd` routes one attempt without ever deciding or hiding a retry.

Before a side-effecting request leaves the executor, it durably records the attempt identity, idempotency key, and start under the scope lock, having validated scope state and lease ownership in the same transaction. That record is **unresolved** until a definitive outcome is written back. Nothing else resolves it: not queue deletion, not lease expiry, not a transport timeout. This is what lets §3.4 distinguish "the worker stopped" from "the effect did not happen".

On a successful call, the executor lifts the control-flow fields named by the tool's registered **log-fields schema** — status codes, scores, classifications — directly into `vertex/succeeded`, while bulk output streams to blob storage. Routers evaluate strictly against those in-event fields, so a deterministic branch decision never performs blob I/O ([09 §3](./09-tool-registry-gateway.md#3-registration-and-the-tool-view-contract), [10 §7](./10-deterministic-routers.md#7-runtime-execution-and-event-lifecycle)).

### 3.4 Orphan Sweeper

The sweeper polls two recovery sets, and the worker loop polls a third. A scope with a pending Engine cancellation request is served first on every worker pass, through the same decision below with origin `engine`; a request deferred by a live lease stays pending and comes round again a second later, and a deferred or failing request never uses up the pass, so it cannot starve claims for other runs. An `open` scope with a sealed bracket past its deadline is a **candidate** for cancellation. A `cancelling` scope with no effective member lease is a recoverable interruption; the sweeper passes its recorded cancellation idempotency key back to the same scope-cancellation loop, which claims the remaining inverse work or appends the terminal completed event when none remains. A live lease prevents takeover, while an expired lease permits an idempotent retry. Confirm and cancellation still race through the scope fence, and no correctness-critical timer or cancellation cursor exists only in memory.

A candidate is not yet a decision. The earlier query result is never trusted: inside the cancellation transaction, under `txn_scope FOR UPDATE`, `request_scope_cancel` re-verifies the scope state, the authorization for its origin, live leases, and unresolved attempts, and then takes exactly one path ([02 §4.4](./02-transaction-model.md#44-orphan-try-detection)). Both origins use the scope's one cancel key, so a sweep and an Engine request converge (`duplicate`):

| Observation under the lock | Action |
|---|---|
| Origin `engine` with no recorded request | Refuse. A failure-driven cancellation exists only because the Engine asked for it. |
| Origin `timeout` with no expired sealed try | `ineligible`: the candidate no longer qualifies. |
| A live execution lease exists | Defer. Progress is defined by a live lease, not by queue occupancy. |
| An attempt is unresolved (§3.3) | Preserve the queue and the attempt evidence, record suspension, and escalate to L4. Suspension keeps pivot-admission and pivot-passage evidence and never clears the no-cancel fence. |
| Authorized, no live lease, no unresolved attempt | Append `txn/cancel {phase: requested}` and remove pending ordinary work in the same transaction, retaining attempt history and every recorded effect cancellation will need. |

The projection behind the function enforces the same authorization, so an append that goes around it is refused as well. Post-pivot states never take the last path. The only automatic resolution of an unknown outcome remains the pivot's registered status query; for an unresolved non-pivot attempt an operator establishes the external outcome and ensures the original request can no longer create an effect before authorizing recovery. A late worker result arriving after suspension is retained as evidence and authorizes nothing on its own.

## 4. Adapter Boundary

The Coordinator reaches every tool through the [gatewayd Tool Registry Gateway](./09-tool-registry-gateway.md), by MCP `tools/call`. Each request carries the run, vertex, scope, attempt number, exact tool version, tool-view digest, idempotency key, immutable input, and a deadline. Responses are one of `succeeded`, `retryable-failure`, `permanent-failure`, or `unknown`.

Routing through the gateway changes discovery and dispatch, not ownership. The Coordinator still decides every retry, appends the `vertex/*` events for the vertices it executes and all `txn/*` events, and enforces TCC and pivot recovery. The gateway routes exactly one requested attempt and never generates a second.

A companion call — confirm, cancel, compensate, or a pivot status query — carries the try's `tool_view_digest` and no version of its own. The companion resolves by name inside that same frozen view, which registration admission already guarantees it belongs to.

The direct HTTP adapter remains as one thing only: the control arm of the dual-path fixture that proves both routes produce identical outcomes and byte-identical upstream payloads. No scenario runs on it.

The test world is a set of tool services built on the SDK, with deterministic fault injection keyed by `(seed, tool, attempt_no)`. They register with the gateway exactly as a production service does, and expose reset and oracle snapshots only in tests.

## 5. Interaction with the Engine

The event log remains the only Engine/Coordinator boundary. The Engine owns planning and structure events; the Coordinator owns every `txn/*` event.

Execution events are owned by the vertex's executor rather than by the Coordinator unconditionally ([01 §3.2.1](./01-jit-dag-and-event-log.md)). The Coordinator executes every queued vertex except those whose pinned contract declares `effect_class: none` and which carry no scope; those are the Orchestrator's, because they have no bracket, no compensation, and no pivot interaction for a transaction coordinator to own. Router vertices are never queued and are evaluated by the Engine. The database enforces the partition on the work queue and the append boundary, so no service can execute or record a vertex belonging to another.

On a pre-pivot terminal failure in a deterministic router branch, the Engine requests the scope's cancellation exactly as for any other, and once it has resolved records an L4 `replan/boundary` whose `selected` is null — an escalation, never a replan. No planner is called for that failure ([03 §2.5](./03-replan-and-recovery.md#25-deterministic-branches-never-replan-with-a-model)).

The Coordinator may build operational projections for execution, but it must not implement `surface`, `slice`, `fold`, `linearize`, or `assemble`.

On a pre-pivot terminal failure, scope cancellation completes before the Engine may append a legal `replan/boundary`: the Engine decides and appends under the run's scope locks, waits while any scope it asked about is still cancelling, and the database refuses a `subgraph/shadowed` into a scope that has not closed. On a post-pivot terminal failure, the scope is not fenced and nothing is requested; the Coordinator completes the work, and never compensates backward across `txn/pivot-passed`.
