import {describe, expect, it} from 'vitest';
import {evaluateCondition, evaluateRouter} from '../../src/router/router.js';
import {slotIdOf, type PublishedRuleTemplate} from '../../src/router/rule-template.js';
import {linearize, type SurfaceVertex} from '../../src/log/projection.js';

const facts = new Map<string, Record<string, unknown>>([['record.read', {status: 'ready', 'risk.score': 12, amount: 350}]]);

function template(...conditions: string[]): PublishedRuleTemplate {
    return {
        templateRef: 'rule://x@v1',
        digest: `sha256:${'e'.repeat(64)}`,
        author: 'operator',
        capability: {maxEffectClass: 'none', canOpenScope: false, canProvidePivot: false, isPureReadOnly: true},
        branches: conditions.map((condition) => ({
            condition,
            subDag: {vertices: [{id: 'act', kind: 'tool', tool: 'record.read', parents: []}], scopes: []},
            opensScope: false,
            hasPivot: false,
            maxEffect: 'none',
        })),
    };
}

describe('condition evaluation', () => {
    it('compares summary fields by value and by order', () => {
        expect(evaluateCondition('record.read.output.status == "ready"', facts)).toBe(true);
        expect(evaluateCondition('record.read.output.status != "ready"', facts)).toBe(false);
        expect(evaluateCondition('record.read.output.risk.score < 30', facts)).toBe(true);
        expect(evaluateCondition('record.read.output.amount >= 350', facts)).toBe(true);
    });

    it('joins comparisons with && and ||, with && binding tighter', () => {
        expect(evaluateCondition('record.read.output.risk.score < 30 && record.read.output.amount > 200', facts)).toBe(true);
        expect(evaluateCondition('record.read.output.risk.score > 90 && record.read.output.amount > 200', facts)).toBe(false);
        expect(evaluateCondition('record.read.output.risk.score > 90 || record.read.output.amount > 200', facts)).toBe(true);
    });

    it('refuses to decide rather than quietly deciding false', () => {
        // A missing field that evaluated to false would route real business away from its branch
        // and be indistinguishable in the log from a deliberate fall-through.
        expect(() => evaluateCondition('record.read.output.absent == 1', facts)).toThrow('did not report the summary field');
        expect(() => evaluateCondition('other.tool.output.status == "x"', facts)).toThrow('produced no summary fields');
        expect(() => evaluateCondition('record.read.output.status', facts)).toThrow('cannot parse');
        expect(() => evaluateCondition('record.read.output.status > 1', facts)).toThrow('requires numbers');
    });
});

describe('router outcomes', () => {
    it('takes the first matching branch, in declared order', () => {
        const outcome = evaluateRouter(template('record.read.output.amount > 1000', 'record.read.output.amount > 100'), facts);
        expect(outcome).toMatchObject({kind: 'matched', branch: 1});
    });

    it('falls through when nothing matches', () => {
        expect(evaluateRouter(template('record.read.output.amount > 1000'), facts)).toEqual({kind: 'no_match'});
    });

    it('treats an unbound slot as a pass-through, not an error', () => {
        // This is what keeps topology identical whether or not a rule is bound.
        expect(evaluateRouter(undefined, facts)).toEqual({kind: 'no_match'});
    });

    it('reports an evaluation error instead of guessing', () => {
        const outcome = evaluateRouter(template('record.read.output.missing == 1'), facts);
        expect(outcome).toMatchObject({kind: 'evaluation_error'});
    });
});

describe('slot identity', () => {
    it('keys on the set of upstream tool types, so ordering cannot change it', () => {
        expect(slotIdOf('returns', ['b.read', 'a.read'], 'planner://negotiate')).toBe(slotIdOf('returns', ['a.read', 'b.read'], 'planner://negotiate'));
        expect(slotIdOf('returns', ['a.read'], 'planner://negotiate')).not.toBe(slotIdOf('returns', ['a.read', 'b.read'], 'planner://negotiate'));
        expect(slotIdOf('returns', ['a.read'], 'planner://negotiate')).not.toBe(slotIdOf('refunds', ['a.read'], 'planner://negotiate'));
    });
});

describe('router visibility in a planner prompt', () => {
    function vertex(id: string, role: string, matched?: string | null): SurfaceVertex {
        return {vertex_id: id, parent_refs: [], role, created_seq: 1, ...(matched === undefined ? {} : {matched_condition: matched})};
    }

    it('omits a fall-through router entirely and renders a matched one as its condition', () => {
        const fellThrough = linearize([vertex('a-tool', 'tool'), vertex('b-router', 'router', null)]);
        expect(fellThrough.map((item) => item.vertex_id)).toEqual(['a-tool']);

        const matched = linearize([vertex('a-tool', 'tool'), vertex('b-router', 'router', 'record.read.output.status == "ready"')]);
        expect(matched.map((item) => item.vertex_id)).toEqual(['a-tool', 'b-router']);
        expect(matched[1]!.condition).toBe('record.read.output.status == "ready"');
    });

    it('gives a planner the same context whether or not an unbound router sits in the graph', () => {
        const withoutRouter = linearize([vertex('a-tool', 'tool')]);
        const withRouter = linearize([vertex('a-tool', 'tool'), vertex('b-router', 'router', null)]);
        expect(withRouter).toEqual(withoutRouter);
    });

    it('hides a router that has not decided yet', () => {
        expect(linearize([vertex('b-router', 'router')])).toEqual([]);
    });
});
