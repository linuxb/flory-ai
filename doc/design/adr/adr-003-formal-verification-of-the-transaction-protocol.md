# ADR-003: Formal verification of the transaction protocol — TLA+ with TLC and Apalache

- **Status:** Accepted
- **Date:** 2026-08-20
- **Deciders:** Flory engine team
- **Related:** [ADR-001](./adr-001-engine-language-split.md) (the Go coordinator is the component specified here), [ADR-002](./adr-002-in-place-replan-and-dry-run-forks.md) (replan and dry-run semantics enter the model)
- **Implemented by:** [Plan 001](../../plan/plan-001-tla-plus-specification.md), which stages this scope and holds the preconditions

## Context

Flory's central claim is that JIT planning can be made transactionally safe ([06 §1](../06-validation-harness.md)). The load-bearing part of that claim is a concurrency protocol: TCC brackets, a pivot barrier across parallel branches, delta-based compensation, a backtrack floor, and an orphan-try sweep ([02](../02-transaction-model.md), [03](../03-replan-and-recovery.md)).

The validation harness tests this protocol by **sampling**: scenario S7 exercises one interleaving of two conflicting branches, S11 one crash point. But two of the design's key claims are statements of **unreachability** and **termination**:

- "The state *A has passed its pivot while B still requires rollback* is unreachable by construction" ([02 §4.3](../02-transaction-model.md)).
- "Every failure episode eventually terminates" — currently unproven, and the reason S3c fails by design ([06 §6](../06-validation-harness.md)).

Tests can demonstrate presence, never absence. No number of passing scenarios establishes unreachability, and no scenario suite derives a termination bound. This is a structural gap in the evidence, not a coverage gap.

Implementation cost is explicitly not a constraint for this decision; verification completeness is the priority.

## Decision

Specify the transaction protocol in **TLA+** and check it with **two engines against one specification**:

- **TLC** (explicit-state model checking) for exploratory checking, counterexample discovery, and **liveness** under fairness assumptions. Small constants with symmetry reduction.
- **Apalache** (SMT-based symbolic model checking) for **inductive invariants**, yielding **unbounded safety guarantees** for arbitrary branch counts, SKU counts, and quantities.

Three complements are mandatory, each closing a gap no prover closes:

- **Trace validation.** Real vertex-log traces are checked as behaviours of the specification.
- **Deterministic simulation.** The real implementation runs under a seeded, enumerable scheduler.
- **Alloy**, for exactly one job: bounded structural search for a DAG shape that satisfies all of R1–R9 yet still reaches a dead state.

**TLAPS** is optional and scoped to at most one theorem (I1). **P**, **Ivy**, and **Coq/Isabelle** are rejected.

### The modeling decision that makes this sound

The planner is modeled as **demonic nondeterminism constrained only by check-rules**: at a planner step, the specification may propose *any* sub-DAG that check-rules would admit.

An LLM cannot be modeled — it may emit anything. Attempting to characterize its behaviour would make every result conditional on an assumption no one can discharge. Modeling it as an adversary bounded only by the rule engine yields exactly the guarantee the architecture is designed to provide:

> For **any** plan the model could emit that check-rules admits, the transaction invariants hold.

This is [02 §3.2](../02-transaction-model.md) and discipline 14 — the safety boundary is check-rules, not the model's good behaviour — restated as a machine-checkable proposition. **Any assumption of reasonable planner behaviour introduced into the specification invalidates the entire result**, and reviewers must reject such assumptions.

A corollary governs how counterexamples are read. If a check reports "a plan admitted by check-rules violates an invariant", the defect is **in the rule set, not the engine**, and the counterexample names the missing rule. R9 was found by hand during design discussion; this mechanism finds the next R9 without relying on someone thinking of it.

## Scope: what gets specified

