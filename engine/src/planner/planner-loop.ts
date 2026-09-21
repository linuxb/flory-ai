import {createHash} from 'node:crypto';
import {assemble, linearize, slice, surface} from '../log/projection.js';
import type {PlannerExecutor} from './planner-executor.js';
import type {LlmMessage} from './llm-client.js';
import type {EventStore} from '../log/store.js';
import type {SubmissionResult, WorkflowSubmitter} from '../admission/submission.js';
import type {ResolvedToolView} from '../gateway/gateway-client.js';
import type {SubmittedVertex, WorkflowSubmission} from '../admission/workflow.js';

/** The projection versions a planner turn assembles its prompt under. */
export interface ProjectionVersions {
    projector_version: string;
    harness_state_version: string;
}

/** What one planner turn did. */
export type PlannerTurn =
    | {status: 'frozen'; result: Extract<SubmissionResult, {status: 'accepted'}>; content: string}
    | {status: 'rejected'; result: Extract<SubmissionResult, {status: 'rejected'}>; content: string}
    /** The model answered, but its answer was not a proposal this engine can read. */
    | {status: 'unreadable'; reason: string; content: string};

/** One planner turn's inputs beyond the run it advances. */
export interface PlannerTurnRequest {
    runId: string;
    plannerVertexId: string;
    /** The business task, pinned at run start and unchanged by any turn. */
    taskInput: Record<string, unknown>;
    /** Names the kind of workflow, so an interposed router resolves the right slot. */
    workflowType: string;
    /** Extra instruction for this junction only, such as what decision is being asked for. */
    goal: string;
    /**
     * What already failed here, when this turn is a replan rather than a first attempt.
     *
     * Structured rather than a log excerpt, so the planner is told which approach is disproven
     * without being handed the discarded work to copy (03 §2.3). It also makes the extra input
     * cost of a replan bounded and predictable, which is what the budget preflight assumes.
     */
    evidence?: Record<string, unknown>;
    /**
     * Distinguishes this turn from the planner's earlier ones in the submission log.
     *
     * A replanned planner submits twice from the same vertex, and two submissions sharing an id
     * would make the audit trail claim one proposal where there were two.
     */
    attempt?: number;
}

/**
 * Turns one planner's thought call into the next frozen chunk of the graph.
 *
 * This is the loop that makes the DAG just-in-time. Everything it composes already exists: the
 * projection decides what the planner may see, the executor makes the call and prices it, and the
 * submitter normalizes, admits and freezes whatever comes back. What was missing was the step
 * between the model's answer and a submission, and it is deliberately narrow — the model proposes
 * tool vertices and planners, and nothing else.
 *
 * The narrowness is the point. A planner that could emit a router would be choosing its own
 * governance, and a planner that could pin a tool version or a rule template would be committing to
 * a contract the engine is supposed to resolve. Both are refused here rather than downstream,
 * because by the time the compiler sees a proposal it can no longer tell who wrote it.
 */
export class PlannerLoop {
    constructor(
        private readonly store: EventStore,
        private readonly planner: PlannerExecutor,
        private readonly submitter: WorkflowSubmitter,
        private readonly versions: ProjectionVersions,
    ) {}

    /** Runs one thought call and freezes the sub-DAG it proposes. */
    async advance(request: PlannerTurnRequest, view: ResolvedToolView): Promise<PlannerTurn> {
        const messages = this.compose(await this.context(request.runId, request.plannerVertexId), request, view);
        const {content} = await this.planner.execute({runId: request.runId, plannerId: request.plannerVertexId, messages});

        const parsed = readProposal(content);
        if ('reason' in parsed) {
            // Recorded, not merely returned. A planner that answers unreadably has succeeded in
            // the log and produced no work, so nothing downstream of it can ever become ready and
            // no executor will call it again — the run simply stops. Without this event the stall
            // is invisible: the recovery ladder has no failure to find, and a replay cannot
            // reproduce why the run stopped. The answer itself is not retained, only its digest,
            // for the same reason no prompt is (design document 11 section 3.4).
            await this.store.appendEvents(request.runId, [
                {
                    event_type: 'subgraph/unreadable',
                    vertex_id: request.plannerVertexId,
                    payload: {
                        planner_vertex_id: request.plannerVertexId,
                        reason: parsed.reason,
                        answer_digest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
                        answer_length: content.length,
                    },
                },
            ]);
            return {status: 'unreadable', reason: parsed.reason, content};
        }

        const submission: WorkflowSubmission = {
            submissionId: request.attempt ? `${request.plannerVertexId}:replan-${request.attempt}` : `${request.plannerVertexId}:turn`,
            schemaVersion: 'v1',
            workflowType: request.workflowType,
            vertices: parsed.vertices,
            ...(parsed.scopes.length ? {scopes: parsed.scopes} : {}),
            // The planner never names where its work attaches: it is answering from one position in
            // one graph, and the engine is the only party that knows which vertex that is.
            attachTo: [request.plannerVertexId],
        };
        const result = await this.submitter.submit(request.runId, submission);
        return result.status === 'accepted' ? {status: 'frozen', result, content} : {status: 'rejected', result, content};
    }

