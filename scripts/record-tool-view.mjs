// Records the mock world's published tool view against a running gateway.
//
// The recording is the gateway's own output, not a hand-written catalog: there
// is no manifest anywhere in the repository, because the catalog is whatever the
// tool services declared and the gateway admitted. Check-rule tests read the
// recording rather than the live gateway -- doc 05 requires recorded evaluation
// to consume the recorded view -- and the end-to-end run asserts the live digest
// still equals it, so a stale recording fails rather than drifting quietly.
//
// Run `npm run e2e:up` first, then `npm run record:tool-view`.
import {writeFile} from 'node:fs/promises';

const gateway = process.env.GATEWAY_BASE_URL ?? 'http://127.0.0.1:8092';

const response = await fetch(`${gateway}/mcp`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/list', params: {}}),
});
if (!response.ok) throw new Error(`gateway returned HTTP ${response.status}; is the topology up?`);
const decoded = await response.json();
if (decoded.error) throw new Error(`gateway refused tools/list: ${decoded.error.message}`);

const meta = decoded.result?._meta;
if (!meta?.tool_view_document) throw new Error('tools/list returned no canonical document to record');
const document = JSON.parse(meta.tool_view_document);
if (!document.tools?.length) throw new Error('the gateway has published no tools; check that the mock services registered');

await writeFile(new URL('../test/fixtures/tool-view-ecommerce.json', import.meta.url), `${meta.tool_view_document}\n`);
process.stdout.write(`recorded ${document.tools.length} tools at ${meta.tool_view_digest}\n`);
