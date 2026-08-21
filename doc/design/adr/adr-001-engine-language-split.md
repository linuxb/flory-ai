# ADR-001: Engine language split — TypeScript engine, Go coordinator

- **Status:** Accepted
- **Date:** 2026-08-17
- **Deciders:** Flory engine team
- **Supersedes:** the single-language proposal previously recorded in `AGENTS.md`

## Context

Flory needs an implementation language before construction starts. The engine decomposes into parts with genuinely different demands:

1. **Planner loop and projection pipeline** — reads a partially ordered append-only log, folds it through pure functions, assembles prompts, and calls models. Correctness depends on exhaustive handling of an extensible event vocabulary and on the purity of the projection layers ([01](../01-jit-dag-and-event-log.md), [05](../05-context-aggregation-and-offline-evaluation.md)).
2. **Transaction coordinator and executor** — a long-running daemon holding thousands of in-flight TCC brackets with deadlines, sweeping `try_timeout_s`, detecting orphan tries, scheduling backoff retries, and calling business systems that move inventory and money ([02](../02-transaction-model.md)).
3. **Replay and batch recomputation** — replay testing of the planner loop, plus historical metric recomputation after a projector upgrade.

Organizational context: the team prefers Go and TypeScript, and existing infrastructure already runs Go services with established deployment, observability, and on-call practices.

## Decision

Two services and one database:

- **TypeScript** implements the engine service: planner loop, event vocabulary, the canonical projection pipeline (`surface`, `slice`, `fold`, `linearize`, `assemble`), check-rules, prompt assembly, refine loop, model adapters, and replay testing.
- **Go** implements the coordinator service: transaction brackets, timeout sweeping, orphan-try detection, the tool executor, and tool adapters that need to sit inside existing Go infrastructure.
- **PostgreSQL** holds the event log and harness-state and allocates `seq`.
- **The boundary is the log.** The two services never call each other's internals; they communicate by appending events, and each owns an exclusive set of event types (table in `AGENTS.md`). Work handoff is `FOR UPDATE SKIP LOCKED` or `LISTEN/NOTIFY` — no message broker until load demands one.
- **Canonical projections have exactly one implementation, in TypeScript.** Operational folds (unmatched-try scanning, timeout sweeps, executor readiness) may live in either service.

## Rationale

### Why TypeScript for the engine core

- The log is a tagged union discriminated by `event_type`, and [01](../01-jit-dag-and-event-log.md) requires fail-closed reads. A discriminated union with exhaustive `switch` makes the compiler enforce that requirement. Go has no sum types; the equivalent is an interface plus a type switch, where a forgotten branch after adding an event type compiles silently. For a system whose foundation is log-reading correctness, that is not a matter of taste.
- The projection pipeline is pure-function composition over immutable data — idiomatic in TypeScript, verbose in Go and prone to accidental shared mutability.
- One schema library (zod) covers check-rule validation, refine edit validation, and mem-hint template whitelisting. All three need runtime validation plus static types, which is exactly its purpose.
- Model SDKs, streaming, structured output, and tool-schema generation are first-class. The two systems whose designs Flory borrows from — deepseek-harness and prime-agent — are both TypeScript, so patterns transfer directly.

### Why Go for the coordinator

- It is a timer-dense long-running daemon. Go's context, timer, and goroutine model fits thousands of concurrent deadline-bearing brackets naturally; in Node the same thing must be hand-rolled.
- Its interface is narrow and data-oriented: it handles the small `txn/*` and `vertex/*` execution subsets, so the sum-type advantage that decides the engine core barely applies here.
- **Operability is a correctness property for this component.** It touches inventory and money, and a leaked half-open try must be diagnosable fast. Reusing the dashboards, runbooks, profiling habits, and release process the infrastructure team already has for Go services shortens incident MTTR. This is the argument that moved the decision from "extract later" to "split now."
- It touches no model, so it forfeits nothing from the TypeScript model ecosystem.
- It is the natural home for adapters that must live in Go infrastructure regardless.

