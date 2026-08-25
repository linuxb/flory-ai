# gatewayd Tool Registry Gateway (09)

> Status: Accepted
> Depends on: [02 — Transaction Model](./02-transaction-model.md), [05 — Context Aggregation and Offline Evaluation](./05-context-aggregation-and-offline-evaluation.md), [07 — Distributed Transaction Coordinator](./07-distributed-transaction-coordinator.md)
> Decision record: [ADR-006 — Introduce gatewayd as the Tool Registry and Execution Gateway](./adr/adr-006-tool-registry-gateway.md)
> Implementation: Go 1.25, `gatewayd/`

## 1. Purpose and Boundary

`gatewayd` is the deployment boundary for dynamic tool registration, immutable tool-view publication, and one-attempt execution routing. It has two surfaces:

- **North**, MCP `tools/list` and `tools/call` over JSON-RPC 2.0, consumed by both the Agent Orchestrator and the Distributed Transaction Coordinator.
- **South**, a gRPC registration and execution contract, spoken by tool services through the SDK.

It is an independently deployable Go 1.25 service in its own module. Sharing a language and toolchain with the Distributed Transaction Coordinator creates no internal API boundary: neither module imports the other, and they communicate only through their public contracts.

`gatewayd` does not own planning, transaction admission, retries, event appends, compensation policy, or projection semantics. It validates registrations and routes exactly one requested attempt to an upstream tool service. It writes nothing to the event log.

The deployment relationship is shown in [the deployment architecture](./diagrams/deployment-architecture.html).

## 2. Roles and Request Flow

1. A tool service declares its contracts and registers them through the SDK.
2. `gatewayd` validates each registration, builds the canonical tool view from every admitted contract, stores it in blob storage, and publishes its content-addressed reference and digest.
3. Before planning or replanning, the Agent Orchestrator resolves one immutable tool view over `tools/list`, verifies the digest against the document it was served, and records both in `subgraph/proposed`.
4. `checkSubDag(proposal, toolView)` performs deterministic admission without network I/O.
5. After a subgraph is frozen, its executor claims a ready vertex and calls `tools/call` with the exact tool-view digest, tool version, attempt number, and idempotency key.
6. `gatewayd` resolves that frozen contract and routes one attempt to a healthy registered instance.
7. The executor appends `vertex/*` events, and the Coordinator appends `txn/*` events, deciding whether another attempt is legal.

Which executor makes the call depends on the vertex, not on the gateway: a tool-caller vertex with `effect_class: none` and no scope belongs to the Orchestrator, and every other one to the Coordinator ([01 §3.2.1](./01-jit-dag-and-event-log.md)). The gateway does not know or care which one is calling; caller authority is enforced by the event log's ownership constraints.

Contract changes therefore affect only future proposals. A frozen subgraph never silently observes a newer tool contract. Instance membership and health may change so the gateway can route the same pinned contract to a healthy instance; that changes neither tool semantics nor version identity.

## 3. Registration and the Tool-View Contract

The registration contract is `flory.gateway.v1.ToolContract` in [`idl/proto/`](../../idl/proto/flory/gateway/v1/tool_contract.proto). Every registration declares:

- a stable `tool_id` and immutable `tool_version`;
- an input schema and output schema, as JSON Schema;
- a stable `route_id` and protocol adapter contract, separate from ephemeral instance addresses;
- `effect_class`, `mode`, `idempotency_key_path`, `idempotent_retryable`, timeout limits, and retry constraints;
- compensation and confirmation tool references where the selected mode requires them;
- a resource footprint and write set, and an owner.

