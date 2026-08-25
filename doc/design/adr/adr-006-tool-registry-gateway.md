# ADR-006: Introduce gatewayd as the Tool Registry and Execution Gateway

## Status

Accepted

## Context

The engine and the Distributed Transaction Coordinator require the same versioned tool metadata for planning, deterministic transaction admission, execution, compensation, replay, and offline evaluation. Keeping that metadata only in process-local configuration makes dynamic service registration difficult and creates a risk that planning validates one contract while execution routes through another.

The event log and projection pipeline must remain deterministic. Consequently, live registry discovery cannot occur inside a check-rule, reducer, replay, or recorded historical evaluation. Retry legality depends on idempotency, TCC state, and pivot state; an intermediary that retried side effects independently would split transaction authority.

## Decision

Introduce `gatewayd` as a standalone deployment boundary, implemented in Go 1.25 as its own module.

**Two surfaces, chosen separately.** North is MCP `tools/list` and `tools/call` over hand-rolled JSON-RPC 2.0, consumed by the Agent Orchestrator and the Distributed Transaction Coordinator. South is gRPC, spoken by tool services. MCP is a JSON-RPC protocol, so the north side has no choice; the south side does, and Protocol Buffers is what keeps the Go and TypeScript SDKs provably identical rather than merely intended to be.

**A shared SDK owns the service side of the protocol.** Registration, the heartbeat lease, and health reporting are what make a stateless gateway recoverable. No tool service implements them itself. The Go SDK validates contracts by calling the gateway's own admission rules rather than restating them.

**The tool view is the only catalog.** `gatewayd` builds a canonical, content-addressed document from every admitted registration, stores it in blob storage, and publishes its reference and digest. The Orchestrator resolves that view before planning, re-derives the digest from the bytes it was served, records the identity in `subgraph/proposed`, and passes the immutable snapshot to the pure rule engine. Executors supply the same digest and pinned version when executing a frozen vertex. Nothing else in the system keeps a parallel list of tools.

**Execution authority splits by effect class, and the database enforces it.** A tool-caller vertex with `effect_class: none` and no scope is executed by the Orchestrator; every other queued vertex by the Coordinator. R10 guarantees the two classes partition the queued vertices, and both the work queue and the event-log ownership trigger derive the class the same way from the vertex payload.

`gatewayd` validates registrations and routes exactly one requested attempt. It does not plan, retry, append events, decide compensation, implement projection semantics, or resolve a tool version its caller did not pin.

## Consequences

- Planning and execution share one immutable tool-contract identity, verifiable by any reader from the bytes alone.
- `gatewayd` and the Distributed Transaction Coordinator share the repository's Go 1.25 toolchain while remaining separate modules with separate deployment and ownership boundaries.
- Services register dynamically without introducing I/O into deterministic check-rules or replay.
- Historical replay is independent of current gateway state, because a superseded view stays resolvable by its digest.
- The gateway becomes an availability dependency for new discovery and routed execution, so callers fail closed and preserve recorded history during outages.
- Two canonical-encoding implementations exist, in Go and TypeScript, and must be held together by a shared conformance fixture — a digest one side cannot reproduce would make every pinned contract unresolvable.
- Adding a language to the tool-service ecosystem means adding an SDK, not reimplementing a protocol.

## Rejected Alternatives

### Keep a static repository-only registry

Rejected because every tool deployment would require an engine or coordinator configuration rollout, and independent local copies could drift between planning and execution.

### Keep a checked-in tool manifest alongside the gateway

Rejected for the same reason in a smaller form. A manifest is a second catalog, and the moment it disagrees with what services actually registered, planning validates something execution does not use. Tests that need a catalog read a *recording* of the gateway's own output instead, and the end-to-end run asserts the live digest still equals it, so a stale recording fails rather than drifting.

### Let gatewayd own retries and transaction events

Rejected because retry legality depends on idempotency, TCC state, and pivot state owned by an executor. Splitting those decisions would create two transaction authorities. A transport failure after dispatch is therefore reported as `unknown` rather than retryable: reporting it as retryable would authorise a duplicate side effect from a component that cannot know whether one already happened.

### Query the live registry during rule checking or replay

Rejected because live discovery is I/O and current registry state is not historical evidence. It would make admission and replay nondeterministic.

### Make gatewayd a time-travel registry

Rejected because immutable content-addressed tool views already preserve the required historical contract. Reconstructing history from mutable registry state adds a second history system without improving replay correctness.

### Use gRPC on both surfaces, or the MCP Go SDK on the north side

Rejected on the north side because ADR-006's whole point is that the Orchestrator and the Coordinator consume the *same versioned tool contracts* through MCP, which is JSON-RPC. Hand-rolling that surface keeps the fail-closed refusal vocabulary under our control and adds no dependency; the surface is small enough that an SDK would constrain error semantics more than it would save.

### Let each tool service implement registration itself

Rejected because registration, heartbeat, and health are the mechanism by which a stateless gateway recovers. A service that hand-rolled them could look registered while being unroutable, or keep heartbeating at a gateway that has forgotten it, and each such bug would be discovered separately in every service.

### Keep all `vertex/*` execution events with the Coordinator

Rejected because a vertex with `effect_class: none` and no scope has no bracket, no compensation, and no pivot interaction — nothing for a transaction coordinator to own. The old rule forced the Coordinator to record execution events for work it did not do, and doc 05's `reads-live` fold mode already assumed the Orchestrator executes that class live.

### Let either service execute anything, by convention

Rejected because a split enforced only by convention degrades into whichever worker claimed the row first. The partition is derived from the vertex payload and enforced by the database on both the work queue and the append boundary; an in-process guard is advice, not a boundary.

### Give the Orchestrator a separate read-event vocabulary

Rejected because it would fork the execution vocabulary by executor rather than by meaning. Every projection, oracle, and replay test would then have to know which service ran a vertex in order to read its outcome, which is exactly the coupling the event log exists to remove.

### Store tool views on the local filesystem, or hand-roll a GCS client

Rejected in favour of a `BlobStore` interface with a GCS-compatible implementation. The filesystem does not survive the stateless gateway it serves. A hand-rolled client would save dependency weight in the one component whose entire job is durable, verifiable storage, which is the wrong place to economise.
