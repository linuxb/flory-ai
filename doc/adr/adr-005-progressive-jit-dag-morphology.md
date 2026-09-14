# ADR-005: Progressive JIT-DAG Workflow Morphology and Deterministic Routers

## Status
Proposed

## Context
Flory is fundamentally an engine for executing **Progressive JIT-DAG Workflows**. Users submit an initial workflow to Flory, which can range from a multi-vertex DAG combining deterministic tools and probabilistic AI steps to a single planner vertex. The workflow progressively unfolds just-in-time (JIT) through recursive generation: planners and routers JIT-generate sub-DAGs of tool callers and further downstream planners/routers.

In high-throughput e-commerce production (e.g., 300k+ customer service and order workflows at 1k TPS), many workflow transitions are purely deterministic (e.g., "if `order.lookup` status is Shipped, execute `logistics.track`"). Invoking an LLM Planner to evaluate such deterministic conditional transitions introduces three major defects:
1. **Unnecessary Latency:** LLM inference adds 500ms–3000ms delay to a transition that can be evaluated in microseconds.
2. **Cost:** Wastes token budget on decisions that do not require probabilistic reasoning.
3. **Reliability & Hallucination Risk:** Introduces probabilistic drift and hallucinations into rigid, audited business rules.

However, introducing deterministic routing into a transactional JIT-DAG engine poses severe architectural challenges:
- **Transaction Safety & Late Detection:** If a router standing after a committed payment (pivot) evaluates a buggy rule at runtime and emits a shape-illegal sub-DAG (e.g., violating single-pivot rule R3), runtime interception occurs *after* money has moved and the proposing planner has fallen below the backtrack floor.
- **Deterministic Dead-End Trap:** If a deterministic rule execution fails, delegating recovery to an LLM planner creates critical audit and financial safety violations (e.g., an LLM making up an unapproved refund workaround).
- **Scope Ambiguity:** A router has no side effects, so inheriting or opening transaction scopes at join points must be mechanically derived without ambiguity.

We need a deterministic branching mechanism that integrates seamlessly into Flory's JIT-DAG ReAct loop, preserves exact transaction boundaries, and prevents late-detected configuration deadlocks.

## Proposed Decision

Introduce a new first-class vertex role: **`router`** (Deterministic Router Node).

### 1. Dual-Track Router Topology and Mandatory Interposition (R14)
A router (`router`) is a first-class deterministic vertex that evaluates upstream tool output
summary fields and dynamically instantiates an execution sub-DAG without LLM invocation.
Routers enter the progressive JIT-DAG through two complementary tracks:

1. **Explicit DAG Declaration (Direct Content-Addressed SOPs):**
   In enterprise SOP workflows, pure deterministic pipelines (`tool -> router -> tool`), or
   nested sub-DAG templates, workflow authors declare a `router` vertex directly in the proposal,
   explicitly pinning its published template:
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
   - **$O(1)$ Direct Resolution:** Eliminates template matching overhead and signature collision
     across large catalogs (1,000+ templates). The router binds directly to the content-addressed
     URI/digest.
   - **Pure Deterministic Pipelines:** Enables multi-step deterministic branching without
     requiring an artificial downstream LLM planner.
2. **Automatic Engine Interposition (Dynamic ReAct Thought Interception):**
   When an LLM planner dynamically proposes a sub-DAG where a tool-caller connects directly to a
   downstream planner, the engine normalizes the graph by automatically interposing a router:
   ```
   [tool-a, tool-b, …]  →  [router]  →  [planner]      (Structural fall-through on no_match)
                               │
                               └─ rule matched → emit deterministic sub-DAG branch, zero model calls
   ```
   - **R14 (Router Topology Invariant):** *No tool-caller vertex may have a planner vertex as a
     direct successor.* Every such edge must carry a router. If not explicitly supplied, the
     engine normalizes the graph by interposing one. This keeps the LLM's action vocabulary pure
     while ensuring business policies can intercept execution.
