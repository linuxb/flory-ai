import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {Ajv2020} from 'ajv/dist/2020.js';
import {EVENT_TYPES, type EventType, type FoldMode, type ForkRequest, type ForkSubstitution} from './generated/event-log.js';

export {EVENT_TYPES, type EventType, type FoldMode, type ForkRequest, type ForkSubstitution};
/** A JSON object suitable for an event payload. */
export type JsonObject = Record<string, unknown>;

/** An event before the store assigns its stream and global sequence numbers. */
export interface EventDraft {
    event_type: EventType | string;
    vertex_id?: string | null;
    parent_refs?: string[];
    planner_id?: string | null;
    scope_id?: string | null;
    pin_version?: string | null;
    ignorable?: boolean;
    payload: JsonObject;
}

/** A persisted event with database-assigned identifiers, provenance, and timestamps. */
export interface StoredEvent extends Required<Omit<EventDraft, 'vertex_id' | 'planner_id' | 'scope_id' | 'pin_version'>> {
    run_id: string;
    run_seq: number;
    global_seq: number;
    vertex_id: string | null;
    planner_id: string | null;
    scope_id: string | null;
    pin_version: string | null;
    /** True when the row is a read-only copy inherited from a fork's source stream. */
    inherited: boolean;
    created_at: string;
}

/** One domain fact of one aggregate root, before the database allocates its stream sequence. */
export interface BusinessFactDraft {
    event_type: string;
    payload: Record<string, unknown>;
}

/** A persisted business-plane row: one domain fact, ordered per entity and stamped with its cause. */
export interface StoredBusinessEvent {
    stream_id: string;
    /** Per-entity position: strict, contiguous, and rollback-safe across every run of the entity. */
    stream_seq: number;
    global_seq: number;
    /**
     * The orchestration step that produced this fact. Null only on the configuration stream, whose
     * rows are caused by a person publishing a template rather than by a run.
     */
    run_id: string | null;
    run_seq: number | null;
    event_type: string;
    /** True for a fork's quarantined writes; production reads exclude them. */
    is_counterfactual: boolean;
    payload: Record<string, unknown>;
    created_at: string;
}

/** The two plane positions one domain fact occupies, allocated in a single transaction. */
export interface DomainAppendResult {
    run_seq: number;
    stream_seq: number;
}

const schema = JSON.parse(readFileSync(resolve(process.cwd(), 'idl/event-log.schema.json'), 'utf8'));
const ajv = new Ajv2020({allErrors: true, strict: false});
ajv.addFormat('uuid', /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
ajv.addFormat('date-time', {validate: (value: string) => !Number.isNaN(Date.parse(value))});
const validateSchema = ajv.compile(schema);
const known = new Set<string>(EVENT_TYPES);

/** Validates that an event draft has a known type and conforms to the shared schema. */
export function assertEventDraft(event: EventDraft): void {
    const candidate = {parent_refs: [], ignorable: false, ...event};
    if (!known.has(event.event_type) && !event.ignorable) throw new Error(`unknown non-ignorable event type: ${event.event_type}`);
    if (!validateSchema(candidate) && !(event.ignorable && typeof event.event_type === 'string' && !known.has(event.event_type))) {
        throw new Error(`invalid event draft: ${ajv.errorsText(validateSchema.errors)}`);
    }
    if (!event.payload || Array.isArray(event.payload) || typeof event.payload !== 'object') throw new Error('event payload must be an object');
}

/** Serializes JSON-compatible data with deterministically ordered object keys. */
export function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') {
        const object = value as Record<string, unknown>;
        return `{${Object.keys(object)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
            .join(',')}}`;
    }
    return JSON.stringify(value);
}
