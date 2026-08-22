import {describe, expect, it} from 'vitest';
import {checkSubDag, ToolRegistry, type ProposalVertex, type RuleCode, type SubDagProposal} from '../../src/check-rules.js';

function validRegistry(): ToolRegistry {
    const registry = new ToolRegistry();
    registry.register({name: 'read', effectClass: 'none', mode: 'plain', idempotentRetryable: true, footprint: []});
    registry.register({name: 'confirm', effectClass: 'bufferable', mode: 'plain', idempotentRetryable: true, footprint: ['x'], writes: ['x']});
    registry.register({name: 'cancel', effectClass: 'reversible', mode: 'plain', idempotentRetryable: true, footprint: ['x'], writes: ['x']});
    registry.register({
        name: 'try-x',
        effectClass: 'reversible',
        mode: 'tcc',
        idempotentRetryable: true,
        footprint: ['x'],
        writes: ['x'],
        confirmTool: 'confirm',
        cancelTool: 'cancel',
        tryTimeoutS: 30,
    });
    registry.register({name: 'compensate', effectClass: 'reversible', mode: 'plain', idempotentRetryable: true, footprint: ['y'], writes: ['y']});
    registry.register({
        name: 'saga-y',
        effectClass: 'reversible',
        mode: 'saga',
        idempotentRetryable: true,
        footprint: ['y'],
        writes: ['y'],
        compensateTool: 'compensate',
    });
    registry.register({name: 'plain-reversible', effectClass: 'reversible', mode: 'plain', idempotentRetryable: true, footprint: ['z'], writes: ['z']});
    registry.register({name: 'safe', effectClass: 'bufferable', mode: 'plain', idempotentRetryable: true, footprint: ['safe'], writes: ['safe']});
    registry.register({name: 'unsafe', effectClass: 'bufferable', mode: 'plain', idempotentRetryable: false, footprint: ['unsafe'], writes: ['unsafe']});
    registry.register({name: 'pivot-x', effectClass: 'irreversible', mode: 'plain', idempotentRetryable: true, footprint: ['x'], writes: ['x']});
    registry.register({name: 'pivot-y', effectClass: 'irreversible', mode: 'plain', idempotentRetryable: true, footprint: ['y'], writes: ['y']});
    return registry;
}

function tool(id: string, name: string, parents: string[] = [], scopeId?: string, confirmedOutput?: boolean): ProposalVertex {
    return {id, kind: 'tool', tool: name, parents, scopeId, confirmedOutput};
}

function proposal(vertices: ProposalVertex[], scopes: Array<{id: string; members: string[]}>): SubDagProposal {
    return {vertices, scopes};
}

function expectRule(result: ReturnType<typeof checkSubDag>, rule: RuleCode): void {
    expect(result.accepted).toBe(false);
    expect(result.violations.map((violation) => violation.rule)).toContain(rule);
}

describe('Doc 02 check rules', () => {
    it('accepts a valid single-pivot bracket, providing a passing fixture for R1-R11', () => {
        const graph = proposal([tool('try', 'try-x', [], 's'), tool('pivot', 'pivot-x', ['try'], 's'), tool('finish', 'safe', ['pivot'], 's')], [{id: 's', members: ['try', 'pivot', 'finish']}]);
        expect(checkSubDag(graph, validRegistry())).toEqual({accepted: true, violations: []});
    });

    it('rejects R1: a non-idempotent successor after a pivot', () => {
        expectRule(checkSubDag(proposal([tool('pivot', 'pivot-x', [], 's'), tool('unsafe', 'unsafe', ['pivot'], 's')], [{id: 's', members: ['pivot', 'unsafe']}]), validRegistry()), 'R1');
    });

    it('rejects R2: a non-undoable predecessor before a pivot', () => {
        expectRule(checkSubDag(proposal([tool('prefix', 'plain-reversible', [], 's'), tool('pivot', 'pivot-x', ['prefix'], 's')], [{id: 's', members: ['prefix', 'pivot']}]), validRegistry()), 'R2');
    });

    it('rejects R3: two pivots in one scope', () => {
        expectRule(checkSubDag(proposal([tool('first', 'pivot-x', [], 's'), tool('second', 'pivot-y', ['first'], 's')], [{id: 's', members: ['first', 'second']}]), validRegistry()), 'R3');
    });

    it('rejects R4: an incomplete compensation chain', () => {
        const registry = new ToolRegistry();
        registry.register({
            name: 'broken-saga',
            effectClass: 'reversible',
            mode: 'saga',
            idempotentRetryable: true,
            footprint: ['x'],
            compensateTool: 'missing',
        });
        expectRule(checkSubDag(proposal([], []), registry), 'R4');
    });

    it('rejects R5: independent parallel pivots without a confirmation barrier', () => {
        expectRule(
            checkSubDag(
                proposal(
                    [tool('first', 'pivot-x', [], 'a'), tool('second', 'pivot-y', [], 'b')],
                    [
                        {id: 'a', members: ['first']},
                        {id: 'b', members: ['second']},
                    ],
                ),
                validRegistry(),
            ),
            'R5',
        );
    });

    it('rejects R6: a TCC try without complete exits and timeout', () => {
        const registry = new ToolRegistry();
        registry.register({name: 'broken-try', effectClass: 'reversible', mode: 'tcc', idempotentRetryable: true, footprint: ['x']});
        expectRule(checkSubDag(proposal([], []), registry), 'R6');
    });

    it('rejects R7: an unconfirmed cross-scope dependency', () => {
        expectRule(
            checkSubDag(
                proposal(
                    [tool('source', 'saga-y', [], 'a'), tool('reader', 'read', ['source'], 'b')],
                    [
                        {id: 'a', members: ['source']},
                        {id: 'b', members: ['reader']},
                    ],
                ),
                validRegistry(),
            ),
            'R7',
        );
    });

    it('rejects R8: a read dependency that blocks post-pivot recovery', () => {
        expectRule(
            checkSubDag(
                proposal([tool('pivot', 'pivot-x', [], 's'), tool('read', 'read', ['pivot'], 's'), tool('finish', 'safe', ['read'], 's')], [{id: 's', members: ['pivot', 'read', 'finish']}]),
                validRegistry(),
            ),
            'R8',
        );
    });

    it('rejects R9: conflicting parallel writes before a pivot without a barrier', () => {
        expectRule(
            checkSubDag(
                proposal([tool('left', 'try-x', [], 's'), tool('right', 'confirm', [], 's'), tool('pivot', 'pivot-y', ['left'], 's')], [{id: 's', members: ['left', 'right', 'pivot']}]),
                validRegistry(),
            ),
            'R9',
        );
    });

    it('rejects R10: a side-effecting node with no scope', () => {
        expectRule(checkSubDag(proposal([tool('effect', 'safe')], []), validRegistry()), 'R10');
    });

    it('rejects R11: a scope narrower than the footprint-derived minimum', () => {
        expectRule(
            checkSubDag(
                proposal(
                    [tool('try', 'try-x', [], 'a', true), tool('pivot', 'pivot-x', ['try'], 'b')],
                    [
                        {id: 'a', members: ['try']},
                        {id: 'b', members: ['pivot']},
                    ],
                ),
                validRegistry(),
            ),
            'R11',
        );
    });
});
