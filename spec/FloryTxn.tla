----------------------------- MODULE FloryTxn -----------------------------
EXTENDS FiniteSets, Naturals, TLC

(*******************************************************************************
S1 model of Flory's flat transaction protocol.

The planner is demonic: it may extend a scope across freezes, pick any planner
after cancellation, or repeatedly choose alternating replanners. The normal
model admits only scope declarations accepted by the structural R10/R11 gates.
Negative configurations relax exactly one gate to demonstrate that the
admission checks are non-vacuous. This is not a model of an LLM.
*******************************************************************************)

CONSTANTS Branches,
          PlannerIds,
          ConsecutiveLimit,
          EpisodeCap,
          K,
          UseBarrier,
          AllowPostPivotCancel,
          EnableEpisodeCap,
          AllowUnscopedEffect,
          AllowNarrowScope

\* A concrete sentinel keeps TLC's initial-state evaluation finite.
NoPlanner == "noPlanner"
PivotNode == "pivot"
Nodes == Branches \cup {PivotNode}

\* The finite S1 abstraction has one shared resource class. Therefore every
\* reversible branch created before the pivot belongs to its minimum scope.
\* Pivot identity and undoability are derived, never planner-declared.
EffectClass(n) == IF n = PivotNode THEN "irreversible" ELSE "reversible"
IsPivot(n) == EffectClass(n) = "irreversible"
Undoable(n) == EffectClass(n) \in {"reversible", "bufferable"}
MinimumScope(nodes) ==
    IF PivotNode \in nodes
        THEN {PivotNode} \cup (nodes \cap Branches)
        ELSE {}

ScopeStates == {"open", "barrierWaiting", "pivotPassed", "cancelled"}
TryStates == {"none", "tried", "sealed", "failed"}
Outcomes == {"none", "committed", "cancelled", "suspended"}

VARIABLES scopeState,
          createdNodes,
          scopeMembers,
          foreignScopeMembers,
          tryState,
          holds,
          pivotFrozen,
          barrierFrozen,
          pivotDone,
          cancelSeen,
          episodeState,
          outcome,
          lastPlanner,
          lastPlannerFailures,
          replanCount,
          clock

vars == <<scopeState, createdNodes, scopeMembers, foreignScopeMembers,
          tryState, holds, pivotFrozen, barrierFrozen, pivotDone, cancelSeen,
          episodeState, outcome, lastPlanner, lastPlannerFailures, replanCount,
          clock>>

Init ==
    /\ Branches # {}
    /\ PlannerIds # {}
    /\ PivotNode \notin Branches
    /\ ConsecutiveLimit >= 1
    /\ EpisodeCap >= 1
    /\ K >= Cardinality(Branches)
    /\ scopeState = "open"
    /\ createdNodes = {}
    /\ scopeMembers = {}
    /\ foreignScopeMembers = {}
    /\ tryState = [b \in Branches |-> "none"]
    /\ holds = [b \in Branches |-> 0]
    /\ pivotFrozen = FALSE
    /\ barrierFrozen = FALSE
    /\ pivotDone = FALSE
    /\ cancelSeen = FALSE
    /\ episodeState = "active"
    /\ outcome = "none"
    /\ lastPlanner = NoPlanner
    /\ lastPlannerFailures = 0
    /\ replanCount = 0
    /\ clock = 0

TypeOK ==
    /\ scopeState \in ScopeStates
    /\ createdNodes \subseteq Nodes
    /\ scopeMembers \subseteq Nodes
    /\ foreignScopeMembers \subseteq Branches
    /\ scopeMembers \cap foreignScopeMembers = {}
    /\ tryState \in [Branches -> TryStates]
    /\ holds \in [Branches -> 0..1]
    /\ pivotFrozen \in BOOLEAN
    /\ barrierFrozen \in BOOLEAN
    /\ pivotDone \in BOOLEAN
    /\ cancelSeen \in BOOLEAN
    /\ episodeState \in {"active", "terminal"}
    /\ outcome \in Outcomes
    /\ lastPlanner \in PlannerIds \cup {NoPlanner}
    /\ lastPlannerFailures \in Nat
    /\ replanCount \in Nat
    /\ clock \in 0..1

