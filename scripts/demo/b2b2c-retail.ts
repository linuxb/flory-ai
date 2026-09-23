/**
 * An end-to-end B2B2C retail run: sourcing, market analysis, listing, and fulfilment.
 *
 * The retailer's goal is one sentence — source a product from the wholesale catalogue and get it
 * listed and fulfilled — and nothing below plans it. The graph is grown one frozen chunk at a time
 * by a real model, guarded at every junction by a deterministic router, and its side effects are
 * bracketed by the Coordinator.
 *
 * This is a demo driver, not a service. It plays the part of the process supervisor that a
 * deployment would own: it decides which ready vertex to hand to which executor, and it narrates
 * what happened. Every decision that matters — what may be frozen, where a router sits, which rule
 * it binds, which executor owns a vertex, when a scope commits — is made by the engine, the
 * database, or the Coordinator, never here.
 *
 *   npm run db:refresh && npm run e2e:up          # terminal 1: postgres, gatewayd, tool services
 *   npm run demo:coordinator                      # terminal 2: the transaction coordinator
 *   npm run demo:retail                           # terminal 3: this script
 */
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {coordinatorDatabaseUrl, engineDatabaseUrl} from '../../db/config.js';
import {EventStore} from '../../engine/src/log/store.js';
import {GatewayClient, type ResolvedToolView} from '../../engine/src/gateway/gateway-client.js';
import {LlmClient, loadLlmConfig, type LlmPricing} from '../../engine/src/planner/llm-client.js';
import {PlannerExecutor} from '../../engine/src/planner/planner-executor.js';
import {PlannerLoop} from '../../engine/src/planner/planner-loop.js';
import {ReadExecutor} from '../../engine/src/read-executor.js';
import {RouterExecutor} from '../../engine/src/router/router-executor.js';
import {DEFAULT_RECOVERY_POLICY, outstanding, RecoveryLoop, stalledPlanners} from '../../engine/src/recovery.js';
import {RuleTemplateStore, slotIdOf, type RuleTemplateDraft} from '../../engine/src/router/rule-template.js';
import {WorkflowSubmitter} from '../../engine/src/admission/submission.js';
import {surface} from '../../engine/src/log/projection.js';
import type {StoredEvent} from '../../engine/src/log/events.js';
import type {WorkflowSubmission} from '../../engine/src/admission/workflow.js';

const GATEWAY_URL = process.env.GATEWAY_BASE_URL ?? 'http://127.0.0.1:8092';
const SANDBOX_URL = process.env.SANDBOX_BASE_URL ?? 'http://127.0.0.1:8090';
const WORKFLOW_TYPE = 'b2b2c-retail';
/**
 * A tool to make fail, so the run exercises the recovery ladder rather than only the happy path.
 *
 * The sandbox already owns a deterministic fault schedule keyed by `(seed, tool, attempt)`, so
 * nothing new is injected here: the demo just schedules one and lets the ordinary machinery
 * produce a real `vertex/failed`. A read-only tool exercises replanning alone; a try inside a
 * transaction scope (`payment.authorize`, say) exercises cancel-before-replan as well: the failure
 * fences the scope, the ladder asks for the cancellation, the Coordinator runs it, and only then
 * does the ladder replan.
 */
const FAULT_TOOL = process.env.FLORY_DEMO_FAULT?.trim();
const CATEGORY = 'portable-espresso';
const VERSIONS = {projector_version: 'projector@v1', harness_state_version: 'harness@v1'};
/**
 * Prices used to compare replan boundaries when the provider configuration carries none.
 *
 * Boundary selection compares candidates, so what matters is the ratio between input and output,
 * not the absolute figures. They are named here rather than hidden in a default so a reader of the
 * log knows the estimate came from the demo and not from a provider's price list.
 */
