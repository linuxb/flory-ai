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

### 1. Fixed Slot and Mandatory Engine Interposition (R14)
A router is a **deterministic short-circuit around the ReAct thought step**. It is not an arbitrary peer of the planner; its topological slot in the DAG is fixed between a set of tool-callers and the downstream planner that would otherwise re-think their results:

```
[tool-a, tool-b, …]  →  [router]  →  [planner]      (Structural fall-through on no_match)
                            │
                            └─ rule matched → emit deterministic sub-DAG branch, no model call
```

- **R14 (New Check-Rule, Pure Topology):** *No tool-caller vertex may have a planner vertex as a direct successor.* Every such edge must carry a router.
- **Engine Normalization:** The planner does not propose router vertices, nor does a user declaring an initial DAG need to hand-roll them. The engine automatically interposes routers when normalizing the frozen graph. This keeps the model's vocabulary unchanged and enforces R14 as a frozen graph invariant.
- **Authority Bounded:** A router's authority is a strict subset of the planner's. It can only emit sub-DAG proposals that a planner could legally propose.

### 2. Declarative Rule Configuration, Slot Identity, and Template Diff Events
A rule configuration is strictly declarative, requiring only an ordered list of `(condition, sub_dag_template)` pairs:
- **Condition:** A pure boolean predicate evaluating upstream tool output summary fields (e.g., `tool-a.output.risk_score < 30`).
- **Execution Template:** The sub-DAG to instantiate when the condition matches.

Rule binding is completely out-of-band and never passes through an LLM:
- **Slot Identity:** A template is bound to a stable topological slot coordinate:
  $$\text{SlotId} = \text{Hash}(\text{workflow\_type} + \text{sorted}(\text{upstream\_tool\_types}) + \text{target\_planner\_template})$$
- At freeze time, the engine resolves the rule template assigned to the slot and freezes its immutable content-addressed pin and digest (e.g., `rule://refund-routing@v3`) into the router's `vertex/created` event payload.
- No redundant fallback planner references are declared in the rule: falling through to the downstream planner on `no_match` is structural.

**Template Versioning and Audit Diff Events (`rule_template/published`):**
To guarantee zero-loss historical replayability, template mutations are recorded as first-class events:
- Whenever a rule template is created, updated, or bound to a slot, the system appends a `rule_template/published` event to the configuration stream.
- The event payload captures the structural diff against the predecessor version (e.g., RFC 6902 JSON Patch), the resulting content digest, author metadata, and the associated `SlotId`.
- **Time-Travel Replay Fidelity:** Recording diff events ensures that for any historical execution or counterfactual fork, the engine can reconstruct the exact template definition bound to any slot at timestamp $T$. Replay tests remain 100% reproducible without relying on external, mutable registry databases.

### 3. Invariant DAG Topology and First-Class Fork A/B Evaluation
Mandatory interposition guarantees that attaching or updating a rule does not alter the physical topology of the DAG:
- With mandatory interposition, attaching a rule changes only which template version the router **pins**.
- This satisfies Doc 01 §5.3: changing a rule is mechanically identical to changing a model pin. Counterfactual evaluation ("What would have happened on Order #12345 if this junction had pinned v3 instead of v2?") becomes an ordinary fork replay evaluated with standard `surface-identity` and `cost-delta` evaluators (Doc 05 §3.1).

### 4. Derived Placement and Scope Semantics
Routers have no side effects and are never scope members. Their transaction placement is derived mechanically by the engine from the ancestor graph at freeze time:
- `at_savepoint`: All ancestor scopes are closed. Any branch emitted by the router opens a fresh transaction scope.
- `inside_scope(S)`: An ancestor scope `S` remains half-open (a try is sealed but unconfirmed). The emitted branch joins `S`.

