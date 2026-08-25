import {createHash} from 'node:crypto';
import {type EffectClass, ToolRegistry, type ToolMode} from './check-rules.js';

/** The transaction contract of one published tool, in the event log's own vocabulary. */
export interface ToolViewTransaction {
    effect_class: EffectClass;
    mode: ToolMode;
    idempotency_key_path?: string;
    idempotent_retryable: boolean;
    try_timeout_s?: number;
    confirm_tool?: string;
    cancel_tool?: string;
    compensate_tool?: string;
    status_tool?: string;
}

/** The retry envelope an executor may not exceed for a tool. */
export interface ToolViewRetry {
    max_attempts: number;
    initial_backoff_ms: number;
    /** Thousandths, so the whole document is integer-valued and has a canonical text form. */
    multiplier_milli: number;
    max_backoff_ms: number;
}

/** One immutable published contract. */
export interface ToolViewTool {
    tool_id: string;
    tool_version: string;
    description?: string;
    input_schema: Record<string, unknown>;
    output_schema: Record<string, unknown>;
    route_id: string;
    adapter: {protocol: string; operation?: string};
    txn: ToolViewTransaction;
    compensation_style: string;
    footprint: string[];
    writes: string[];
    timeout_ms: number;
    retry_constraints: ToolViewRetry;
    owner: string;
}

/** One complete published tool view. */
export interface ToolViewDocument {
    tool_view_version: string;
    tools: ToolViewTool[];
}

/** The identity a proposal records and an execution attempt pins. */
export interface ToolViewIdentity {
    tool_view_ref: string;
    tool_view_digest: string;
}

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/**
 * Returns the canonical JSON encoding of a value.
 *
 * This must agree byte for byte with the gateway's Go encoder, because both sides derive the same digest from it and a
 * disagreement would make every pinned contract unresolvable. The rules are the same three: object keys sorted, only
 * the escapes JSON requires, and integers only. A float is rejected rather than formatted, since `1e2`, `100`, and
 * `100.0` are one value with three spellings and a digest cannot depend on which one a caller wrote.
 */
export function canonicalize(value: unknown): string {
    if (value === null) return 'null';
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'number') {
        if (!Number.isInteger(value) || !Number.isSafeInteger(value)) {
            throw new Error(`canonicalize: ${value} is not a safe integer; tool views are integer-valued`);
        }
        return String(value);
    }
    if (typeof value === 'string') return canonicalizeString(value);
    if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
    if (typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>).filter(([, member]) => member !== undefined);
        entries.sort(([first], [second]) => (first < second ? -1 : first > second ? 1 : 0));
        return `{${entries.map(([key, member]) => `${canonicalizeString(key)}:${canonicalize(member)}`).join(',')}}`;
    }
    throw new Error(`canonicalize: unsupported value of type ${typeof value}`);
}

const SHORT_ESCAPES: Record<string, string> = {'"': '\\"', '\\': '\\\\', '\b': '\\b', '\f': '\\f', '\n': '\\n', '\r': '\\r', '\t': '\\t'};

/**
 * Emits the minimal JSON escaping every conforming parser accepts.
 *
 * It deliberately leaves `<`, `>`, and `&` alone. Escaping them is an HTML-embedding habit, and here it would make a
 * digest depend on whether a tool description happened to contain an angle bracket.
 */
function canonicalizeString(value: string): string {
    let encoded = '"';
    for (const symbol of value) {
        const short = SHORT_ESCAPES[symbol];
        if (short) {
            encoded += short;
        } else if (symbol < ' ') {
            encoded += `\\u${symbol.codePointAt(0)!.toString(16).padStart(4, '0')}`;
        } else {
            encoded += symbol;
        }
    }
    return `${encoded}"`;
}

/** Returns the content address of a canonical encoding. */
export function digestOf(canonical: string): string {
    return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

/** Returns the canonical encoding of a tool view. */
export function canonicalizeToolView(document: ToolViewDocument): string {
    return canonicalize(document);
}

/** Returns the digest a tool view is pinned by. */
export function toolViewDigest(document: ToolViewDocument): string {
    return digestOf(canonicalizeToolView(document));
}

/** Returns the blob object name that stores the view with this digest. */
export function toolViewRef(digest: string): string {
    return `tool-views/${digest.replace(':', '-')}.json`;
}

/**
 * Parses a stored tool view and verifies it against the digest it was fetched by.
 *
 * Content addressing is only a guarantee if a reader checks it, so every path that resolves a recorded digest --
 * including replay reading a historical view -- goes through here rather than trusting what it was handed.
 */
export function parseToolView(canonical: string, expectedDigest?: string): {document: ToolViewDocument; identity: ToolViewIdentity} {
    const document = JSON.parse(canonical) as ToolViewDocument;
    const digest = toolViewDigest(document);
    if (expectedDigest !== undefined && digest !== expectedDigest) {
        throw new Error(`parseToolView: document canonicalises to ${digest}, not ${expectedDigest}`);
    }
    return {document, identity: {tool_view_ref: toolViewRef(digest), tool_view_digest: digest}};
}

/**
 * Builds the checker's registry from a published tool view.
 *
 * This is the boundary where "discovery happens before the checker, never inside it" becomes literal: the gateway is
 * queried here, and what `checkSubDag` receives afterwards is an immutable snapshot with no I/O behind it.
 */
export function loadToolRegistry(document: ToolViewDocument, expectedDigest?: string): ToolRegistry {
    if (expectedDigest !== undefined) {
        if (!DIGEST_PATTERN.test(expectedDigest)) throw new Error(`loadToolRegistry: ${expectedDigest} is not a sha256 digest`);
        const digest = toolViewDigest(document);
        if (digest !== expectedDigest) throw new Error(`loadToolRegistry: view canonicalises to ${digest}, not ${expectedDigest}`);
    }
    const versionsByTool = new Map<string, string[]>();
    for (const tool of document.tools) versionsByTool.set(tool.tool_id, [...(versionsByTool.get(tool.tool_id) ?? []), tool.tool_version]);
    for (const [toolId, versions] of versionsByTool) {
        // The checker's registry is keyed by tool name, because a proposal names tools and pins versions separately.
        // Silently choosing one of several published versions would admit a proposal against a contract nobody
        // selected, so this fails closed instead. Resolving it properly means teaching the checker about versions.
        if (versions.length > 1) {
            throw new Error(`loadToolRegistry: ${toolId} is published at ${versions.sort().join(', ')}; the checker's registry cannot represent more than one version of a tool`);
        }
    }
    const registry = new ToolRegistry();
    for (const tool of document.tools) {
        registry.register({
            name: tool.tool_id,
            effectClass: tool.txn.effect_class,
            mode: tool.txn.mode,
            idempotentRetryable: tool.txn.idempotent_retryable,
            footprint: tool.footprint ?? [],
            writes: tool.writes ?? [],
            ...(tool.txn.compensate_tool ? {compensateTool: tool.txn.compensate_tool} : {}),
            ...(tool.txn.confirm_tool ? {confirmTool: tool.txn.confirm_tool} : {}),
            ...(tool.txn.cancel_tool ? {cancelTool: tool.txn.cancel_tool} : {}),
            ...(tool.txn.try_timeout_s ? {tryTimeoutS: tool.txn.try_timeout_s} : {}),
        });
    }
    return registry;
}