3. **Authority Bounded:** A router's authority is a strict subset of the planner's. It can only emit
   sub-DAG proposals that a planner could legally propose.

### 2. Declarative Rule Configuration, Dual Binding Resolution, and Template Diff Events
A rule configuration is strictly declarative, consisting of an ordered list of
`(condition, sub_dag_template)` pairs:
- **Condition:** A pure boolean predicate evaluating upstream tool output summary fields
  (e.g., `tool-a.output.risk_score < 30`). No blob dereferencing, no clock reads, no network I/O.
- **Execution Sub-DAG:** The sub-DAG to instantiate upon match. Sub-DAGs may contain tool callers,
  confirmation barriers, nested routers, or downstream planners.

**Dual Binding Resolution:**
Binding resolves out-of-band and never passes through an LLM:
1. **Explicit Reference:** If the vertex declares `template_ref`, the engine fetches the pinned
   contract directly from `gatewayd` in $O(1)$ time by URI and content digest.
2. **Slot-Based Dynamic Resolution:** If the router is auto-interposed on an unpinned edge, the
   template resolves via its stable topological coordinate:
   $$\text{SlotId} = \text{Hash}(\text{workflow\_type} + \text{sorted}(\text{upstream\_tool\_types}) + \text{target\_planner\_template})$$
   If no template is registered for that `SlotId`, the router acts as a transparent pass-through
   (`no_match`).

**Template Versioning and Audit Diff Events (`rule_template/published`):**
To guarantee zero-loss historical replayability, template mutations are recorded as first-class events:
- Whenever a rule template is published, updated, or bound, `gatewayd` appends a
  `rule_template/published` event to the configuration stream.
- The event captures the structural diff against the predecessor version (e.g., RFC 6902 JSON Patch),
  the resulting content digest, author metadata, and optional slot coordinates.
- **Time-Travel Replay Fidelity:** Recording diff events ensures that for any historical execution
  or counterfactual fork, the engine can reconstruct the exact template definition bound to any
  router at timestamp $T$. Replay tests remain 100% reproducible without relying on external,
  mutable registry databases.