**Scope Widening:** By default, the engine derives the minimum required scope based on tool footprint intersection (Doc 02 §3.1). When business atomicity requires binding unrelated footprints together (e.g., deducting company balance and updating ERP stock in a Supplier Procurement flow), the human-authored rule template can explicitly declare a widened `txn/scope` (Doc 02 §3.2 workflow policy). Widening beyond the minimum is legal; narrowing below it is rejected by R11.

### 5. Downstream Planner Topology & Strict Transaction Failure Semantics
In enterprise workflows, the downstream planner is a legitimate, declared stage in the workflow pipeline (e.g., `Tool-A -> Router -> Tool-B -> Planner`). The router deterministically selects the branch condition feeding into subsequent human/AI review.

**Strict Failure Semantics (No LLM Replanning on Deterministic Failures):**
When a router matches a deterministic branch and downstream tools execute, errors are strictly governed by the distributed transaction protocol:
- **Never Replan with an LLM on Deterministic Failures:** A deterministic rule represents rigid business policy. If a deterministic tool fails, allowing an LLM planner to "replan" and invent an ad-hoc workaround (e.g., issuing unapproved discount coupons when payment gateway times out) violates financial and audit compliance.
- **Pre-Pivot Failure:** If a tool fails before passing the pivot, the coordinator immediately triggers scope cancellation (TCC Cancel / Saga compensation) to cleanly roll back held resources.
- **Post-Pivot Failure:** If a tool fails after a pivot has passed, the coordinator enforces idempotent forward recovery (retries).
- **Terminal Escalation to L4:** If retries are exhausted or an unrecoverable failure occurs on a deterministic path, the workflow halts, scopes are rolled back, and it immediately escalates to **L4 (Human Intervention)**. It never backtracks to an LLM planner.

**Downstream Planner Lifecycle:**
- If the router branch connects to the downstream planner, the planner runs normally when upstream dependencies complete.
- If the router selects an early-exit terminal branch, the downstream planner is cleanly shadowed (`subgraph/shadowed`).
- If no rule condition matches (`no_match`), the router passes through to the downstream planner as the default decision maker.

### 6. Three Lines of Defense

Safety is enforced through three distinct gates:

| Gate | Timing | Responsibility |
|---|---|---|
| **Registration** | Template publish time | Validates condition field syntax, resolves tools in catalog, verifies branch shapes in isolation (Q1–Q6). |
| **Freeze Admission** | Proposal freeze time (pre-execution) | Runs **Exhaustive Admission** over all branches $\times$ placements against run-specific role views and existing scopes. |
| **Structural Fall-Through** | Router evaluation time | Handles `no_match` by passing control to the downstream planner. |

#### 6.1 Registration Admission (Q1–Q6)
Rule templates are published, content-addressed, immutable contracts in `gatewayd`:
- **Q1:** Conditions reference only **summary fields** of upstream payloads. No blob dereferencing, no clock reads, no network I/O.
- **Q2:** Every tool referenced by every branch resolves inside a published tool view with a known `effect_class`.
- **Q3:** The template is derived, never declared: marked `needs_savepoint` if any branch contains an irreversible tool or opens a fresh scope; otherwise `joinable`.
- **Q4:** Each branch sub-DAG independently passes `checkSubDag` in isolation.
- **Q5:** Conditions are totally ordered with first-match semantics.
- **Q6:** Fall-through to the downstream planner on `no_match` is structural; no explicit fallback declarations are allowed.

#### 6.2 Freeze-Time Exhaustive Admission & Complexity Analysis
The core vulnerability of deterministic rules is **late detection**: discovering an invalid branch after an irreversible pivot has already passed. The fix is to move detection to freeze time, before any tool executes.

**Exhaustive Admission Algorithm:**
At the freeze introducing the router, the engine runs `checkSubDag` over:
$$\text{Total Verifications} = N \text{ (branches)} \times M \text{ (reachable placements)}$$
against this run's actual role-scoped tool view and existing-scope snapshot.
- If all combinations are admissible, whichever branch fires at runtime is guaranteed 100% admissible by construction. **Runtime rejection probability for rule topology is zero.**
- If any combination violates a rule, the proposal is rejected at freeze time. The rejection lands on the proposing planner, which sits safely at or above the backtrack floor, allowing clean replanning before any real-world state is mutated.

