/** Side-effect classification supplied by a tool registry. */
export type EffectClass = 'none' | 'bufferable' | 'reversible' | 'irreversible';
/** Transaction integration supported by a registered tool. */
export type ToolMode = 'plain' | 'tcc' | 'saga';

/** Static metadata used to admit a proposed sub-DAG before freeze. */
export interface ToolDefinition {
    name: string;
    effectClass: EffectClass;
    mode: ToolMode;
    idempotentRetryable: boolean;
    footprint: readonly string[];
    writes?: readonly string[];
    compensateTool?: string;
    confirmTool?: string;
    cancelTool?: string;
    tryTimeoutS?: number;
}

/**
 * A proposed vertex role. These are spelled exactly as the event-log `role` values, so lowering a
 * proposal into `vertex/created` events is an identity mapping rather than a lookup table that can
 * drift from the schema.
 */
export type VertexKind = 'planner' | 'tool' | 'router' | 'confirmation-barrier';

/** A proposed executable vertex, deterministic router, planner, or engine-inserted barrier. */
export interface ProposalVertex {
    id: string;
    parents: string[];
    kind: VertexKind;
    tool?: string;
    scopeId?: string;
    confirmedOutput?: boolean;
    /** Pinned rule template on an author-declared router; absent on an engine-interposed one. */
    templateRef?: string;
}

/** A planner-declared transaction scope and its members. */
export interface ProposalScope {
    id: string;
    members: string[];
}

/** The complete sub-DAG proposal evaluated by the deterministic rule engine. */
export interface SubDagProposal {
    vertices: ProposalVertex[];
    scopes: ProposalScope[];
}

/**
 * The closed check-rule vocabulary from transaction design document 02.
 *
 * Every code is enforced somewhere. `checkSubDag` covers what is decidable from a proposal alone;
 * the placement clauses of R12 and R13 need a router's bound template and live in
 * {@link checkFreezeAdmission}, which the submission path calls over the branches of each template
 * it resolved.
 */
export type RuleCode = 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6' | 'R7' | 'R8' | 'R9' | 'R10' | 'R11' | 'R12' | 'R13' | 'R14';

/** One deterministic admission violation. */
export interface CheckViolation {
    rule: RuleCode;
    message: string;
    vertices: string[];
}

/**
 * One ancestor transaction scope as it stands at the freeze that introduces a router.
 *
 * `half-open` means a try is sealed but unconfirmed, which is the state that forbids opening a
 * fresh scope: an open scope is not a savepoint.
 */
export interface ScopeSnapshot {
    scopeId: string;
    state: 'open' | 'half-open' | 'committed' | 'cancelled';
    /** Pivots already bound to this scope in earlier freezes; R3 counts across them. */
    pivotCount: number;
}

/** Where a router sits relative to the transaction structure above it. */
export type RouterPlacement = 'at_savepoint' | 'inside_scope';

/**
 * Derives where a router sits from the scopes recorded above it.
 *
 * Placement is derived, never declared. A declared one could disagree with the state it claims to
 * describe, which is exactly the disagreement R13 exists to catch; deriving it from the same
 * snapshot the rule reads means the two cannot drift apart. `unclosed` here is the same predicate
 * R13 uses — an open scope is not a savepoint any more than a half-open one is, so either forces
 * inside_scope, and only a run with nothing left open sits at a savepoint.
 */
export function derivePlacement(existingScopes: readonly ScopeSnapshot[]): RouterPlacement {
    return existingScopes.some((scope) => scope.state === 'open' || scope.state === 'half-open') ? 'inside_scope' : 'at_savepoint';
}

/** The complete admission result for a proposal. */
export interface CheckResult {
    accepted: boolean;
    violations: CheckViolation[];
}

/** Stores immutable tool metadata supplied to the pure checker. */
export class ToolRegistry {
    private readonly definitions = new Map<string, ToolDefinition>();

    /** Registers one tool name exactly once. */
    register(definition: ToolDefinition): void {
        if (this.definitions.has(definition.name)) throw new Error(`tool already registered: ${definition.name}`);
        this.definitions.set(definition.name, Object.freeze({...definition, footprint: Object.freeze([...definition.footprint]), writes: Object.freeze([...(definition.writes ?? [])])}));
    }