CurrentBranches == scopeMembers \cap Branches
AllCurrentTriesSealed ==
    \A b \in CurrentBranches : tryState[b] = "sealed"
SomeCurrentTrySealed ==
    \E b \in CurrentBranches : tryState[b] = "sealed"
SomeCurrentTryFailed ==
    \E b \in CurrentBranches : tryState[b] = "failed"
ReservedCount == Cardinality({b \in Branches : holds[b] = 1})

\* R10: every created effect belongs to some declared scope. R11: when a
\* pivot is frozen, its current scope includes its computed minimum.
AdmissionAllEffectsScoped ==
    createdNodes \subseteq (scopeMembers \cup foreignScopeMembers)
AdmissionMinimumScope ==
    ~pivotFrozen \/ MinimumScope(createdNodes) \subseteq scopeMembers

BarrierReady ==
    IF UseBarrier
        THEN scopeState = "barrierWaiting" /\ pivotFrozen /\ barrierFrozen
             /\ AllCurrentTriesSealed
        ELSE scopeState = "open" /\ pivotFrozen /\ SomeCurrentTrySealed

\* An extension is a later freeze that joins a reversible effect to the current
\* scope. Membership is monotone until that scope is cancelled or closed.
ExtendScope(b) ==
    /\ episodeState = "active"
    /\ scopeState = "open"
    /\ ~pivotFrozen
    /\ Undoable(b)
    /\ b \notin createdNodes
    /\ createdNodes' = createdNodes \cup {b}
    /\ scopeMembers' = scopeMembers \cup {b}
    /\ UNCHANGED <<scopeState, foreignScopeMembers, tryState, holds,
                   pivotFrozen, barrierFrozen, pivotDone, cancelSeen,
                   episodeState, outcome, lastPlanner, lastPlannerFailures,
                   replanCount, clock>>

\* Controlled R10 negative: an effect is frozen without any scope membership.
CreateUnscopedEffect(b) ==
    /\ episodeState = "active"
    /\ scopeState = "open"
    /\ AllowUnscopedEffect
    /\ ~pivotFrozen
    /\ b \notin createdNodes
    /\ createdNodes' = createdNodes \cup {b}
    /\ UNCHANGED <<scopeState, scopeMembers, foreignScopeMembers, tryState,
                   holds, pivotFrozen, barrierFrozen, pivotDone, cancelSeen,
                   episodeState, outcome, lastPlanner, lastPlannerFailures,
                   replanCount, clock>>

\* Controlled R11 negative: the effect is scoped, but in a different scope,
\* so the pivot's current scope is narrower than its engine-computed minimum.
CreateForeignScopedEffect(b) ==
    /\ episodeState = "active"
    /\ scopeState = "open"
    /\ AllowNarrowScope
    /\ ~pivotFrozen
    /\ b \notin createdNodes
    /\ createdNodes' = createdNodes \cup {b}
    /\ foreignScopeMembers' = foreignScopeMembers \cup {b}
    /\ UNCHANGED <<scopeState, scopeMembers, tryState, holds, pivotFrozen,
                   barrierFrozen, pivotDone, cancelSeen, episodeState, outcome,
                   lastPlanner, lastPlannerFailures, replanCount, clock>>

ReserveTry(b) ==
    /\ episodeState = "active"
    /\ scopeState = "open"
    /\ b \in createdNodes
    /\ b \in scopeMembers
    /\ tryState[b] = "none"
    /\ ReservedCount < K
    /\ tryState' = [tryState EXCEPT ![b] = "tried"]
    /\ holds' = [holds EXCEPT ![b] = 1]
    /\ UNCHANGED <<scopeState, createdNodes, scopeMembers, foreignScopeMembers,
                   pivotFrozen, barrierFrozen, pivotDone, cancelSeen,
                   episodeState, outcome, lastPlanner, lastPlannerFailures,
                   replanCount, clock>>

SealTry(b) ==
    /\ episodeState = "active"
    /\ scopeState = "open"
    /\ b \in scopeMembers
    /\ tryState[b] = "tried"
    /\ tryState' = [tryState EXCEPT ![b] = "sealed"]
    /\ UNCHANGED <<scopeState, createdNodes, scopeMembers, foreignScopeMembers,
                   holds, pivotFrozen, barrierFrozen, pivotDone, cancelSeen,
                   episodeState, outcome, lastPlanner, lastPlannerFailures,
                   replanCount, clock>>