### Why the split is cheap here

Because the log is the single source of truth, the two services share no mutable state and expose no internal RPC to each other; PostgreSQL allocates `seq`, so no coordination protocol is needed. Had the design used mutable shared state with inter-service RPC, this split would have introduced consistency problems instead. The log-as-truth decision in [01](../01-jit-dag-and-event-log.md) is what makes polyglot affordable.

### Why replay stays in TypeScript

"Replay" names two activities, and the deciding constraint is the same for both: **how many implementations of the projection semantics can we afford? Exactly one.**

- Replay testing exercises the projection pipeline and planner loop themselves, so it must run the same code as production. If projections are in TypeScript, replay testing is in TypeScript.
- Batch historical recomputation looks like a Go task — CPU-bound, embarrassingly parallel, read-only — but porting the projector to Go creates two projectors that can disagree on edge cases, which makes discipline 3 (identical recomputation) unverifiable and destroys `projector_version` attribution ([05](../05-context-aggregation-and-offline-evaluation.md) §3.1). Scale it instead by sharding on `run_id` across worker processes, or by pushing a fold down into SQL.

## Consequences

### Accepted costs

- **Schema-first becomes mandatory.** The event vocabulary moves into a versioned IDL in the repository with generated types for both languages. Changing a field means editing the schema and regenerating rather than editing one file.
- **Cross-language conformance tests are required.** Golden log fixtures with expected outcomes that both readers must satisfy; fail-closed handling of an unknown `event_type` is a mandatory fixture. Per-language unit tests cannot establish agreement.
- **Two build pipelines, two dependency ecosystems, two deployment units.** Bounded but real.
- **Contributors must know which side of the boundary they are on.** Mitigated by the exclusive event-ownership table and the review checklist in `AGENTS.md`.

### Gained

- Correctness-critical log handling gets compiler-enforced exhaustiveness; money-critical execution gets a runtime the infrastructure team can already operate.
- The executor and coordinator can scale and be released independently of the planner loop.
- No message broker, no distributed transaction manager, no new datastore.

### Team-size condition

This split assumes an engine team of roughly three or more people alongside an infrastructure team already operating Go services. **With one or two engineers on v0, prefer a single TypeScript service** with the executor behind a narrow interface (`execute(vertex) → result` plus transaction-bracket callbacks) and extract the Go coordinator at first real load. Two pipelines, two dependency sets, and duplicated schema synchronization would otherwise consume more iteration speed than the split returns. Revisit this ADR if the team is smaller than assumed.

## Alternatives considered

**Single TypeScript service (all components).** Simplest to build and the right choice for a very small team. Rejected here because the transaction coordinator is the component where operational maturity matters most, and re-creating Go-grade timer and long-running-daemon ergonomics plus a parallel set of ops practices costs more than the polyglot boundary.

**Single Go service (all components).** Attractive for infrastructure uniformity. Rejected because the event vocabulary loses compiler-enforced exhaustiveness, the projection pipeline becomes verbose and mutation-prone, there is no equivalent of one schema library covering all three validation sites, and borrowing from the TypeScript prior art becomes a rewrite rather than a port.

**Split with the projector duplicated in Go for batch recomputation.** Rejected: two implementations of the projection semantics is the worst available bug class and makes attribution unverifiable. Sharding and SQL pushdown solve the throughput problem without it.

**Python.** Rejected without deep evaluation: outside the stated language preferences, and its ecosystem advantage is concentrated in model-side tooling where TypeScript SDKs are now equivalent.

**Introducing Kafka or Temporal for handoff and orchestration.** Rejected for v0. PostgreSQL already provides atomic append, `seq` allocation, and work claiming via `SKIP LOCKED`; Flory's transaction semantics are JIT-generated and planner-declared, which is precisely what a fixed-workflow orchestrator cannot express ([02](../02-transaction-model.md) §5).