    /** Returns one registered definition or fails closed. */
    get(name: string): ToolDefinition {
        const definition = this.definitions.get(name);
        if (!definition) throw new Error(`unknown tool: ${name}`);
        return definition;
    }

    /**
     * Reports whether a tool is published in this view. Callers that turn an unpublished tool into
     * an admission violation use this first; {@link get} stays fail-closed for everyone else.
     */
    has(name: string): boolean {
        return this.definitions.has(name);
    }

    /** Reports registry defects governed by R4 and R6. */
    validate(): CheckViolation[] {
        const violations: CheckViolation[] = [];
        for (const definition of this.definitions.values()) {
            if (definition.mode === 'saga') {
                const compensation = definition.compensateTool ? this.definitions.get(definition.compensateTool) : undefined;
                if (!compensation?.idempotentRetryable) {
                    violations.push({rule: 'R4', message: `${definition.name} requires a registered idempotent compensation tool`, vertices: []});
                }
            }
            if (definition.mode === 'tcc') {
                const confirm = definition.confirmTool ? this.definitions.get(definition.confirmTool) : undefined;
                const cancel = definition.cancelTool ? this.definitions.get(definition.cancelTool) : undefined;
                if (!confirm?.idempotentRetryable || !cancel?.idempotentRetryable || !definition.tryTimeoutS || definition.tryTimeoutS <= 0) {
                    violations.push({rule: 'R6', message: `${definition.name} requires idempotent confirm/cancel tools and a positive timeout`, vertices: []});
                }
            }
        }
        return violations;
    }
}

interface GraphContext {
    vertices: Map<string, ProposalVertex>;
    tools: Map<string, ToolDefinition>;
    ancestors: Map<string, Set<string>>;
    descendants: Map<string, Set<string>>;
    scopeMembers: Map<string, Set<string>>;
}

function intersects(first: readonly string[], second: readonly string[]): boolean {
    const values = new Set(first);
    return second.some((value) => values.has(value));
}

function isUndoable(tool: ToolDefinition): boolean {
    return tool.effectClass === 'none' || tool.effectClass === 'bufferable' || tool.mode === 'tcc' || Boolean(tool.compensateTool);
}

function buildContext(proposal: SubDagProposal, registry: ToolRegistry): GraphContext {
    const vertices = new Map(proposal.vertices.map((vertex) => [vertex.id, vertex]));
    const tools = new Map<string, ToolDefinition>();
    // Only tool vertices enter `tools`, and that is load-bearing rather than incidental: R10 and
    // `pivotIds` both iterate this map, so a planner or router is never asked for a scope and can
    // never be counted as a pivot (doc 10 section 2: a router is never a scope member). A non-tool
    // vertex carrying a tool name is a structural contradiction, not a rule violation, so it fails
    // loudly here instead of being silently dropped from every rule.
    for (const vertex of proposal.vertices) {
        if (vertex.kind !== 'tool') {
            if (vertex.tool) throw new Error(`${vertex.id} is a ${vertex.kind} and must not name a tool`);
            continue;
        }
        if (vertex.tool) tools.set(vertex.id, registry.get(vertex.tool));
    }
    const ancestors = new Map<string, Set<string>>();
    const visitAncestors = (id: string, visiting = new Set<string>()): Set<string> => {
        const cached = ancestors.get(id);
        if (cached) return cached;
        if (visiting.has(id)) throw new Error(`proposal contains a cycle at ${id}`);
        const nextVisiting = new Set(visiting).add(id);
        const result = new Set<string>();
        for (const parent of vertices.get(id)?.parents ?? []) {
            if (!vertices.has(parent)) throw new Error(`unknown parent ${parent} for ${id}`);
            result.add(parent);
            for (const ancestor of visitAncestors(parent, nextVisiting)) result.add(ancestor);
        }
        ancestors.set(id, result);
        return result;
    };
    for (const id of vertices.keys()) visitAncestors(id);
    const descendants = new Map<string, Set<string>>([...vertices.keys()].map((id) => [id, new Set<string>()]));
    for (const [id, values] of ancestors) for (const ancestor of values) descendants.get(ancestor)!.add(id);
    const scopeMembers = new Map(proposal.scopes.map((scope) => [scope.id, new Set(scope.members)]));
    return {vertices, tools, ancestors, descendants, scopeMembers};
}

