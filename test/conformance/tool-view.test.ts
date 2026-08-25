import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {checkSubDag, type SubDagProposal, ToolRegistry} from '../../engine/src/check-rules.js';
import {canonicalize, digestOf, loadToolRegistry, parseToolView, type ToolViewDocument, toolViewDigest, toolViewRef} from '../../engine/src/tool-view.js';

interface Fixture {
    canonical_cases: Array<{name: string; value: unknown; canonical: string; digest: string}>;
    rejected_cases: Array<{name: string; value: unknown; reason: string}>;
    view_cases: Array<{name: string; document: ToolViewDocument; canonical: string; digest: string; ref: string}>;
}

const fixture = JSON.parse(readFileSync(new URL('../fixtures/tool-view-conformance.json', import.meta.url), 'utf8')) as Fixture;

/** The complete TCC cluster the fixture publishes, which every equivalence case is stated against. */
function clusterView(): ToolViewDocument {
    const view = fixture.view_cases.find((testCase) => testCase.document.tools.length > 0);
    if (!view) throw new Error('the fixture has no non-empty view case');
    return view.document;
}

describe('canonical encoding conformance', () => {
    // The same fixture is asserted by gatewayd/internal/toolview/conformance_test.go, which is what makes the two
    // encoders provably identical rather than merely intended to be. A digest neither side can reproduce would make
    // every pinned contract unresolvable.
    it.each(fixture.canonical_cases)('$name', (testCase) => {
        expect(canonicalize(testCase.value)).toBe(testCase.canonical);
        expect(digestOf(testCase.canonical)).toBe(testCase.digest);
    });

    it.each(fixture.rejected_cases)('refuses $name', (testCase) => {
        expect(() => canonicalize(testCase.value)).toThrow();
    });

    it.each(fixture.view_cases)('pins $name by its own content', (testCase) => {
        expect(toolViewDigest(testCase.document)).toBe(testCase.digest);
        expect(toolViewRef(testCase.digest)).toBe(testCase.ref);
        expect(parseToolView(testCase.canonical, testCase.digest).identity.tool_view_digest).toBe(testCase.digest);
    });
});

describe('resolving a published view', () => {
    it('refuses a document that does not canonicalise to the digest it was fetched by', () => {
        const view = clusterView();
        const wrong = `sha256:${'f'.repeat(64)}`;
        expect(() => parseToolView(canonicalize(view), wrong)).toThrow(/canonicalises to/);
        expect(() => loadToolRegistry(view, wrong)).toThrow(/canonicalises to/);
    });

    // The checker's registry is keyed by tool name, so silently choosing between two published versions would admit a
    // proposal against a contract nobody selected.
    it('fails closed when one tool is published at several versions', () => {
        const view = clusterView();
        const doubled: ToolViewDocument = {...view, tools: [...view.tools, {...view.tools[0]!, tool_version: '2.0.0'}]};
        expect(() => loadToolRegistry(doubled)).toThrow(/cannot represent more than one version/);
    });

    it('carries every transaction attribute the checker reasons from', () => {
        const registry = loadToolRegistry(clusterView());
        const reserve = registry.get('inventory.reserve');
        expect(reserve.effectClass).toBe('reversible');
        expect(reserve.mode).toBe('tcc');
        expect(reserve.confirmTool).toBe('inventory.confirm');
        expect(reserve.cancelTool).toBe('inventory.release');
        expect(reserve.tryTimeoutS).toBe(900);
        expect(registry.get('inventory.release').idempotentRetryable).toBe(true);
        expect(registry.validate()).toEqual([]);
    });
});

/**
 * The hand-built registry a test would have written before the gateway existed.
 *
 * Doc 09 section 7 makes this pair a precondition for the gateway becoming the production route: a local snapshot and
 * the canonical gateway view must admit identically, or planning and execution would be validating different things.
 */
function localSnapshot(): ToolRegistry {
    const registry = new ToolRegistry();
    registry.register({name: 'inventory.confirm', effectClass: 'bufferable', mode: 'plain', idempotentRetryable: true, footprint: ['inventory:{sku}'], writes: ['inventory:{sku}']});
    registry.register({name: 'inventory.release', effectClass: 'bufferable', mode: 'plain', idempotentRetryable: true, footprint: ['inventory:{sku}'], writes: ['inventory:{sku}']});
    registry.register({
        name: 'inventory.reserve',
        effectClass: 'reversible',
        mode: 'tcc',
        idempotentRetryable: true,
        footprint: ['inventory:{sku}'],
        writes: ['inventory:{sku}'],
        confirmTool: 'inventory.confirm',
        cancelTool: 'inventory.release',
        tryTimeoutS: 900,
    });
    return registry;
}

const PROPOSALS: Record<string, SubDagProposal> = {
    'an admitted reservation': {
        vertices: [{id: 'v1', parents: [], kind: 'tool', tool: 'inventory.reserve', scopeId: 's1'}],
        scopes: [{id: 's1', members: ['v1']}],
    },
    'a side effect with no scope': {
        vertices: [{id: 'v1', parents: [], kind: 'tool', tool: 'inventory.reserve'}],
        scopes: [],
    },
    'a confirm reachable from its own try': {
        vertices: [
            {id: 'v1', parents: [], kind: 'tool', tool: 'inventory.reserve', scopeId: 's1'},
            {id: 'v2', parents: ['v1'], kind: 'tool', tool: 'inventory.confirm', scopeId: 's1'},
        ],
        scopes: [{id: 's1', members: ['v1', 'v2']}],
    },
};

describe('admission is identical from a local snapshot and from the gateway view', () => {
    it.each(Object.entries(PROPOSALS))('%s', (_name, proposal) => {
        const fromGateway = checkSubDag(proposal, loadToolRegistry(clusterView()));
        const fromSnapshot = checkSubDag(proposal, localSnapshot());
        expect(fromGateway).toEqual(fromSnapshot);
    });

    it('rejects what it should, so the equality above is not two identical blanks', () => {
        const result = checkSubDag(PROPOSALS['a side effect with no scope']!, loadToolRegistry(clusterView()));
        expect(result.accepted).toBe(false);
        expect(result.violations.map((violation) => violation.rule)).toContain('R10');
    });
});
