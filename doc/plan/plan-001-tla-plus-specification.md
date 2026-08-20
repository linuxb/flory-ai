# Plan 001: TLA+ specification of the transaction protocol

- **Status:** Active — S1 complete; S2 and S3 remain trigger-gated
- **Date:** 2026-08-20
- **Implements:** [ADR-003](../design/adr/adr-003-formal-verification-of-the-transaction-protocol.md)
- **Specifies:** [02 transaction model](../design/02-transaction-model.md), [03 replan and recovery](../design/03-replan-and-recovery.md)

## 1. Why now

The repository currently contains documentation and no engine code. That makes this the cheapest and highest-value moment to specify, for three reasons that are specific rather than general.

**The specification is on the critical path of the design, not queued behind it.** Three open questions are blocked on it today:

| Blocked question | Where | What the spec produces |
|---|---|---|
| Oscillation bound — how many replans may one episode contain | [03 §6](../design/03-replan-and-recovery.md), [06 §12](../design/06-validation-harness.md) | **Resolved:** the L2 lasso has two replan transitions, yielding `E = 2`; S3c is now specified to pass. |
| Is the parallel-pivot dead state truly unreachable | [02 §6](../design/02-transaction-model.md) | A machine-checked invariant replacing a prose argument. |
| Is the R1–R11 rule set complete | [02 §6](../design/02-transaction-model.md) | Counterexamples that name missing rules. |

**A defect found now costs a document edit.** After the Go coordinator ships, the same defect costs a rewrite of the component that touches money, plus possibly a migration of live half-open brackets.

**R9 was found by a human noticing it.** It emerged during a design discussion about parallel branches. The rule set's completeness therefore currently depends on someone happening to think of a case. The adversarial planner model (§3.2) automates that. If an R10 exists, finding it now is nearly free.

## 2. Staged scope

The plan deliberately separates *specification as a design instrument* — cheap, blocking, ordinary skill — from *specification as an assurance artifact* — expensive, needing scarce skill, aimed at claiming "holds for all N".

| Stage | Trigger | Scope | Skill required |
|---|---|---|---|
| **S1 — complete** | no engine code exists | TLC only. Invariants I1, I3. Liveness **L2** derived the oscillation bound. Constants `N ∈ {2,3}`, `K = 3`; symmetry is used for safety only because TLC warns against it for liveness. | Ordinary TLA+, learnable in weeks |
| **S2** | start of Go coordinator implementation (ADR-001 Phase 2) | Add I2, I4–I7. Introduce Apalache inductive invariants for unbounded safety. Build trace validation | **Inductive invariant strengthening — scarce** |
| **S3** | first production traffic with real logs | Alloy structural search for admissible-but-dead DAG shapes. Optional TLAPS for I1 | Specialist |

Stage triggers are objective events, not availability. S2 is required at the moment coordinator implementation begins; "when we have time" is not a trigger.

Merging the stages is the failure mode this table exists to prevent: pooling them means the whole effort stalls waiting for the Apalache skill that answering today's three questions does not need.

## 3. Stage S1 in detail

### 3.1 Modules

```
spec/
  FloryTxn.tla        -- protocol plus R10/R11 admission abstraction
  MCSmall*.cfg        -- N=2 safety and liveness configurations
  MCThree*.cfg        -- N=3 safety and liveness configurations
  MC*.tla/.cfg        -- discovery and controlled-negative configurations
  run-tlc.sh          -- pinned TLC runner used locally and by CI
  README.md           -- how to run, what each invariant means, current findings
```

### 3.2 The modeling decision that makes the result meaningful

The planner is modeled as **demonic nondeterminism constrained only by check-rules**: at a planner step the specification may propose *any* sub-DAG that check-rules would admit.

An LLM cannot be characterized, so any assumption about its behaviour would make every result conditional on something undischargeable. Bounding it only by the rule engine yields the guarantee the architecture is designed for: *for any plan the model could emit that check-rules admits, the invariants hold.*

**Review rule:** an assumption of reasonable planner behaviour appearing anywhere in the specification invalidates the entire result. Reviewers reject it outright.

**Reading counterexamples:** when a check reports "a plan admitted by check-rules violates an invariant", the first hypothesis is a **missing check-rule**, not an engine defect. The counterexample names the gap.

### 3.3 State variables

Kept minimal — every added variable multiplies the state space.

| Variable | Meaning |
|---|---|
| `scopeState` | `open`, `barrierWaiting`, `pivotPassed`, `cancelled` |
| `createdNodes` | effects frozen so far; pivot identity is derived from `effect_class` |
| `scopeMembers` | members of the current scope; grows across freezes while open |
| `foreignScopeMembers` | another declared scope, used to demonstrate R11 narrowing rejection |
| `tryState[b]` | per current-scope branch: `none`, `tried`, `sealed`, `failed` |
| `holds[b]` | binary reservation held by a branch in the finite shared pool |
| `pivotFrozen` / `barrierFrozen` | whether the pivot-introducing freeze derived the pivot and inserted its barrier |
| `pivotDone` | whether the scope's irreversible action has executed |
| `replanCount` | per-episode replan counter, for L2 |
| `lastPlanner` / `lastPlannerFailures` | per-planner failure state for the oscillation model |

Excluded from the model on purpose: token budgets, prompt assembly, projections, cost estimation, and anything about plan quality. None of them affect the invariants, and each would inflate the state space.

