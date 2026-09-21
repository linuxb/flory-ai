import {describe, expect, it, vi} from 'vitest';
import {PlannerLoop} from '../../src/planner-loop.js';
import {loadToolRegistry} from '../../src/tool-view.js';
import type {ResolvedToolView} from '../../src/gateway-client.js';
import type {ToolViewDocument} from '../../src/tool-view.js';
import type {EventDraft} from '../../src/events.js';
import type {WorkflowSubmission} from '../../src/workflow.js';

const digest = `sha256:${'c'.repeat(64)}`;
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
        },
    ],
};
const view: ResolvedToolView = {identity: {tool_view_ref: 'tool-views/x.json', tool_view_digest: digest}, document, registry: loadToolRegistry(document)};

/**
 * Drives one turn with a scripted model answer and returns what the submitter was handed.
 *
 * The submitter is a spy rather than the real one: this file is about what a model answer is
 * allowed to become, and the freeze path has its own tests.
 */
async function turnOn(answer: string): Promise<{submitted?: WorkflowSubmission; status: string; reason?: string; recorded: EventDraft[]}> {
    const submit = vi.fn(async (_runId: string, _submission: WorkflowSubmission) => ({status: 'accepted' as const, proposedSeq: 1, frozenSeq: 2, vertexIds: new Map<string, string>()}));
    // The planner has to exist on the surface for its context to be projected at all.
    const events = [
        {run_id: 'run-1', run_seq: 1, global_seq: 1, event_type: 'vertex/created', vertex_id: 'planner-1', parent_refs: [], payload: {role: 'planner'}, inherited: false, ignorable: false},
    ];
    // An unreadable answer is appended to the log rather than only returned, so the fake store
    // has to accept it — and capturing it is how the tests below check what was recorded.
    const recorded: EventDraft[] = [];
    const store = {readStream: async () => events, appendEvents: async (_runId: string, drafts: EventDraft[]) => void recorded.push(...drafts)};
    const loop = new PlannerLoop(store as never, {execute: async () => ({content: answer})} as never, {submit} as never, {
        projector_version: 'projector@v1',
        harness_state_version: 'harness@v1',
    });
    const turn = await loop.advance({runId: 'run-1', plannerVertexId: 'planner-1', taskInput: {}, workflowType: 'demo', goal: 'go'}, view);
    return {submitted: submit.mock.calls[0]?.[1], status: turn.status, recorded, ...(turn.status === 'unreadable' ? {reason: turn.reason} : {})};
}

describe('reading a model answer', () => {
    it('accepts tool and planner vertices and attaches them where the engine decided', async () => {
        const {submitted, status} = await turnOn('{"vertices":[{"id":"look","kind":"tool","tool":"record.read","input":{"sku":"S"}},{"id":"next","kind":"planner","parents":["look"]}]}');
        expect(status).toBe('frozen');
        expect(submitted?.vertices.map((vertex) => vertex.id)).toEqual(['look', 'next']);
        // The planner never says where its work lands; the engine is the only party that knows.
        expect(submitted?.attachTo).toEqual(['planner-1']);
    });

    it('tolerates a markdown fence and nothing else', async () => {
        expect((await turnOn('```json\n{"vertices":[{"id":"look","kind":"tool","tool":"record.read"}]}\n```')).status).toBe('frozen');
        expect(await turnOn('Sure! Here is the plan.')).toMatchObject({status: 'unreadable', reason: expect.stringContaining('not JSON')});
    });

    it("refuses a router, because routing is not the planner's to decide", async () => {
        expect(await turnOn('{"vertices":[{"id":"r","kind":"router"}]}')).toMatchObject({status: 'unreadable', reason: expect.stringContaining('only tool and planner')});
    });

    it("records an unreadable answer, so the run's stall is in the log", async () => {
        // Without this the stall is invisible. The planner succeeded, nothing failed, and no
        // executor will call a succeeded planner again — so the run stops with nothing anywhere
        // saying why, and the recovery ladder has no trigger to find.
        const {recorded, status} = await turnOn('not json at all');
        expect(status).toBe('unreadable');
        expect(recorded).toHaveLength(1);
        expect(recorded[0]).toMatchObject({event_type: 'subgraph/unreadable', vertex_id: 'planner-1'});
        const payload = recorded[0]!.payload as {planner_vertex_id: string; reason: string; answer_digest: string; answer_length: number};
        expect(payload.planner_vertex_id).toBe('planner-1');
        expect(payload.reason).toMatch(/json/i);
        // The answer itself is not retained, for the same reason no prompt is. Its digest still
        // tells an operator whether two runs got the same bad answer.
        expect(payload.answer_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(payload.answer_length).toBe('not json at all'.length);
    });

    it('records nothing extra when the answer was readable', async () => {
        const {recorded, status} = await turnOn('{"vertices":[{"id":"look","kind":"tool","tool":"record.read","input":{}}]}');
        expect(status).toBe('frozen');
        expect(recorded).toEqual([]);
    });

    it('refuses a parent outside the answer', async () => {
        // A model that has seen the existing graph will sometimes name a vertex from it. That has to
        // arrive as a refusal, not as an exception out of the freeze path.
        expect(await turnOn('{"vertices":[{"id":"look","kind":"tool","tool":"record.read","parents":["4ef0-existing"]}]}')).toMatchObject({
            status: 'unreadable',
            reason: expect.stringContaining('not in this answer'),
        });
    });

    it('reads scope membership from whichever end the model wrote it', async () => {
        // A vertex names its scope and a scope lists its members: the same fact from two ends, and
        // a model that writes only one has still said it.
        const {submitted} = await turnOn('{"vertices":[{"id":"a","kind":"tool","tool":"record.read"}],"scopes":[{"id":"s","members":["a"]}]}');
        expect(submitted?.vertices[0]).toMatchObject({scope: 's'});
        expect(submitted?.scopes).toEqual([{id: 's', members: ['a']}]);

        const other = await turnOn('{"vertices":[{"id":"a","kind":"tool","tool":"record.read","scope":"s"}],"scopes":[{"id":"s","members":[]}]}');
        expect(other.submitted?.scopes).toEqual([{id: 's', members: ['a']}]);
    });

    it('refuses membership the two ends disagree about', async () => {
        expect(await turnOn('{"vertices":[{"id":"a","kind":"tool","tool":"record.read"}],"scopes":[{"id":"s","members":["a"]},{"id":"t","members":["a"]}]}')).toMatchObject({
            status: 'unreadable',
            reason: expect.stringContaining('claimed by both'),
        });
        expect(await turnOn('{"vertices":[{"id":"a","kind":"tool","tool":"record.read","scope":"missing"}]}')).toMatchObject({
            status: 'unreadable',
            reason: expect.stringContaining('not declared'),
        });
    });

    it('refuses an empty plan and a tool vertex with no tool', async () => {
        expect(await turnOn('{"vertices":[]}')).toMatchObject({status: 'unreadable', reason: expect.stringContaining('no vertices')});
        expect(await turnOn('{"vertices":[{"id":"a","kind":"tool"}]}')).toMatchObject({status: 'unreadable', reason: expect.stringContaining('no tool')});
    });
});
