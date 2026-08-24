# ADR-006: Introduce gatewayd as the Tool Registry and Execution Gateway

## Status

Proposed

## Context

The engine and the Distributed Transaction Coordinator require the same versioned tool metadata for planning, deterministic transaction admission, execution, compensation, replay, and offline evaluation. Keeping that metadata only in process-local configuration makes dynamic service registration difficult and creates a risk that planning validates one contract while execution routes through another.

The event log and projection pipeline must remain deterministic. Consequently, live registry discovery cannot occur inside a check-rule, reducer, replay, or recorded historical evaluation. The coordinator must also remain the sole owner of retries and transaction events; an intermediary that retries side effects independently would split transaction authority.

## Decision

Introduce `gatewayd` as a proposed standalone deployment boundary with two MCP surfaces:

- `tools/list` publishes canonical, content-addressed tool views built from admitted registrations.
- `tools/call` resolves an exact frozen tool version and routes one requested execution attempt to its upstream service.

`gatewayd` stores each canonical tool view in blob storage and publishes its content-addressed reference and digest. The Agent Orchestrator resolves that view before planning, records its identity in `subgraph/proposed`, and passes the immutable snapshot to the pure rule engine. The Distributed Transaction Coordinator supplies the same digest and pinned tool version when executing a frozen vertex.

`gatewayd` validates registrations and performs routing, but it does not plan, retry side-effecting calls, append events, decide compensation, or implement projection semantics. Existing in-process registry and direct-adapter paths remain as migration and test implementations of the same contracts.

## Consequences

- Planning and execution share one immutable tool-contract identity.
- Services can register dynamically without introducing I/O into deterministic check-rules or replay.
- Historical replay remains independent of current gateway state because the tool view is recorded by reference and digest.
- The gateway becomes an availability dependency for new discovery and routed execution, so callers must fail closed and preserve recorded history during outages.
- Tool-view storage, registration admission, gateway adapters, and cross-path conformance fixtures must be implemented before the gateway becomes the production route.

## Rejected Alternatives

### Keep a static repository-only registry

Rejected because every tool deployment would require an engine or coordinator configuration rollout, and independent local copies could drift between planning and execution.

### Let gatewayd own retries and transaction events

Rejected because retry legality depends on idempotency, TCC state, and pivot state owned by the coordinator. Splitting those decisions would create two transaction authorities.

### Query the live registry during rule checking or replay

Rejected because live discovery is I/O and current registry state is not historical evidence. It would make admission and replay nondeterministic.

### Make gatewayd a time-travel registry

Rejected because immutable content-addressed tool views already preserve the required historical contract. Reconstructing history from mutable registry state adds a second history system without improving replay correctness.
