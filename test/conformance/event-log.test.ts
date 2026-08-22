import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {assertEventDraft, type EventDraft} from '../../engine/src/events.js';

interface FixtureEvent extends EventDraft {
    stream_seq: number;
}

interface FixtureCase {
    name: string;
    valid: boolean;
    expected_scope_state: string;
    events: FixtureEvent[];
}

const fixture = JSON.parse(readFileSync(new URL('../fixtures/event-log-conformance.json', import.meta.url), 'utf8')) as {cases: FixtureCase[]};

function validate(events: FixtureEvent[]): void {
    for (const {stream_seq: _streamSequence, ...event} of events) assertEventDraft(event);
    const pivoted = new Set<string>();
    for (const event of events) {
        if (event.event_type === 'txn/pivot-passed' && event.scope_id) {
            if (pivoted.has(event.scope_id)) throw new Error('duplicate pivot');
            pivoted.add(event.scope_id);
        }
        if (event.event_type === 'txn/cancel' && event.scope_id && pivoted.has(event.scope_id)) throw new Error('post-pivot cancel');
    }
}

function scopeState(events: FixtureEvent[], fallback: string): string {
    let state = fallback;
    for (const event of events) {
        if (event.event_type === 'txn/scope' && typeof event.payload.state === 'string') state = event.payload.state;
        if (event.event_type === 'txn/cancel' && event.payload.phase === 'completed') state = 'cancelled';
    }
    return state;
}

describe('cross-language event-log conformance fixture', () => {
    for (const testCase of fixture.cases) {
        it(testCase.name, () => {
            if (testCase.valid) expect(() => validate(testCase.events)).not.toThrow();
            else expect(() => validate(testCase.events)).toThrow();
            expect(scopeState(testCase.events, 'open')).toBe(testCase.expected_scope_state);
        });
    }
});