| ID | Property | Kind | Engine |
|---|---|---|---|
| I1 | Pivot-barrier unreachability: no reachable state has A past its pivot while B requires whole-scope rollback | safety | Apalache, unbounded (+ optional TLAPS) |
| I2 | Hold conservation and no amplification: `Σ open_holds(sku) ≤ Σ demanded(sku)`, and `on_hand + Σ holds + Σ shipped == initial` | safety | Apalache, unbounded |
| I3 | No `txn/cancel` after `txn/pivot-passed` in the same scope | safety | Apalache, unbounded |
| I4 | At most one pivot takes effect per scope across all reachable executions | safety | Apalache, unbounded |
| I5 | Floor property: for a given `scope_id`, the pivot action occurs at most once in the whole run, including after any replan | safety | Apalache, unbounded |
| I6 | Sweep/confirm TOCTOU: the orphan sweep never cancels a `txn/try` that is concurrently confirming | safety | TLC then Apalache |
| I7 | A dry-run child appends no `txn/*` event referencing a bracket opened before its `run/end-seed` | safety | Apalache |
| L1 | Every scope eventually reaches committed, cancelled, or L4 suspension | liveness | TLC with fairness |
| L2 | Every failure episode terminates — and the counterexample length **derives** the oscillation bound | liveness | TLC with fairness |

Parameterization: branch count `N`, SKU count `M`, unit quantity `K`, DAG depth, and replan count. TLC uses small constants (`N ∈ {2,3}`, `K = 3`) with symmetry reduction; Apalache leaves them free and proves by induction.

L2 is the item that produces a design answer rather than confidence: [03 §6](../03-replan-and-recovery.md) currently proposes an episode-level replan cap with no principled value. A liveness counterexample exhibits the shortest non-terminating cycle, and its length gives the bound.

## Scope: what is deliberately excluded

| Excluded | Verified instead by | Why formal methods is the wrong tool |
|---|---|---|
| Delta-compensation commutativity (D2) | property tests over real reducers, plus tool-registration validation | An algebraic property of concrete compensation functions. A specification would model an idealized `release` and prove nothing about the real one. |
| Check-rules R1–R9 as functions | T-A exhaustive table-driven fixtures | Pure functions over a proposal graph. Testing the real code is *stronger* than modeling an idealized rule engine. |
| World conservation as arithmetic (O1) | property tests over the sandbox ledger | Already exactly asserted against the real implementation. |
| Projection purity, prompt determinism | T-A replay diff, permutation tests | Determinism of pure functions is directly testable. |
| Plan quality, greedy-versus-wider, JIT payoff | [06 §8](../06-validation-harness.md) policy validation | Optimization questions with no invariant to state. |

## Rationale

### Why the TLA+ ecosystem, and why two engines

Completeness decomposes into four independent gaps, and no single tool closes more than two:

1. **State-space completeness** — were all interleavings explored? TLC, bounded; Apalache, unbounded via induction.
2. **Parameter completeness** — does the result hold for arbitrary `N`? This is the gap TLC alone leaves open, and the reason Apalache is not optional. A protocol verified for two branches is not verified for five.
3. **Specification-implementation completeness** — does the code do what the specification says? No prover closes this. Trace validation and deterministic simulation do.
4. **Invariant completeness** — is the set of invariants right and complete? **No tool closes this.** With cost removed, this becomes the binding constraint, which is why the adversarial planner model and the Alloy structural search receive dedicated budget rather than being treated as extras.

One specification, two engines, is standard modern TLA+ practice and avoids maintaining two models that can drift.

### Why trace validation is unusually valuable here

The classic failure of formal methods is an elegant specification alongside an implementation that diverges from it, with no affordable way to detect the divergence. Flory is unusually well positioned: the specification's state variables map almost one-to-one onto logged events — `txn/try`, `txn/confirm`, `txn/cancel`, `txn/pivot-passed`, `replan/boundary`. A real trace can therefore be replayed against the specification and checked for membership in its behaviours. The append-only log turns formal verification from a paper exercise into something reconcilable against production.

### Why Alloy for one job