### 3. Invariant DAG Topology and First-Class Fork A/B Evaluation
Mandatory interposition and explicit router pinning guarantee that attaching or updating a rule does
not alter the physical topology of the DAG:
- Attaching or updating a rule changes only which template version the router **pins**.
- This satisfies Doc 01 §5.3: changing a rule is mechanically identical to changing a model pin.
  Counterfactual evaluation ("What would have happened on Order #12345 if this junction had pinned v3
  instead of v2?") becomes an ordinary fork replay evaluated with standard `surface-identity` and
  `cost-delta` evaluators (Doc 05 §3.1).

### 4. Derived Placement, Multi-Scope Joins, and Sweeper Fencing
Routers have no side effects and are never scope members. Their transaction placement is derived mechanically by the engine from the ancestor graph at freeze time:
- `at_savepoint`: All ancestor scopes are closed. Any branch emitted by the router opens a fresh transaction scope.
- `inside_scope(S)`: An ancestor scope `S` remains half-open (a try is sealed but unconfirmed). The emitted branch joins `S`.

**Multi-Scope Join & Parallel Branch Invariants:**
When a router acts as a join node over parallel branches, freeze admission evaluates the router's pinned rule template against upstream scope membership:
1. **Pre-Declared Common Scope for Atomicity:** If any branch in the router's rule template emits a pivot or joins an open scope, all parallel branches that execute tries intended to be atomic with that pivot **must be declared upfront as members of the same common scope $S$** (Doc 02 R3 natively supports parallel branches within one scope). A `confirmation-barrier` vertex precedes the router to ensure all parallel tries of $S$ reach the `sealed` state. The router then evaluates unambiguously as `inside_scope(S)`. Flory defines no ad-hoc runtime "scope-merge" protocol; atomicity across parallel branches must be declared at graph freeze time.
2. **Disjoint Scope Isolation:** If parallel branches belong to distinct, uncoordinated scopes ($S_1 \ne S_2$), they **must commit or close before reaching the router join** if the router emits a pivot (since a single pivot cannot bind two independent scopes). Joining distinct open scopes is admitted *only* if the router's rule template is purely read-only (all branches have `effect_class: none`), where the router reads outputs without binding to either transaction scope.

**Runtime Sweeper Fencing and Unresolved Attempts:**
Branch admission, worker claims, and cancellation serialize through the same scope row. A lease grants temporary worker ownership; expiry does not prove that an external request stopped or that its effect is absent.

1. **Atomic Admission and Claims:**
   - Acquire locks in the order `txn_scope FOR UPDATE`, then `work_queue FOR UPDATE SKIP LOCKED`. Candidate discovery must not lock the queue before the scope. Branch admission checks `state = 'open'`, rejects expired sealed tries, and appends the branch and queues its work in that same transaction.
   - A worker checks the scope state and establishes its bounded lease in one transaction. If cancellation wins first, ordinary queued work cannot be claimed; if claiming wins first, the live lease blocks sweeper cancellation.
   - Claim eligibility depends on the operation's frozen phase, not merely on the existence of a scope:

     | Work | Eligible scope state |
     |---|---|
     | New pre-pivot member work | `open` |
     | Already-admitted post-pivot forward work | `pivot-passed`; also `committed` if the frozen graph permits work after confirmation |
     | Confirm or forward-recovery operation | The existing Coordinator recovery path; never a new pre-pivot claim |
     | Cancel or compensate | `cancelling`, through the existing cancellation-member queue |
     | Unscoped read | No scope lock; retain the existing executor ownership rule |

   - `pivot-inflight` is reserved for the admitted pivot and its outcome-resolution path. `suspended` blocks automatic business dispatch until explicit recovery. Ordinary work cannot run in `cancelling` or `cancelled`. Claim eligibility does not replace parent-dependency checks, pivot admission, or the prohibition on backward compensation after a pivot.

2. **Durable Attempt Evidence:**
   Before sending a side-effecting request, the Coordinator records its attempt identity, idempotency key, and start durably while validating scope state and lease ownership under the scope lock. An attempt remains unresolved until a definitive outcome is recorded. Queue deletion, lease expiry, or a transport timeout must never erase or resolve this evidence. A recorded start with no recorded outcome is conservatively unresolved, even if the worker may have crashed before sending.

3. **Expiry Means Reconcile or Suspend:**
   - Leases remain finite. On expiry, do not assume that the external operation has stopped and do not automatically redispatch an unresolved side-effecting attempt.
   - Under the scope lock, the sweeper rechecks the expired sealed try, scope state, live leases, and unresolved attempts. If there is a live lease, it defers cancellation. If an attempt is unresolved, it preserves the queue and attempt evidence, records suspension, and escalates to L4. Suspension preserves pivot-admission and pivot-passage evidence; it never clears the no-cancel fence. The existing registered pivot status-query recovery remains the exception: it may establish occurrence or absence before deciding the next action.
   - For an unresolved non-pivot attempt, this proposal adds no new automatic reconciliation protocol. An operator must establish the final external outcome and ensure the old request cannot later create another effect before authorizing recovery. A transient “not found” response is insufficient while the original request may still arrive. Late worker results may be retained as evidence, but do not authorize new dispatch, automatic unsuspension, or omission of cleanup.
   - Only an `open` scope with an expired sealed try, no live execution lease, and no unresolved side-effecting attempt may automatically enter cancellation. The Coordinator atomically appends `txn/cancel (requested)` and removes pending ordinary work, retaining attempt history and all recorded effects needed for cancellation. Post-pivot states never take this path.

This conservative policy deliberately trades automatic cleanup for explicit intervention when an external outcome is unknown. It avoids adding downstream fencing tokens while preventing lease expiry from being mistaken for proof that cancellation is safe.

**Required Verification Cases:**
- Cancellation wins before claim: no member adapter call starts. Claim wins first: the live lease prevents cancellation.
- A request is delayed beyond lease expiry: the scope suspends, evidence remains, and neither automatic cancellation nor redispatch occurs. A late success remains visible for recovery.
- Payment has passed its pivot: already-admitted forward work can still be claimed, while pre-pivot work and backward cancellation remain blocked.

**Scope Widening:** By default, the engine derives the minimum required scope based on tool footprint intersection (Doc 02 §3.1). When business atomicity requires binding unrelated footprints together (e.g., deducting company balance and updating ERP stock in a Supplier Procurement flow), the human-authored rule template can explicitly declare a widened `txn/scope` (Doc 02 §3.2 workflow policy). Widening beyond the minimum is legal; narrowing below it is rejected by R11.

### 5. Downstream Planner Topology & Strict Transaction Failure Semantics
In enterprise workflows, the downstream planner is a legitimate, declared stage in the workflow pipeline (e.g., `Tool-A -> Router -> Tool-B -> Planner`). The router deterministically selects the branch condition feeding into subsequent human/AI review.

**Strict Failure Semantics (No LLM Replanning on Deterministic Failures):**
When a router matches a deterministic branch and downstream tools execute, errors are strictly governed by the distributed transaction protocol (Doc 02 §1, Doc 07 §2.3):
- **Never Replan with an LLM on Deterministic Failures:** A deterministic rule represents rigid business policy. If a deterministic tool fails, allowing an LLM planner to "replan" and invent an ad-hoc workaround (e.g., issuing unapproved discount coupons when payment gateway times out) violates financial and audit compliance.
- **Pre-Pivot Failure:** A definitive failure before the pivot permits scope cancellation (TCC Cancel / Saga compensation) once §4 establishes that no member attempt remains unresolved. An unknown outcome instead requires reconciliation or suspension.
- **Post-Pivot Failure:** If a tool fails *after* a pivot has passed (e.g., payment succeeded, but warehouse notification timed out), **cancellation is strictly prohibited**. The database trigger `check_pivot_pass` and coordinator state machine reject any cancel event. The coordinator enforces idempotent forward recovery (retries).
- **Terminal Escalation to L4 (Separated by Pivot Boundary):** If retries are exhausted or an unrecoverable failure occurs on a deterministic path:
  - *If Pre-Pivot:* Cancel the scope only when §4 permits it, then halt to **L4 (Human Intervention)**. If any member outcome remains unresolved, suspend with its evidence and reservations preserved instead.
  - *If Post-Pivot:* **No rollback is attempted**. The run halts and suspends with all committed state and unconfirmed tries preserved, escalating to **L4** for operator-assisted forward completion or manual ledger reconciliation.
  - *If Pivot Outcome is Unknown (e.g., network timeout during pivot call):* The coordinator does **not** immediately halt to manual intervention. It executes automatic recovery via the pivot's registered `status_query` operation (Doc 07 §3.3, `processPivot`) using its frozen retry policy. If the status query confirms execution occurred, it proceeds to `txn/pivot-passed`; if it confirms execution did not occur, the guarded cancellation path is safely permitted. Only if the status query itself fails or remains unresolved does the scope suspend to **L4**. Cancellation is strictly prohibited while the outcome remains indeterminate.

**Downstream Planner Lifecycle:**
- If the router branch connects to the downstream planner, the planner runs normally when upstream dependencies complete.
- If the router selects an early-exit terminal branch, the downstream planner is cleanly shadowed (`subgraph/shadowed`).
- If no rule condition matches (`no_match`), the router passes through to the downstream planner as the default decision maker.

### 6. Three Lines of Defense

Safety is enforced through three distinct gates:

| Gate | Timing | Responsibility |
|---|---|---|
| **Registration** | Template publish time | Validates condition field syntax, resolves tools in catalog, verifies branch shapes in isolation (Q1–Q6). |
| **Freeze Admission** | Proposal freeze time (pre-execution) | Runs **Exhaustive Admission** over all branches $\times$ placements under topological stability invariants. |
| **Structural Fall-Through** | Router evaluation time | Handles `no_match` by passing control to the downstream planner. |

#### 6.1 Registration Admission (Q1–Q6)
Rule templates are published, content-addressed, immutable contracts in `gatewayd`:
- **Q1:** Conditions reference only **summary fields** of upstream payloads. No blob dereferencing, no clock reads, no network I/O.
- **Q2:** Every tool referenced by every branch resolves inside a published tool view with a known `effect_class`.
- **Q3 (Multi-Dimensional Capability Envelope & Branch Traits):** The template metadata is derived mechanically upon publication to prevent branch heterogeneity from being erased:
  - **Template-Level Capability Envelope:** Used for $O(1)$ fast-path pruning at slot binding: `max_effect_class`, `can_open_scope`, `can_provide_pivot`, and `is_pure_read_only`.
  - **Branch-Level Morphological Traits:** Preserved for Gate 2 exhaustive admission: `branch[i].opens_scope`, `branch[i].has_pivot`, and `branch[i].max_effect`.
- **Q4:** Each branch sub-DAG independently passes `checkSubDag` in isolation.
- **Q5:** Conditions are totally ordered with first-match semantics.
- **Q6:** Fall-through to the downstream planner on `no_match` is structural; no explicit fallback declarations are allowed.

#### 6.2 Freeze-Time Exhaustive Admission & Complexity Analysis
The core vulnerability of deterministic rules is **late detection**: discovering an invalid branch after an irreversible pivot has already passed. The fix is to move detection to freeze time, before any tool executes.

**Exhaustive Admission Algorithm & Topological Preconditions:**
At the freeze introducing the router, the engine runs `checkSubDag` over:
$$\text{Total Verifications} = N \text{ (branches)} \times M \text{ (reachable placements)}$$
against this run's actual role-scoped tool view and existing-scope snapshot.

**Static Placement and Runtime Validity:**
Freeze admission validates each branch against its declared placement and the existing-scope snapshot. A slot with one fixed placement requires `N` branch checks; a supported topology with multiple placements requires every relevant combination. Parent success does not establish that a scope is still open or that a reservation is unexpired. Cancellation never converts an `inside_scope(S)` branch into a fresh transaction at a savepoint.

Static checks reject illegal shapes before execution. Runtime admission still performs the atomic checks in §4 and may reject a previously shape-valid branch because transaction state changed. The checks have different responsibilities; freeze admission does not guarantee zero runtime rejection. Its cost depends on branch count and graph size, while runtime fencing also requires a database transaction.

**Refined Check-Rules R12 & R13:**
- **R12 (Placement & Scope Invariants):**
  - *Inside Scope (`inside_scope(S)`):* A branch must not declare `opens_scope` (an open scope is not a savepoint; nesting or starting independent scopes inside half-open tries violates Doc 02 §4.1). If a branch emits a pivot (`has_pivot = true`), it is rejected if scope $S$ already contains a pivot (Doc 02 R3 across freezes); if scope $S$ has no pivot yet, the branch is admitted, joining $S$ as its unique commit point.
  - *At Savepoint (`at_savepoint`):* A branch may declare `opens_scope` (JIT-generating a fresh scope at this savepoint). Any branch with side effects (`max_effect ≠ 'none'`) must declare a scope or receive an engine-computed minimum scope (Doc 02 R10).
- **R13:** An `at_savepoint` router must not have unclosed ancestor scopes; its tools must exist in the run's role-scoped view; and condition field paths must statically resolve against upstream tool output schemas.
- **Engine Requirement:** `engine/src/check-rules.ts` must accept a third parameter: an immutable snapshot of existing scope states (`existing_scope_snapshot`).

**Multi-Dimensional Tag Pruning & Freeze Admission Logic:**

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

/** Gate 1: Fast O(1) template catalog pruning against slot context. */
function fastPruneTemplate(cap: TemplateCapability, slot: SlotPlacementContext): boolean {
    if (slot.is_read_only_context && !cap.is_pure_read_only) {
        return false; // Reject side-effect templates on read-only simulation forks
    }
    if (slot.placement === 'inside_scope' && cap.can_open_scope && !cap.can_provide_pivot && !cap.is_pure_read_only) {
        return false; // Cannot open fresh scopes inside an active half-open scope
    }
    if (slot.placement === 'inside_scope' && (slot.active_scope?.pivot_count ?? 0) > 0 && !cap.is_pure_read_only) {
        if (!cap.can_open_scope && cap.can_provide_pivot && cap.max_effect_class === 'irreversible') {
            return false; // Reject if scope already has a pivot and template only provides pivots
        }
    }
    return true;
}

/** Gate 2: Freeze-time exhaustive branch-level admission check. */
function checkFreezeAdmission(
    branches: BranchTraits[],
    slot: SlotPlacementContext,
    existing_scopes: ScopeSnapshot[],
): CheckResult {
    const violations: CheckViolation[] = [];

    for (let i = 0; i < branches.length; i++) {
        const b = branches[i];

        // Guard against side-effects in read-only contexts (e.g. offline forks)
        if (slot.is_read_only_context && b.max_effect !== 'none') {
            violations.push({rule: 'R10', message: `Branch ${i} emits side-effects in read-only slot`, vertices: []});
            continue;
        }

        // Refined R12: Placement-specific scope invariants
        if (slot.placement === 'inside_scope') {
            if (b.opens_scope) {
                violations.push({
                    rule: 'R12',
                    message: `Branch ${i} cannot open fresh scope inside active scope`,
                    vertices: [],
                });
            }
            if (b.has_pivot) {
                if ((slot.active_scope?.pivot_count ?? 0) > 0) {
                    violations.push({
                        rule: 'R3',
                        message: `Branch ${i} introduces duplicate pivot in scope`,
                        vertices: [],
                    });
                }
                // If active_scope.pivot_count === 0: Admitted! Branch supplies S's pivot.
            }
        } else {
            // at_savepoint: Side-effect nodes must be bounded by a scope (Doc 02 R10).
            // If the branch did not explicitly declare opens_scope, the engine auto-synthesizes
            // the minimum required scope based on tool footprints (Doc 02 §3.1 Layer 1).
            if (b.max_effect !== 'none' && !b.opens_scope) {
                const autoScope = synthesizeMinimumScope(b.sub_dag, slot.role_tool_view);
                if (!autoScope) {
                    violations.push({
                        rule: 'R10',
                        message: `Branch ${i} side-effect node lacks declared scope and cannot derive minimum scope`,
                        vertices: [],
                    });
                } else {
                    b.sub_dag.scopes.push(autoScope);
                }
            }
        }

        // Exhaustive checkSubDag call over branch sub-DAG
        const subResult = checkSubDag(b.sub_dag, slot.role_tool_view, existing_scopes);
        if (!subResult.accepted) {
            violations.push(...subResult.violations);
        }
    }

    return {accepted: violations.length === 0, violations};
}
```

#### 6.3 Closed Outcome Vocabulary
Router evaluation produces one of four mutually exclusive outcomes:
1. `matched(i)`: Emits the matched branch sub-DAG. Downstream planner is shadowed if branch is terminal.
2. `no_match`: Structural fall-through. Control passes directly to the downstream planner.
3. `evaluation_error`: Fatal runtime error (e.g., malformed field path). Raises an operational alert and halts to L4.
4. `proposal_rejected`: Runtime scope or reservation checks reject an otherwise statically checked branch. Append `vertex/failed` with the rejection reason; do not publish runnable branch work or fall through to an LLM planner. Leave transaction cleanup or suspension to the Coordinator under §4. Illegal static shapes are rejected at freeze time before router execution.

### 7. Prompt Invisibility in Context Reduction
To preserve prompt cache stability and prevent noise:
- If a router **matches**, `linearize` includes the matched condition string to explain why the emitted branch exists.
- If a router **falls through** (`no_match`), it is completely invisible in the linearized prompt. The downstream planner receives a byte-identical context to classic ReAct execution.

### 8. Runtime Execution and Event Lifecycle
- **Executor Class:** Routers are executed directly by the TypeScript Engine synchronously upon parent completion. They call no tools and hold no brackets. A third executor class (`router`) is added to `flory_executor_class` in PostgreSQL. Routers are not queued in `enqueue_vertex_work`.
- **Strict Event Trajectory:** Routers emit `vertex/started` followed immediately by `vertex/succeeded` (with `{matched_condition}`) or `vertex/failed`. Skipping `vertex/started` is strictly prohibited to maintain state-machine monotonicity for TLA+ models and Coordinator trace validators.
- **Log-Fields Schema:** To avoid blob I/O during pure router evaluation, tool contracts declare a `log-fields schema`. The Go Coordinator extracts control-flow fields (status codes, scores) directly into `vertex/succeeded`, while streaming raw bulk data to blob storage. Routers evaluate strictly against in-event payloads.

### 9. Governance and Match-Rate Telemetry
Rule templates are versioned, published contracts. Per-rule match rates must be folded from the event log as first-class operational metrics (Doc 05 §4.2):
- A rule matching ~100% of the time indicates the junction never needed a planner and should be inlined into a static pipeline.
- A rule whose condition list grows excessively indicates rules are being substituted for intelligent thought, signaling the junction should revert to an LLM planner.

---

## Worked Example: Post-Sale Return Workflow (Order #12345)

### Step 0 — Registration of `rule://return-routing@v3`
An enterprise SOP rule is published with two conditions:
1. `risk.score < 30 && order.amount <= 200` $\to$ `refund.issue` (pivot)
2. `risk.score < 30 && order.amount > 200` $\to$ `inventory.reserve_slot` (TCC try) $\to$ `refund.issue` (pivot)
3. Otherwise $\to$ no match (structural fall-through)

Q1–Q5 pass: conditions reference declared schema fields; branches are shape-legal; derived capability envelope is `{max_effect_class: 'irreversible', can_open_scope: true, can_provide_pivot: true, is_pure_read_only: false}`. Published with content digest.

### Step 1 — Proposal and Freeze-Time Exhaustive Admission
Planner `P1` (intake) proposes `order.lookup` $\to$ `risk.score` $\to$ `P2` (negotiation planner).
- The engine normalizes the graph by interposing `R1` between the read tools and `P2`.
- Slot identity resolves `rule://return-routing@v3` into `R1`.
- Derived placement: ancestors are read-only tools, so `at_savepoint`.
- **Exhaustive Admission:** Engine checks Branch 1, Branch 2, and fall-through under `at_savepoint`. Tools exist in role view, schemas match, transaction shapes valid. Graph freezes cleanly.

### Step 2 — Happy Path (Microsecond Zero-LLM Execution)
Reads complete with `risk.score = 12` and `amount = 350`.
- Engine evaluates `R1`: Condition 2 matches.
- Engine appends `subgraph/proposed` for `T4` (reserve slot) and `T5` (refund issue), opening fresh scope `S2`.
- `checkSubDag` admits instantly $\to$ `vertex/succeeded {matched_condition: 2}`.
- Zero LLM calls required. Downstream planner `P2` is shadowed. Coordinator completes `T4` try $\to$ `T5` pivot $\to$ confirms `T4`.

### Step 3 — Structural Fall-Through (`no_match`)
Reads return `risk.score = 75` (high risk).
- Engine evaluates `R1`: no condition matches (`no_match`).
- `R1` records `vertex/succeeded {matched_condition: null}`.
- Control cleanly falls through to `P2` (negotiation planner). `R1` is omitted from `P2`'s prompt context, leaving it byte-identical to standard ReAct execution.

### Step 4 — Deterministic Branch Failure Leads to L4 (No LLM Replan)
Assume Branch 2 executed, but `T4` (reserve slot) permanently fails due to inventory service outage.
- Coordinator cancels scope `S2`, releasing reserved resources back to `R1`'s savepoint.
- Backtracking to `P1` is illegal if a prior pivot passed (below backtrack floor).
- Re-planning via `P2` is strictly forbidden: `T4` was emitted by a deterministic business rule, not an AI plan. Allowing an LLM to invent an alternative would breach audit rules.
- **The workflow cleanly halts and escalates to L4 (Human Intervention)** with full causal postmortem. No double-charges occur; funds and inventory remain protected.

### Step 5 — Freeze-Time Detection of Configuration Defects
Suppose the run is authorized under role `junior-agent`, which lacks permission for `refund.issue`.
- During `P1`'s freeze, R13 detects that Branch 1 and 2 reference unauthorized tools.
- Exhaustive admission rejects the proposal **before `P1` freezes and before any tool runs**.
- `P1` receives the violation at a point where no pivots have passed, allowing the LLM to safely replan an alternative inquiry path.

---

## Rationale
- **Mathematical Invariance:** Mandatory interposition eliminates structural graph divergence between ruled and unruled runs, preserving prompt caches and enabling fork-based counterfactual evaluation.
- **Early Shape Validation:** Exhaustive freeze admission rejects illegal branch shapes before execution. Atomic runtime checks separately protect against changed scope state, expired reservations, and unresolved external attempts.
- **Strict Separation of Concerns:** Rigid business policies execute deterministically without LLM hallucination risk, while transaction failures are contained by protocol rollback rather than ad-hoc model replanning.

## Consequences
- **Log Volume:** Adds 3 event rows per thought junction (`vertex/created`, `vertex/started`, `vertex/succeeded`). However, whenever a rule matches, an entire model call, its token overhead, and its `budget/charged` events are eliminated, resulting in a net cost and log reduction.
- **Codebase Updates:**
  - `engine/src/check-rules.ts`: Implements R12, R13, R14, and accepts the third `existing_scope_snapshot` parameter.
  - `db/migrations/`: Extends `flory_executor_class` enum with `router`.
  - `idl/event-log.schema.json`: Adds `router` to `vertexCreatedPayload` role union, and adds `rule_template/published` diff event schema.

---

## Rejected Alternatives

### 1. Let the Router Infer Its Own Scope Dynamically
*Why rejected:* A router has no side effects and cannot make transaction structure judgments. Bypasses template-declared widening required by Doc 02 §3.2.

### 2. Force Upstream Scopes Closed at Join (Artificial Savepoint)
*Why rejected:* In TCC, sealing a try means the resource is locked but unconfirmed (half-open). Forcing a commit early destroys reservation semantics (e.g., decrementing inventory before knowing if payment succeeds) and prematurely raises the backtrack floor.

### 3. Optional Routers (Inserted Only When Rules Exist)
*Why rejected:* Makes rule attachment a structural DAG change. Destroys prompt-cache stability and prevents counterfactual A/B evaluation via pin substitution.

### 4. Have LLM Planners Emit Router Vertices
*Why rejected:* Violates Doc 02 §3.1 ("computed, never asked of the planner"). Forces mechanical syntax obligations onto LLM prompts that the engine can derive deterministically. Human SOP authors and template sub-DAGs may explicitly declare routers via `template_ref`, but LLM planners are kept pure.

### 5. Lazily Materialize Downstream Planners to Serve as Replan Anchors
*Why rejected:* Assumes deterministic branch failures should be replanned by LLMs. Allowing an LLM to invent workarounds around failed deterministic policy is a critical audit violation. Deterministic failures must rollback and escalate to L4.

### 6. Rely Purely on Runtime Check-Rule Interception
*Why rejected:* Detecting an illegal rule shape only after execution may leave irreversible work without a valid continuation. Validate static shapes at freeze time and retain runtime fencing for mutable transaction state.

### 7. Harden Runtime Interception Instead of Moving Detection Earlier
*Why rejected:* Runtime checks cannot undo a captured payment or replace early shape validation. Both freeze-time validation and atomic runtime admission are required; unresolved external outcomes suspend for recovery rather than triggering speculative rollback.