\* The freeze that introduces the derived pivot may also introduce its barrier.
FreezePivot ==
    /\ episodeState = "active"
    /\ scopeState = "open"
    /\ ~pivotFrozen
    /\ IF AllowNarrowScope
          THEN TRUE
          ELSE MinimumScope(createdNodes \cup {PivotNode})
               \subseteq (scopeMembers \cup {PivotNode})
    /\ createdNodes' = createdNodes \cup {PivotNode}
    /\ scopeMembers' = scopeMembers \cup {PivotNode}
    /\ pivotFrozen' = TRUE
    /\ barrierFrozen' = UseBarrier
    /\ UNCHANGED <<scopeState, foreignScopeMembers, tryState, holds, pivotDone,
                   cancelSeen, episodeState, outcome, lastPlanner,
                   lastPlannerFailures, replanCount, clock>>

EnterBarrier ==
    /\ episodeState = "active"
    /\ UseBarrier
    /\ scopeState = "open"
    /\ pivotFrozen
    /\ barrierFrozen
    /\ AllCurrentTriesSealed
    /\ scopeState' = "barrierWaiting"
    /\ UNCHANGED <<createdNodes, scopeMembers, foreignScopeMembers, tryState,
                   holds, pivotFrozen, barrierFrozen, pivotDone, cancelSeen,
                   episodeState, outcome, lastPlanner, lastPlannerFailures,
                   replanCount, clock>>

FailPrePivot(b) ==
    /\ episodeState = "active"
    /\ scopeState \in {"open", "barrierWaiting"}
    /\ b \in scopeMembers
    /\ tryState[b] \in {"tried", "sealed"}
    /\ tryState' = [tryState EXCEPT ![b] = "failed"]
    /\ UNCHANGED <<scopeState, createdNodes, scopeMembers, foreignScopeMembers,
                   holds, pivotFrozen, barrierFrozen, pivotDone, cancelSeen,
                   episodeState, outcome, lastPlanner, lastPlannerFailures,
                   replanCount, clock>>

PassPivot ==
    \* One TLA+ action represents the synchronous projection read and the
    \* pivot-passed append in their required single database transaction.
    /\ episodeState = "active"
    /\ IsPivot(PivotNode)
    /\ BarrierReady
    /\ scopeState' = "pivotPassed"
    /\ pivotDone' = TRUE
    /\ UNCHANGED <<createdNodes, scopeMembers, foreignScopeMembers, tryState,
                   holds, pivotFrozen, barrierFrozen, cancelSeen, episodeState,
                   outcome, lastPlanner, lastPlannerFailures, replanCount, clock>>

CommitScope ==
    /\ episodeState = "active"
    /\ scopeState = "pivotPassed"
    /\ scopeState' = "pivotPassed"
    /\ episodeState' = "terminal"
    /\ outcome' = "committed"
    /\ UNCHANGED <<createdNodes, scopeMembers, foreignScopeMembers, tryState,
                   holds, pivotFrozen, barrierFrozen, pivotDone, cancelSeen,
                   lastPlanner, lastPlannerFailures, replanCount, clock>>

CancelScope ==
    /\ episodeState = "active"
    /\ (scopeState \in {"open", "barrierWaiting"} /\ SomeCurrentTryFailed)
       \/ (scopeState = "pivotPassed" /\ AllowPostPivotCancel)
    /\ scopeState' = "cancelled"
    /\ holds' = [b \in Branches |-> 0]
    /\ cancelSeen' = TRUE
    /\ UNCHANGED <<createdNodes, scopeMembers, foreignScopeMembers, tryState,
                   pivotFrozen, barrierFrozen, pivotDone, episodeState, outcome,
                   lastPlanner, lastPlannerFailures, replanCount, clock>>

NextPlannerFailures(p) ==
    IF p = lastPlanner THEN lastPlannerFailures + 1 ELSE 1

