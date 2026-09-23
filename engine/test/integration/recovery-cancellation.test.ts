import {randomUUID} from 'node:crypto';
import {afterAll, describe, expect, it} from 'vitest';
import {Client} from 'pg';
import {coordinatorDatabaseUrl, databaseUrl, engineDatabaseUrl} from '../../../db/config.js';
import {EventStore} from '../../src/log/store.js';
import {DEFAULT_RECOVERY_POLICY, RecoveryLoop, type RecoveryPolicy, type RecoveryResult} from '../../src/recovery.js';
import {cancelBeforeReplan, cancelRequestDiscipline, oneAnswerPerFailure} from '../../src/harness/oracles.js';
import type {EventDraft} from '../../src/log/events.js';
import type {PlannerTurn} from '../../src/planner/planner-loop.js';

/**
 * Engine-initiated cancellation against a real database.
 *
 * The unit tests and the interleaving model decide what the ladder should do; this checks that the
 * schema agrees — that the database accepts exactly the appends the ladder makes and refuses the
 * ones it must never make — and replays the ladder against real rows at every point of a
 * Coordinator's cancellation. The Coordinator is played through its own role and its own SQL
 * functions, step by step, so each split point is reached on purpose rather than by timing.
 */

const engine = new EventStore({connectionString: engineDatabaseUrl, actor: 'engine'});
const coordinatorStore = new EventStore({connectionString: coordinatorDatabaseUrl, actor: 'coordinator'});
const coordinator = new Client({connectionString: coordinatorDatabaseUrl});
const owner = new Client({connectionString: databaseUrl});
await coordinator.connect();
await owner.connect();

const POLICY: RecoveryPolicy = {
    ...DEFAULT_RECOVERY_POLICY,
    pricing: {currency: 'CNY', cache_hit_input_per_million: 1, cache_miss_input_per_million: 4, output_per_million: 16, reference: 'test'},
};
const WORKER = 'cancellation-suite';
const RETRY = {max_attempts: 1, initial_backoff_ms: 0, multiplier: 1, max_backoff_ms: 0};

/** Queue rows this suite created, removed afterwards: the queue is global within the database. */
const created: string[] = [];

afterAll(async () => {
    await owner.query('DELETE FROM work_queue WHERE vertex_id = ANY($1::uuid[])', [created]);
    await coordinator.end();
    await owner.end();
    await engine.close();
    await coordinatorStore.close();
});

interface ScopedRun {
    run: string;
    p1: string;
    p2: string;
    hold: string;
    tool: string;
    scope: string;
}

function tccVertex(vertexId: string, parents: string[], scopeId: string, tool: string): EventDraft {
    return {
        event_type: 'vertex/created',
        vertex_id: vertexId,
        parent_refs: parents,
        scope_id: scopeId,
        payload: {
            role: 'tool',
            tool,
            tool_version: '1.0.0',
            tool_view_digest: `sha256:${'0'.repeat(64)}`,
            input: {sku: 'SKU-1'},
            retry_policy: RETRY,
            txn: {effect_class: 'reversible', mode: 'tcc', idempotency_key: `${vertexId}:try`, try_timeout_s: 600, confirm_tool: `${tool}.confirm`, cancel_tool: `${tool}.release`},
        },
    };
}

/** P1 → P2 → HOLD → TOOL, the last two in one scope; nothing has run past P2 yet. */
async function scopedRun(): Promise<ScopedRun> {
    const shape = {run: await engine.createRun(), p1: randomUUID(), p2: randomUUID(), hold: randomUUID(), tool: randomUUID(), scope: randomUUID()};
    created.push(shape.hold, shape.tool);
    const planner = (id: string, parents: string[]): EventDraft[] => [
        {event_type: 'vertex/created', vertex_id: id, parent_refs: parents, payload: {role: 'planner'}},
        {event_type: 'vertex/started', vertex_id: id, payload: {attempt: 1}},
        {event_type: 'vertex/succeeded', vertex_id: id, payload: {attempts: 1, result: {}}},
    ];
    await engine.appendEvents(shape.run, [
        {event_type: 'run/start', payload: {}},
        ...planner(shape.p1, []),
        ...planner(shape.p2, [shape.p1]),
        tccVertex(shape.hold, [shape.p2], shape.scope, 'inventory.hold'),
        tccVertex(shape.tool, [shape.hold], shape.scope, 'carrier.book'),
    ]);
    return shape;
}