`is_pivot` and `compensable` have no field. They are derived from `effect_class` and the declared undo path exactly as specified in [02 §2.1](./02-transaction-model.md#21-derived-attributes-are-never-declared), and the schema gives a service nothing to declare that could disagree with what they are derived from. That obligation is therefore discharged structurally rather than by a runtime check.

Two fields are explicitly outside the digest: the registering `InstanceInfo` and its `HealthReport`. Both are operational, and neither may change a contract's identity.

### 3.1 Admission and Pending State

Registration admission uses a closed vocabulary, `AdmissionCode`, reported identically by both SDK languages:

| Code | Rule |
|---|---|
| G1 | Required identity fields are present, and both schemas compile |
| G2 | `mode: tcc` declares a complete try-confirm-cancel triple with a positive `try_timeout_s`, and both companions are registered and `idempotent_retryable` |
| G3 | `mode: saga` declares a registered, `idempotent_retryable` `compensate_tool` |
| G4 | The declared `effect_class` agrees with the declared undo path: a read may not carry a bracket, an irreversible tool may not declare one, and a reversible tool with no undo path must be registered irreversible |
| G5 | A compensating tool is delta-based; snapshot restore is refused outright |
| G6 | Every referenced companion exists in the same view |
| G7 | A published `(tool_id, tool_version)` is immutable: an identical re-registration is idempotent, a differing body is refused |
| G8 | A companion reference is not self-referential |

"Proven idempotent" means *declared* `idempotent_retryable`. The gateway cannot prove idempotency; it can only refuse to publish a recovery path that never claimed to be safe to retry.

Because microservices register asynchronously on startup, a service may register a `mode: saga` tool before the service hosting its `compensate_tool` exists. Such a registration is held **Pending** and is absent from the published view, so an incomplete compensation chain is never visible to a planner. Resolution runs to a fixed point: admitting one tool can only enable others, so a dependency chain settles in whatever order the services happened to start.

Health gates a cluster's **first** admission and nothing after it. Once published, a contract stays published: health is operational evidence, not a contract mutation (§5), and withdrawing a contract on a flap would let an already-frozen digest lose a tool it was admitted against.

### 3.2 The SDK and the MCP Extension

A tool service reaches `gatewayd` only through the SDK — `gatewayd/sdk` for Go, `sdk/typescript` for TypeScript, both generated from the same `.proto`. The SDK owns registration, the heartbeat lease, health reporting, and the execution surface. Nothing else implements the protocol, because those three are what make a stateless gateway recoverable, and a service that got any of them subtly wrong would look registered while being unroutable.

The SDK validates contracts locally at startup, against the gateway's own rules rather than a restatement of them, so a bad contract fails while someone is watching the service start.

Heartbeats retry on transport failure; tool calls never do. A heartbeat is idempotent control-plane traffic with no side effect. When the gateway reports an instance unknown — which is what a restarted gateway reports — the SDK registers again. That is the entire recovery path for a gateway that deliberately keeps no durable registry.

To carry Flory's transaction semantics over standard MCP without breaking protocol compliance, `tools/list` renders each tool's registered `inputSchema` and injects the transaction properties into `metadata`:

```json
{
  "name": "inventory.reserve",
  "description": "Reserve inventory for an order",
  "inputSchema": { ... },
  "metadata": {
    "flory_transaction": {
      "effect_class": "reversible",
      "mode": "tcc",
      "idempotency_key_path": "$.order_id",
      "idempotent_retryable": true,
      "confirm_tool": "inventory.confirm",
      "cancel_tool": "inventory.release",
      "try_timeout_s": 900
    }
  }
}
```

*(`is_pivot` is absent because it is derived from `effect_class`, not declared.)*

The response's `_meta` carries `tool_view_ref`, `tool_view_digest`, and the canonical document verbatim. The rendering above is for a model; the document is the byte sequence the digest was taken over, so a caller re-derives the digest itself rather than trusting what it was served. The `subgraph/proposed` payload records the ref and digest; each tool vertex records its `tool_version` and `tool_view_digest`.

A tool view is a canonical, content-addressed JSON document. Object keys are sorted, only the escapes JSON requires are applied, and every number is an integer — a float has no canonical text form, so retry multipliers are integer thousandths. The digest covers every semantic field, including `route_id`, and excludes instance membership and health. Two independent implementations of this encoding exist, in Go and TypeScript, and a shared fixture asserts they agree byte for byte: a digest one side cannot reproduce would make every pinned contract unresolvable.

## 4. Execution Contract

An executor sends one logical attempt per `tools/call`. The request carries `run_id`, `vertex_id`, transaction scope, `tool_version`, `tool_view_digest`, `attempt`, `idempotency_key`, validated arguments, and a deadline.

Everything before dispatch fails closed, in this order: resolve the pinned view, find that exact version inside it, validate the arguments against its frozen input schema, then confirm a route is healthy. Each refusal carries a reason from a closed vocabulary — `unknown-tool-view`, `unknown-tool`, `version-absent-from-view`, `schema-violation`, `route-unhealthy` — and each means the attempt was never dispatched, which is what lets a caller treat it as decisive rather than as an ambiguous outcome needing a status query. The gateway never selects a newer version than the one requested.

A companion call — confirm, cancel, compensate, or a pivot status query — carries the try's digest and no version of its own. G6 guarantees the companion exists in that same published view, so it resolves there by name.

The gateway performs no retries. Not on a timeout, not on a transport error, not on an unavailable upstream; configured gRPC retry is disabled at the connection so an upstream cannot enable it either. A transport failure after dispatch is reported as `unknown`: the attempt left the gateway, so whether the side effect happened is unknowable there, and reporting it as retryable would authorise a duplicate. Retry legality depends on idempotency, TCC state, and pivot state owned by an executor, which is what keeps the Coordinator the single owner of `vertex/retried`, TCC brackets, pivot admission, and forward recovery.

## 5. Failure and Availability Semantics

- Publication is atomic: the blob is written before the current-view pointer is swapped, so a reader observes either the previous complete view or the next complete one, and a resolvable digest always has a document behind it.
- Tool-view resolution fails closed on an unknown digest or a malformed contract, and every read re-derives the digest before trusting the document.
- A gateway outage blocks new discovery and routed execution for both executors, but does not corrupt already recorded history.
- Executors record routing and upstream failures through the existing `vertex/failed` vocabulary; `gatewayd` appends nothing.
- Health has two independent inputs: the gateway's own gRPC health probe and the instance's self-report on each heartbeat. Both must agree before an instance is routable, because a process can believe it is serving while nothing can reach it, and can be reachable while knowing it is not ready.
- Deregistration and lease expiry withdraw a **route**, never a contract. The published view and its digest are unchanged, so a subgraph frozen against them still resolves and the call fails as unroutable rather than as unknown.

## 6. Replay and Offline Evaluation

Replay and the `recorded` or `model-live` evaluation modes consume the recorded tool view; they do not query the live gateway. Because views are content-addressed and durable, a superseded view stays resolvable by its digest long after the registry has moved on — which is what makes a frozen subgraph independent of current gateway state.

`reads-live` may execute only tools whose pinned contract declares `effect_class: none`, subject to the fold-mode rules in [05 §3.2](./05-context-aggregation-and-offline-evaluation.md#32-fold-modes-govern-the-cost-and-the-risk). The Orchestrator's read executor enforces that ceiling at the node level, recording an unverified estimate rather than calling a tool above it.

If the recorded contract or required adapter is unavailable, evaluation records a blocked or unverified result. `gatewayd` is not a time-travel database and does not reconstruct historical registrations from its current state.

## 7. The Two Routes and Their Fixtures

The gateway is the production route for both executors. The Coordinator's direct HTTP adapter survives for one purpose: it is the control arm of a dual-path fixture proving both routes are interchangeable. No scenario runs on it.

Three fixtures hold that claim up:

- **Canonical-encoding conformance.** One shared fixture, read by Go and TypeScript, asserting identical canonical bytes and digests for the cases where encoders usually diverge — key order, escaping, non-ASCII, empty containers, negative integers, and floats, which both refuse.
- **Admission equivalence.** A hand-built local registry and a registry loaded from the published tool view produce identical `CheckResult`s for the same proposals, including a case that is genuinely rejected, so the equality is not two identical blanks.
- **Dual-path execution.** The same attempt through the direct adapter and the gateway adapter yields identical outcomes across all four outcome classes, and identical upstream payloads — an equivalence proved on outcomes alone would hide a difference in what the tool was asked to do.

The validation harness runs on the gateway route end to end: the mock commerce world is four tool services built on the SDK, registering exactly as a production service does ([06 §3.3](./06-validation-harness.md)).
