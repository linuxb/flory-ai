# gatewayd Tool Registry Gateway (09)

> Status: Proposed
> Depends on: [02 — Transaction Model](./02-transaction-model.md), [05 — Context Aggregation and Offline Evaluation](./05-context-aggregation-and-offline-evaluation.md), [07 — Distributed Transaction Coordinator](./07-distributed-transaction-coordinator.md)
> Decision record: [ADR-006 — Introduce gatewayd as the Tool Registry and Execution Gateway](./adr/adr-006-tool-registry-gateway.md)
> Planned implementation: Go 1.25

## 1. Purpose and Boundary

`gatewayd` is the proposed deployment boundary for dynamic tool registration, immutable tool-view publication, and one-attempt execution routing. It exposes the MCP `tools/list` and `tools/call` surfaces so the Agent Orchestrator and Distributed Transaction Coordinator consume the same versioned tool contracts.

The planned implementation uses Go 1.25 as a standalone service. Sharing an implementation language with the Distributed Transaction Coordinator does not create an internal API boundary: `gatewayd` remains independently deployable and communicates only through its MCP contract and storage interfaces.

`gatewayd` does not own planning, transaction admission, retries, event appends, compensation policy, or projection semantics. Those responsibilities remain with the Agent Orchestrator and the Distributed Transaction Coordinator. The gateway validates registrations and routes exactly one requested attempt to an upstream tool service.

The deployment relationship is shown in [the deployment architecture](./diagrams/deployment-architecture.html).

## 2. Roles and Request Flow

1. A tool service registers a versioned contract with `gatewayd`.
2. `gatewayd` validates the registration, stores the canonical document in blob storage, and publishes its content-addressed tool-view reference and digest.
3. Before planning or replanning, the Agent Orchestrator resolves one immutable tool view and records its reference and digest in `subgraph/proposed`.
4. `checkSubDag(proposal, toolView)` performs deterministic admission without network I/O.
5. After a subgraph is frozen, the Distributed Transaction Coordinator claims a ready vertex and calls `gatewayd` with the exact tool-view digest, tool version, attempt number, and idempotency key.
6. `gatewayd` resolves that frozen contract and routes one attempt to the registered upstream endpoint.
7. The coordinator appends `vertex/*` and `txn/*` events and decides whether another attempt is legal.

Contract changes therefore affect only future proposals. A frozen subgraph never silently observes a newer tool contract. Operational endpoint membership and health may change so the gateway can route the same pinned contract to a healthy instance; that does not change tool semantics or version identity.

## 3. Registration and Tool-View Contract

Every registration includes:

- a stable `tool_id` and immutable `tool_version`;
- an input schema and output schema;
- a stable logical route identifier and protocol adapter contract, separate from ephemeral endpoint addresses;
- `effect_class`, `mode`, idempotency metadata, timeout limits, and retry constraints;
- compensation and confirmation tool references where the selected mode requires them;
- an owner and health-check policy.

`is_pivot` is not registration metadata. It is derived from `effect_class` exactly as specified in [02 — Transaction Model](./02-transaction-model.md#21-derived-attributes-are-never-declared).

Registration admission applies the same structural rules required by transaction planning, including:

- `mode: tcc` tools must declare a complete try-confirm-cancel triple;
- `mode: saga` tools must declare valid idempotent compensation;
- `effect_class: irreversible` tools must declare whether retries are idempotent;
- compensation schemas must identify the delta owned by the corresponding try;
- referenced companion tools must exist in the same published tool view;
- a published `(tool_id, tool_version)` is immutable.

### 3.1 Dependency Resolution and Pending State

Because microservices register asynchronously on startup, a tool service might register a `mode: saga` tool before the service hosting its `compensate_tool` is ready. To prevent exposing incomplete compensation chains to the Agent Orchestrator:

- `gatewayd` places new registrations into a `Pending` state.
- A tool remains `Pending` until all its transactional dependencies (e.g., `compensate_tool` for Saga, `confirm`/`cancel` endpoints for TCC) are successfully registered, healthy, and proven idempotent.
- Only when the entire transactional cluster is resolved does `gatewayd` publish them into the globally visible, content-addressed `tool view`.

### 3.2 MCP Protocol Extension

To carry these strict transaction semantics over standard MCP without breaking protocol compliance, the SDK injects Flory-specific transaction properties into the tool's `metadata` field.

The Orchestrator parses this extension to perform its deterministic `checkSubDag` admission:

```json
{
  "name": "inventory.try_reserve",
  "description": "Reserve inventory for an order",
  "inputSchema": { ... },
  "metadata": {
    "flory_transaction": {
      "effect_class": "reversible",
      "mode": "tcc",
      "idempotency_key_path": "$.order_id"
    }
  }
}
```
*(Note: `is_pivot` is absent because it is derived statically from `effect_class: irreversible` rather than declared.)*

A tool view is a canonical, content-addressed document. Its digest covers every semantic field that can affect admission, execution, compensation, or replay, including the logical route identifier but not transient endpoint membership or health. The `subgraph/proposed` payload records `tool_view_ref` and `tool_view_digest`; each vertex's `pin_version` continues to identify its exact tool contract.

## 4. Execution Contract

The coordinator sends one logical attempt per `tools/call` request. The request carries at least:

- `run_id`, `vertex_id`, and transaction scope;
- `tool_id`, `tool_version`, and `tool_view_digest`;
- `attempt` and `idempotency_key`;
- validated arguments and a deadline.

`gatewayd` rejects a call if the requested version is absent from the referenced view, if the request violates the registered schema, or if the route is unhealthy before dispatch. It must not silently select a newer version.

The gateway does not perform hidden retries for side-effecting tools. A transport retry that could duplicate an upstream call is a coordinator decision governed by the registered idempotency contract. This preserves the coordinator as the single owner of `vertex/retried`, TCC brackets, pivot admission, and forward recovery.

## 5. Failure and Availability Semantics

- Registration publication is atomic: readers observe either the previous complete view or the next complete view.
- Tool-view resolution fails closed on an unknown digest or malformed contract.
- A gateway outage blocks new discovery and routed execution but does not corrupt already recorded history.
- The coordinator records routing or upstream failures through the existing `vertex/failed` vocabulary; `gatewayd` does not append to the event log.
- Health status is operational evidence, not a contract mutation. It may stop routing but cannot change a frozen tool version's semantics.

## 6. Replay and Offline Evaluation

Replay and the `recorded` or `model-live` evaluation modes consume the recorded tool view; they do not query the live gateway. `reads-live` may execute only tools whose pinned contract declares `effect_class: none`, subject to the fold-mode rules in [05 — Context Aggregation and Offline Evaluation](./05-context-aggregation-and-offline-evaluation.md#32-fold-modes-govern-the-cost-and-the-risk).

If the recorded contract or required adapter is unavailable, evaluation records a blocked or unverified result. `gatewayd` is not a time-travel database and does not reconstruct historical registrations from its current state.

## 7. Migration

The current in-process `ToolRegistry` remains the deterministic checker input, and the coordinator's direct HTTP adapter remains valid until `gatewayd` is implemented. Migration adds a discovery and routing boundary without changing the pure `checkSubDag(proposal, toolView)` contract or moving transaction ownership out of the coordinator.

During migration, conformance fixtures must prove that a local registry snapshot and the canonical gateway tool view produce identical admission results. The coordinator must also pass the same execution-attempt fixtures through both the direct adapter and the gateway adapter.
