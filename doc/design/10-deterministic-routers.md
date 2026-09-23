# Deterministic Routers and Rule Templates (10)

> Status: Draft v0.1 | Depends on: [01](./01-jit-dag-and-event-log.md), [02](./02-transaction-model.md), [03](./03-replan-and-recovery.md), [09](./09-tool-registry-gateway.md)

> Diagram: [diagram/router-admission.html](../diagram/router-admission.html) — regions A–E: mandatory interposition, template binding, the three gates, runtime evaluation, and derived placement.

## 1. Why a Deterministic Branch Vertex Exists

Flory executes **progressive JIT-DAG workflows**. A submitted workflow may be a multi-vertex DAG combining deterministic tools and probabilistic model steps, or a single planner vertex, and it unfolds just in time as planners and routers generate sub-DAGs of tool callers and further downstream planners and routers ([01 §1](./01-jit-dag-and-event-log.md#1-goals)).

In high-throughput commerce operation — order and customer-service workflows in the hundreds of thousands per day — many transitions are purely deterministic: *if `order.lookup` returns `Shipped`, call `logistics.track`*. Routing such a transition through a model costs three things that the business never agreed to pay:

| Defect | Effect |
|---|---|
| Latency | Model inference adds hundreds of milliseconds to seconds to a decision computable in microseconds. |
| Cost | Token budget is spent on a decision that requires no probabilistic reasoning. |
| Reliability | Probabilistic drift and hallucination enter rigid, audited business rules. |

The **router** vertex exists to take those transitions back. It is a first-class deterministic vertex that evaluates upstream tool-output summary fields and instantiates an execution sub-DAG without calling a model.

Introducing deterministic branching into a transactional JIT-DAG engine is not free, and this document's structure follows the three hazards it must answer:

- **Late detection.** A router standing after a committed pivot that evaluates a buggy rule and emits a shape-illegal sub-DAG is intercepted *after* money has moved and after the proposing planner has fallen below the backtrack floor ([03 §2.1](./03-replan-and-recovery.md#21-legal-replan-boundaries-and-the-backtrack-floor)). Detection therefore moves to freeze time (§5).
- **The deterministic dead end.** Delegating recovery from a failed deterministic branch to a model invites an unapproved workaround into an audited path. Deterministic failures are governed by the transaction protocol only (§9).
- **Scope ambiguity.** A router has no side effects, so its transaction placement must be derived mechanically rather than judged (§4).

## 2. The Router Vertex

A router is the third vertex role, beside the planner and the tool caller ([01 §2](./01-jit-dag-and-event-log.md#2-node-roles)). It calls no tool, holds no transaction bracket, and is never a scope member.

### 2.1 Two entry tracks

Routers enter the graph through two complementary tracks.

**Explicit declaration.** In enterprise SOP workflows, pure deterministic pipelines (`tool -> router -> tool`), and nested sub-DAG templates, the workflow author declares the router directly and pins its published template:

```yaml
vertices:
  - id: "order_lookup"
    tool: "order.lookup"
  - id: "route_dispatch"
    kind: "router"
    parents: ["order_lookup"]
    template_ref: "rule://dispatch-routing@v3"
    fallback_planner: "planner://negotiate" # optional; omitted in pure deterministic pipelines
```

Explicit declaration resolves the template in constant time by content-addressed URI and digest, which removes template matching and signature-collision handling across catalogues of a thousand or more templates. It also makes multi-step deterministic branching expressible without inventing an artificial downstream planner.

**Automatic interposition.** When a planner proposes a sub-DAG in which a tool caller connects directly to a downstream planner, the engine normalizes the graph by interposing a router on that edge:

```
[tool-a, tool-b, …]  →  [router]  →  [planner]      (structural fall-through on no_match)
                            │
                            └─ rule matched → emit deterministic sub-DAG branch, zero model calls
```

Region A of [diagram/router-admission.html](../diagram/router-admission.html) shows the normalization. This is check-rule **R14**, the router topology invariant ([02 §3.4](./02-transaction-model.md#34-deterministic-check-rules)): *no tool-caller vertex may have a planner vertex as a direct successor; every such edge carries a router, interposed by the engine when the proposal does not supply one.* The planner's action vocabulary stays pure — it never writes router syntax — while business policy keeps a guaranteed interception point on every thought junction.

**The normalizer's guarantee is per planner, and deliberately stronger than the rule it discharges.** R14 is a prohibition on one kind of edge, which is the right shape for a check-rule: monotone, and decidable on the graph in front of it. The engine's normalizer produces a canonical form instead — *every planner that has parents reaches all of them through exactly one router* — and does not classify parents by role. Three things follow. The interception point exists wherever a decision is made, not only where a tool happens to feed it directly. Slot identity stays well defined, since a slot is keyed by the set of what flows into one junction. And the pass is idempotent on a one-line condition — a planner is canonical when its only parent is a router — which is what lets the invariant be asserted after the fact rather than trusted. A planner with no parents is left alone: it opens the run, so there is no incoming edge to intercept and nothing upstream for a rule to read.

The checker keeps enforcing the prohibition rather than the canonical form. The stronger property is what the engine *produces*; the weaker one is what any proposal, from any source, must *satisfy*.

### 2.2 Bounded authority

A router's authority is a strict subset of a planner's: it may emit only sub-DAG proposals that a planner could legally propose at the same position. Everything a planner's proposal must satisfy, a router's emitted branch must satisfy, and the branch is admitted by the same `checkSubDag` implementation ([02 §3.4](./02-transaction-model.md#34-deterministic-check-rules)).

## 3. Rule Templates

### 3.1 Shape

A rule template is strictly declarative: an ordered list of `(condition, sub_dag_template)` pairs.

- A **condition** is a pure boolean predicate over upstream tool-output summary fields, for example `order.lookup.output.risk_score < 30`. It dereferences no blob, reads no clock, and performs no network I/O. The prefix names a **tool type**, not a vertex: a template is published before it is bound to any graph, so the only upstream name it can carry is one the catalogue also knows — which is the same key a slot identity is built from.
- A **branch sub-DAG** is instantiated on match. It may contain tool callers, confirmation barriers, nested routers, and downstream planners.

Conditions are totally ordered and evaluated with first-match semantics. A template is a published, immutable, content-addressed contract, and it is **Engine-owned**: a rule template is planning structure — the same authority that admits a planner's proposal admits a router's branches — so the Engine publishes it, admits it under Q1–Q6 (§3.4), and records every mutation. `gatewayd` publishes the tool view those branches are resolved and admitted against, and nothing else about a template ([09 §1](./09-tool-registry-gateway.md#1-purpose-and-boundary)).

### 3.2 Dual binding resolution

Binding resolves out of band and never passes through a model; region B of [the diagram](../diagram/router-admission.html) shows both tracks.

1. **Explicit reference.** A vertex declaring `template_ref` resolves its pinned contract from the Engine's rule-template store in constant time by URI and content digest.
2. **Slot-based dynamic resolution.** An auto-interposed router resolves its template through a stable topological coordinate:

   ```
   SlotId = Hash(workflow_type + sorted(upstream_tool_types) + target_planner_template)
   ```

   If no template is registered for that `SlotId`, the router is a transparent pass-through and evaluates to `no_match`.

### 3.3 Templates are pins, and pin changes are events

A router's bound template is a `pin_version` exactly like a model endpoint or a tool contract ([01 §5.3](./01-jit-dag-and-event-log.md#53-pin_version-what-a-substitution-actually-changes)). Two properties follow, and both are load-bearing.

**Topology is invariant under rule changes.** Because interposition is mandatory and explicit routers are pinned, attaching, updating, or removing a rule changes only which template version a router pins — never the physical shape of the DAG. Prompt prefixes stay stable ([05 §2.4](./05-context-aggregation-and-offline-evaluation.md#24-prompt-cache-dividend)), and "what would have happened on order #12345 if this junction had pinned v3 instead of v2" is an ordinary fork with one substitution, evaluated by the standard `surface-identity` and `cost-delta` evaluators ([05 §3.1](./05-context-aggregation-and-offline-evaluation.md#31-the-evaluation-api)).

**Template mutations are recorded, not looked up.** Whenever a template is published, updated, or bound to a slot, the Engine appends a `rule_template/published` event to the **configuration stream** — a reserved, Engine-owned `stream_id` in the data plane, separate from every run and every business entity ([01 §3.2](./01-jit-dag-and-event-log.md#32-core-event-vocabulary), [08 §3](./08-database-schema.md#3-write-time-guards)). The event carries the structural diff against its predecessor version as an RFC 6902 JSON Patch, the resulting content digest, author metadata, and the slot coordinates when the change is a binding. This is the same treatment an externally imposed event already receives: a human-triggered publication changes the context later decisions fold from, so it belongs in the log rather than in a mutable side table. Replay and counterfactual evaluation therefore reconstruct the exact template bound to any router at any historical position from recorded history, without consulting a mutable registry.

### 3.4 Publication admission (Q1–Q6)

A template is admitted before it can be bound to any router. The gate is Engine-side, runs against a role-scoped tool view resolved from `gatewayd`, and uses a closed vocabulary:

| Code | Rule |
|---|---|
| Q1 | Every condition references only **summary fields** of upstream payloads, as named by the producing tool's log-fields schema ([09 §3](./09-tool-registry-gateway.md#3-registration-and-the-tool-view-contract)). No blob dereference, no clock read, no network I/O. A path is resolved against the log fields rather than the output schema, and the two are not interchangeable: the output schema describes the payload that streams to blob storage, so accepting a path because it appears there would admit a rule that can only be evaluated by dereferencing a blob. A tool that declares no log fields is not silently trusted — none of its fields can be referenced. |
| Q2 | Every tool referenced by every branch resolves inside a published tool view with a known `effect_class`. |
| Q3 | Template metadata is **derived at publication, never declared**: a template-level capability envelope (`max_effect_class`, `can_open_scope`, `can_provide_pivot`, `is_pure_read_only`) for constant-time catalogue pruning, and per-branch morphological traits (`opens_scope`, `has_pivot`, `max_effect`) preserved for freeze-time admission. The envelope summarizes; the traits are what keep branch heterogeneity from being erased by that summary. |
| Q4 | Each branch sub-DAG independently passes `checkSubDag` in isolation. |
| Q5 | Conditions are totally ordered with first-match semantics. |
| Q6 | Fall-through to the downstream planner on `no_match` is structural. An explicit fallback declaration is refused, because a second channel could disagree with the topology R14 already guarantees. |

Admission is therefore the same code path a proposal takes, which is the point of keeping publication in the Engine: a branch a planner could not legally propose must not become publishable merely by being written into a template instead.

Isolated admission is deliberately weaker than the freeze-time gate. Q1–Q6 validate a template against the catalogue; they cannot know which run will bind it, under which role-scoped view, or into which transaction placement. Those are checked exhaustively at freeze (§5.1).

## 4. Placement and Transaction Binding

A router has no side effects and is never a scope member, so its transaction placement is **derived** by the engine from the ancestor graph at freeze time, never declared and never inferred at runtime:

| Derived placement | Condition | Consequence for an emitted branch |
|---|---|---|
| `at_savepoint` | Every ancestor scope is closed — committed or cancelled. | The branch opens a fresh transaction scope. |
| `inside_scope(S)` | An ancestor scope `S` is unclosed: open, or half-open with a try sealed but unconfirmed. | The branch joins `S`. |

Only `committed` and `cancelled` close a scope. `cancelling`, `suspended`, and both pivot states are all still unclosed, and an open scope is no more a savepoint than a half-open one, so a router below any of them derives `inside_scope`. The same predicate decides the placement and enforces R13, which is what keeps a derived placement from ever contradicting the rule that checks it.

The admission rules for each placement are R12 and R13 ([02 §3.4](./02-transaction-model.md#34-deterministic-check-rules)); region E of [the diagram](../diagram/router-admission.html) shows both placements and the two legal join shapes.

Both the derived placement and the resolved template are written onto the router's `vertex/created` event at freeze — the placement in the payload, the template's content digest in the `pin_version` column ([01 §5.3](./01-jit-dag-and-event-log.md#53-pin_version-what-a-substitution-actually-changes)). Resolving the template at evaluation time instead would make a router read whatever the registry holds at replay time, so one recorded log could route two ways on two replays; pinning at freeze makes the decision a function of recorded history, and makes rebinding a slot a `pin_version` substitution that an ordinary fork performs without touching topology.

### 4.1 Routers as join nodes over parallel branches

When a router joins parallel branches, freeze admission evaluates its pinned template against upstream scope membership, and two shapes are legal.

**Pre-declared common scope.** If any branch of the template emits a pivot or joins an open scope, every parallel branch whose tries must be atomic with that pivot is declared upfront as a member of one common scope `S`; R3 natively supports parallel branches inside one scope ([02 §3.5](./02-transaction-model.md#35-why-r3-permits-at-most-one-pivot)). A confirmation barrier precedes the router so that all parallel tries of `S` are sealed before it evaluates, and the router then derives `inside_scope(S)` unambiguously.

**Disjoint scope isolation.** If parallel branches belong to distinct, uncoordinated scopes, they must commit or close before the join whenever the router's template can emit a pivot, because one pivot cannot bind two independent scopes. Joining distinct open scopes is admitted only when the template is purely read-only — every branch carries `effect_class: none` — where the router reads outputs without binding to either scope.

**A branch that joins `S` cannot yet be written.** Publication admission runs `checkSubDag` over each branch in isolation (Q4), and R10 requires every side-effecting vertex to name a scope. A template is published before it is bound to any graph, so the only scope it can name is one it declares itself — which makes the branch scope-opening, and therefore inadmissible at an `inside_scope` placement. Every side-effecting template is consequently refused at an `inside_scope` placement today, whether one ancestor scope is unclosed or several. Expressing a join requires a way for a branch to declare that it inherits its placement's scope rather than opening one, which is deferred with the other template-language gaps in §13.

Flory defines **no runtime scope-merge protocol**. Atomicity across parallel branches is declared at freeze time or it does not exist.

### 4.2 Scope widening

By default the engine derives the minimum scope from tool-footprint intersection ([02 §3.1](./02-transaction-model.md#31-layer-1--the-engine-computes-the-minimum-scope)). When business atomicity binds unrelated footprints — deducting a company balance together with an ERP stock update in a supplier-procurement flow — the human-authored template declares a widened `txn/scope` through the same workflow-policy channel a planner uses ([02 §3.2](./02-transaction-model.md#32-layer-2--the-planner-may-widen-never-narrow)). Widening beyond the minimum is legal; narrowing below it is rejected by R11.

## 5. Three Lines of Defence

Safety is enforced at three distinct times, and the division of labour between them is the point (region C of [the diagram](../diagram/router-admission.html)):

| Gate | Timing | Responsibility |
|---|---|---|
| Publication | Template publish time | Validates condition syntax, resolves every referenced tool, and verifies branch shapes in isolation (Q1–Q6, §3.4). |
| Freeze admission | Proposal freeze, before any tool executes | Runs exhaustive admission over all branches against the run's role-scoped tool view and the existing-scope snapshot (§5.1). |
| Structural fall-through | Router evaluation | Passes control to the downstream planner on `no_match` (§6). |

### 5.1 Freeze-time exhaustive admission

The core vulnerability of a deterministic rule is late detection: an invalid branch discovered after an irreversible pivot has passed. The remedy is exhaustive checking at the freeze that introduces the router, over

```
total verifications = N branches × M reachable placements
```

evaluated against this run's actual role-scoped tool view and its existing-scope snapshot. A slot with one fixed placement costs `N` branch checks; a topology admitting several placements costs every relevant combination. Cost scales with branch count and graph size, and it is paid once per freeze rather than once per execution.

**Static shape and runtime state are different responsibilities.** Freeze admission validates each branch against its declared placement and the recorded scope snapshot. Parent success does not establish that a scope is still open or that a reservation is unexpired, and cancellation never converts an `inside_scope(S)` branch into a fresh transaction at a savepoint. Runtime admission therefore still performs the atomic checks of [07 §3.1](./07-distributed-transaction-coordinator.md#31-work-scheduler) and may reject a branch that was shape-valid at freeze because transaction state has changed. Freeze admission does not promise zero runtime rejection; it promises that no *shape* defect survives to execution.

`engine/src/admission/check-rules.ts` therefore accepts a third argument: an immutable `existing_scope_snapshot` of current scope states ([02 §3.4](./02-transaction-model.md#34-deterministic-check-rules)).

### 5.2 Multi-dimensional tags and admission logic

Template metadata is derived mechanically at publication so that branch heterogeneity is never erased by a single summary label. A **template-level capability envelope** drives constant-time catalogue pruning at slot binding, while **branch-level morphological traits** are preserved for exhaustive admission.

```typescript
/** Multi-dimensional template capability envelope for O(1) catalog pruning. */
interface TemplateCapability {
    max_effect_class: 'none' | 'bufferable' | 'reversible' | 'irreversible';
    can_open_scope: boolean;
    can_provide_pivot: boolean;
    is_pure_read_only: boolean;
}

/** Branch-level morphological traits preserving branch heterogeneity. */
interface BranchTraits {
    condition: string;
    sub_dag: SubDagProposal;
    opens_scope: boolean;
    has_pivot: boolean;
    max_effect: 'none' | 'bufferable' | 'reversible' | 'irreversible';
}

/** Topological slot context resolved at freeze time. */
interface SlotPlacementContext {
    placement: 'at_savepoint' | 'inside_scope';
    is_read_only_context: boolean; // e.g. offline simulation fork or disjoint join
    active_scope?: {
        scope_id: string;
        pivot_count: number;
    };
    role_tool_view: ToolRegistry;
}

/** Gate 1: fast O(1) template catalogue pruning against a slot context. */
function fastPruneTemplate(cap: TemplateCapability, slot: SlotPlacementContext): boolean {
    if (slot.is_read_only_context && !cap.is_pure_read_only) {
        return false; // Reject side-effect templates on read-only simulation forks
    }
    if (slot.placement === 'inside_scope' && cap.can_open_scope && !cap.can_provide_pivot && !cap.is_pure_read_only) {
        return false; // Cannot open fresh scopes inside an active half-open scope
    }
    if (slot.placement === 'inside_scope' && (slot.active_scope?.pivot_count ?? 0) > 0 && !cap.is_pure_read_only) {
        if (!cap.can_open_scope && cap.can_provide_pivot && cap.max_effect_class === 'irreversible') {
            return false; // Reject if the scope already has a pivot and the template only provides pivots
        }
    }
    return true;
}

/** Gate 2: freeze-time exhaustive branch-level admission check. */
function checkFreezeAdmission(branches: BranchTraits[], slot: SlotPlacementContext, existingScopes: ScopeSnapshot[]): CheckResult {
    const violations: CheckViolation[] = [];

    for (let i = 0; i < branches.length; i++) {
        const b = branches[i];

        // Guard against side effects in read-only contexts such as offline forks.
        if (slot.is_read_only_context && b.max_effect !== 'none') {
            violations.push({rule: 'R10', message: `Branch ${i} emits side-effects in read-only slot`, vertices: []});
            continue;
        }

        if (slot.placement === 'inside_scope') {
            if (b.opens_scope) {
                violations.push({rule: 'R12', message: `Branch ${i} cannot open fresh scope inside active scope`, vertices: []});
            }
            if (b.has_pivot && (slot.active_scope?.pivot_count ?? 0) > 0) {
                violations.push({rule: 'R3', message: `Branch ${i} introduces duplicate pivot in scope`, vertices: []});
            }
            // A branch with a pivot is admitted when the scope has none: it supplies S's unique commit point.
        } else {
            // at_savepoint: a side-effecting node must be bounded by a scope (02 R10). If the branch
            // declares none, the engine synthesizes the minimum scope from tool footprints (02 §3.1).
            if (b.max_effect !== 'none' && !b.opens_scope) {
                const autoScope = synthesizeMinimumScope(b.sub_dag, slot.role_tool_view);
                if (!autoScope) {
                    violations.push({rule: 'R10', message: `Branch ${i} side-effect node lacks declared scope and cannot derive minimum scope`, vertices: []});
                } else {
                    b.sub_dag.scopes.push(autoScope);
                }
            }
        }

        const subResult = checkSubDag(b.sub_dag, slot.role_tool_view, existingScopes);
        if (!subResult.accepted) {
            violations.push(...subResult.violations);
        }
    }

    return {accepted: violations.length === 0, violations};
}
```

## 6. Closed Outcome Vocabulary

Router evaluation produces exactly one of four mutually exclusive outcomes, traced in region D of [the diagram](../diagram/router-admission.html):

| Outcome | Meaning |
|---|---|
| `matched(i)` | Emit branch `i`'s sub-DAG. A terminal branch shadows the downstream planner through `subgraph/shadowed`. |
| `no_match` | Structural fall-through: control passes to the downstream planner as the default decision maker. |
| `evaluation_error` | A fatal runtime error such as a malformed field path. The vertex fails, an operational alert is raised, and the run escalates to L4. |
| `proposal_rejected` | Runtime scope or reservation checks reject an otherwise statically valid branch. Append `vertex/failed` with the rejection reason; publish no runnable branch work and do not fall through to a planner. Transaction cleanup or suspension belongs to the Coordinator ([02 §4.4](./02-transaction-model.md#44-orphan-try-detection)). |

Fall-through is structural. A template declares no explicit fallback, because a second declaration channel could disagree with the topology that R14 already guarantees.

## 7. Runtime Execution and Event Lifecycle

- **Executor class.** Routers are executed by the TypeScript Engine synchronously on parent completion. They are a third `flory_executor_class` beside the Orchestrator and Coordinator classes, and they are never queued in `enqueue_vertex_work` ([01 §3.2.1](./01-jit-dag-and-event-log.md#321-which-executor-owns-a-vertex), [08 §2](./08-database-schema.md#2-ground-truth-tables)).
- **Strict event trajectory.** A router appends `vertex/started`, then `vertex/succeeded` carrying `{matched_condition}` — the matched index, or `null` on fall-through — or `vertex/failed`. Skipping `vertex/started` is prohibited: the state machine's monotonicity is what the TLA+ models and the Coordinator trace validator depend on ([06 §12](./06-validation-harness.md#12-formal-verification-design)).
- **Log-fields schema.** So that a pure router evaluation performs no blob I/O, every tool contract declares a **log-fields schema** naming the control-flow fields — status codes, scores, classifications — that the executor lifts directly into `vertex/succeeded` while bulk output streams to blob storage ([09 §3](./09-tool-registry-gateway.md#3-registration-and-the-tool-view-contract)). Routers evaluate strictly against in-event payload fields.

## 8. Prompt Invisibility

Routers must not pollute planner context or destabilize prompt prefixes:

- On `matched(i)`, `linearize` includes the matched condition string, so the downstream context explains why the emitted branch exists.
- On `no_match`, the router is entirely invisible in the linearized prompt. The downstream planner receives a byte-identical context to classic ReAct execution ([01 §4.2](./01-jit-dag-and-event-log.md#42-linearization)).

## 9. Failure Semantics on a Deterministic Branch

A deterministic branch is rigid business policy, so its failures are governed by the transaction protocol and never by model replanning. The rule and its ladder positions are specified in [03 §2.5](./03-replan-and-recovery.md#25-deterministic-branches-never-replan-with-a-model); the summary is:

- A pre-pivot definitive failure permits scope cancellation once no member attempt remains unresolved, then halts to L4. An unknown outcome suspends with its evidence and reservations preserved instead.
- A post-pivot failure is forward-only. Cancellation is rejected by the coordinator state machine and by the `check_pivot_pass` trigger ([08 §3](./08-database-schema.md#3-write-time-guards)); the run suspends to L4 for operator-assisted completion or ledger reconciliation.
- An unknown pivot outcome is resolved by the pivot's registered status-query operation under its frozen retry policy before any decision is taken ([07 §3.3](./07-distributed-transaction-coordinator.md#33-tool-executor)).

The downstream planner's own lifecycle is unaffected: it runs normally when the emitted branch connects to it, is cleanly shadowed when the branch is terminal, and receives control on `no_match`.

## 10. Governance and Match-Rate Telemetry

Rule templates are versioned, published contracts, and their behaviour is an operational metric folded from the log rather than sampled from telemetry ([05 §4.2](./05-context-aggregation-and-offline-evaluation.md#42-provenance-and-aggregation)). Two readings drive governance:

- A rule matching close to 100% of the time means the junction never needed a planner and should be inlined into a static pipeline.
- A condition list that keeps growing means rules are being substituted for thought, and the junction should revert to a planner.

## 11. Worked Example: Post-Sale Return on Order #12345

**Step 0 — publication of `rule://return-routing@v3`.** Two conditions plus structural fall-through:

1. `risk.score < 30 && order.amount <= 200` → `refund.issue` (pivot)
2. `risk.score < 30 && order.amount > 200` → `inventory.reserve_slot` (TCC try) → `refund.issue` (pivot)
3. otherwise → no match

Q1–Q6 pass: conditions reference declared schema fields, both branches are shape-legal in isolation, and the derived envelope is `{max_effect_class: 'irreversible', can_open_scope: true, can_provide_pivot: true, is_pure_read_only: false}`. The template is published with its content digest.

**Step 1 — proposal and exhaustive admission.** Planner `P1` proposes `order.lookup → risk.score → P2` (a negotiation planner). R14 interposes `R1` between the read tools and `P2`; slot identity resolves `rule://return-routing@v3`; ancestors are read-only, so the derived placement is `at_savepoint`. Both branches and the fall-through are checked under that placement against the role-scoped tool view. The graph freezes.

**Step 2 — happy path, zero model calls.** Reads return `risk.score = 12`, `amount = 350`. `R1` matches condition 2 and appends `subgraph/proposed` for the reservation and the refund, opening fresh scope `S2`; `checkSubDag` admits it and `R1` appends `vertex/succeeded {matched_condition: 2}`. `P2` is shadowed. The Coordinator seals the try, passes the pivot, and confirms.

**Step 3 — structural fall-through.** Reads return `risk.score = 75`. `R1` appends `vertex/succeeded {matched_condition: null}` and control falls through to `P2`, whose prompt is byte-identical to a run in which no router existed.

**Step 4 — deterministic branch failure.** Branch 2 executed, and the reservation fails permanently because the inventory service is down. The failure fences `S2`; the Engine requests its cancellation and the Coordinator cancels it back to `R1`'s savepoint. Backtracking to `P1` is illegal below the backtrack floor, and replanning through `P2` is forbidden because the failed work came from a deterministic policy rather than a plan. Once the cancellation has completed, the run halts at L4 — an escalation with no planner selected — with a full causal postmortem; no funds moved twice and no inventory is stranded.

**Step 5 — freeze-time detection of a configuration defect.** The same run authorized under a `junior-agent` role that lacks `refund.issue`. R13 finds that both branches reference a tool absent from the run's role-scoped view, and the proposal is rejected before `P1` freezes and before any tool runs — a position at which no pivot has passed, so the planner can safely replan an alternative inquiry path.

## 12. Rationale, Consequences, and Rejected Alternatives

### 12.1 Rationale

- **Topological invariance.** Mandatory interposition removes structural divergence between ruled and unruled runs. That is what preserves prompt caches and what makes rule changes evaluable as ordinary pin substitutions.
- **Early shape validation.** Exhaustive freeze admission rejects illegal branch shapes before execution, while atomic runtime checks separately defend against changed scope state, expired reservations, and unresolved external attempts. Neither substitutes for the other.
- **Separation of concerns.** Rigid policy executes deterministically without hallucination risk, and transaction failures are contained by protocol recovery rather than ad-hoc replanning.

### 12.2 Consequences

A router adds three event rows per thought junction (`vertex/created`, `vertex/started`, `vertex/succeeded`). Whenever a rule matches, an entire model call, its token cost, and its `budget/charged` event disappear, so both cost and log volume fall net of that addition. The freeze that introduces a router pays `N × M` shape checks, and a template catalogue large enough to need pruning depends on the capability envelope being derived correctly at publication.

### 12.3 Rejected alternatives

- **Publish rule templates through `gatewayd` alongside tool contracts.** Superficially symmetric — both are versioned, content-addressed contracts — but it splits planning authority across a service boundary. A template's branches are sub-DAG proposals, so admitting one means running `checkSubDag`, which is Engine code and must stay the single admission implementation; the gateway would either reimplement it or publish templates it cannot judge. It would also make the gateway append to the event log, which its whole boundary is built to avoid ([09 §1](./09-tool-registry-gateway.md#1-purpose-and-boundary)). The gateway publishes the tool view; the Engine publishes what plans with it.
- **Let the router infer its own scope at runtime.** A router has no side effects and cannot make transaction-structure judgements, and runtime inference bypasses the template-declared widening channel of [02 §3.2](./02-transaction-model.md#32-layer-2--the-planner-may-widen-never-narrow).
- **Force upstream scopes closed at a join, creating an artificial savepoint.** Sealing a try means the resource is held but unconfirmed. Committing early destroys reservation semantics — decrementing inventory before knowing whether payment succeeds — and prematurely raises the backtrack floor.
- **Insert routers only where rules exist.** Rule attachment would become a structural DAG change, destroying prompt-cache stability and making counterfactual A/B evaluation by pin substitution impossible.
- **Have planners emit router vertices.** This violates "computed, never asked of the planner" ([02 §3.1](./02-transaction-model.md#31-layer-1--the-engine-computes-the-minimum-scope)) and moves mechanical syntax obligations into prompts. Human SOP authors and template sub-DAGs may declare routers explicitly; planners stay pure.
- **Lazily materialize downstream planners as replan anchors for failed branches.** This assumes a model should recover from deterministic policy failure, which is the audit violation the role exists to prevent.
- **Rely purely on runtime check-rule interception.** Detecting an illegal shape only after execution can leave irreversible work with no legal continuation.
- **Harden runtime interception instead of moving detection earlier.** Runtime checks cannot undo a captured payment and cannot replace early shape validation. Both gates are required, and an unresolved external outcome suspends for recovery rather than triggering speculative rollback.

## 13. Open Questions

- Slot-collision policy when two templates are registered for one `SlotId` across workflow types that hash identically: currently a publication-time refusal, but no rebinding or migration path is specified.
- Whether nested routers should bound their own depth, and where that bound belongs — registration admission or freeze admission.
- Match-rate thresholds that should trigger an automatic governance review rather than a dashboard reading (§10).
- How a branch declares that it joins its placement's scope instead of opening one (§4.1). Without it no side-effecting template is admissible at an `inside_scope` placement, so the two legal join shapes reduce in practice to the read-only one.
- Branch inputs. A branch names tools but binds no parameters, so an emitted vertex carries an empty input until the template language gains a way to reference upstream output.