const DEMO_PRICING: LlmPricing = {currency: 'CNY', cache_hit_input_per_million: 1, cache_miss_input_per_million: 4, output_per_million: 16, reference: 'demo-price-list'};
/**
 * Bounds the run so a demo cannot spend an unbounded number of model calls.
 *
 * A turn is a pass, not a model call: asking for a cancellation and waiting for it each take one,
 * so a failure inside a transaction scope needs room for both before its replan.
 */
const MAX_TURNS = 12;

const TASK_INPUT = {
    role: 'retailer',
    platform: 'B2B2C marketplace',
    goal: `Source ${CATEGORY} from the wholesale catalogue, list it on our channel, and fulfil the first order.`,
    category: CATEGORY,
    order_id: `ORDER-${randomUUID().slice(0, 8)}`,
    purchase_order_id: `PO-${randomUUID().slice(0, 8)}`,
    target_units: 40,
    listing_id: `LST-${randomUUID().slice(0, 8)}`,
    destination_postcode: '3000',
    carrier: 'auspost',
};

/* ------------------------------------------------------------------ narration */

let step = 0;
const bold = (text: string): string => `[1m${text}[0m`;
const dim = (text: string): string => `[2m${text}[0m`;

function heading(title: string): void {
    step += 1;
    process.stdout.write(`\n${bold(`[${step}] ${title}`)}\n`);
}
function line(text: string): void {
    process.stdout.write(`    ${text}\n`);
}
function note(text: string): void {
    process.stdout.write(`    ${dim(text)}\n`);
}

/* ------------------------------------------------------------------ rule templates */

/**
 * The two deterministic policies this business wants applied without asking a model.
 *
 * Both branches emit a planner rather than a tool, and that is a limitation rather than a choice:
 * a template names tools but binds no parameters yet (doc 10 section 13), so an emitted tool would
 * arrive with an empty input. Emitting a planner is the honest shape available today, and it still
 * demonstrates the point — the *structure* of the graph changed without a model being consulted.
 */
function policies(): RuleTemplateDraft[] {
    return [
        {
            templateRef: 'rule://retail/sourcing-negotiation@v1',
            author: 'category-manager@retailer',
            slotId: slotIdOf(WORKFLOW_TYPE, ['market.demand', 'supplier.search'], 'source'),
            branches: [
                {
                    // Surging demand with real competition: policy says negotiate before buying.
                    condition: 'market.demand.output.trend == "surging" && supplier.search.output.candidate_count >= 2',
                    subDag: {vertices: [{id: 'negotiate', kind: 'planner', parents: []}], scopes: []},
                },
            ],
        },
        {
            templateRef: 'rule://retail/out-of-stock-restock@v1',
            author: 'ops@retailer',
            slotId: slotIdOf(WORKFLOW_TYPE, ['inventory.check', 'supplier.quote'], 'fulfil'),
            branches: [
                {
                    // No sellable stock: a restocking decision is inserted, never improvised.
                    condition: 'inventory.check.output.available < 1',
                    subDag: {vertices: [{id: 'restock', kind: 'planner', parents: []}], scopes: []},
                },
            ],
        },
    ];
}

/* ------------------------------------------------------------------ the seed graph */

/** The only graph a human writes: two reads and the decision they feed. */
function seedWorkflow(): WorkflowSubmission {
    return {
        submissionId: `retail-${randomUUID()}`,
        schemaVersion: 'v1',
        workflowType: WORKFLOW_TYPE,
        vertices: [
            {id: 'demand', kind: 'tool', tool: 'market.demand', input: {category: CATEGORY}},
            {id: 'catalogue', kind: 'tool', tool: 'supplier.search', input: {category: CATEGORY}},
            {id: 'source', kind: 'planner', parents: ['demand', 'catalogue'], goal: 'Choose a supplier and a quantity'},
        ],
    };
}

/* ------------------------------------------------------------------ scheduling */

interface Pending {
    vertexId: string;
    role: string;
}