### 3.4 Properties checked in S1

| ID | Statement | Kind |
|---|---|---|
| I1 | No reachable state has one branch past its pivot while a sibling in the same scope requires whole-scope rollback | safety |
| I3 | No `cancel` action occurs in a scope after `pivotPassed` | safety |
| A10 | Every frozen side-effecting node belongs to a declared scope (R10 admission) | safety |
| A11 | A pivot scope contains its engine-computed minimum (R11 admission) | safety |
| L2 | Every failure episode eventually reaches commit, cancel, or L4 suspension | liveness, weak fairness on executor and planner steps |

I2 and I4–I7 are deferred to S2 not because they matter less, but because S1's purpose is to answer the three blocked questions with the smallest model that can.

### 3.5 Work items

| # | Item | Output |
|---|---|---|
| 1 | Owner completes a TLA+ primer (Lamport's video course plus one worked example) | ability to read and modify the spec |
| 2 | Write `FloryTxn.tla` covering the bracket lifecycle only — no barrier yet — and check I3 | a spec that runs, and confidence in the state encoding |
| 3 | Add parallel branches, shared resources, and the pivot barrier; check I1 | I1 either holds or a counterexample trace |
| 4 | Add the replan boundary and episode counter; check L2 with fairness | the **oscillation bound**, or a proof that none is needed |
| 5 | Run `MCThree` and compare findings against `MCSmall` | evidence that N=2 was not hiding anything |
| 6 | Record every counterexample as a numbered scenario in [06 §6](../design/06-validation-harness.md) | permanent regression coverage |
| 7 | Wire TLC into CI for the `spec/` directory | staleness prevention |

Item 6 is the one that makes this plan pay off even if the specification is later abandoned: findings survive as harness scenarios.

### 3.6 Exit criteria

- I1 and I3 hold for `N = 2` and `N = 3`, **or** counterexamples exist and the corresponding design documents have been corrected.
- L2 yields a concrete episode replan cap, written into [03 §3](../design/03-replan-and-recovery.md) with its derivation, and S3c in [06 §6](../design/06-validation-harness.md) turns green.
- Every counterexample is a numbered harness scenario.
- TLC runs in CI on changes under `spec/`.

### 3.7 S1 findings (updated 2026-08-21)

The Flory engine team owns the specification. TLC completed the hardened
two-branch and three-branch models with I1, I3, R10 admission, R11 admission,
and L2 satisfied. Safety is also checked with branch symmetry reduction;
liveness is checked separately without symmetry because TLC warns that symmetry
may hide a liveness violation.

The uncapped discovery configuration produced the shortest lasso:

```text
replan(P2) -> failure -> cancel -> replan(P1) -> failure -> cancel -> replan(P2)
```

The cycle has two `replan/boundary` transitions. The resulting episode cap is
therefore `E = 2`: after two replans in one episode, the next cancellation
escalates to L3 rather than opening a third replan. The controlled no-barrier,
post-pivot-cancel, unscoped-effect, and narrow-scope models respectively violate
I1, I3, R10, and R11. The narrow-scope counterexample keeps its effect in a
different declared scope, so it isolates R11 from the R10 check. The reproducible
command is `./spec/run-tlc.sh`.

## 4. What is deliberately excluded from S1

| Excluded | Why |
|---|---|
| Apalache and unbounded guarantees | S1 answers design questions; unbounded assurance is about a shipped protocol. Deferred to S2 with its own trigger. |
| Trace validation | Needs a real log, and there is no engine yet. S2. |
| Alloy structural search | Valuable for rule completeness, but the adversarial TLC model surfaces part of it first. S3. |
| TLAPS | Optional even in S3. A half-finished proof provides no more assurance than a model check. |
| Compensation algebra, R1–R11 as functions, world conservation arithmetic, projection purity | Verified against real code by the harness; see [ADR-003](../design/adr/adr-003-formal-verification-of-the-transaction-protocol.md) exclusions. |

## 5. A rejected shortcut

Hand-writing a small state machine in TypeScript and enumerating all interleavings for `N = 2` as a T-A test would find some of the same design defects with no new toolchain.

Rejected. It is a reimplementation of a model checker, and it gives up the one capability S1 most needs: **liveness checking under fairness**, which is how the oscillation bound is derived. TLC is free and mature; the shortcut saves learning cost and forfeits the highest-value result.

## 6. Effort

| Stage | Estimate |
|---|---|
| S1 | 2–3 weeks for one person including the primer; ≈150–200 lines of spec |
| S2 | Substantially larger, dominated by manual invariant strengthening for I2 |
| S3 | Specialist, scoped per finding |

Implementation cost is not the constraint on this plan. Skill availability is.

## 7. Preconditions and the open decision

Per [ADR-003](../design/adr/adr-003-formal-verification-of-the-transaction-protocol.md), three preconditions apply. Timing is satisfied — no engine code exists. Ownership is now resolved; the S2 skill precondition remains open:

1. **Named owner — resolved.** The Flory engine team owns `spec/`, its TLC workflow, and review of changes to the transaction model.
2. **Scarce skill for S2.** Inductive invariant strengthening for I2 will likely require capability the team does not currently have. Treat it as a hiring or training precondition attached to the S2 trigger, not an implementation detail.

If ownership changes, assign a replacement before accepting a transaction-protocol change; an unowned specification becomes write-only documentation and creates false confidence.