**Complexity Analysis:**
- **Search Space ($N \times M$):** In real-world enterprise SOPs, the number of branches $N$ in a rule template typically ranges from 2 to 8 (rarely exceeding 20). The number of reachable placement states $M$ is bounded by at most 2 (`at_savepoint` or `inside_scope(S)`), because the ancestor graph of *this specific run* is already fixed. Thus, total evaluations per freeze are small (typically 3 to 16 checks).
- **Execution Cost:** `checkSubDag` is a pure in-memory topological check with zero disk, network, or database I/O. Validating a 2–3 vertex branch in TypeScript takes 10–30 microseconds ($\mu s$). 
  $$\text{Total CPU Overhead} = 20 \text{ checks} \times 25\mu s \approx 0.5 \text{ ms}$$
  A sub-millisecond CPU check is negligible compared to database queries (2–5ms) or LLM latency (500–3000ms).
- **Scalability Safeguards:** Q4 registration checks eliminate malformed graphs upfront. For large enterprise rules spanning multiple business domains, static context pruning discards irrelevant branches based on immutable run attributes (e.g., skipping cross-border branches on domestic order runs) before topological checks begin.

**Check-Rules R12 & R13:**
- **R12:** A `needs_savepoint` template must not sit at a slot whose derived placement is `inside_scope`. A router inside scope `S` must not emit a branch with a pivot if `S` already contains one (enforcing R3 across freezes).
- **R13:** An `at_savepoint` router must not have unclosed ancestor scopes; its tools must exist in the run's role-scoped view; and condition field paths must statically resolve against upstream tool output schemas.
- **Engine Requirement:** `engine/src/check-rules.ts` must accept a third parameter: an immutable snapshot of existing scope states (`existing_scope_snapshot`).

#### 6.3 Closed Outcome Vocabulary
Router evaluation produces one of four mutually exclusive outcomes:
1. `matched(i)`: Emits the matched branch sub-DAG. Downstream planner is shadowed if branch is terminal.
2. `no_match`: Structural fall-through. Control passes directly to the downstream planner.
3. `evaluation_error`: Fatal runtime error (e.g., malformed field path). Raises an operational alert and halts to L4.
4. `proposal_rejected`: Prevented upfront by freeze-time exhaustive admission.

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

Q1–Q5 pass: conditions reference declared schema fields; branches are shape-legal; derived label is `needs_savepoint`. Published with content digest.

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
- **Zero Late Rejections:** Moving validation from runtime to freeze-time exhaustive admission ($N \times M$) ensures runtime execution never encounters structural deadlocks after irreversible actions have committed.
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

### 4. Have Planners Emit Router Vertices
*Why rejected:* Violates Doc 02 §3.1 ("computed, never asked of the planner"). Forces mechanical obligations on LLMs that can be derived deterministically by the engine.

### 5. Lazily Materialize Downstream Planners to Serve as Replan Anchors
*Why rejected:* Assumes deterministic branch failures should be replanned by LLMs. Allowing an LLM to invent workarounds around failed deterministic policy is a critical audit violation. Deterministic failures must rollback and escalate to L4.

### 6. Rely Purely on Runtime Check-Rule Interception
*Why rejected:* For deterministic rules, runtime rejections are unrecoverable defects. If a rejection occurs after an irreversible pivot, the system is deadlocked below the backtrack floor. Detection must occur at freeze time.

### 7. Harden Runtime Interception Instead of Moving Detection Earlier
*Why rejected:* No amount of runtime checking can undo a captured payment. Moving validation to freeze-time exhaustive admission is sub-millisecond in cost and guarantees zero runtime structural rejections.