/**
 * Finds vertices whose parents have all succeeded and that no executor owns.
 *
 * Routers and planners are deliberately absent from `work_queue` — the database enqueues only tool
 * callers and barriers — so a supervisor has to read them off the surface. That asymmetry is the
 * design working: a router is a pure function the engine runs inline, and a lease expiry must not
 * be able to fabricate a failure for it.
 */
function readyNonTool(events: StoredEvent[], roles: readonly string[]): Pending[] {
    const view = surface(events);
    const succeeded = new Set(events.filter((event) => event.event_type === 'vertex/succeeded' && event.vertex_id).map((event) => event.vertex_id!));
    const touched = new Set(events.filter((event) => event.event_type === 'vertex/started' && event.vertex_id).map((event) => event.vertex_id!));
    const pending: Pending[] = [];
    for (const vertex of view.vertices.values()) {
        if (!vertex.role || !roles.includes(vertex.role) || touched.has(vertex.vertex_id)) continue;
        if (vertex.parent_refs.every((parent) => succeeded.has(parent))) pending.push({vertexId: vertex.vertex_id, role: vertex.role});
    }
    return pending.sort((first, second) => first.vertexId.localeCompare(second.vertexId));
}

/** Names a vertex the way its author did, using the mapping every freeze records. */
function authorNames(events: StoredEvent[]): Map<string, string> {
    const names = new Map<string, string>();
    for (const event of events) {
        if (event.event_type !== 'subgraph/frozen') continue;
        for (const entry of (event.payload as {vertices?: Array<{author_id: string; vertex_id: string}>}).vertices ?? []) {
            names.set(entry.vertex_id, entry.author_id);
        }
    }
    return names;
}

/* ------------------------------------------------------------------ the run */

async function main(): Promise<void> {
    const llmConfig = await loadLlmConfig();
    const engine = new EventStore({connectionString: engineDatabaseUrl, actor: 'engine'});
    const pool = new Pool({connectionString: engineDatabaseUrl});
    const gateway = new GatewayClient({baseUrl: GATEWAY_URL});
    const templates = new RuleTemplateStore(engine);
    const submitter = new WorkflowSubmitter(engine, gateway, templates);
    const routers = new RouterExecutor(engine, templates, submitter);
    const reads = new ReadExecutor(engine, pool, gateway, 'demo-orchestrator');
    const loop = new PlannerLoop(engine, new PlannerExecutor(engine, new LlmClient(llmConfig)), submitter, VERSIONS);
    const recovery = new RecoveryLoop(engine, loop, {...DEFAULT_RECOVERY_POLICY, pricing: llmConfig.pricing ?? DEMO_PRICING});

    try {
        const view = await gateway.resolveToolView();
        heading('Topology');
        line(`gateway     ${GATEWAY_URL}`);
        line(`tool view   ${view.identity.tool_view_digest} (${view.document.tools.length} tools)`);
        line(`model       ${llmConfig.provider} / ${llmConfig.model} via ${llmConfig.protocol}`);
        // One schedule covers every attempt of the named tool, so the failure is definitive
        // rather than something L0 retries away. A transient one would never reach the ladder.
        const faults = FAULT_TOOL ? Object.fromEntries([1, 2, 3, 4].map((attempt) => [`demo:${FAULT_TOOL}:${attempt}`, 'permanent-failure'])) : {};
        await fetch(`${SANDBOX_URL}/test/reset`, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({seed: 'demo', faults}),
        }).catch(() => undefined);
        if (FAULT_TOOL) {
            line(`fault       ${FAULT_TOOL} fails every attempt`);
            note('Scheduled in the sandbox, so the engine learns about it the same way it would learn about a real outage.');
        }

        heading('Publish the deterministic policies');
        for (const draft of policies()) {
            const published = await templates.publish(draft, view);
            if (!published.admitted) throw new Error(`${draft.templateRef} was refused: ${JSON.stringify(published.violations)}`);
            line(`${draft.templateRef}`);
            note(`digest ${published.template.digest.slice(0, 23)}…  slot ${draft.slotId?.slice(0, 16)}…  read-only=${published.template.capability.isPureReadOnly}`);
            note(`when: ${draft.branches[0]!.condition}`);
        }
        note('Published to the configuration stream, not to a side table: a replay reconstructs these from the log.');

        const runId = await engine.createRun();
        await engine.appendEvents(runId, [{event_type: 'run/start', payload: {schema_version: 'v1', task_input: TASK_INPUT}}]);
        heading('Submit the workflow');
        line(`run ${runId}`);
        line(`goal: ${TASK_INPUT.goal}`);
        const seeded = await submitter.submit(runId, seedWorkflow());
        if (seeded.status !== 'accepted') throw new Error(`the seed workflow was refused: ${JSON.stringify(seeded.violations)}`);
        line(`frozen ${seeded.vertexIds.size} vertices; the author wrote 3`);
        note('The extra vertex is a router the compiler interposed: every planner with parents reaches them through one.');
        await reportRouters(engine, runId);

        for (let turn = 0; turn < MAX_TURNS; turn += 1) {
            const progressed = await advance(engine, runId, reads, routers, loop, recovery, view);
            // Nothing here is ready, but the Coordinator may still be driving a transaction in its
            // own process. Waiting for it is not politeness: its commit is what unblocks whatever
            // comes after, and reading the ledger before it settles reports a half-finished world.
            if (!progressed && !(await settle(engine, pool, runId))) break;
        }

        heading('Final state');
        await reportLedger();
        await reportLog(engine, pool, runId);
    } finally {
        await pool.end();
        await engine.close();
    }
}

