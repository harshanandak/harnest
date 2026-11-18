import { z } from "zod";
import { WorkflowRegistry } from "./workflow-registry.mjs";
import { inspectDynamicInvocation } from "./dynamic-inspect.mjs";
import { MAX_PHASE_LIMIT } from "./dynamic-protocol.mjs";
export { renderDynamicView, watchDynamicView } from "./dynamic-view.mjs";

const object = z.record(z.string(), z.unknown());
const id = z.string().trim().min(1).max(200);
const name = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const source = z.string().min(1).max(1_000_000);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const saved = { name, cwd: z.string().min(1).optional(), scope: z.enum(["project", "user"]).optional() };
export const dynamicInputSchema = z.object({
  requestId: id, name: z.string().max(200).optional(), source, args: z.json().optional(),
  cwd: z.string().min(1), target: z.enum(["auto", "pi", "opencode", "claude", "codex", "cursor", "gemini", "amp", "acp"]).optional(),
  route: object.optional(), policy: object.optional(), context: object.optional(), metadata: object.optional(),
  execution: z.object({
    background: z.boolean().optional(), timeoutMs: z.number().int().min(1).max(86400000).optional(),
    maxConcurrency: z.number().int().min(1).max(6).optional(), maxAgents: z.number().int().min(1).max(1000).optional(),
    prefixStaggerMs: z.number().int().min(0).max(5000).optional(),
    transport: z.enum(["oneshot", "session"]).optional(),
    providerWait: z.object({ maxRetries: z.number().int().min(0).max(10) }).strict().optional(),
  }).strict().optional(),
}).strict();

export function lazyDynamicRunner(options) {
  let loaded;
  let runner;
  const load = () => loaded ??= import("./dynamic-runner.mjs").then(({ DynamicWorkflowRunner }) => {
    runner = new DynamicWorkflowRunner(options);
    return runner;
  });
  return {
    ...Object.fromEntries(["validate", "start", "status", "result", "history", "control", "resume"].map((method) => [method, async (...args) => (await load())[method](...args)])),
    inspect: async (input) => inspectDynamicInvocation(await load(), input),
    isBusy: () => Boolean(runner?.running.size),
  };
}

