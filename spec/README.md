# Flory Transaction Protocol: TLA+ S1

**Owner:** Flory engine team

This directory contains the Stage S1 executable model required by
[ADR-003](../doc/design/adr/adr-003-formal-verification-of-the-transaction-protocol.md).
It is a verification artifact only. Neither the TLA+ tools nor this model are
runtime dependencies of the TypeScript engine or Go coordinator.

## Run the model

```bash
./spec/run-tlc.sh
```

The script downloads the pinned official `tla2tools.jar` into the ignored
`spec/.tlc/` directory, verifies its SHA-256 digest from `toolchain.env`, and
runs TLC with Java 11 or newer. Set `TLC_WORKERS` to change the worker count.

After every successful full check, the same command uses the pinned jar's
TLA2TeX renderer and `pdflatex` to write `spec/output/FloryTxn.pdf`. The PDF is
a snapshot of the root module only after the complete TLC suite has passed; it
is ignored locally and uploaded as the `flory-tla-specification-pdf` GitHub
Actions artifact. Do not commit files under `spec/.tlc/`, `spec/output/`, or
TLC trace-exploration modules.

## Model boundary

`FloryTxn.tla` models one flat transaction scope with two or three parallel
branches, a shared finite reservation pool (`K = 3`), TCC `try` states, a pivot
barrier, cancellation, and in-place replanning. The model derives pivot identity
from `effect_class = irreversible` and undoability from registered metadata; it
does not accept either property as a planner declaration. It exposes the stable
constants `Branches`, `PlannerIds`, `ConsecutiveLimit`, and `EpisodeCap`, plus
`Spec`, `TypeOK`, `I1PivotBarrier`, `I3NoCancelAfterPivot`, and
`L2EpisodeTerminates`.

The planner is demonic after cancellation: it may select any member of
`PlannerIds`, including an alternating sequence. It may also extend the current
scope in a later freeze while a prior `try` remains open. The model does not
assume an LLM is cooperative.

S1 makes the R10/R11 admission boundary explicit. `createdNodes` records frozen
effects, `scopeMembers` records the current scope, and
`foreignScopeMembers` represents a separate declared scope used only by the R11
negative control. `AdmissionAllEffectsScoped` requires every frozen effect to
belong to a declared scope; `AdmissionMinimumScope` requires a pivot scope to
contain every preceding reversible member in the model's shared footprint class.
Scope membership may only grow while that scope is open. This is an abstract
model of the admission boundary, not a proof of the real R1-R11 functions;
those pure functions remain harness tests.

Nested scopes, hold-conservation arithmetic, orphan-sweep races, dry-run seed
isolation, Apalache induction, Alloy search, and real-log trace validation are
deferred to the later stages defined in ADR-003. `PassPivot` is one atomic TLA+
action, deliberately abstracting the required same-database-transaction
projection read and `txn/pivot-passed` append. The `run_seq`/`global_seq` split,
database constraints, and implementation interleavings are S2 trace and
coordinator concerns rather than extra S1 state variables.

## Configurations and findings

| Check | Configuration | Expected result |
| --- | --- | --- |
| Safety, N=2 / N=3 | `MCSmallSafety.cfg`, `MCThreeSafety.cfg` | `TypeOK`, I1, I3, R10 admission, and R11 admission hold with branch symmetry reduction. |
| Liveness, N=2 / N=3 | `MCSmall.cfg`, `MCThree.cfg` | I1, I3, both admission invariants, and L2 hold without symmetry reduction. TLC warns that symmetry can hide liveness violations, so liveness is checked separately. |
| Discovery | `MCDiscovery.cfg` | L2 fails as required, exposing the alternating-planner lasso. |
| Barrier negative control | `MCNoBarrier.cfg` | I1 fails. |
| Post-pivot-cancel negative control | `MCPostPivotCancel.cfg` | I3 fails. |
| Unscoped-effect negative control | `MCUnscopedEffect.cfg` | R10 admission fails. |
| Narrow-scope negative control | `MCNarrowScope.cfg` | R11 admission fails while the effect remains scoped elsewhere. |

The discovery model disables only the episode cap and abstracts away the
unbounded diagnostic counter so TLC can close a finite lasso. TLC's trace is:

```text
Replan(p2) -> pre-pivot failure -> cancel -> Replan(p1)
  -> pre-pivot failure -> cancel -> back to Replan(p2)
```

The lasso contains two `replan/boundary` transitions. Therefore S1 sets
`EpisodeCap = 2`: after two replans in one episode, the next cancellation moves
to L3 rollback rather than allowing the third replan. The hardened N=2 and N=3
models satisfy L2 with that cap.

Counterexamples from future changes are evidence of a protocol or check-rule
gap. Add a numbered harness scenario and, when the resolution selects among
alternatives, a new ADR before changing the model's expected result.
