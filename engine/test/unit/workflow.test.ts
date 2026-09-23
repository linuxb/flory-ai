import {describe, expect, it} from 'vitest';
import {checkSubDag, loadToolRegistry} from '../../src/index.js';
import {compileVertexDrafts, generationOf, lowerToProposal, nextIdempotencyKey, normalizeWorkflow, type BracketRecord, type WorkflowSubmission} from '../../src/admission/workflow.js';
import type {ResolvedToolView} from '../../src/gateway/gateway-client.js';
import type {ToolViewDocument} from '../../src/gateway/tool-view.js';

const digest = `sha256:${'a'.repeat(64)}`;

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
                // Thousandths in the view; the event schema wants a plain number.
                retry_constraints: {max_attempts: 3, initial_backoff_ms: 100, multiplier_milli: 2500, max_backoff_ms: 5000},
                owner: 'team',
                allowed_roles: ['operator'],
            },
            {
                tool_id: 'record.reserve',
                tool_version: '1.0.0',
                input_schema: {type: 'object'},
                output_schema: {type: 'object'},
                route_id: 'route-reserve',
                adapter: {protocol: 'grpc'},
                // Declares which field of its input names the operation, which is what makes two
                // calls the same call.
                txn: {
                    effect_class: 'reversible',
                    mode: 'tcc',
                    idempotent_retryable: true,
                    idempotency_key_path: '$.order_id',
                    try_timeout_s: 60,
                    confirm_tool: 'record.read',
                    cancel_tool: 'record.read',
                },
                compensation_style: 'delta',
                footprint: ['record'],
                writes: ['record'],
                timeout_ms: 1000,
                retry_constraints: {max_attempts: 3, initial_backoff_ms: 100, multiplier_milli: 2500, max_backoff_ms: 5000},
                owner: 'team',
                allowed_roles: ['operator'],
            },
        ],
    };
    return {identity: {tool_view_ref: 'tool-views/x.json', tool_view_digest: digest}, document, registry: loadToolRegistry(document)};
}

function submission(vertices: WorkflowSubmission['vertices'], scopes?: WorkflowSubmission['scopes']): WorkflowSubmission {
    return {submissionId: 'sub-1', schemaVersion: 'v1', vertices, ...(scopes ? {scopes} : {})};
}

describe('workflow normalization', () => {
    it('interposes one router ahead of a planner and leaves the rest of the graph alone', () => {
        const {workflow, interposed} = normalizeWorkflow(
            submission([
                {id: 'lookup', kind: 'tool', tool: 'record.read'},
                {id: 'decide', kind: 'planner', parents: ['lookup']},
            ]),
        );
        expect(interposed).toEqual(['decide#router']);
        const routed = workflow.vertices.find((vertex) => vertex.id === 'decide#router');
        expect(routed).toMatchObject({kind: 'router', parents: ['lookup']});
        expect(workflow.vertices.find((vertex) => vertex.id === 'decide')?.parents).toEqual(['decide#router']);
    });

    it('puts every parent of a planner behind one router, whatever their roles', () => {
        const {workflow, interposed} = normalizeWorkflow(
            submission([
                {id: 'a', kind: 'tool', tool: 'record.read'},
                {id: 'b', kind: 'tool', tool: 'record.read'},
                {id: 'gate', kind: 'confirmation-barrier', parents: ['a', 'b']},
                {id: 'decide', kind: 'planner', parents: ['a', 'b', 'gate']},
            ]),
        );
        expect(interposed).toEqual(['decide#router']);
        expect(workflow.vertices.find((vertex) => vertex.id === 'decide#router')?.parents).toEqual(['a', 'b', 'gate']);
        expect(workflow.vertices.find((vertex) => vertex.id === 'decide')?.parents).toEqual(['decide#router']);
    });

    it('is idempotent, which is what lets R14 be asserted as a post-condition', () => {
        const once = normalizeWorkflow(
            submission([
                {id: 'lookup', kind: 'tool', tool: 'record.read'},
                {id: 'decide', kind: 'planner', parents: ['lookup']},
            ]),
        );
        const twice = normalizeWorkflow(once.workflow);
        expect(twice.workflow).toEqual(once.workflow);
        expect(twice.interposed).toEqual([]);
    });

    it('leaves a planner that already sits behind a router alone, and a parentless planner too', () => {
        const declared = submission([
            {id: 'lookup', kind: 'tool', tool: 'record.read'},
            {id: 'junction', kind: 'router', parents: ['lookup'], templateRef: 'rule://x@v1'},
            {id: 'decide', kind: 'planner', parents: ['junction']},
        ]);
        expect(normalizeWorkflow(declared)).toEqual({workflow: declared, interposed: []});

        // A run-opening planner has no incoming edge to intercept and nothing upstream to read.
        const root = submission([{id: 'decide', kind: 'planner'}]);
        expect(normalizeWorkflow(root)).toEqual({workflow: root, interposed: []});
    });

    it('leaves a workflow with no planner untouched', () => {
        const original = submission([
            {id: 'a', kind: 'tool', tool: 'record.read'},
            {id: 'b', kind: 'tool', tool: 'record.read', parents: ['a']},
        ]);
        expect(normalizeWorkflow(original).workflow).toEqual(original);
    });

    it('rejects an unknown parent instead of compiling a dangling edge', () => {
        expect(() => normalizeWorkflow(submission([{id: 'decide', kind: 'planner', parents: ['ghost']}]))).toThrow('unknown parent ghost');
    });

    it('produces a graph the checker admits, where the unnormalized one violates R14', () => {
        const original = submission([
            {id: 'lookup', kind: 'tool', tool: 'record.read'},
            {id: 'decide', kind: 'planner', parents: ['lookup']},
        ]);
        const registry = view().registry;
        expect(checkSubDag(lowerToProposal(original), registry).violations.map((violation) => violation.rule)).toContain('R14');
        expect(checkSubDag(lowerToProposal(normalizeWorkflow(original).workflow), registry)).toEqual({accepted: true, violations: []});
    });
});

