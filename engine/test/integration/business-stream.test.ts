import {randomUUID} from 'node:crypto';
import {afterAll, describe, expect, it} from 'vitest';
import {Client} from 'pg';
import {databaseUrl, engineDatabaseUrl} from '../../../db/config.js';
import {EventStore} from '../../src/store.js';

const engine = new EventStore({connectionString: engineDatabaseUrl, actor: 'engine'});
const plannerId = '00000000-0000-4000-8000-000000000201';

/** A distinct entity per test, so this file never contends with another suite on one stream row. */
function entity(): string {
    return `order:${randomUUID()}`;
}

async function plannerRun(): Promise<string> {
    const run = await engine.createRun();
    await engine.appendEvents(run, [
        {event_type: 'run/start', payload: {schema_version: 'v1'}},
        {event_type: 'vertex/created', vertex_id: plannerId, pin_version: 'model://planner@v1', payload: {role: 'planner'}},
    ]);
    return run;
}

afterAll(async () => {
    await engine.close();
});

describe('business plane', () => {
    it('allocates both sequences for one domain event and records its cause', async () => {
        const run = await plannerRun();
        const streamId = entity();
        const placed = await engine.appendDomainEvents(run, streamId, {event_type: 'vertex/succeeded', vertex_id: plannerId, payload: {result: 'ok'}}, [
            {event_type: 'order/placed', payload: {total: 1250}},
            {event_type: 'order/line-added', payload: {sku: 'SKU-123'}},
        ]);

        // One orchestration step, two facts: the run advances once, the entity twice.
        expect(placed.map((row) => row.stream_seq)).toEqual([1, 2]);
        expect(new Set(placed.map((row) => row.run_seq)).size).toBe(1);

        const runEvents = await engine.readStream(run);
        expect(runEvents.map((event) => event.run_seq)).toEqual([1, 2, 3]);
        const cause = runEvents.find((event) => event.run_seq === placed[0]!.run_seq);
        expect(cause?.event_type).toBe('vertex/succeeded');

        const facts = await engine.readBusinessStream(streamId);
        expect(facts.map((fact) => fact.event_type)).toEqual(['order/placed', 'order/line-added']);
        expect(facts.every((fact) => fact.run_id === run && fact.run_seq === placed[0]!.run_seq)).toBe(true);
        expect(facts.every((fact) => fact.is_counterfactual === false)).toBe(true);
    });

    it('un-increments both counters when the append fails, leaving neither ordering with a gap', async () => {
        const run = await plannerRun();
        const streamId = entity();
        await engine.appendDomainEvents(run, streamId, {event_type: 'vertex/succeeded', vertex_id: plannerId, payload: {}}, [{event_type: 'order/placed', payload: {}}]);

        // A coordinator-owned event from the engine actor is refused by the ownership trigger, so
        // the failure happens inside the same transaction that already advanced the run counter.
        await expect(
            engine.appendDomainEvents(run, streamId, {event_type: 'txn/scope', scope_id: randomUUID(), payload: {state: 'open'}}, [{event_type: 'order/paid', payload: {}}]),
        ).rejects.toThrow();

        // The rollback is the whole reason both counters live in rows rather than in sequences.
        const next = await engine.appendDomainEvents(run, streamId, {event_type: 'vertex/succeeded', vertex_id: plannerId, payload: {}}, [{event_type: 'order/paid', payload: {amount: 1250}}]);
        expect(next[0]!.stream_seq).toBe(2);
        const runEvents = await engine.readStream(run);
        expect(runEvents.map((event) => event.run_seq)).toEqual([1, 2, 3, 4]);
    });

    it('keys the business plane on the entity alone, with no partition-key workaround', async () => {
        const owner = new Client({connectionString: databaseUrl});
        await owner.connect();
        try {
            const key = await owner.query<{attname: string}>(
                `SELECT a.attname FROM pg_constraint c
                 JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
                 WHERE c.contype = 'p' AND c.conrelid = 'business_event_stream'::regclass
                 ORDER BY a.attname`,
            );
            expect(key.rows.map((row) => row.attname)).toEqual(['stream_id', 'stream_seq']);

            const streamId = entity();
            const run = await plannerRun();
            await engine.appendDomainEvents(run, streamId, {event_type: 'vertex/succeeded', vertex_id: plannerId, payload: {}}, [{event_type: 'order/placed', payload: {}}]);
            await expect(
                owner.query(`INSERT INTO business_event_stream (stream_id, stream_seq, run_id, run_seq, event_type, payload) VALUES ($1, 1, $2, 1, 'order/placed', '{}'::jsonb)`, [streamId, run]),
            ).rejects.toMatchObject({code: '23505'});
        } finally {
            await owner.end();
        }
    });

    it('takes no stream lock for an orchestration-only append', async () => {
        const run = await plannerRun();
        const streamId = entity();
        await engine.appendDomainEvents(run, streamId, {event_type: 'vertex/succeeded', vertex_id: plannerId, payload: {}}, [{event_type: 'order/placed', payload: {}}]);

        const holder = new Client({connectionString: databaseUrl});
        await holder.connect();
        try {
            await holder.query('BEGIN');
            await holder.query('SELECT 1 FROM stream WHERE stream_id = $1 FOR UPDATE', [streamId]);

            // The single-lock path must be unaffected by a held stream row.
            await expect(engine.appendEvents(run, [{event_type: 'run/end', payload: {status: 'ok'}}])).resolves.toBeDefined();

            // The dual path must actually contend for it, or the lock order claim is untested.
            const blocked = new Client({connectionString: engineDatabaseUrl});
            await blocked.connect();
            try {
                await blocked.query("SET statement_timeout = '700ms'");
                await expect(
                    blocked.query(`SELECT run_seq, stream_seq FROM append_domain_events($1, $2, $3::jsonb, $4::jsonb)`, [
                        run,
                        streamId,
                        JSON.stringify({event_type: 'vertex/succeeded', vertex_id: plannerId, payload: {}}),
                        JSON.stringify([{event_type: 'order/shipped', payload: {}}]),
                    ]),
                ).rejects.toMatchObject({code: '57014'});
            } finally {
                await blocked.end();
            }
        } finally {
            // vitest runs files serially, so a leaked row lock would hang the whole suite.
            await holder.query('ROLLBACK').catch(() => undefined);
            await holder.end();
        }
    });

    it('creates no stream row for a run that only appends orchestration events', async () => {
        const run = await plannerRun();
        const streamId = entity();
        await engine.appendEvents(run, [{event_type: 'vertex/succeeded', vertex_id: plannerId, payload: {}}]);

        const owner = new Client({connectionString: databaseUrl});
        await owner.connect();
        try {
            const rows = await owner.query<{count: string}>('SELECT count(*) AS count FROM stream WHERE stream_id = $1', [streamId]);
            expect(Number(rows.rows[0]!.count)).toBe(0);
        } finally {
            await owner.end();
        }
    });

    it('quarantines a fork: the live entity is untouched and the synthetic stream reads empty', async () => {
        const run = await plannerRun();
        const streamId = entity();
        await engine.appendEvents(run, [{event_type: 'vertex/succeeded', vertex_id: plannerId, payload: {result: {plan: 'ok'}}}]);
        await engine.appendDomainEvents(run, streamId, {event_type: 'vertex/succeeded', vertex_id: plannerId, payload: {}}, [{event_type: 'order/placed', payload: {total: 1250}}]);
        const before = await engine.readBusinessStream(streamId);

        const fork = await engine.fork({
            source_run_id: run,
            at_vertex_id: plannerId,
            substitutions: [],
            eval_up_to_seq: 3,
            fold_mode: 'recorded',
            evaluator_pin: 'eval://surface-identity@v1',
            projector_version: 'proj://v1',
            harness_state_version: 'hs://v1',
        });

        // A fork writing the live entity is refused outright; quarantine is not a convention.
        await expect(
            engine.appendDomainEvents(fork.child_run_id, streamId, {event_type: 'vertex/succeeded', vertex_id: plannerId, payload: {}}, [{event_type: 'order/refunded', payload: {}}]),
        ).rejects.toThrow('fork:');

        const synthetic = `fork:${fork.child_run_id}:${streamId}`;
        await engine.appendDomainEvents(fork.child_run_id, synthetic, {event_type: 'vertex/succeeded', vertex_id: plannerId, payload: {}}, [{event_type: 'order/refunded', payload: {amount: 1250}}]);

        // The source entity's head and rows are unchanged.
        expect(await engine.readBusinessStream(streamId)).toEqual(before);

        // Namespace and flag are independent halves: a production read of the synthetic stream is
        // empty even though the rows exist under that exact id.
        expect(await engine.readBusinessStream(synthetic)).toEqual([]);
        const quarantined = await engine.readBusinessStream(synthetic, {includeCounterfactual: true});
        expect(quarantined.map((fact) => fact.event_type)).toEqual(['order/refunded']);
        expect(quarantined.every((fact) => fact.is_counterfactual)).toBe(true);
    });
});