/* ------------------------------------------------ the Coordinator, one SQL call at a time */

async function scoped(run: string, scope: string, events: EventDraft[]): Promise<void> {
    await coordinator.query('SELECT run_seq FROM append_scope_events($1, $2, $3::jsonb)', [run, scope, JSON.stringify(events)]);
}

async function claim(expected: string): Promise<void> {
    const rows = await coordinator.query<{vertex_id: string; run_id: string; scope_id: string}>('SELECT vertex_id, run_id, scope_id FROM claim_ready_work($1, $2)', [WORKER, 60]);
    expect(rows.rows[0]?.vertex_id).toBe(expected);
    await coordinator.query('SELECT ensure_txn_scope($1, $2)', [rows.rows[0]!.run_id, rows.rows[0]!.scope_id]);
}

/** HOLD runs and seals its try. */
async function seal(shape: ScopedRun): Promise<void> {
    await claim(shape.hold);
    await scoped(shape.run, shape.scope, [
        {event_type: 'vertex/started', vertex_id: shape.hold, scope_id: shape.scope, payload: {attempt: 1}},
        {
            event_type: 'txn/try',
            vertex_id: shape.hold,
            scope_id: shape.scope,
            payload: {
                idempotency_key: `${shape.hold}:try`,
                deadline_at: new Date(Date.now() + 600_000).toISOString(),
                confirm_tool: 'inventory.hold.confirm',
                cancel_tool: 'inventory.hold.release',
            },
        },
        {event_type: 'vertex/succeeded', vertex_id: shape.hold, scope_id: shape.scope, payload: {attempts: 1, result: {}}},
    ]);
    await coordinator.query('SELECT complete_work($1, $2)', [WORKER, shape.hold]);
}

/** TOOL runs and fails for good, which fences the scope in the same append. */
async function fail(shape: ScopedRun): Promise<void> {
    await claim(shape.tool);
    await scoped(shape.run, shape.scope, [
        {event_type: 'vertex/started', vertex_id: shape.tool, scope_id: shape.scope, payload: {attempt: 1}},
        {event_type: 'vertex/failed', vertex_id: shape.tool, scope_id: shape.scope, payload: {attempts: 1, outcome: 'permanent-failure', error: 'carrier refused'}},
    ]);
    await coordinator.query('SELECT complete_work($1, $2)', [WORKER, shape.tool]);
}

async function requestScopeCancel(shape: ScopedRun, origin: 'engine' | 'timeout'): Promise<string> {
    const rows = await coordinator.query<{decision: string}>('SELECT request_scope_cancel($1, $2, $3, $4, $5, $6) AS decision', [
        WORKER,
        shape.run,
        shape.scope,
        `scope:${shape.scope}:cancel`,
        'suite',
        origin,
    ]);
    return rows.rows[0]!.decision;
}

/** The Coordinator's cancellation, split into the steps the ladder may land between. */
const coordinatorSteps: {name: string; run(shape: ScopedRun): Promise<void>}[] = [
    {name: 'pickup', run: async (shape) => void expect(await requestScopeCancel(shape, 'engine')).toBe('requested')},
    {
        name: 'inverse',
        run: async (shape) => {
            const member = await coordinator.query<{vertex_id: string}>('SELECT vertex_id FROM claim_cancel_member($1, $2, $3, $4)', [WORKER, shape.run, shape.scope, 60]);
            expect(member.rows[0]?.vertex_id).toBe(shape.hold);
            await coordinator.query('SELECT complete_cancel_member($1, $2, $3, $4)', [WORKER, shape.run, shape.scope, shape.hold]);
        },
    },
    {
        name: 'complete',
        run: (shape) => scoped(shape.run, shape.scope, [{event_type: 'txn/cancel', scope_id: shape.scope, payload: {idempotency_key: `scope:${shape.scope}:cancel`, phase: 'completed'}}]),
    },
];

