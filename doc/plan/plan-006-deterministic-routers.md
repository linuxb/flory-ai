# Plan 006: Deterministic Routers and Rule Templates

- **Status:** Proposed
- **Date:** 2026-09-14
- **Implements:** [10 Deterministic Routers and Rule Templates](../design/10-deterministic-routers.md)
- **Specifies:** [10](../design/10-deterministic-routers.md), [02 §3.4](../design/02-transaction-model.md#34-deterministic-check-rules), [02 §4.4](../design/02-transaction-model.md#44-orphan-try-detection), [07 §3.1](../design/07-distributed-transaction-coordinator.md#31-work-scheduler), [08](../design/08-database-schema.md), [10 §3.4](../design/10-deterministic-routers.md#34-publication-admission-q1q6)

## 1. Objective

Make a rule-governed transition executable without a model call: a first-class `router` vertex, published rule templates, freeze-time exhaustive admission, and the runtime fencing that keeps a deterministic branch inside the transaction protocol.

## 2. Contract Baseline

Interposition is mandatory, so a run with no template bound has the same topology as one with a template bound. A router is Engine-executed, never queued, and never a scope member. Its placement is derived; its branches are admitted at freeze against the run's role-scoped tool view and an existing-scope snapshot; its failures never reach an LLM replan.

## 3. Delivery Increments

1. Extend the shared contracts: `router` in the `vertex/created` role union, the `rule_template/published` diff event, and the tool contract's log-fields schema in [`idl/`](../../idl/), regenerating both language consumers.
2. Extend `flory_executor_class` with `router`, exclude routers from `enqueue_vertex_work`, and add the `txn_attempt` evidence table with its migration.
3. Add the Engine-owned configuration stream with its own counter row, and the ownership-trigger case admitting `rule_template/published` from `engine_role` alone.
4. Implement R12, R13, and R14 in `engine/src/check-rules.ts`, including the third `existing_scope_snapshot` argument and exhaustive per-branch, per-placement admission.
5. Implement Engine-side rule-template publication: the management API, Q1–Q6 admission over a role-scoped tool view, derived capability envelope and branch traits, content addressing, and diff events.
6. Implement router evaluation in the Engine: binding resolution by `template_ref` and by `SlotId`, the closed outcome vocabulary, the strict event trajectory, and fall-through invisibility in `linearize`.
7. Enforce the single lock order and claim-eligibility table in the Coordinator, and rewrite the sweeper around durable attempt evidence: defer on a live lease, suspend on an unresolved attempt, cancel only a clean scope.
8. Add scenarios S15–S20 and the router assertions in oracles O2 and O4 to the validation harness.

## 4. Exit Criteria

- A tool-caller-to-planner edge cannot survive a freeze without a router, whether or not the proposal supplied one.
- A template whose *non-matching* branch is illegal at the bound placement is rejected at freeze, before any tool runs.
- A bound non-matching template produces a byte-identical planner prompt hash to an unbound slot.
- A failed router-emitted branch produces no `replan/boundary` and starts no planner vertex.
- A scope holding an unresolved attempt suspends; no `txn/cancel {phase: requested}` is appended for it.
- A fork substituting only a rule-template pin differs from its source in no structural way.
- `rule_template/published` is appended only by the Engine, only to the configuration stream; `gateway_role` still cannot write the event log at all.

## 5. Exclusions

Slot-collision rebinding and template migration, a nested-router depth bound, and automatic governance actions on match-rate thresholds are out of scope; they are the open questions in [10 §13](../design/10-deterministic-routers.md#13-open-questions). Automatic reconciliation of an unresolved non-pivot attempt stays out of scope by design: recovery is operator-authorized ([02 §4.4](../design/02-transaction-model.md#44-orphan-try-detection)).