describe('workflow lowering and compilation', () => {
    it('drops everything the checker must not read', () => {
        const lowered = lowerToProposal(
            submission([
                {id: 'lookup', kind: 'tool', tool: 'record.read', input: {secret: 'value'}, idempotencyKey: 'k'},
                {id: 'junction', kind: 'router', parents: ['lookup'], templateRef: 'rule://x@v1'},
                {id: 'decide', kind: 'planner', parents: ['junction'], goal: 'decide something'},
            ]),
        );
        expect(JSON.stringify(lowered)).not.toContain('secret');
        expect(JSON.stringify(lowered)).not.toContain('decide something');
        expect(lowered.vertices.map((vertex) => vertex.kind)).toEqual(['tool', 'router', 'planner']);
    });

    it('converts the retry multiplier out of thousandths', () => {
        const compiled = compileVertexDrafts(submission([{id: 'lookup', kind: 'tool', tool: 'record.read'}]), view(), new Map(), () => '00000000-0000-4000-8000-000000000001');
        const payload = compiled.drafts[0]!.payload as {retry_policy: {multiplier: number}};
        expect(payload.retry_policy.multiplier).toBe(2.5);
    });

    it('carries the scope as a column and the effect class into the payload, which is what the database routes on', () => {
        const compiled = compileVertexDrafts(submission([{id: 'lookup', kind: 'tool', tool: 'record.read', scope: 's'}], [{id: 's', members: ['lookup']}]), view());
        const draft = compiled.drafts[0]!;
        expect(draft.scope_id).toBe(compiled.scopeIds.get('s'));
        expect((draft.payload as {txn: {effect_class: string}}).txn.effect_class).toBe('none');
    });

    it('emits parents before children and records the origin of each router', () => {
        const {workflow} = normalizeWorkflow(
            submission([
                {id: 'decide', kind: 'planner', parents: ['lookup']},
                {id: 'lookup', kind: 'tool', tool: 'record.read'},
            ]),
        );
        const compiled = compileVertexDrafts(workflow, view());
        const order = compiled.drafts.map((draft) => draft.vertex_id);
        expect(order.indexOf(compiled.vertexIds.get('lookup')!)).toBeLessThan(order.indexOf(compiled.vertexIds.get('decide#router')!));
        const routerDraft = compiled.drafts.find((draft) => draft.vertex_id === compiled.vertexIds.get('decide#router'));
        expect(routerDraft!.payload).toMatchObject({role: 'router', origin: 'interposed'});
        expect(routerDraft!.parent_refs).toEqual([compiled.vertexIds.get('lookup')]);
    });

    it('allocates a fresh vertex id per compilation, never one derived from the submission', () => {
        const input = submission([{id: 'lookup', kind: 'tool', tool: 'record.read'}]);
        const first = compileVertexDrafts(input, view());
        const second = compileVertexDrafts(input, view());
        expect(first.vertexIds.get('lookup')).not.toBe(second.vertexIds.get('lookup'));
    });
});