function pivotIds(context: GraphContext): string[] {
    return [...context.tools].filter(([, tool]) => tool.effectClass === 'irreversible').map(([id]) => id);
}

function hasConfirmationBarrier(context: GraphContext, pivotIdsToProtect: string[]): boolean {
    return [...context.vertices.values()].some(
        (vertex) => vertex.kind === 'confirmation-barrier' && vertex.parents.length >= 2 && pivotIdsToProtect.every((pivotId) => context.ancestors.get(pivotId)?.has(vertex.id)),
    );
}

function add(violations: CheckViolation[], rule: RuleCode, message: string, vertices: string[]): void {
    if (!violations.some((violation) => violation.rule === rule && violation.vertices.join('\0') === vertices.join('\0'))) violations.push({rule, message, vertices});
}

/**
 * Applies the Doc 02 check rules to a complete proposal without I/O or ambient state.
 *
 * A proposal containing a router is admitted here for its *own* structure only. The branches that
 * router may emit live in a pinned rule template and are admitted separately at freeze, so this
 * function's verdict is necessary but not sufficient for a graph with routers.
 */
export function checkSubDag(proposal: SubDagProposal, registry: ToolRegistry, existingScopes: readonly ScopeSnapshot[] = []): CheckResult {
    const violations = [...registry.validate()];
    const context = buildContext(proposal, registry);
    const pivots = pivotIds(context);
    const routerIds = [...context.vertices.values()].filter((vertex) => vertex.kind === 'router').map((vertex) => vertex.id);

    for (const [vertexId, tool] of context.tools) {
        const vertex = context.vertices.get(vertexId)!;
        if (tool.effectClass !== 'none' && !vertex.scopeId) add(violations, 'R10', `${vertexId} has a side effect but no scope`, [vertexId]);
    }

    for (const scope of proposal.scopes) {
        const members = context.scopeMembers.get(scope.id)!;
        const scopePivots = pivots.filter((id) => members.has(id));
        if (scopePivots.length > 1) add(violations, 'R3', `${scope.id} contains more than one pivot`, scopePivots);
        for (const pivotId of scopePivots) {
            const pivotTool = context.tools.get(pivotId)!;
            for (const memberId of members) {
                const memberTool = context.tools.get(memberId);
                if (!memberTool) continue;
                if (context.ancestors.get(pivotId)?.has(memberId) && memberTool.effectClass !== 'none' && !isUndoable(memberTool)) {
                    add(violations, 'R2', `${memberId} is not undoable before pivot ${pivotId}`, [memberId, pivotId]);
                }
                if (context.descendants.get(pivotId)?.has(memberId) && !memberTool.idempotentRetryable) {
                    add(violations, 'R1', `${memberId} is not retry-safe after pivot ${pivotId}`, [pivotId, memberId]);
                }
            }
            for (const ancestorId of context.ancestors.get(pivotId) ?? []) {
                const ancestor = context.tools.get(ancestorId);
                if (ancestor?.effectClass === 'reversible' && intersects(ancestor.footprint, pivotTool.footprint) && !members.has(ancestorId)) {
                    add(violations, 'R11', `${scope.id} omits required predecessor ${ancestorId}`, [ancestorId, pivotId]);
                }
            }
        }
    }

    // R12 placement, and R3 across freezes. Both are gated on the proposal actually containing a
    // router: without the gate, a caller that starts passing a real snapshot would begin reporting
    // violations on ordinary planner proposals no router ever touched.
    if (routerIds.length) {
        const halfOpen = existingScopes.filter((scope) => scope.state === 'half-open');
        const known = new Set(existingScopes.map((scope) => scope.scopeId));
        for (const scope of proposal.scopes) {
            if (halfOpen.length && !known.has(scope.id)) {
                add(violations, 'R12', `${scope.id} opens a fresh scope inside half-open scope ${halfOpen[0]!.scopeId}`, [...scope.members]);
            }
            const existing = existingScopes.find((candidate) => candidate.scopeId === scope.id);
            const members = context.scopeMembers.get(scope.id)!;
            const scopePivots = pivots.filter((id) => members.has(id));
            // A branch pivot is admitted when the scope holds none: it supplies S's unique commit
            // point. It is refused only when that commit point already exists.
            if (existing && existing.pivotCount + scopePivots.length > 1) {
                add(violations, 'R3', `${scope.id} already holds a pivot in this run's scope snapshot`, scopePivots);
            }
        }
    }

    for (let firstIndex = 0; firstIndex < pivots.length; firstIndex += 1) {
        for (let secondIndex = firstIndex + 1; secondIndex < pivots.length; secondIndex += 1) {
            const first = pivots[firstIndex]!;
            const second = pivots[secondIndex]!;
            const parallel = !context.ancestors.get(first)?.has(second) && !context.ancestors.get(second)?.has(first);
            if (parallel && !hasConfirmationBarrier(context, [first, second])) {
                add(violations, 'R5', `parallel pivots ${first} and ${second} require a confirmation barrier`, [first, second]);
            }
        }
    }

    for (const [childId, child] of context.vertices) {
        for (const parentId of child.parents) {
            const parent = context.vertices.get(parentId)!;
            // Only a tool caller produces an output another scope could read dirtily. Without this
            // guard `parentTool?.effectClass !== 'none'` reads `undefined !== 'none'` as true, so a
            // non-tool parent would be treated as having side effects.
            if (parent.kind !== 'tool') continue;
            const parentTool = context.tools.get(parentId);
            if (parent.scopeId && child.scopeId && parent.scopeId !== child.scopeId && parentTool?.effectClass !== 'none' && !parent.confirmedOutput) {
                add(violations, 'R7', `${childId} reads an unconfirmed cross-scope output from ${parentId}`, [parentId, childId]);
            }
        }
    }

    // R14: a tool caller may not hand control straight to a planner. Every such edge carries a
    // router, which the engine interposes during normalization when the author did not supply one.
    for (const [childId, child] of context.vertices) {
        if (child.kind !== 'planner') continue;
        for (const parentId of child.parents) {
            if (context.vertices.get(parentId)!.kind !== 'tool') continue;
            add(violations, 'R14', `${parentId} has planner ${childId} as a direct successor without an interposed router`, [parentId, childId]);
        }
    }

    // R12 (scope membership): a planner or router has no side effects and never joins a scope.
    // This is what exempts both from R10, so it has to be enforced rather than assumed.
    for (const [vertexId, vertex] of context.vertices) {
        if (vertex.kind === 'tool' || vertex.kind === 'confirmation-barrier') continue;
        if (vertex.scopeId) add(violations, 'R12', `${vertexId} is a ${vertex.kind} and may not declare a transaction scope`, [vertexId]);
        for (const scope of proposal.scopes) {
            if (scope.members.includes(vertexId)) add(violations, 'R12', `${vertexId} is a ${vertex.kind} and may not be a member of scope ${scope.id}`, [vertexId]);
        }
    }

    for (const pivotId of pivots) {
        const pivotScope = context.vertices.get(pivotId)?.scopeId;
        for (const descendantId of context.descendants.get(pivotId) ?? []) {
            const descendant = context.vertices.get(descendantId)!;
            const tool = context.tools.get(descendantId);
            if (descendant.scopeId === pivotScope && tool?.effectClass === 'none' && (context.descendants.get(descendantId)?.size ?? 0) > 0) {
                add(violations, 'R8', `${descendantId} is a read dependency on the post-pivot recovery path`, [pivotId, descendantId]);
            }
        }
    }

    const toolVertices = [...context.tools.keys()];
    for (let firstIndex = 0; firstIndex < toolVertices.length; firstIndex += 1) {
        for (let secondIndex = firstIndex + 1; secondIndex < toolVertices.length; secondIndex += 1) {
            const firstId = toolVertices[firstIndex]!;
            const secondId = toolVertices[secondIndex]!;
            const firstTool = context.tools.get(firstId)!;
            const secondTool = context.tools.get(secondId)!;
            if (!intersects(firstTool.writes ?? [], secondTool.writes ?? [])) continue;
            if (context.ancestors.get(firstId)?.has(secondId) || context.ancestors.get(secondId)?.has(firstId)) continue;
            const relatedPivots = pivots.filter(
                (pivotId) => pivotId === firstId || pivotId === secondId || context.descendants.get(firstId)?.has(pivotId) || context.descendants.get(secondId)?.has(pivotId),
            );
            if (!relatedPivots.length) continue;
            const protectedByBarrier = [...context.vertices.values()].some(
                (vertex) =>
                    vertex.kind === 'confirmation-barrier' &&
                    context.ancestors.get(vertex.id)?.has(firstId) &&
                    context.ancestors.get(vertex.id)?.has(secondId) &&
                    relatedPivots.every((pivotId) => context.ancestors.get(pivotId)?.has(vertex.id)),
            );
            if (!protectedByBarrier) add(violations, 'R9', `${firstId} and ${secondId} have conflicting parallel writes before a pivot`, [firstId, secondId]);
        }
    }

    return {accepted: violations.length === 0, violations};
}