FinishAtEpisodeCap ==
    /\ episodeState = "active"
    /\ scopeState = "cancelled"
    /\ EnableEpisodeCap
    /\ replanCount >= EpisodeCap
    /\ episodeState' = "terminal"
    /\ outcome' = "cancelled"
    /\ UNCHANGED <<scopeState, createdNodes, scopeMembers, foreignScopeMembers,
                   tryState, holds, pivotFrozen, barrierFrozen, pivotDone,
                   cancelSeen, lastPlanner, lastPlannerFailures, replanCount,
                   clock>>

FinishAtPlannerLimit(p) ==
    /\ episodeState = "active"
    /\ scopeState = "cancelled"
    /\ ~EnableEpisodeCap \/ replanCount < EpisodeCap
    /\ NextPlannerFailures(p) >= ConsecutiveLimit
    /\ episodeState' = "terminal"
    /\ outcome' = "cancelled"
    /\ UNCHANGED <<scopeState, createdNodes, scopeMembers, foreignScopeMembers,
                   tryState, holds, pivotFrozen, barrierFrozen, pivotDone,
                   cancelSeen, lastPlanner, lastPlannerFailures, replanCount,
                   clock>>

Replan(p) ==
    /\ episodeState = "active"
    /\ scopeState = "cancelled"
    /\ ~EnableEpisodeCap \/ replanCount < EpisodeCap
    /\ NextPlannerFailures(p) < ConsecutiveLimit
    /\ scopeState' = "open"
    /\ createdNodes' = {}
    /\ scopeMembers' = {}
    /\ foreignScopeMembers' = {}
    /\ tryState' = [b \in Branches |-> "none"]
    /\ holds' = [b \in Branches |-> 0]
    /\ pivotFrozen' = FALSE
    /\ barrierFrozen' = FALSE
    /\ lastPlanner' = p
    /\ lastPlannerFailures' = NextPlannerFailures(p)
    \* Discovery mode abstracts the unbounded diagnostic count away so that
    \* TLC can close the alternating-planner lasso. Hardened models retain it.
    /\ replanCount' = IF EnableEpisodeCap THEN replanCount + 1 ELSE replanCount
    /\ UNCHANGED <<pivotDone, cancelSeen, episodeState, outcome, clock>>

Suspend ==
    /\ episodeState = "active"
    /\ scopeState = "pivotPassed"
    /\ episodeState' = "terminal"
    /\ outcome' = "suspended"
    /\ UNCHANGED <<scopeState, createdNodes, scopeMembers, foreignScopeMembers,
                   tryState, holds, pivotFrozen, barrierFrozen, pivotDone,
                   cancelSeen, lastPlanner, lastPlannerFailures, replanCount,
                   clock>>

TerminalTick ==
    /\ episodeState = "terminal"
    /\ clock' = 1 - clock
    /\ UNCHANGED <<scopeState, createdNodes, scopeMembers, foreignScopeMembers,
                   tryState, holds, pivotFrozen, barrierFrozen, pivotDone,
                   cancelSeen, episodeState, outcome, lastPlanner,
                   lastPlannerFailures, replanCount>>

Next ==
    \/ \E b \in Branches : ExtendScope(b)
    \/ \E b \in Branches : CreateUnscopedEffect(b)
    \/ \E b \in Branches : CreateForeignScopedEffect(b)
    \/ \E b \in Branches : ReserveTry(b)
    \/ \E b \in Branches : SealTry(b)
    \/ FreezePivot
    \/ EnterBarrier
    \/ \E b \in Branches : FailPrePivot(b)
    \/ PassPivot
    \/ CommitScope
    \/ CancelScope
    \/ \E p \in PlannerIds : FinishAtPlannerLimit(p)
    \/ \E p \in PlannerIds : Replan(p)
    \/ FinishAtEpisodeCap
    \/ Suspend
    \/ TerminalTick

I1PivotBarrier ==
    ~(scopeState = "pivotPassed" /\ \E b \in CurrentBranches :
        tryState[b] \in {"tried", "failed"})

I3NoCancelAfterPivot ==
    ~(pivotDone /\ cancelSeen /\ scopeState = "cancelled")

Terminal == episodeState = "terminal"
L2EpisodeTerminates == <>[]Terminal

Symmetry == Permutations(Branches)

Spec == Init /\ [][Next]_vars /\ WF_vars(Next)

=============================================================================
