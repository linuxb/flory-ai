import {describe, expect, it} from 'vitest';
import {loadToolRegistry, type ToolViewDocument} from '../../src/gateway/tool-view.js';
import {diffTemplates, digestOfTemplate, publishRuleTemplate, type RuleTemplateDraft} from '../../src/router/rule-template.js';
import type {ResolvedToolView} from '../../src/gateway/gateway-client.js';
import type {SubDagProposal} from '../../src/admission/check-rules.js';

const digest = `sha256:${'c'.repeat(64)}`;

function view(): ResolvedToolView {
    const document: ToolViewDocument = {
        tool_view_version: 'v2',
        tools: [
            {
                tool_id: 'record.read',
                tool_version: '1.0.0',
                input_schema: {type: 'object'},
                output_schema: {type: 'object'},
                route_id: 'route-read',
                adapter: {protocol: 'grpc'},
                txn: {effect_class: 'none', mode: 'plain', idempotent_retryable: true},
                compensation_style: 'none',
                footprint: [],
                writes: [],
                timeout_ms: 1000,
                retry_constraints: {max_attempts: 1, initial_backoff_ms: 0, multiplier_milli: 1000, max_backoff_ms: 0},
                owner: 'team',
                allowed_roles: ['operator'],
                log_fields: ['status', 'risk.score'],
            },
            {
                tool_id: 'record.settle',
                tool_version: '1.0.0',
                input_schema: {type: 'object'},
                output_schema: {type: 'object'},
                route_id: 'route-settle',
                adapter: {protocol: 'grpc'},
                txn: {effect_class: 'irreversible', mode: 'plain', idempotent_retryable: true},
                compensation_style: 'none',
                footprint: ['ledger'],
                writes: ['ledger'],
                timeout_ms: 1000,
                retry_constraints: {max_attempts: 1, initial_backoff_ms: 0, multiplier_milli: 1000, max_backoff_ms: 0},
                owner: 'team',
                allowed_roles: ['operator'],
                log_fields: ['status'],
            },
        ],
    };
    return {identity: {tool_view_ref: 'tool-views/t.json', tool_view_digest: digest}, document, registry: loadToolRegistry(document)};
}

const readBranch: SubDagProposal = {vertices: [{id: 'probe', kind: 'tool', tool: 'record.read', parents: []}], scopes: []};
const settleBranch: SubDagProposal = {
    vertices: [{id: 'settle', kind: 'tool', tool: 'record.settle', parents: [], scopeId: 's'}],
    scopes: [{id: 's', members: ['settle']}],
};

function draft(overrides: Partial<RuleTemplateDraft> = {}): RuleTemplateDraft {
    return {
        templateRef: 'rule://dispatch@v1',
        author: 'operator@example',
        branches: [{condition: 'record.read.output.status == "ready"', subDag: readBranch}],
        ...overrides,
    };
}