/**
 * Runs whatever is ready, in the order the design requires.
 *
 * Reads first, because a router and a planner both decide on what reads produced. Routers next,
 * because a router may insert work a planner would otherwise be asked to invent. Planners last,
 * and one per pass, so every model call sees everything that happened before it.
 */
async function advance(engine: EventStore, runId: string, reads: ReadExecutor, routers: RouterExecutor, loop: PlannerLoop, recovery: RecoveryLoop, view: ResolvedToolView): Promise<boolean> {
    let progressed = false;

    const executed: string[] = [];
    for (;;) {
        const report = await reads.processOne();
        if (!report) break;
        executed.push(`${report.vertexId.slice(0, 8)} ${report.outcome}`);
        progressed = true;
    }
    if (executed.length) {
        heading('Orchestrator executed the reads it owns');
        for (const item of executed) line(item);
        await reportSummaries(engine, runId);
    }

    let events = await engine.readStream(runId);
    let names = authorNames(events);

    // Recovery comes before routing and planning, and the order is the point: a failure left
    // unanswered would let the next planner turn build on top of work that is already dead.
    const blocked = outstanding(events);
    if (blocked.length) {
        const failed = blocked[0]!;
        const stalled = stalledPlanners(events).includes(failed);
        heading(`Recovery: ${names.get(failed) ?? failed.slice(0, 8)} ${stalled ? 'answered unreadably' : 'failed'}`);
        const outcome = await recovery.recoverOne({runId, taskInput: TASK_INPUT, workflowType: WORKFLOW_TYPE, goalFor: (vertexId) => goalFor(names.get(vertexId) ?? '')}, view);
        for (const decision of outcome.status === 'idle' ? [] : outcome.status === 'awaiting_cancellation' ? outcome.decisions : [outcome.decision]) {
            line(`ladder      ${decision.level}  ${decision.action}  ${decision.reason}`);
            for (const candidate of decision.candidates) {
                const label = names.get(candidate.planner_vertex_id) ?? candidate.planner_vertex_id.slice(0, 8);
                line(`  ${label.padEnd(12)} ${candidate.rejected ? `rejected: ${candidate.rejected}` : `${candidate.cost} ${candidate.currency}`}`);
            }
            note('The engine publishes the whole comparison, not only its answer: boundary selection is policy, so a harness checks it rather than recomputing it.');
        }
        if (outcome.status === 'replanned') {
            line(`discarded   ${outcome.decision.shadowed.length} vertices, none deleted`);
            line(`replanned   at ${names.get(outcome.decision.selected!) ?? outcome.decision.selected!.slice(0, 8)} (${outcome.turn.status})`);
            note('Same run, same run_id. The shadowed subtree stays in the log as evidence, and the planner was told what failed rather than shown the work.');
        } else if (outcome.status === 'escalated') {
            line('escalated   no legal boundary; this run needs a human');
            note('Any cancellation the failure needed has already resolved; the escalation is the final answer.');
        } else if (outcome.status === 'cancel_requested') {
            line(`requested   cancellation of ${outcome.decision.requestScopes.map((scope) => scope.slice(0, 8)).join(', ')} at run_seq ${outcome.requestSeq}`);
            note('The engine asks, the Coordinator executes. The boundary is recorded only once the cancellation has completed (03 §2.4 rule 1).');
        } else if (outcome.status === 'awaiting_cancellation') {
            note('Waiting for a cancellation already under way; nothing is appended until it resolves.');
        }
        events = await engine.readStream(runId);
        names = authorNames(events);
        // Waiting is not progress: the Coordinator has to move before this pass can do anything.
        progressed = outcome.status !== 'awaiting_cancellation' && outcome.status !== 'idle';
    }

    for (const pending of readyNonTool(events, ['router'])) {
        heading(`Router ${names.get(pending.vertexId) ?? pending.vertexId} decides`);
        const evaluation = await routers.evaluate(runId, pending.vertexId);
        if (evaluation.outcome.kind === 'matched') {
            line(`matched: ${evaluation.outcome.condition}`);
            line(`emitted: ${[...evaluation.emitted!.keys()].join(', ')}`);
            note('No model was consulted, and the branch was admitted when the graph froze, not now.');
        } else if (evaluation.outcome.kind === 'no_match') {
            line('fell through — no rule matched');
            note('Invisible downstream: the planner receives a prompt identical to a run with no rule bound.');
        } else {
            line(`refused to decide: ${JSON.stringify(evaluation.outcome)}`);
        }
        progressed = true;
    }

    const planners = readyNonTool(await engine.readStream(runId), ['planner']);
    const next = planners[0];
    if (next) {
        const authored = names.get(next.vertexId) ?? next.vertexId;
        heading(`Planner ${authored} thinks (real model call)`);
        const turn = await loop.advance({runId, plannerVertexId: next.vertexId, taskInput: TASK_INPUT, workflowType: WORKFLOW_TYPE, goal: goalFor(authored)}, view);
        if (turn.status === 'frozen') {
            const frozen = await engine.readStream(runId);
            const proposed = [...turn.result.vertexIds.keys()];
            line(`proposed and froze: ${proposed.join(', ')}`);
            note(`the model wrote ${turn.content.length} characters; the engine admitted them before anything ran`);
            await reportRouters(engine, runId, frozen);
        } else if (turn.status === 'rejected') {
            line(`refused at freeze (${turn.result.stage}):`);
            for (const violation of turn.result.violations) line(`  ${violation.rule}: ${violation.message}`);
            note('Nothing ran. A rule violation is caught when the graph freezes, not when a tool fails.');
        } else {
            line(`unreadable answer: ${turn.reason}`);
            note(turn.content.slice(0, 300));
            // Nothing failed — the model answered and the engine refused to read the answer —
            // so the ladder has no failed vertex to find. It finds the stall instead, from the
            // `subgraph/unreadable` the loop just appended, and asks this planner again.
            note('the answer was not a proposal; recorded as a stall, and the ladder will ask this planner again with the refusal as evidence');
        }
        progressed = true;
    }
    return progressed;
}