/** Where one router slot sits, and the view its branches are admitted against. */
export interface SlotPlacementContext {
    placement: RouterPlacement;
    /** True on an offline simulation fork, where no branch may carry an effect. */
    isReadOnlyContext: boolean;
    roleToolView: ToolRegistry;
}

/** One branch of a pinned template, as freeze admission consumes it. */
export interface AdmissibleBranch {
    condition: string;
    subDag: SubDagProposal;
    opensScope: boolean;
    hasPivot: boolean;
    maxEffect: EffectClass;
}

/**
 * Admits every branch of a pinned template against the placement it will actually land in.
 *
 * The defect a deterministic rule creates is late detection: an illegal branch found after an
 * irreversible pivot has passed, when the proposing planner is already below the backtrack floor.
 * So every branch is checked at the freeze that introduces the router, not only the one that will
 * eventually match.
 *
 * Violations are pushed rather than deduplicated: two branches can fail the same way with no vertex
 * id to tell them apart, and collapsing those would hide the second defect behind the first.
 */
export function checkFreezeAdmission(branches: readonly AdmissibleBranch[], slot: SlotPlacementContext, existingScopes: readonly ScopeSnapshot[] = []): CheckResult {
    const violations: CheckViolation[] = [];

    // R13: a declared placement can disagree with the recorded scope state, and cancellation never
    // converts an inside_scope branch into a fresh transaction at a savepoint.
    const unclosed = existingScopes.find((scope) => scope.state === 'open' || scope.state === 'half-open');
    if (slot.placement === 'at_savepoint' && unclosed) {
        violations.push({rule: 'R13', message: `router slot declares at_savepoint while ancestor scope ${unclosed.scopeId} is unclosed`, vertices: []});
    }

    for (const [index, branch] of branches.entries()) {
        if (slot.isReadOnlyContext && branch.maxEffect !== 'none') {
            violations.push({rule: 'R10', message: `branch ${index} emits a side effect in a read-only slot`, vertices: []});
            continue;
        }

        // R13: every tool a branch names must exist in this run's role-scoped view. Checked before
        // checkSubDag, whose registry lookup throws rather than reports on an unknown tool.
        const missing = branch.subDag.vertices.filter((vertex) => vertex.kind === 'tool' && vertex.tool && !slot.roleToolView.has(vertex.tool));
        for (const vertex of missing) {
            violations.push({rule: 'R13', message: `branch ${index} references ${vertex.tool}, absent from this run's role-scoped tool view`, vertices: [vertex.id]});
        }
        if (missing.length) continue;

        if (slot.placement === 'inside_scope') {
            if (branch.opensScope) {
                violations.push({rule: 'R12', message: `branch ${index} cannot open a fresh scope inside an active one`, vertices: []});
            }
            const active = existingScopes.find((scope) => scope.state === 'half-open');
            if (branch.hasPivot && (active?.pivotCount ?? 0) > 0) {
                violations.push({rule: 'R3', message: `branch ${index} introduces a second pivot into scope ${active!.scopeId}`, vertices: []});
            }
        } else if (branch.maxEffect !== 'none' && !branch.opensScope) {
            // At a savepoint a side-effecting branch must be bounded by a scope. The engine would
            // synthesize the minimum here once footprint grouping lands; until then the template
            // has to declare it, and R10 is the honest refusal.
            violations.push({rule: 'R10', message: `branch ${index} has a side effect but declares no scope`, vertices: []});
        }

        for (const violation of checkSubDag(branch.subDag, slot.roleToolView, existingScopes).violations) {
            violations.push({rule: violation.rule, message: `branch ${index}: ${violation.message}`, vertices: violation.vertices});
        }
    }

    return {accepted: violations.length === 0, violations};
}