async function scopeRow(shape: ScopedRun): Promise<{state: string; fenced: boolean; outcome: string | null}> {
    const rows = await owner.query<{state: string; fenced: boolean; outcome: string | null}>(
        'SELECT state, fenced_at IS NOT NULL AS fenced, cancel_request_outcome AS outcome FROM txn_scope WHERE run_id = $1 AND scope_id = $2',
        [shape.run, shape.scope],
    );
    return rows.rows[0]!;
}

/* ------------------------------------------------ the Engine */

const turns: string[] = [];
const recovery = new RecoveryLoop(
    engine,
    {
        async advance(request): Promise<PlannerTurn> {
            turns.push(request.plannerVertexId);
            return {status: 'unreadable', reason: 'stub planner', content: ''};
        },
    },
    POLICY,
);

async function recover(shape: ScopedRun): Promise<RecoveryResult> {
    return recovery.recoverOne({runId: shape.run, taskInput: {}, workflowType: 'suite', goalFor: () => 'decide again'}, {} as never);
}

const requestDraft = (failed: string, scopes: string[]): EventDraft => ({
    event_type: 'replan/cancel-requested',
    payload: {failed_vertex_id: failed, scope_ids: scopes, level: 'L1', reason: 'suite', candidates: []},
});

describe('the database side of engine-initiated cancellation', () => {
    it('fences a scope on a pre-pivot failure, which stops its claims and its pivot', async () => {
        const shape = await scopedRun();
        await seal(shape);
        await fail(shape);
        expect(await scopeRow(shape)).toMatchObject({state: 'open', fenced: true, outcome: null});
        const pivot = await coordinator.query<{admitted: boolean}>('SELECT admit_pivot($1, $2, $3) AS admitted', [shape.run, shape.scope, randomUUID()]);
        expect(pivot.rows[0]!.admitted).toBe(false);
        // Nothing was cancelled: that is the Engine's to ask for.
        const events = await engine.readStream(shape.run);
        expect(events.some((event) => event.event_type === 'txn/cancel')).toBe(false);
    });

    it('lets only the Engine ask, and only once, and only of a scope that can still cancel', async () => {
        const shape = await scopedRun();
        await seal(shape);
        await fail(shape);
        await expect(coordinatorStore.appendEvents(shape.run, [requestDraft(shape.tool, [shape.scope])])).rejects.toThrow(/coordinator_role cannot append/);
        await expect(engine.appendEvents(shape.run, [{event_type: 'txn/cancel', scope_id: shape.scope, payload: {idempotency_key: 'k', phase: 'requested'}}])).rejects.toThrow(
            /engine_role cannot append/,
        );
        // Asking without a request, or around the function, is refused too.
        await expect(requestScopeCancel(shape, 'engine')).rejects.toThrow(/requires an engine request/);
        await expect(scoped(shape.run, shape.scope, [{event_type: 'txn/cancel', scope_id: shape.scope, payload: {idempotency_key: 'k', phase: 'requested'}}])).rejects.toThrow(
            /needs an engine request/,
        );

        await engine.appendEvents(shape.run, [requestDraft(shape.tool, [shape.scope])]);
        expect(await scopeRow(shape)).toMatchObject({fenced: true, outcome: 'pending'});
        await expect(engine.appendEvents(shape.run, [requestDraft(shape.tool, [shape.scope])])).rejects.toThrow(/open, unrequested scope/);

        await coordinatorSteps[0]!.run(shape);
        expect(await scopeRow(shape)).toMatchObject({state: 'cancelling', outcome: 'requested'});
        await expect(engine.appendEvents(shape.run, [requestDraft(shape.tool, [shape.scope])])).rejects.toThrow(/open, unrequested scope/);
        await coordinatorSteps[1]!.run(shape);
        await coordinatorSteps[2]!.run(shape);
    });

    it('refuses a shadow into a scope until its cancellation completes', async () => {
        const shape = await scopedRun();
        await seal(shape);
        await fail(shape);
        const shadow: EventDraft = {event_type: 'subgraph/shadowed', payload: {vertex_ids: [shape.hold, shape.tool], reason: 'suite'}};
        await expect(engine.appendEvents(shape.run, [shadow])).rejects.toThrow(/cannot shadow members of scope/);
        await engine.appendEvents(shape.run, [requestDraft(shape.tool, [shape.scope])]);
        await coordinatorSteps[0]!.run(shape);
        await expect(engine.appendEvents(shape.run, [shadow])).rejects.toThrow(/while it is cancelling/);
        await coordinatorSteps[1]!.run(shape);
        await coordinatorSteps[2]!.run(shape);
        await expect(engine.appendEvents(shape.run, [shadow])).resolves.toHaveLength(1);
    });

    it('resolves a pending request whichever path cancels or suspends its scope', async () => {
        // A request left `pending` on a scope that already closed would be picked up on every poll
        // and fail, and a handful of those at the head of the list starve every request behind them.
        const cancelled = await scopedRun();
        await seal(cancelled);
        await fail(cancelled);
        await engine.appendEvents(cancelled.run, [requestDraft(cancelled.tool, [cancelled.scope])]);
        await scoped(cancelled.run, cancelled.scope, [{event_type: 'txn/cancel', scope_id: cancelled.scope, payload: {idempotency_key: 'another-key', phase: 'requested'}}]);
        expect(await scopeRow(cancelled)).toMatchObject({state: 'cancelling', outcome: 'requested'});

        const suspended = await scopedRun();
        await seal(suspended);
        await fail(suspended);
        await engine.appendEvents(suspended.run, [requestDraft(suspended.tool, [suspended.scope])]);
        await scoped(suspended.run, suspended.scope, [{event_type: 'txn/scope', scope_id: suspended.scope, payload: {state: 'suspended', reason: 'operator hold'}}]);
        expect(await scopeRow(suspended)).toMatchObject({state: 'suspended', outcome: 'suspended'});

        // Leave nothing cancelling behind for another suite's sweep.
        await coordinatorSteps[1]!.run(cancelled);
        await scoped(cancelled.run, cancelled.scope, [{event_type: 'txn/cancel', scope_id: cancelled.scope, payload: {idempotency_key: 'another-key', phase: 'completed'}}]);
    });

    it('converges a sweep and a request on one cancellation', async () => {
        const shape = await scopedRun();
        await seal(shape);
        await fail(shape);
        await engine.appendEvents(shape.run, [requestDraft(shape.tool, [shape.scope])]);
        // The try has not expired, so the sweep has no standing here and says so.
        expect(await requestScopeCancel(shape, 'timeout')).toBe('ineligible');
        expect(await requestScopeCancel(shape, 'engine')).toBe('requested');
        expect(await requestScopeCancel(shape, 'timeout')).toBe('duplicate');
        expect(await requestScopeCancel(shape, 'engine')).toBe('duplicate');
        await coordinatorSteps[1]!.run(shape);
        await coordinatorSteps[2]!.run(shape);
        const cancels = (await engine.readStream(shape.run)).filter((event) => event.event_type === 'txn/cancel');
        expect(cancels.map((event) => event.payload.phase)).toEqual(['requested', 'completed']);
    });
});

