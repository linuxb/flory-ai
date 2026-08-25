# Plan 004: Tool Registry Gateway

- **Status:** Done
- **Date:** 2026-08-25
- **Implements:** [ADR-006](../design/adr/adr-006-tool-registry-gateway.md)
- **Specifies:** [09 gatewayd Tool Registry Gateway](../design/09-tool-registry-gateway.md), [06 validation harness §3.3](../design/06-validation-harness.md), [01 event log §3.2.1](../design/01-jit-dag-and-event-log.md)

## 1. Objective

Deliver `gatewayd` as the production route for every tool call, together with the tool-service SDK that services register through, and move the validation harness onto that route.

## 2. Contract Baseline

One immutable tool view is built from admitted registrations, stored by content address, and pinned by digest. Planning resolves it before `checkSubDag`; execution supplies the same digest and version. The gateway routes exactly one requested attempt and appends nothing.

## 3. Delivery Increments

1. Publish the south-side contract as Protocol Buffers and pin the frozen view in the event-log IDL.
2. Implement canonical encoding, content-addressed blob storage, and the G1-G8 admission rules with pending resolution.
3. Implement routing, health, the MCP surface, and the registration surface.
4. Ship the Go and TypeScript SDKs over one generated contract.
5. Resolve published views into the checker's registry, with a cross-language canonical-encoding fixture.
6. Split executor authority by effect class and enforce it in the database.
7. Route the Coordinator through the gateway by default, with a dual-path equivalence fixture.
8. Rebuild the mock commerce world as four SDK tool services and record the published view.

## 4. Exit Criteria

- Both canonical encoders reproduce every fixture case byte for byte.
- A hand-built registry and a loaded tool view admit identically.
- Both execution routes produce identical outcomes and identical upstream payloads.
- A refusal reaches no tool service, and a failing upstream is attempted exactly once.
- The live tool view's digest equals the recorded fixture.
- No `vertex/*` event can be appended outside its executor class.

## 5. Exclusions

Gateway authentication and authorization, multi-tenant view namespacing, durable registration across a gateway restart, and upstream protocols beyond gRPC and the SDK's HTTP execute bridge.
