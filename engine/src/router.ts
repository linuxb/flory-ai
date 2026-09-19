import type {CheckViolation, SubDagProposal} from './check-rules.js';
import type {BranchTraits, PublishedRuleTemplate} from './rule-template.js';

/** The summary fields one upstream tool lifted into its `vertex/succeeded`, keyed by tool type. */
export type RouterFacts = ReadonlyMap<string, Record<string, unknown>>;

/** The four mutually exclusive results a router vertex can reach. */
export type RouterOutcome =
    | {kind: 'matched'; branch: number; condition: string; subDag: SubDagProposal}
    | {kind: 'no_match'}
    | {kind: 'evaluation_error'; reason: string}
    | {kind: 'proposal_rejected'; violations: CheckViolation[]};

/**
 * What evaluation alone can produce.
 *
 * `proposal_rejected` is absent by construction: evaluation is pure, and a branch is refused by
 * runtime admission after the fact, which only the executor can observe.
 */
export type EvaluatedOutcome = Extract<RouterOutcome, {kind: 'matched' | 'no_match' | 'evaluation_error'}>;

const COMPARISON = /^\s*([A-Za-z_][\w.-]*)\.output\.([\w.]+)\s*(==|!=|<=|>=|<|>)\s*(.+?)\s*$/;

/** Reads a dotted path out of a lifted summary object. */
function readPath(facts: Record<string, unknown>, path: string): unknown {
    // The executor lifts each declared field under its full path, so a direct hit is the common
    // case; the walk covers a tool that nests them instead.
    if (path in facts) return facts[path];
    let current: unknown = facts;
    for (const segment of path.split('.')) {
        if (typeof current !== 'object' || current === null) return undefined;
        current = (current as Record<string, unknown>)[segment];
    }
    return current;
}

function parseLiteral(text: string): unknown {
    if (/^".*"$/.test(text) || /^'.*'$/.test(text)) return text.slice(1, -1);
    if (text === 'true') return true;
    if (text === 'false') return false;
    if (text === 'null') return null;
    const numeric = Number(text);
    if (!Number.isNaN(numeric) && text.trim() !== '') return numeric;
    throw new Error(`unsupported literal ${text}`);
}

function compare(left: unknown, operator: string, right: unknown): boolean {
    if (operator === '==') return left === right;
    if (operator === '!=') return left !== right;
    if (typeof left !== 'number' || typeof right !== 'number') {
        throw new Error(`operator ${operator} requires numbers, got ${typeof left} and ${typeof right}`);
    }
    if (operator === '<') return left < right;
    if (operator === '<=') return left <= right;
    if (operator === '>') return left > right;
    return left >= right;
}

/**
 * Evaluates one comparison against the lifted summary fields.
 *
 * Throws rather than returning false on anything it cannot decide. A rule that silently evaluates
 * to false on a missing field would route real business away from its intended branch and look
 * like a deliberate `no_match`, which is the one failure mode a deterministic router must not have.
 */
function evaluateComparison(clause: string, facts: RouterFacts): boolean {
    const match = COMPARISON.exec(clause);
    if (!match) throw new Error(`cannot parse condition clause "${clause.trim()}"`);
    const [, toolId, path, operator, literal] = match as unknown as [string, string, string, string, string];
    const produced = facts.get(toolId);
    if (!produced) throw new Error(`condition reads ${toolId}, which produced no summary fields upstream`);
    const value = readPath(produced, path);
    if (value === undefined) throw new Error(`${toolId} did not report the summary field ${path}`);
    return compare(value, operator, parseLiteral(literal));
}

/**
 * Evaluates a condition written as comparisons joined by `&&` and `||`.
 *
 * Deliberately not an expression language: no parentheses, no calls, no arithmetic. A condition is
 * a business rule an auditor reads, and every construct beyond this is one a rule author could use
 * to hide a decision the log would not explain.
 */
export function evaluateCondition(condition: string, facts: RouterFacts): boolean {
    return condition.split('||').some((disjunct) => disjunct.split('&&').every((clause) => evaluateComparison(clause, facts)));
}

/**
 * Evaluates a router's pinned template against its upstream summary fields.
 *
 * An unbound slot is `no_match`, not an error: a router with nothing bound is a transparent
 * pass-through, which is what keeps a run's topology identical whether or not a rule exists.
 */
export function evaluateRouter(template: PublishedRuleTemplate | undefined, facts: RouterFacts): EvaluatedOutcome {
    if (!template) return {kind: 'no_match'};
    for (const [index, branch] of template.branches.entries()) {
        let matched: boolean;
        try {
            matched = evaluateCondition(branch.condition, facts);
        } catch (error) {
            return {kind: 'evaluation_error', reason: error instanceof Error ? error.message : String(error)};
        }
        if (matched) return {kind: 'matched', branch: index, condition: branch.condition, subDag: branch.subDag};
    }
    return {kind: 'no_match'};
}

/** Restates a published branch in the shape freeze admission consumes. */
export function admissibleBranches(template: PublishedRuleTemplate): BranchTraits[] {
    return template.branches;
}