    /** Returns exactly what this planner is allowed to see, in its canonical assembled form. */
    private async context(runId: string, plannerVertexId: string): Promise<string> {
        const events = await this.store.readStream(runId);
        return assemble(linearize(slice(surface(events), plannerVertexId)), this.versions).text;
    }

    private compose(context: string, request: PlannerTurnRequest, view: ResolvedToolView): LlmMessage[] {
        return [
            {role: 'system', content: SYSTEM_CONTRACT},
            {
                role: 'user',
                content: [
                    `# Task\n${JSON.stringify(request.taskInput, null, 2)}`,
                    `# Goal for this step\n${request.goal}`,
                    `# Tools you may call\n${catalogue(view)}`,
                    `# What has happened so far\n${context}`,
                    // Placed after the surface and before the instruction, because it is a fact
                    // about the surface the planner is looking at: the work it describes has been
                    // discarded and is no longer in that surface at all.
                    ...(request.evidence
                        ? [
                              `# A previous attempt from here failed and was discarded\n${JSON.stringify(request.evidence, null, 2)}\n` +
                                  'Propose a different approach. Repeating the failed call will fail again.',
                          ]
                        : []),
                    '# Your answer\nReturn one JSON object and nothing else.',
                ].join('\n\n'),
            },
        ];
    }
}

/**
 * The output contract, stated as constraints rather than as an example to copy.
 *
 * Every prohibition here is a rule the engine enforces anyway. They are repeated to the model so a
 * rejection is rare rather than routine: a refused proposal costs a whole turn, and the log then
 * records the engine refusing work the model was never told it could not do.
 */
const SYSTEM_CONTRACT = `You plan one step of a long-running business workflow.

Answer with a single JSON object and no prose, no markdown fence:
{"vertices": [...], "scopes": [...]}

Each vertex is {"id": string, "kind": "tool"|"planner", "parents": [ids within this answer], "tool"?: string, "input"?: object, "scope"?: string, "goal"?: string}.
Each scope is {"id": string, "members": [tool vertex ids]}.

Rules:
- Plan only the next step. Do not plan the whole workflow; you will be called again with the results.
- "tool" is required on a tool vertex and must be one of the listed tool ids. A planner vertex has no tool.
- Only tool vertices may belong to a scope. Group into one scope the side-effecting tools that must succeed or fail together.
- Every tool whose effect_class is not "none" must belong to a scope.
- A scope may contain at most one tool whose effect_class is "irreversible".
- If a side-effecting tool reads the output of another side-effecting tool, both must be in the SAME scope.
- An uncommitted effect may not be consumed across a scope boundary, so a chain of dependent side effects is one scope, not several.
- A scope holding an irreversible tool must also hold every reversible tool that irreversible one depends on.
- Never emit a vertex of kind "router". Routing is not yours to decide.
- Never name a tool version, a tool view digest, or a rule template. Those are resolved for you.
- Every value in "input" must come from the task, or from a result you can see above. Do not invent identifiers, prices, or quantities.
- "parents" may only name ids inside this same answer. Where your work attaches to the existing graph is decided for you.`;

/** Renders the tools this run's role may call, with what a planner needs to choose between them. */
function catalogue(view: ResolvedToolView): string {
    return view.document.tools
        .map((tool) =>
            JSON.stringify({
                tool: tool.tool_id,
                description: tool.description ?? '',
                effect_class: tool.txn.effect_class,
                mode: tool.txn.mode,
                input_schema: tool.input_schema,
            }),
        )
        .join('\n');
}

interface ReadProposal {
    vertices: SubmittedVertex[];
    scopes: Array<{id: string; members: string[]}>;
}

/**
 * Reads a model answer into submittable vertices, or says why it could not.
 *
 * Refusal beats repair. A proposal that is nearly valid is still a proposal the model did not mean
 * to make, and quietly correcting it would put work into the log that no party authored: the model
 * would be blamed for a graph the parser wrote.
 */
