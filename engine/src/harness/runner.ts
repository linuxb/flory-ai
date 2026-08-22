import type {EventDraft, StoredEvent} from '../events.js';
import {EventStore} from '../store.js';
import {noInheritedMutation, type OracleResult} from './oracles.js';

/** A pure harness assertion supplied by the framework or a test fixture package. */
export type FixtureOracle = (events: StoredEvent[]) => OracleResult;

/** A sequence of drafts and optional expected oracle names for a harness run. */
export interface Fixture {
    id: string;
    events: EventDraft[];
    expected?: {oracle_names?: string[]};
}
/** The persisted events and oracle outcomes from one fixture run. */
export interface FixtureResult {
    id: string;
    run_id: string;
    events: StoredEvent[];
    oracles: OracleResult[];
}
/** Persists a fixture and evaluates the harness oracles against its stream. */
export async function runFixture(store: EventStore, fixture: Fixture, oracles: FixtureOracle[] = [noInheritedMutation]): Promise<FixtureResult> {
    const runId = await store.createRun();
    await store.appendEvents(runId, fixture.events);
    const events = await store.readStream(runId);
    return {id: fixture.id, run_id: runId, events, oracles: oracles.map((oracle) => oracle(events))};
}
