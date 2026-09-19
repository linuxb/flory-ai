import {createHash} from 'node:crypto';
import {checkSubDag, type CheckViolation, type EffectClass, type SubDagProposal} from './check-rules.js';
import {canonicalJson} from './events.js';
import type {ResolvedToolView} from './gateway-client.js';

/** The reserved data-plane stream that records every template mutation. */
export const CONFIGURATION_STREAM_ID = 'config:rule-templates';

/** One ordered rule: a condition over upstream summary fields, and the sub-DAG it emits. */
export interface RuleBranch {
    /**
     * A pure boolean predicate over upstream summary fields, written as
     * `<tool_id>.output.<path> <operator> <literal>`. The prefix names a tool type rather than a
     * vertex, because a template is published before it is bound to any graph. Q1 validates that
     * every path it names is a log field the producing tool declares.
     */
    condition: string;
    subDag: SubDagProposal;
}

/** A rule template as its author writes it. */
export interface RuleTemplateDraft {
    /** Content-addressed URI, e.g. `rule://dispatch-routing@v3`. */
    templateRef: string;
    author: string;
    branches: RuleBranch[];
    /** Topological slot this template binds to, when it is bound rather than only published. */
    slotId?: string;
}

/** Constant-time pruning metadata, derived at publication and never declared. */
export interface TemplateCapability {
    maxEffectClass: EffectClass;
    canOpenScope: boolean;
    canProvidePivot: boolean;
    isPureReadOnly: boolean;
}

/** Per-branch morphology, preserved so a summary cannot erase branch heterogeneity. */
export interface BranchTraits {
    condition: string;
    subDag: SubDagProposal;
    opensScope: boolean;
    hasPivot: boolean;
    maxEffect: EffectClass;
}

/** A template admitted under Q1-Q6 and pinned by its content. */
export interface PublishedRuleTemplate {
    templateRef: string;
    digest: string;
    author: string;
    branches: BranchTraits[];
    capability: TemplateCapability;
    slotId?: string;
}

/** The publication vocabulary, reported the way admission codes are elsewhere. */
export type PublicationCode = 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5' | 'Q6';

/** One reason a template was refused. */
export interface PublicationViolation {
    code: PublicationCode;
    message: string;
    /** Index of the offending branch, or -1 for a template-wide defect. */
    branch: number;
}

/** The complete publication result. */
export type PublicationResult = {admitted: true; template: PublishedRuleTemplate} | {admitted: false; violations: PublicationViolation[]};

const EFFECT_ORDER: readonly EffectClass[] = ['none', 'bufferable', 'reversible', 'irreversible'];
/**
 * Matches the `<tool_id>.output.<path>` references a condition may read.
 *
 * The prefix is a tool *type*, not a vertex id: a template is published independently of any graph
 * it may later bind into, so the only upstream name it can carry is one the catalogue also knows.
 * That is the same key a slot identity is built from.
 */
const FIELD_REFERENCE = /([A-Za-z_][\w.-]*)\.output\.([\w.]+)/g;
/** Anything that would make a condition impure: a call, a clock, or a blob dereference. */
const IMPURE = /\b(now|Date|fetch|require|import|blob|await)\b|\(\s*\)/;

function higherEffect(first: EffectClass, second: EffectClass): EffectClass {
    return EFFECT_ORDER.indexOf(first) >= EFFECT_ORDER.indexOf(second) ? first : second;
}

/**
 * Derives one branch's morphology from the sub-DAG itself.
 *
 * Derived rather than declared, for the same reason the executor class is: a declared trait could
 * disagree with the structure it summarizes, and nothing downstream could tell which was right.
 */
function traitsOf(branch: RuleBranch, resolved: ResolvedToolView): BranchTraits {
    let maxEffect: EffectClass = 'none';
    let hasPivot = false;
    for (const vertex of branch.subDag.vertices) {
        if (vertex.kind !== 'tool' || !vertex.tool) continue;
        if (!resolved.registry.has(vertex.tool)) continue;
        const effect = resolved.registry.get(vertex.tool).effectClass;
        maxEffect = higherEffect(maxEffect, effect);
        if (effect === 'irreversible') hasPivot = true;
    }
    return {condition: branch.condition, subDag: branch.subDag, opensScope: branch.subDag.scopes.length > 0, hasPivot, maxEffect};
}

function capabilityOf(branches: readonly BranchTraits[]): TemplateCapability {
    const maxEffectClass = branches.reduce<EffectClass>((highest, branch) => higherEffect(highest, branch.maxEffect), 'none');
    return {
        maxEffectClass,
        canOpenScope: branches.some((branch) => branch.opensScope),
        canProvidePivot: branches.some((branch) => branch.hasPivot),
        isPureReadOnly: maxEffectClass === 'none',
    };
}

/** Returns the log fields a tool declares, or undefined when it declares none. */
function logFieldsOf(toolId: string, resolved: ResolvedToolView): string[] | undefined {
    return resolved.document.tools.find((tool) => tool.tool_id === toolId)?.log_fields;
}

/**
 * Q1: a condition reads declared summary fields only.
 *
 * A path is checked against the producing tool's log-fields schema rather than its output schema.
 * The two are not interchangeable: the output schema describes the full payload that streams to
 * blob storage, so accepting a path because it appears there would admit a rule that can only be
 * evaluated by dereferencing a blob — the precise thing the log-fields split exists to prevent. A
 * tool that declares no log fields is not silently trusted; its fields cannot be referenced at all.
 */