describe('rule template publication', () => {
    it('admits a well-formed template and derives its envelope rather than taking it', () => {
        const result = publishRuleTemplate(
            draft({
                branches: [
                    {condition: 'record.read.output.risk.score < 30', subDag: readBranch},
                    {condition: 'record.settle.output.status == "due"', subDag: settleBranch},
                ],
            }),
            view(),
        );
        expect(result.admitted).toBe(true);
        if (!result.admitted) throw new Error('unreachable');

        expect(result.template.capability).toEqual({maxEffectClass: 'irreversible', canOpenScope: true, canProvidePivot: true, isPureReadOnly: false});
        // Branch heterogeneity survives the summary: the read branch is not a pivot.
        expect(result.template.branches.map((branch) => branch.hasPivot)).toEqual([false, true]);
        expect(result.template.branches.map((branch) => branch.maxEffect)).toEqual(['none', 'irreversible']);
        expect(result.template.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    });

    it('refuses a condition that reads a field the producing tool does not declare (Q1)', () => {
        const result = publishRuleTemplate(draft({branches: [{condition: 'record.read.output.secret > 1', subDag: readBranch}]}), view());
        expect(result.admitted).toBe(false);
        if (result.admitted) throw new Error('unreachable');
        expect(result.violations[0]).toMatchObject({code: 'Q1'});
        expect(result.violations[0]!.message).toContain('does not declare as a log field');
    });

    it('refuses an impure condition outright (Q1)', () => {
        const result = publishRuleTemplate(draft({branches: [{condition: 'record.read.output.status == now()', subDag: readBranch}]}), view());
        expect(result.admitted).toBe(false);
        if (result.admitted) throw new Error('unreachable');
        expect(result.violations.map((violation) => violation.code)).toContain('Q1');
    });

    it('refuses a branch naming a tool the view does not publish (Q2)', () => {
        const missing: SubDagProposal = {vertices: [{id: 'ghost', kind: 'tool', tool: 'record.missing', parents: []}], scopes: []};
        const result = publishRuleTemplate(draft({branches: [{condition: 'record.read.output.status == "x"', subDag: missing}]}), view());
        expect(result.admitted).toBe(false);
        if (result.admitted) throw new Error('unreachable');
        expect(result.violations.map((violation) => violation.code)).toContain('Q2');
    });

    it('refuses a branch that is inadmissible on its own (Q4)', () => {
        // A side-effecting vertex with no scope is R10, which a branch must not smuggle past the
        // checker merely by living inside a template.
        const unscoped: SubDagProposal = {vertices: [{id: 'settle', kind: 'tool', tool: 'record.settle', parents: []}], scopes: []};
        const result = publishRuleTemplate(draft({branches: [{condition: 'record.read.output.status == "x"', subDag: unscoped}]}), view());
        expect(result.admitted).toBe(false);
        if (result.admitted) throw new Error('unreachable');
        expect(result.violations[0]).toMatchObject({code: 'Q4'});
        expect(result.violations[0]!.message).toContain('R10');
    });

    it('refuses a repeated condition and an empty template (Q5)', () => {
        const repeated = publishRuleTemplate(
            draft({
                branches: [
                    {condition: 'record.read.output.status == "x"', subDag: readBranch},
                    {condition: 'record.read.output.status == "x"', subDag: readBranch},
                ],
            }),
            view(),
        );
        expect(repeated.admitted).toBe(false);
        if (repeated.admitted) throw new Error('unreachable');
        expect(repeated.violations.map((violation) => violation.code)).toContain('Q5');

        const empty = publishRuleTemplate(draft({branches: []}), view());
        expect(empty.admitted).toBe(false);
    });

    it('refuses a declared fallback, because fall-through is structural (Q6)', () => {
        const result = publishRuleTemplate(draft({branches: [{condition: 'fallback', subDag: readBranch}]}), view());
        expect(result.admitted).toBe(false);
        if (result.admitted) throw new Error('unreachable');
        expect(result.violations.map((violation) => violation.code)).toContain('Q6');
    });

    it('pins by content, so a changed branch is a different template and a reordered field is not', () => {
        const first = digestOfTemplate(draft());
        expect(digestOfTemplate(draft())).toBe(first);
        expect(digestOfTemplate(draft({author: 'someone-else'}))).toBe(first);
        expect(digestOfTemplate(draft({branches: [{condition: 'record.read.output.status == "other"', subDag: readBranch}]}))).not.toBe(first);
    });

    it('describes a version as a patch against its predecessor', () => {
        const previous = draft();
        const next = draft({branches: [...previous.branches, {condition: 'record.read.output.risk.score < 30', subDag: readBranch}]});
        expect(diffTemplates(previous, next)).toEqual([{op: 'add', path: '/branches/1', value: next.branches[1]}]);
        expect(diffTemplates(undefined, previous)[0]).toMatchObject({op: 'add', path: ''});
        expect(diffTemplates(next, previous)).toEqual([{op: 'remove', path: '/branches/1'}]);
    });
});
