import { z } from "zod";
import { EXACT_TOOL_NAME } from "./protocol.mjs";

const target = z.enum(["auto", "pi", "claude", "codex", "opencode", "cursor", "gemini", "amp", "acp"]);
const nodeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const object = z.record(z.string(), z.unknown());
const nonEmpty = z.string().trim().min(1);
const toolNames = z.array(z.string().regex(EXACT_TOOL_NAME));

export const routeInputSchema = z.object({
  provider: nonEmpty.optional(),
  model: nonEmpty.optional(),
  agent: nonEmpty.optional(),
  variant: nonEmpty.optional(),
  thinking: z.union([nonEmpty, z.boolean()]).optional(),
  harnessVersion: z.enum(["v1", "v2"]).optional(),
  serverUrl: nonEmpty.optional(),
}).strict();

export const policyInputSchema = z.object({
  write: z.boolean().describe("Write-capable request. On guarded hosts, confirm scope and set metadata.harnest.writeApproved=true.").optional(),
  readOnly: z.boolean().describe("Legacy alias for !write; must not contradict write or allowWrites.").optional(),
  allowWrites: z.boolean().describe("Legacy alias for write; must not contradict write or readOnly.").optional(),
  tools: z.union([
    z.array(nonEmpty),
    z.object({ allow: toolNames.optional(), deny: toolNames.optional() }).strict(),
  ]).describe("Legacy list or exact native allow and deny names. Claude print and Gemini support both lists. Pi and local OpenCode V1 support deny only.").optional(),
  mode: z.literal("plan").describe("Cursor print only. Selects read-only plan mode regardless of write authorization.").optional(),
  sandbox: z.boolean().describe("Cursor print only. True enables native isolation. False is rejected.").optional(),
  maxCostUsd: z.number().nonnegative().optional(),
}).strict();

export const metadataInputSchema = z.object({
  harnest: z.object({
    writeApproved: z.boolean().describe("Exact guarded-host approval marker. Set true only after the lead confirms the intended write scope; there is no separate writeScope protocol field.").optional(),
  }).catchall(z.unknown()).optional(),
  routing: object.optional(),
}).catchall(z.unknown());

export const graphInputSchema = z.object({
  requestId: z.string().trim().min(1).max(200),
  cwd: z.string().trim().min(1),
  task: z.string().optional(),
  context: object.optional(),
  policy: policyInputSchema.optional(),
  metadata: metadataInputSchema.optional(),
  execution: z.object({
    background: z.boolean().optional(),
    timeoutMs: z.number().int().min(1).max(86400000).optional(),
    maxConcurrency: z.number().int().min(1).max(6).optional(),
  }).strict().optional(),
  nodes: z.array(z.object({
    id: nodeId,
    target,
    task: z.string().trim().min(1),
    dependsOn: z.array(nodeId).max(256).optional(),
    route: routeInputSchema.optional(),
    cwd: z.string().trim().min(1).optional(),
    context: object.optional(),
    policy: policyInputSchema.optional(),
    metadata: metadataInputSchema.optional(),
    execution: z.object({ timeoutMs: z.number().int().min(1).max(86400000).optional() }).strict().optional(),
  }).strict()).min(1).max(256),
  outputs: z.array(nodeId).min(1).max(256).optional(),
}).strict().describe("Agent-authored DAG. Each node is a prompt-only handoff; dependencies pass attributed results. Different nodes may use different harnesses. Completed nodes are preserved during recovery.");

export function registerGraphTools(server, graphs, { dataResponse, failure }) {
  const reference = z.object({ graphId: z.string().trim().min(1) }).strict();
  const definitions = [
    ["handoff_graph_validate", "Validate an agent graph", "Validate all nodes, dependencies, routes, directories and permissions without dispatching agents. On guarded hosts, validation does not grant write authority; graph start still requires metadata.harnest.writeApproved=true after the lead confirms scope.", z.object({ graph: graphInputSchema }), true, ({ graph }) => graphs.validate(graph)],
    ["handoff_graph_start", "Run an agent graph", "Execute a durable mixed-harness DAG. Ready nodes run in parallel; dependents receive attributed outputs. Defaults to background execution. Retain graphId and poll handoff_graph_status. A repeated identical requestId reattaches to the same graph. On guarded hosts, write-capable graphs require metadata.harnest.writeApproved=true after the lead confirms scope.", z.object({ graph: graphInputSchema }), false, ({ graph }) => graphs.start(graph)],
    ["handoff_graph_status", "Read agent graph status", "Read compact node state and child job references. Pass the previous revision as afterRevision and waitMs up to 25000 to wait for changes without repeated agent polling. Unchanged responses omit node detail. Inspect children with handoff_trace.", z.object({
      graphId: z.string().trim().min(1),
      afterRevision: z.number().int().min(0).optional(),
      waitMs: z.number().int().min(0).max(25000).optional(),
    }).strict(), true, ({ graphId, ...options }) => graphs.status(graphId, options)],
    ["handoff_graph_result", "Read settled graph results", "Read a settled graph and its selected output nodes. Partial results retain successful independent branches and identify unsuccessful or blocked nodes. Does not resume work.", reference, true, ({ graphId }) => graphs.result(graphId)],
    ["handoff_graph_cancel", "Cancel an agent graph", "Persist cancellation intent, stop future dispatch, and request cancellation of running children. Poll graph status until settled; partial may mean a child could not confirm stopping.", reference, false, ({ graphId }) => graphs.cancel(graphId)],
    ["handoff_graph_resume", "Resume unsuccessful graph steps", "Resume selected unsuccessful nodes and newly unblocked dependents while preserving completed nodes. commandId is caller-owned and idempotent. Retry of a write-capable node requires explicit approveWrites after review. Never approve writes on behalf of the user.", z.object({
      graphId: z.string().trim().min(1),
      commandId: z.string().trim().min(1).max(200),
      nodeIds: z.array(nodeId).min(1).max(256).optional(),
      approveWrites: z.boolean().optional(),
      background: z.boolean().optional(),
    }).strict(), false, (input) => graphs.resume(input)],
  ];
  for (const [name, title, description, inputSchema, readOnlyHint, run] of definitions) {
    server.registerTool(name, {
      title, description, inputSchema,
      annotations: { readOnlyHint, destructiveHint: name === "handoff_graph_cancel" },
    }, async (input) => {
      try { return dataResponse("graph", await run(input)); }
      catch (error) { return failure(error); }
    });
  }
}