describe('frozen idempotency key', () => {
    /** Reads the transaction block a compiled tool vertex carries. */
    function txnOf(vertices: WorkflowSubmission['vertices'], scopes?: WorkflowSubmission['scopes']): Record<string, unknown> {
        const compiled = compileVertexDrafts(submission(vertices, scopes), view());
        return (compiled.drafts[0]!.payload as {txn: Record<string, unknown>}).txn;
    }

    it('resolves the key the contract says names the operation', () => {
        const txn = txnOf([{id: 'hold', kind: 'tool', tool: 'record.reserve', scope: 's', input: {order_id: 'ORDER-1', sku: 'SKU-1'}}], [{id: 's', members: ['hold']}]);
        // `txn_bracket` is keyed by this, so leaving it unset makes the first bracket in the
        // database collide with every later one.
        expect(txn.idempotency_key).toBe('record.reserve:ORDER-1');
    });

    it('lets an author override it, and leaves a tool that declares no key path alone', () => {
        const overridden = txnOf([{id: 'hold', kind: 'tool', tool: 'record.reserve', scope: 's', idempotencyKey: 'chosen', input: {order_id: 'ORDER-1'}}], [{id: 's', members: ['hold']}]);
        expect(overridden.idempotency_key).toBe('chosen');
        expect(txnOf([{id: 'look', kind: 'tool', tool: 'record.read'}])).not.toHaveProperty('idempotency_key');
    });

    it('fails the freeze when the declared path names nothing in the input', () => {
        // An empty key would be accepted by the schema and then collide at the first other bracket,
        // so refusing here is the only outcome that stays visible.
        expect(() => txnOf([{id: 'hold', kind: 'tool', tool: 'record.reserve', scope: 's', input: {sku: 'SKU-1'}}], [{id: 's', members: ['hold']}])).toThrow('resolves to nothing');
    });
});

describe('a key after a cancellation', () => {
    const base = 'record.reserve:ORDER-1';
    const bracket = (idempotencyKey: string, state: BracketRecord['state']): BracketRecord => ({idempotencyKey, state});

    it('reads a generation off a key, and nothing off a key that is not one', () => {
        expect(generationOf(base, base)).toBe(1);
        expect(generationOf(base, `${base}#3`)).toBe(3);
        expect(generationOf(base, `${base}#x`)).toBeNull();
        expect(generationOf(base, `${base}#0`)).toBeNull();
        expect(generationOf(base, `${base}0`)).toBeNull();
        expect(generationOf(base, 'record.reserve:ORDER-10')).toBeNull();
    });

    it('keeps the business key when nothing is bracketed under it', () => {
        expect(nextIdempotencyKey(base, [])).toBe(base);
        // A key that merely starts the same way belongs to a different order.
        expect(nextIdempotencyKey(base, [bracket('record.reserve:ORDER-10', 'cancelled')])).toBe(base);
    });

    it('moves on past a cancelled generation, and past every one of them', () => {
        // The live run's case: a replan reserving for an order whose reservation was cancelled.
        expect(nextIdempotencyKey(base, [bracket(base, 'cancelled')])).toBe(`${base}#2`);
        expect(nextIdempotencyKey(base, [bracket(`${base}#2`, 'cancelled'), bracket(base, 'cancelled')])).toBe(`${base}#3`);
        // Order of the history does not matter, and a stray non-generation key is ignored.
        expect(nextIdempotencyKey(base, [bracket(`${base}#x`, 'cancelled'), bracket(base, 'cancelled'), bracket(`${base}#4`, 'cancelled')])).toBe(`${base}#5`);
    });

    it('keeps a live key, so a genuine duplicate is refused rather than given a fresh identity', () => {
        expect(nextIdempotencyKey(base, [bracket(base, 'sealed')])).toBe(base);
        expect(nextIdempotencyKey(base, [bracket(base, 'cancelled'), bracket(`${base}#2`, 'confirmed')])).toBe(`${base}#2`);
        // Even a live generation below a cancelled newer one — which should not exist — wins: a
        // fresh key there would make a second live reservation for one operation.
        expect(nextIdempotencyKey(base, [bracket(base, 'sealed'), bracket(`${base}#2`, 'cancelled')])).toBe(base);
    });

    it('freezes a call under the key its bracket history calls for', () => {
        const history = new Map([[base, [bracket(base, 'cancelled')]]]);
        const compiled = compileVertexDrafts(
            submission([{id: 'hold', kind: 'tool', tool: 'record.reserve', scope: 's', input: {order_id: 'ORDER-1'}}], [{id: 's', members: ['hold']}]),
            view(),
            new Map(),
            undefined,
            history,
        );
        expect((compiled.drafts[0]!.payload as {txn: {idempotency_key: string}}).txn.idempotency_key).toBe(`${base}#2`);
        // An author-chosen key has a history too, and moves on the same way.
        const chosen = compileVertexDrafts(
            submission([{id: 'hold', kind: 'tool', tool: 'record.reserve', scope: 's', idempotencyKey: 'chosen', input: {order_id: 'ORDER-1'}}], [{id: 's', members: ['hold']}]),
            view(),
            new Map(),
            undefined,
            new Map([['chosen', [bracket('chosen', 'cancelled')]]]),
        );
        expect((chosen.drafts[0]!.payload as {txn: {idempotency_key: string}}).txn.idempotency_key).toBe('chosen#2');
    });
});