Alloy searches over **structures**, not executions. The question "does there exist a DAG shape satisfying all of R1–R9 that still reaches a dead state" is a bounded relational search — Alloy's core competence and awkward in TLA+. It attacks gap 4 directly, and it is the tool most likely to find a missing rule.

### Why deterministic simulation is mandatory rather than optional

TLA+ verifies the protocol; the coordinator's implementation can still race. Simulation explores interleavings of the **real code**. Flory is already most of the way there: [06 §4](../06-validation-harness.md) requires faults to be a pure function of `(seed, tool, attempt_no)`, so only the scheduler needs to become seeded and enumerable. For I6-class bugs — timing races in implementation detail rather than protocol design — simulation is likely to find more than the model checker.

## Alternatives considered

**TLC alone.** Rejected as insufficient: it leaves gap 2 entirely open, and the protocol's whole point is behaviour under arbitrary parallel branches.

**TLAPS as the primary engine.** Rejected as primary, retained as optional for I1. Machine-checked proofs remove trust in the SMT solver, and liveness proofs are extremely laborious. Decisive consideration: a **half-finished proof provides no more assurance than a model check**, so a proof effort that stalls has produced nothing, whereas Apalache's inductive invariants are useful the moment they close.

**P.** Rejected. Its systematic exploration is weaker than TLC's exhaustive check, and its genuine advantage — proximity to implementation — is already covered by deterministic simulation.

**Ivy.** Rejected. Its decidable EPR fragment gives automated unbounded proofs, which is attractive, but Apalache's inductive invariants reach equivalent unbounded safety guarantees with better tooling maturity and no requirement to re-express the protocol inside a restrictive logic.

**Coq or Isabelle.** Rejected. Maximum assurance about a *model*, while gap 3 remains open unless verified extraction is adopted — a far larger commitment than this protocol warrants.

**Jepsen-style randomized testing as a substitute.** Rejected as a substitute, and rejected as a framework for separate reasons: its randomization conflicts with Flory's determinism requirements, and Elle checks isolation anomalies rather than saga invariants. Targeted infrastructure chaos remains appropriate in harness Phase 2.

## Consequences

### Preconditions — this ADR is void without all three

1. **Timing.** The specification must be complete **before the Go coordinator is implemented** (harness Phase 2, ADR-001). A specification written afterwards is archaeology; its value lies in still being able to change the design.
2. **Ownership.** One named owner must be able to read, run, and maintain the specification. An unowned specification degrades into write-only documentation and is worse than none, because it creates false confidence.
3. **Skill availability.** I2's unbounded proof will very likely require **manual invariant strengthening** — finding a stronger, self-closing form. This consumes scarce skill rather than time, so "cost is not a constraint" does not discharge it. Treat it as a hiring or training precondition, not an implementation detail.

### Ongoing obligations

- **Both engines run in CI.** Every change to the transaction module triggers TLC and Apalache. A specification not mechanically checked on every change is stale within a quarter.
- **Counterexamples become scenarios.** Any counterexample found is added to [06 §6](../06-validation-harness.md) as a numbered scenario, so the harness inherits the finding permanently.
- **Invariant violations are read as rule-set gaps first.** Per the corollary above, the first hypothesis for a violated invariant is a missing check-rule, not an engine defect.

### Gained

- Unreachability and termination claims move from prose argument to machine-checked proposition, including for arbitrary branch counts.
- The oscillation bound is derived rather than guessed, closing [03 §6](../03-replan-and-recovery.md) and un-blocking S3c.
- A mechanism that discovers missing check-rules without depending on someone imagining the failure.

### Accepted costs

- A specification artifact that must be maintained alongside the implementation, with CI time on every transaction-module change.
- Divergence risk remains **bounded but non-zero**: trace validation samples real behaviours, it does not prove conformance.
- Two additional toolchains (TLA+/Apalache, Alloy) in the repository, neither in the engine's languages. These are verification artifacts, not engine code, so ADR-001's third-language prohibition does not apply — but the boundary is deliberate and should be stated in review: **no verification tool may become a runtime dependency**.
