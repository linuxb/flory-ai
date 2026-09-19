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

function planner(id: string, parents: string[] = []): ProposalVertex {
    return {id, kind: 'planner', parents};
}

function router(id: string, parents: string[] = [], templateRef?: string): ProposalVertex {
    return {id, kind: 'router', parents, ...(templateRef ? {templateRef} : {})};
}

function barrier(id: string, parents: string[]): ProposalVertex {
    return {id, kind: 'confirmation-barrier', parents};
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

    it('rejects a tool caller handing control straight to a planner (R14)', () => {
        const graph = proposal([tool('lookup', 'read'), planner('decide', ['lookup'])], []);
        expectRule(checkSubDag(graph, validRegistry()), 'R14');
    });

    it('accepts the same edge once a router carries it, and stays silent for non-tool parents', () => {
        const routed = proposal([tool('lookup', 'read'), router('junction', ['lookup']), planner('decide', ['junction'])], []);
        expect(checkSubDag(routed, validRegistry())).toEqual({accepted: true, violations: []});
        const viaBarrier = proposal([tool('a', 'read'), tool('b', 'read'), barrier('gate', ['a', 'b']), planner('decide', ['gate'])], []);
        expect(checkSubDag(viaBarrier, validRegistry()).violations.map((violation) => violation.rule)).not.toContain('R14');
    });

    it('rejects a router or planner that joins a transaction scope (R12)', () => {
        const scoped = proposal([{id: 'junction', kind: 'router', parents: [], scopeId: 's'}], [{id: 's', members: []}]);
        expectRule(checkSubDag(scoped, validRegistry()), 'R12');
        const member = proposal([router('junction')], [{id: 's', members: ['junction']}]);
        expectRule(checkSubDag(member, validRegistry()), 'R12');
    });

    it('never asks a router for a scope, so R10 stays a tool-only obligation', () => {
        const graph = proposal([tool('lookup', 'read'), router('junction', ['lookup'])], []);
        expect(checkSubDag(graph, validRegistry())).toEqual({accepted: true, violations: []});
    });

    it('treats a non-tool vertex naming a tool as a structural contradiction, not a violation', () => {
        const graph = proposal([{id: 'junction', kind: 'router', parents: [], tool: 'read'}], []);
        expect(() => checkSubDag(graph, validRegistry())).toThrow('must not name a tool');
    });

    it('does not read a cross-scope dirty read through a non-tool parent (R7)', () => {
        // A router parent has no output another scope could read, so the R7 clause that tests for
        // side effects must not fire merely because the parent is not a tool.
        const graph = proposal(
            [tool('try', 'try-x', [], 'a'), router('junction', ['try']), tool('later', 'read', ['junction'], 'b')],
            [
                {id: 'a', members: ['try']},
                {id: 'b', members: ['later']},
            ],
        );
        expect(checkSubDag(graph, validRegistry()).violations.map((violation) => violation.rule)).not.toContain('R7');
    });
});