export function dynamicToolDefinitions(runner, registry = new WorkflowRegistry()) {
  const phasePage = { phaseLimit: z.number().int().min(1).max(MAX_PHASE_LIMIT).optional(), phaseCursor: z.number().int().min(0).optional() };
  const spec = z.object({ workflow: dynamicInputSchema }).strict();
  const definitions = [
    ["validate", "Validate a JavaScript workflow without executing agents.", spec, true, ({ workflow }) => runner.validate(workflow)],
    ["start", "Start an isolated JavaScript workflow. Retain runId; inspect status and child traces. Scripts use ordered-prefix replay, unlike fixed DAG recovery.", spec, false, ({ workflow }) => runner.start({ ...workflow, execution: { ...workflow.execution, background: true } })],
    ["status", "Read workflow progress and per-phase agent counts, reported usage and elapsed state. afterRevision/waitMs wait for changes. invocationLimit/invocationCursor page agent rows. phaseLimit/phaseCursor page phase summaries. Detailed output remains in child traces.", z.object({ runId: id, afterRevision: z.number().int().min(0).optional(), waitMs: z.number().int().min(0).max(25000).optional(), invocationLimit: z.number().int().min(1).max(1000).optional(), invocationCursor: z.number().int().min(0).optional(), ...phasePage }).strict(), true, (input) => runner.status(input)],
    ["result", "Read bounded workflow output and terminal health without replaying work. phaseLimit/phaseCursor page phase summaries.", z.object({ runId: id, ...phasePage }).strict(), true, (input) => runner.result(input)],
    ["history", "List durable workflow history with compact summaries and pagination.", z.object({ limit: z.number().int().min(1).max(100).optional(), cursor: z.string().optional(), state: z.string().optional() }).strict(), true, (input) => runner.history(input)],
    ["resume", "Replay a settled workflow, reusing its successful ordered prefix. Failed or changed invocations invalidate subsequent work. Write retries require explicit user approval.", z.object({ runId: id, commandId: id, source: source.optional(), approveWrites: z.boolean().optional() }).strict(), false, (input) => runner.resume(input)],
  ];
  definitions.push(
    ["revisions", "List immutable source revisions, including deleted definitions, with bounded pagination.", z.object({ ...saved, limit: z.number().int().min(1).max(100).optional(), cursor: revision.optional() }).strict(), true, (input) => registry.revisions(input)],
    ["inspect", "Read an invocation's phase summary and page its historical attempts, including invalidated attempts. Use returned job IDs with handoff_trace/result for full detail.", z.object({ runId: id, invocationId: id, offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(50).optional() }).strict(), true, (input) => runner.inspect ? runner.inspect(input) : inspectDynamicInvocation(runner, input)],
    ["invoke", "Run a reviewed saved workflow with parameters. revision pins the source being invoked; a stable requestId deduplicates starts.", z.object({ ...saved, cwd: z.string().min(1), requestId: id, revision, args: z.json().optional(), target: dynamicInputSchema.shape.target, route: object.optional(), policy: object.optional(), context: object.optional(), execution: dynamicInputSchema.shape.execution }).strict(), false, async (input) => {
      const definition = await registry.get(input);
      const { scope, revision: selectedRevision, ...specification } = input;
      return runner.start({ ...specification, source: definition.source, metadata: { savedWorkflow: { name: definition.name, scope: definition.scope, revision: selectedRevision } }, execution: { ...input.execution, background: true } });
    }],
    ["control", "Durably pause, continue, stop or guide a workflow or invocation. Accepted is not applied; inspect acknowledgements. Restart invalidates the replay suffix.", z.object({ runId: id, commandId: id, action: z.enum(["pause", "continue", "stop", "stop-agent", "restart-agent", "steer", "reroute"]), invocationId: id.optional(), message: z.string().max(50000).optional(), route: object.optional(), approveWrites: z.boolean().optional() }).strict(), false, (input) => runner.control(input)],
    ["save", "Save a reusable script in project or user scope. Replacing requires the current expectedRevision. Existing runs retain their script.", z.object({ ...saved, source, expectedRevision: revision.optional() }).strict(), false, (input) => registry.save(input)],
    ["list", "List saved workflow metadata; project definitions take precedence over user definitions.", z.object({ cwd: saved.cwd, scope: saved.scope, limit: z.number().int().min(1).max(100).optional(), cursor: name.optional() }).strict(), true, (input) => registry.list(input)],
    ["get", "Read a saved script or historical revision for review before invocation.", z.object({ ...saved, revision: revision.optional() }).strict(), true, (input) => registry.get(input)],
    ["delete", "Remove a reusable definition while retaining historical source revisions and run history.", z.object({ ...saved, expectedRevision: revision }).strict(), false, (input) => registry.delete(input)],
  );
  return definitions.map(([suffix, description, inputSchema, readOnlyHint, run]) => ({
    name: `handoff_dynamic_${suffix}`,
    description: description + (["save", "delete", "revisions"].includes(suffix) ? " Defaults to project scope with cwd, otherwise user scope." : ""),
    inputSchema, parameters: z.toJSONSchema(inputSchema), readOnlyHint, run,
  }));
}

export function registerDynamicTools(server, runner, { registry, dataResponse, failure }) {
  for (const { name, description, inputSchema, readOnlyHint, run } of dynamicToolDefinitions(runner, registry)) {
    server.registerTool(name, { title: name.replaceAll("_", " "), description, inputSchema, annotations: { readOnlyHint, destructiveHint: name.endsWith("_delete") || name.endsWith("_control") } }, async (input) => {
      try { return dataResponse("workflow", await run(input)); }
      catch (error) { return failure(error); }
    });
  }
}