/**
 * Waits for the Coordinator to finish whatever it is holding, and reports whether it did anything.
 *
 * A scope is settled when it is committed or cancelled; anything else means the Coordinator is
 * still deciding, or has suspended and is waiting for a human. The poll is over the projection
 * rather than over the Coordinator, because the projection is the only account of a transaction
 * this process is entitled to read.
 */
async function settle(engine: EventStore, pool: Pool, runId: string, timeoutMs = 60_000): Promise<boolean> {
    const before = (await engine.readStream(runId)).length;
    const deadline = Date.now() + timeoutMs;
    let reported = false;
    for (;;) {
        // Outstanding means a frozen vertex with no terminal event yet. Waiting on scope state
        // instead would call an untouched transaction settled, because the Coordinator has not
        // opened its scope at the moment the graph freezes.
        const events = await engine.readStream(runId);
        const terminal = new Set(events.filter((event) => ['vertex/succeeded', 'vertex/failed'].includes(event.event_type)).map((event) => event.vertex_id));
        const scopes = await pool.query<{scope_id: string; state: string; fenced: boolean; requested: boolean}>(
            "SELECT scope_id, state, fenced_at IS NOT NULL AS fenced, cancel_request_outcome IN ('pending', 'deferred') AS requested FROM txn_scope WHERE run_id = $1",
            [runId],
        );
        // Members of a fenced, cancelling, cancelled or suspended scope never reach a terminal
        // event: the fence stops them being claimed, a cancellation deletes them from the queue, and
        // a suspension waits for a person. Waiting for them would spend the whole timeout. A scope
        // past its pivot is different — its forward work still runs — so it is not stopped.
        const stopped = new Set(
            scopes.rows.filter((scope) => (scope.fenced && scope.state === 'open') || ['cancelling', 'cancelled', 'suspended'].includes(scope.state)).map((scope) => scope.scope_id),
        );
        const outstanding = events.filter(
            (event) =>
                event.event_type === 'vertex/created' &&
                ['tool', 'confirmation-barrier'].includes((event.payload as {role?: string}).role ?? '') &&
                !terminal.has(event.vertex_id) &&
                !(event.scope_id && stopped.has(event.scope_id)),
        );
        // A cancellation resolving is what a waiting ladder needs to hear about.
        const resolved = events
            .slice(before)
            .some((event) => (event.event_type === 'txn/cancel' && event.payload.phase === 'completed') || (event.event_type === 'txn/scope' && event.payload.state === 'suspended'));
        // A requested scope is waiting for the Coordinator to pick the request up, and a cancelling
        // one for its inverses: either way the Coordinator still owes this run something. A fenced
        // scope nobody has asked to cancel yet is the ladder's move, not the Coordinator's.
        const cancelling = scopes.rows.some((scope) => (scope.requested && scope.state === 'open') || scope.state === 'cancelling');
        if ((!outstanding.length && !cancelling) || resolved || Date.now() > deadline) {
            const after = await engine.readStream(runId);
            if (after.length === before) return false;
            heading('Coordinator drove the transaction');
            for (const scope of scopes.rows) line(`scope ${scope.scope_id.slice(0, 8)} → ${scope.state}`);
            const brackets = await pool.query<{idempotency_key: string; state: string}>('SELECT idempotency_key, state FROM txn_bracket WHERE run_id = $1 ORDER BY try_seq', [runId]);
            for (const bracket of brackets.rows) line(`bracket ${bracket.idempotency_key} → ${bracket.state}`);
            const pivot = after.find((event) => event.event_type === 'txn/pivot-passed');
            if (pivot) note(`pivot passed at run_seq ${pivot.run_seq}; nothing may be cancelled after it`);
            return true;
        }
        if (!reported) {
            heading('Waiting for the Coordinator');
            note(`${outstanding.length} frozen vertices have no outcome yet; only the Coordinator may execute them`);
            reported = true;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
}

/** Gives each planner the one decision it is being asked for. */
function goalFor(authored: string): string {
    if (authored.startsWith('source')) {
        return [
            "Pick one supplier that can meet target_units and get a binding quote from it, and check our own stock for that supplier's sku.",
            'Then add one planner vertex, and give that planner the id exactly "fulfil".',
        ].join(' ');
    }
    if (authored.startsWith('negotiate')) return 'Demand is surging and there are several suppliers. Get a binding quote from the cheapest one whose minimum order we can meet.';
    if (authored.startsWith('restock')) return 'Take no action here; the fulfilment planner will place the purchase order. Return a single planner vertex with the id "noop".';
    if (authored.startsWith('fulfil')) {
        return [
            'Complete the purchase and go live, in this order:',
            'place the wholesale purchase order with supplier.order using purchase_order_id from the task (this is what lands stock in our warehouse),',
            'reserve that stock, authorize payment, capture the payment, confirm the reservation, then draft and publish the channel listing at the market sell price.',
            'Each step depends on the one before it, so put every one of them in exactly one scope with the id "s1". Do not declare a second scope.',
        ].join(' ');
    }
    return 'Take the next step toward the goal. If nothing is needed, return a single planner vertex with the id "noop".';
}

/* ------------------------------------------------------------------ reporting */

/** Shows what freeze decided about every router: where it sits, and which rule it pinned. */
async function reportRouters(engine: EventStore, runId: string, events?: StoredEvent[]): Promise<void> {
    const stream = events ?? (await engine.readStream(runId));
    const names = authorNames(stream);
    const created = stream.filter((event) => event.event_type === 'vertex/created' && (event.payload as {role?: string}).role === 'router');
    for (const event of created) {
        const payload = event.payload as {placement?: string; slot_id?: string; origin?: string};
        line(`router ${names.get(event.vertex_id!) ?? event.vertex_id}  origin=${payload.origin}  placement=${payload.placement}`);
        note(`pinned rule: ${event.pin_version ?? '(none bound to this slot)'}`);
    }
}

/** Shows the summary fields the tools lifted, which is all a rule may decide on. */
async function reportSummaries(engine: EventStore, runId: string): Promise<void> {
    const events = await engine.readStream(runId);
    const names = authorNames(events);
    for (const event of events) {
        if (event.event_type !== 'vertex/succeeded') continue;
        const lifted = (event.payload as {log_fields?: Record<string, unknown>}).log_fields;
        if (lifted) note(`${names.get(event.vertex_id!) ?? event.vertex_id} lifted ${JSON.stringify(lifted)}`);
    }
}

/** Reads the world's own ledgers, which is where a side effect is either real or it is not. */
async function reportLedger(): Promise<void> {
    const response = await fetch(`${SANDBOX_URL}/test/snapshot`).catch(() => undefined);
    if (!response?.ok) return;
    line(`ledger ${JSON.stringify(await response.json())}`);
}

/** Prints the log itself, which is the only record anything in this run actually happened. */
async function reportLog(engine: EventStore, pool: Pool, runId: string): Promise<void> {
    const events = await engine.readStream(runId);
    const names = authorNames(events);
    for (const event of events) {
        const who = event.vertex_id ? (names.get(event.vertex_id) ?? event.vertex_id.slice(0, 8)) : '';
        line(`${String(event.run_seq).padStart(3)}  ${event.event_type.padEnd(20)} ${who}`);
    }
    // Read straight from the projection: a scope's state is the Coordinator's to write, and this
    // script is only reporting what it decided.
    const scopes = await pool.query('SELECT scope_id, state, is_pivot FROM txn_scope WHERE run_id = $1 ORDER BY opened_seq', [runId]);
    line(`scopes: ${scopes.rows.length ? JSON.stringify(scopes.rows) : 'none opened'}`);
    const brackets = await pool.query('SELECT idempotency_key, state FROM txn_bracket WHERE run_id = $1', [runId]);
    line(`brackets: ${brackets.rows.length ? JSON.stringify(brackets.rows) : 'none sealed'}`);
    note(`coordinator database: ${coordinatorDatabaseUrl.replace(/:[^:@]*@/, ':***@')}`);
}

await main();