function checkConditionPurity(branch: RuleBranch, index: number, resolved: ResolvedToolView, violations: PublicationViolation[]): void {
    if (IMPURE.test(branch.condition)) {
        violations.push({code: 'Q1', message: `branch ${index} condition is not a pure predicate over summary fields`, branch: index});
        return;
    }
    for (const match of branch.condition.matchAll(FIELD_REFERENCE)) {
        const [, toolId, path] = match as unknown as [string, string, string];
        if (!resolved.registry.has(toolId)) {
            violations.push({code: 'Q1', message: `branch ${index} condition reads ${toolId}, which the published tool view does not know`, branch: index});
            continue;
        }
        const declared = logFieldsOf(toolId, resolved);
        if (!declared?.includes(path)) {
            violations.push({code: 'Q1', message: `branch ${index} condition reads ${toolId}.output.${path}, which ${toolId} does not declare as a log field`, branch: index});
        }
    }
}

/**
 * Admits a rule template and pins it by content.
 *
 * This is publication admission, deliberately weaker than the freeze-time gate: it validates a
 * template against the catalogue, and cannot know which run will bind it, under which role-scoped
 * view, or into which transaction placement.
 */
export function publishRuleTemplate(draft: RuleTemplateDraft, resolved: ResolvedToolView): PublicationResult {
    const violations: PublicationViolation[] = [];

    // Q5: a template decides by first match, so an empty or unordered list decides nothing.
    if (!draft.branches.length) violations.push({code: 'Q5', message: 'a template requires at least one ordered branch', branch: -1});
    const conditions = new Set<string>();
    for (const [index, branch] of draft.branches.entries()) {
        if (conditions.has(branch.condition)) {
            violations.push({code: 'Q5', message: `branch ${index} repeats an earlier condition, so first-match order is ambiguous`, branch: index});
        }
        conditions.add(branch.condition);

        // Q6: fall-through is structural. A template that names its own fallback could disagree
        // with the topology interposition already guarantees.
        if (/\bfallback\b/i.test(branch.condition)) {
            violations.push({code: 'Q6', message: `branch ${index} declares a fallback; fall-through to the downstream planner is structural`, branch: index});
        }

        checkConditionPurity(branch, index, resolved, violations);

        // Q2: every tool a branch names resolves in a published view with a known effect class.
        for (const vertex of branch.subDag.vertices) {
            if (vertex.kind !== 'tool' || !vertex.tool) continue;
            if (!resolved.registry.has(vertex.tool)) {
                violations.push({code: 'Q2', message: `branch ${index} names ${vertex.tool}, absent from the published tool view`, branch: index});
            }
        }
    }

    if (violations.length) return {admitted: false, violations};

    // Q4: each branch is admissible on its own, by the same checker a planner's proposal passes.
    const branches = draft.branches.map((branch) => traitsOf(branch, resolved));
    for (const [index, branch] of draft.branches.entries()) {
        const result = checkSubDag(branch.subDag, resolved.registry);
        for (const violation of result.violations) {
            violations.push({code: 'Q4', message: `branch ${index} is not admissible in isolation: ${violation.rule} ${violation.message}`, branch: index});
        }
    }
    if (violations.length) return {admitted: false, violations};

    // Q3: the envelope and the traits are derived here, never taken from the draft.
    const capability = capabilityOf(branches);
    const template: PublishedRuleTemplate = {
        templateRef: draft.templateRef,
        digest: digestOfTemplate(draft),
        author: draft.author,
        branches,
        capability,
        ...(draft.slotId ? {slotId: draft.slotId} : {}),
    };
    return {admitted: true, template};
}

/** Returns the content address a router pins a template by. */
export function digestOfTemplate(draft: RuleTemplateDraft): string {
    const content = {templateRef: draft.templateRef, branches: draft.branches.map((branch) => ({condition: branch.condition, subDag: branch.subDag}))};
    return `sha256:${createHash('sha256').update(canonicalJson(content), 'utf8').digest('hex')}`;
}

/** One RFC 6902 operation describing how a template changed. */
export interface PatchOperation {
    op: 'add' | 'remove' | 'replace';
    path: string;
    value?: unknown;
}

/**
 * Describes a template version as a patch against its predecessor.
 *
 * Recording the diff rather than only the result is what lets replay and counterfactual evaluation
 * reconstruct the exact template bound at a historical position without consulting a live registry.
 * The granularity is one operation per branch, which is the unit a reviewer reasons about.
 */
export function diffTemplates(previous: RuleTemplateDraft | undefined, next: RuleTemplateDraft): PatchOperation[] {
    if (!previous) return [{op: 'add', path: '', value: {templateRef: next.templateRef, branches: next.branches}}];
    const operations: PatchOperation[] = [];
    const length = Math.max(previous.branches.length, next.branches.length);
    for (let index = 0; index < length; index += 1) {
        const before = previous.branches[index];
        const after = next.branches[index];
        if (before && !after) operations.push({op: 'remove', path: `/branches/${index}`});
        else if (!before && after) operations.push({op: 'add', path: `/branches/${index}`, value: after});
        else if (before && after && canonicalJson(before) !== canonicalJson(after)) operations.push({op: 'replace', path: `/branches/${index}`, value: after});
    }
    return operations;
}
