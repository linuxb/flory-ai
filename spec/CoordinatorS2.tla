--------------------------- MODULE CoordinatorS2 ---------------------------
EXTENDS FiniteSets, Naturals

(***************************************************************************
S2 transaction-lifecycle model aligned with the executable Coordinator.
A sealed try owns one unit of a finite resource. Scope cancellation is a
single fenced action whose member inverses release sealed holds. A fork starts
with inherited sealed brackets and is prohibited from executing any lifecycle
transition. The model is intentionally domain-neutral.
***************************************************************************)

CONSTANTS
    \* @type: Set(Str);
    Branches,
    \* @type: Int;
    Capacity

TryStates == {"none", "sealed", "confirmed", "cancelled"}
ScopeStates == {"open", "cancelling", "pivotInflight", "pivotPassed", "committed", "cancelled"}

VARIABLES
    \* @type: Str -> Str;
    tryState,
    \* @type: Int;
    available,
    \* @type: Int;
    shipped,
    \* @type: Str;
    scopeState,
    \* @type: Int;
    pivotCount,
    \* @type: Bool;
    cancelRequested,
    \* @type: Bool;
    forked,
    \* @type: Set(Str);
    inherited

vars == <<tryState, available, shipped, scopeState, pivotCount,
          cancelRequested, forked, inherited>>

OpenHolds == Cardinality({b \in Branches : tryState[b] = "sealed"})

TypeOK ==
    /\ Branches # {}
    /\ Capacity >= Cardinality(Branches)
    /\ tryState \in [Branches -> TryStates]
    /\ available \in 0..Capacity
    /\ shipped \in 0..Capacity
    /\ scopeState \in ScopeStates
    /\ pivotCount \in 0..1
    /\ cancelRequested \in BOOLEAN
    /\ forked \in BOOLEAN
    /\ inherited \in SUBSET Branches

Init ==
    /\ tryState \in [Branches -> {"none", "sealed"}]
    /\ forked \in BOOLEAN
    /\ inherited = IF forked THEN {b \in Branches : tryState[b] = "sealed"} ELSE {}
    /\ available = Capacity - OpenHolds
    /\ shipped = 0
    /\ scopeState = "open"
    /\ pivotCount = 0
    /\ cancelRequested = FALSE

Try(b) ==
    /\ ~forked
    /\ scopeState = "open"
    /\ tryState[b] = "none"
    /\ available > 0
    /\ tryState' = [tryState EXCEPT ![b] = "sealed"]
    /\ available' = available - 1
    /\ UNCHANGED <<shipped, scopeState, pivotCount, cancelRequested, forked, inherited>>

RequestCancel ==
    /\ ~forked
    /\ scopeState = "open"
    /\ scopeState' = "cancelling"
    /\ cancelRequested' = TRUE
    /\ UNCHANGED <<tryState, available, shipped, pivotCount, forked, inherited>>

CancelMember(b) ==
    /\ ~forked
    /\ scopeState = "cancelling"
    /\ tryState[b] = "sealed"
    /\ tryState' = [tryState EXCEPT ![b] = "cancelled"]
    /\ available' = available + 1
    /\ UNCHANGED <<shipped, scopeState, pivotCount, cancelRequested, forked, inherited>>

CompleteCancel ==
    /\ ~forked
    /\ scopeState = "cancelling"
    /\ \A b \in Branches : tryState[b] # "sealed"
    /\ scopeState' = "cancelled"
    /\ UNCHANGED <<tryState, available, shipped, pivotCount, cancelRequested, forked, inherited>>

AdmitPivot ==
    /\ ~forked
    /\ scopeState = "open"
    /\ ~cancelRequested
    /\ \A b \in Branches : tryState[b] = "sealed"
    /\ scopeState' = "pivotInflight"
    /\ UNCHANGED <<tryState, available, shipped, pivotCount, cancelRequested, forked, inherited>>

ResolvePivotAbsent ==
    /\ ~forked
    /\ scopeState = "pivotInflight"
    /\ scopeState' = "open"
    /\ UNCHANGED <<tryState, available, shipped, pivotCount, cancelRequested, forked, inherited>>

PassPivot ==
    /\ ~forked
    /\ scopeState = "pivotInflight"
    /\ pivotCount = 0
    /\ scopeState' = "pivotPassed"
    /\ pivotCount' = 1
    /\ UNCHANGED <<tryState, available, shipped, cancelRequested, forked, inherited>>

ConfirmMember(b) ==
    /\ ~forked
    /\ scopeState = "pivotPassed"
    /\ tryState[b] = "sealed"
    /\ tryState' = [tryState EXCEPT ![b] = "confirmed"]
    /\ shipped' = shipped + 1
    /\ UNCHANGED <<available, scopeState, pivotCount, cancelRequested, forked, inherited>>

Commit ==
    /\ ~forked
    /\ scopeState = "pivotPassed"
    /\ \A b \in Branches : tryState[b] = "confirmed"
    /\ scopeState' = "committed"
    /\ UNCHANGED <<tryState, available, shipped, pivotCount, cancelRequested, forked, inherited>>

Next ==
    \/ \E b \in Branches : Try(b)
    \/ RequestCancel
    \/ \E b \in Branches : CancelMember(b)
    \/ CompleteCancel
    \/ AdmitPivot
    \/ ResolvePivotAbsent
    \/ PassPivot
    \/ \E b \in Branches : ConfirmMember(b)
    \/ Commit

I1PivotBarrier == scopeState \in {"pivotPassed", "committed"} => \A b \in Branches : tryState[b] \in {"sealed", "confirmed"}
I2HoldConservation == available + OpenHolds + shipped = Capacity /\ OpenHolds <= Cardinality(Branches)
I3NoCancelAfterPivot == pivotCount = 1 => ~cancelRequested
I4OnePivotPerScope == pivotCount <= 1
I5PivotFloor == pivotCount = 1 => scopeState \in {"pivotPassed", "committed"}
I6SweepConfirmRace == scopeState = "cancelling" => \A b \in Branches : tryState[b] # "confirmed"
I7ForkIsolation == forked => /\ scopeState = "open" /\ pivotCount = 0 /\ ~cancelRequested /\ \A b \in inherited : tryState[b] = "sealed"

ProtocolShape ==
    /\ (cancelRequested <=> scopeState \in {"cancelling", "cancelled"})
    /\ (pivotCount = 1 <=> scopeState \in {"pivotPassed", "committed"})
    /\ (\E b \in Branches : tryState[b] = "confirmed") => pivotCount = 1
    /\ scopeState = "pivotInflight" => /\ pivotCount = 0 /\ ~cancelRequested /\ \A b \in Branches : tryState[b] = "sealed"
    /\ scopeState \in {"cancelling", "cancelled"} => pivotCount = 0

S2Safety == I1PivotBarrier /\ I2HoldConservation /\ I3NoCancelAfterPivot /\
            I4OnePivotPerScope /\ I5PivotFloor /\ I6SweepConfirmRace /\ I7ForkIsolation
IndInv == TypeOK /\ ProtocolShape /\ S2Safety

=============================================================================