describe('the recovery loop against real rows, at every split point of a cancellation', () => {
    // The Engine may run before any Coordinator step, between any two, or after the last. At each
    // position the loop must do the one right thing, and the finished log must satisfy the oracles.
    const expected: RecoveryResult['status'][] = ['cancel_requested', 'awaiting_cancellation', 'awaiting_cancellation', 'replanned'];

    it('asks once, waits through the cancellation, and replans once it completes', async () => {
        const shape = await scopedRun();
        await seal(shape);
        await fail(shape);
        const statuses: RecoveryResult['status'][] = [];
        const before = turns.length;
        statuses.push((await recover(shape)).status);
        for (const step of coordinatorSteps) {
            await step.run(shape);
            statuses.push((await recover(shape)).status);
        }
        expect(statuses).toEqual(expected);
        expect(turns.slice(before)).toEqual([shape.p2]);

        const events = await engine.readStream(shape.run);
        const boundary = events.find((event) => event.event_type === 'replan/boundary')!;
        expect(boundary.payload).toMatchObject({level: 'L1', selected: shape.p2, cancelled_scopes: [shape.scope]});
        expect(cancelBeforeReplan(events)).toMatchObject({passed: true});
        expect(cancelRequestDiscipline(events, {final: true})).toMatchObject({passed: true});
        expect(oneAnswerPerFailure(events)).toMatchObject({passed: true});
        // And the failure is answered: another pass finds nothing to do.
        expect((await recover(shape)).status).toBe('idle');
    });

    it('does the same when the Engine runs repeatedly between every step', async () => {
        const shape = await scopedRun();
        await seal(shape);
        await fail(shape);
        const first = await recover(shape);
        expect(first.status).toBe('cancel_requested');
        // Asking again before the Coordinator moves must not append a second request.
        expect((await recover(shape)).status).toBe('awaiting_cancellation');
        for (const step of coordinatorSteps.slice(0, -1)) {
            await step.run(shape);
            expect((await recover(shape)).status).toBe('awaiting_cancellation');
            expect((await recover(shape)).status).toBe('awaiting_cancellation');
        }
        await coordinatorSteps.at(-1)!.run(shape);
        expect((await recover(shape)).status).toBe('replanned');
        const events = await engine.readStream(shape.run);
        expect(events.filter((event) => event.event_type === 'replan/cancel-requested')).toHaveLength(1);
        expect(events.filter((event) => event.event_type === 'replan/boundary')).toHaveLength(1);
    });

    it('escalates once the Coordinator suspends the cancellation, and replans nothing', async () => {
        const shape = await scopedRun();
        await seal(shape);
        await fail(shape);
        expect((await recover(shape)).status).toBe('cancel_requested');
        await coordinatorSteps[0]!.run(shape);
        // The inverse fails: the Coordinator suspends the scope and never writes `completed`.
        await scoped(shape.run, shape.scope, [{event_type: 'txn/scope', scope_id: shape.scope, payload: {state: 'suspended', reason: 'inverse failed'}}]);
        const result = await recover(shape);
        expect(result.status).toBe('escalated');
        if (result.status !== 'escalated') throw new Error('unreachable');
        expect(result.decision).toMatchObject({level: 'L4', selected: null});
        expect((await recover(shape)).status).toBe('idle');
    });
});

describe('lock order', () => {
    it('never deadlocks a recovery decision against a scoped Coordinator append', async () => {
        // The recovery loop locks the run's scope rows and then appends (run); the Coordinator's
        // scoped appends take the scope row and then append (run). One order, so fifty concurrent
        // pairs complete. Before `append_scope_events`, the Coordinator locked the run first and
        // touched the scope in a trigger, and this pairing was a deadlock waiting to happen.
        const shape = await scopedRun();
        await seal(shape);
        const rounds = Array.from({length: 50}, async () => {
            await Promise.all([
                engine.appendUnderScopeLock(shape.run, () => [{event_type: 'run/end', payload: {}}]),
                scoped(shape.run, shape.scope, [{event_type: 'txn/scope', scope_id: shape.scope, payload: {state: 'open'}}]),
            ]);
        });
        await expect(Promise.all(rounds)).resolves.toHaveLength(50);
    });
});
