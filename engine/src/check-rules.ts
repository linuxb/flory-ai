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

/** A proposed executable vertex or an engine-inserted confirmation barrier. */
export interface ProposalVertex {
    id: string;
    parents: string[];
    kind: 'tool' | 'confirmation-barrier';
    tool?: string;
    scopeId?: string;
    confirmedOutput?: boolean;
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

/** The closed check-rule vocabulary from transaction design document 02. */
export type RuleCode = 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6' | 'R7' | 'R8' | 'R9' | 'R10' | 'R11';

/** One deterministic admission violation. */
export interface CheckViolation {
    rule: RuleCode;
    message: string;
    vertices: string[];
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
    for (const vertex of proposal.vertices) if (vertex.kind === 'tool' && vertex.tool) tools.set(vertex.id, registry.get(vertex.tool));
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

/** Applies Doc 02 R1-R11 to a complete proposal without I/O or ambient state. */
export function checkSubDag(proposal: SubDagProposal, registry: ToolRegistry): CheckResult {
    const violations = [...registry.validate()];
    const context = buildContext(proposal, registry);
    const pivots = pivotIds(context);

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
            const parentTool = context.tools.get(parentId);
            if (parent.scopeId && child.scopeId && parent.scopeId !== child.scopeId && parentTool?.effectClass !== 'none' && !parent.confirmedOutput) {
                add(violations, 'R7', `${childId} reads an unconfirmed cross-scope output from ${parentId}`, [parentId, childId]);
            }
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
