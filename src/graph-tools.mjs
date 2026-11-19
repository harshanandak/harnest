import { z } from "zod";
import { MAX_ADD_DIRS, MAX_ATTACHMENTS, MAX_INSTRUCTIONS_BYTES } from "./execution-controls.mjs";
import {
  CODEX_PROFILE_PATTERN,
  CODEX_SERVICE_TIERS,
  EXACT_TOOL_NAME,
  HARNESS_VERSIONS,
  MAX_ROUTE_OPTIONS,
  MAX_ROUTE_OPTION_ID,
  MAX_ROUTE_OPTION_VALUE,
  RESERVED_ROUTE_OPTION_IDS,
} from "./protocol.mjs";

const target = z.enum(["auto", "pi", "claude", "codex", "opencode", "cursor", "gemini", "amp", "acp"]);
const nodeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const object = z.record(z.string(), z.unknown());
const nonEmpty = z.string().trim().min(1);
const toolNames = z.array(z.string().regex(EXACT_TOOL_NAME));

export const routeInputSchema = z.object({
  provider: nonEmpty.optional(),
  model: nonEmpty.describe("For ACP, use a model ID advertised by the native session.").optional(),
  agent: nonEmpty.describe("Claude named agent, OpenCode agent, or trusted ACP registration ID.").optional(),
  variant: nonEmpty.describe("For ACP, use a mode ID advertised by the native session.").optional(),
  thinking: z.union([nonEmpty, z.boolean()]).optional(),
  harnessVersion: z.enum(HARNESS_VERSIONS).optional(),
  serverUrl: nonEmpty.optional(),
  serviceTier: z.enum(CODEX_SERVICE_TIERS).describe("One-shot only. Claude supports fast.").optional(),
  profile: z.string().regex(CODEX_PROFILE_PATTERN).describe("Codex one-shot native config profile name.").optional(),
  options: z.record(
    z.string().regex(/\S/).max(MAX_ROUTE_OPTION_ID).meta({ not: { enum: [...RESERVED_ROUTE_OPTION_IDS] } }),
    z.union([z.string().max(MAX_ROUTE_OPTION_VALUE), z.boolean()]),
  ).meta({
    description: "ACP session option IDs mapped to advertised values.",
    maxProperties: MAX_ROUTE_OPTIONS,
  }).optional(),
}).strict();

export const nativeExecutionInputFields = {
  sessionId: z.string().optional(),
  addDirs: z.array(z.string().max(1024)).max(MAX_ADD_DIRS).optional().describe("Existing absolute directories for Claude, Codex, Cursor, or Gemini. Codex requires write policy. External write roots require confirmed write approval."),
  attachments: z.array(z.object({ type: z.enum(["image", "file"]), path: z.string().max(1024) }).strict()).max(MAX_ATTACHMENTS).optional().describe("Absolute local paths, up to 256 KiB each. Codex and Pi accept images. OpenCode and capable ACP agents accept images and files."),
  instructions: z.string().min(1).max(MAX_INSTRUCTIONS_BYTES).optional().describe("Append up to 8000 UTF-8 bytes to the Claude or Pi system prompt."),
  sessionAction: z.enum(["resume", "fork"]).optional().describe("Requires sessionId. Resume is the default. Fork uses native support on Claude, Codex, OpenCode, or Pi."),
  maxTurns: z.number().int().positive().optional().describe("Maximum Claude print-mode agentic turns."),
};

export const policyInputSchema = z.object({
  write: z.boolean().describe("Write-capable request. On guarded hosts, confirm scope and set metadata.harnest.writeApproved=true.").optional(),
  readOnly: z.boolean().describe("Legacy alias for !write; must not contradict write or allowWrites.").optional(),
  allowWrites: z.boolean().describe("Legacy alias for write; must not contradict write or readOnly.").optional(),
  tools: z.union([
    z.array(nonEmpty),
    z.object({ allow: toolNames.optional(), deny: toolNames.optional() }).strict(),
  ]).describe("Legacy list or exact native allow and deny names. Claude print and Gemini support both lists. Pi supports deny only. OpenCode delegates tool permissions to its server.").optional(),
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
    execution: z.object({
      timeoutMs: z.number().int().min(1).max(86400000).optional(),
      ...nativeExecutionInputFields,
    }).strict().optional(),
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