function readProposal(content: string): ReadProposal | {reason: string} {
    const text = unfence(content);
    let decoded: unknown;
    try {
        decoded = JSON.parse(text);
    } catch (error) {
        return {reason: `answer is not JSON: ${error instanceof Error ? error.message : String(error)}`};
    }
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return {reason: 'answer is not a JSON object'};
    const body = decoded as {vertices?: unknown; scopes?: unknown};
    if (!Array.isArray(body.vertices) || !body.vertices.length) return {reason: 'answer declares no vertices'};

    const vertices: SubmittedVertex[] = [];
    for (const [index, raw] of body.vertices.entries()) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {reason: `vertex ${index} is not an object`};
        const vertex = raw as Record<string, unknown>;
        const id = vertex.id;
        if (typeof id !== 'string' || !id.trim()) return {reason: `vertex ${index} has no id`};
        const parents = vertex.parents ?? [];
        if (!Array.isArray(parents) || parents.some((parent) => typeof parent !== 'string')) return {reason: `${id} has a malformed parents list`};
        const base = {id, parents: parents as string[], ...(typeof vertex.scope === 'string' ? {scope: vertex.scope} : {})};

        if (vertex.kind === 'planner') {
            vertices.push({...base, kind: 'planner', ...(typeof vertex.goal === 'string' ? {goal: vertex.goal} : {})});
            continue;
        }
        if (vertex.kind !== 'tool') return {reason: `${id} declares kind ${JSON.stringify(vertex.kind)}; a planner may propose only tool and planner vertices`};
        if (typeof vertex.tool !== 'string' || !vertex.tool.trim()) return {reason: `${id} is a tool vertex with no tool`};
        const input = vertex.input ?? {};
        if (!input || typeof input !== 'object' || Array.isArray(input)) return {reason: `${id} has a malformed input`};
        vertices.push({...base, kind: 'tool', tool: vertex.tool, input: input as Record<string, unknown>});
    }

    const scopes: Array<{id: string; members: string[]}> = [];
    if (body.scopes !== undefined) {
        if (!Array.isArray(body.scopes)) return {reason: 'scopes is not an array'};
        for (const [index, raw] of body.scopes.entries()) {
            const scope = raw as {id?: unknown; members?: unknown};
            if (typeof scope?.id !== 'string' || !Array.isArray(scope.members) || scope.members.some((member) => typeof member !== 'string')) {
                return {reason: `scope ${index} is malformed`};
            }
            scopes.push({id: scope.id, members: scope.members as string[]});
        }
    }
    // Locality is checked here rather than left to the compiler, which throws on an unknown parent.
    // A model that has seen the existing graph will sometimes name a vertex from it, and that has to
    // arrive as a readable refusal rather than as an exception out of the freeze path.
    const local = new Set(vertices.map((vertex) => vertex.id));
    for (const vertex of vertices) {
        const foreign = (vertex.parents ?? []).find((parent) => !local.has(parent));
        if (foreign) return {reason: `${vertex.id} names parent ${foreign}, which is not in this answer; where this work attaches is not the planner's to choose`};
    }
    if (new Set(vertices.map((vertex) => vertex.id)).size !== vertices.length) return {reason: 'two vertices share an id'};

    return bindScopeMembership(vertices, scopes);
}

/**
 * Reconciles the two ways a submission can state scope membership.
 *
 * A vertex names its scope, and a scope lists its members, and both are the same fact written from
 * opposite ends. A model that writes only one of them has still said which scope the vertex is in,
 * so reading it from the other end is normalization rather than repair. Disagreement is a different
 * matter and is refused: two scopes claiming one vertex is a contradiction nothing can resolve.
 */
function bindScopeMembership(vertices: SubmittedVertex[], scopes: Array<{id: string; members: string[]}>): ReadProposal | {reason: string} {
    const declared = new Map<string, string>();
    for (const scope of scopes) {
        for (const member of scope.members) {
            const existing = declared.get(member);
            if (existing && existing !== scope.id) return {reason: `${member} is claimed by both scope ${existing} and scope ${scope.id}`};
            declared.set(member, scope.id);
        }
    }
    const bound = vertices.map((vertex) => {
        const membership = declared.get(vertex.id);
        if (!membership || vertex.scope) return vertex;
        return {...vertex, scope: membership};
    });
    for (const vertex of bound) {
        const membership = declared.get(vertex.id);
        if (vertex.scope && membership && vertex.scope !== membership) return {reason: `${vertex.id} names scope ${vertex.scope} but scope ${membership} lists it as a member`};
        if (vertex.scope && !scopes.some((scope) => scope.id === vertex.scope)) return {reason: `${vertex.id} names scope ${vertex.scope}, which is not declared`};
    }
    // Membership is also completed the other way, so a scope lists every vertex that named it.
    const complete = scopes.map((scope) => ({id: scope.id, members: [...new Set([...scope.members, ...bound.filter((vertex) => vertex.scope === scope.id).map((vertex) => vertex.id)])]}));
    return {vertices: bound, scopes: complete};
}

/**
 * Strips a markdown code fence when the model wrapped its JSON in one.
 *
 * This is the one repair worth making: a fence changes no content and every instruction-tuned model
 * adds one occasionally. Anything beyond it would be the parser guessing at intent.
 */
function unfence(content: string): string {
    const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n?\s*```\s*$/.exec(content);
    return (fenced?.[1] ?? content).trim();
}
