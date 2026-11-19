#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { pathToFileURL } from "node:url";
import { createRuntimeServices } from "./runtime-services.mjs";
import { runtimeInfo } from "./runtime-info.mjs";
import { readLocalConfig } from "./config.mjs";
import { metadataInputSchema, policyInputSchema, registerGraphTools, routeInputSchema } from "./graph-tools.mjs";
import { registerDynamicTools } from "./dynamic-tools.mjs";
import { registerRoutingTools } from "./routing-tools.mjs";
import { MAX_ADD_DIRS, MAX_ATTACHMENTS, MAX_INSTRUCTIONS_BYTES } from "./execution-controls.mjs";

// A stdio MCP caller commonly abandons a tool call after ~60s. A foreground
// handoff whose declared wall-clock budget exceeds this safe wait must not
// hold the tool call until the client gives up and then keep running unseen:
// the boundary converts it into a durable background job and the caller
// polls handoff_status/handoff_result instead.
export const FOREGROUND_SAFE_WAIT_MS = 55_000;
const READ_ONLY_TARGETS = ["opencode", "pi", "cursor", "claude", "codex", "gemini"];

export function foregroundTimeoutConversion(request) {
  const execution = request?.execution;
  if (!execution || execution.background === true) return null;
  if (!Number.isInteger(execution.timeoutMs) || execution.timeoutMs <= FOREGROUND_SAFE_WAIT_MS) return null;
  return {
    requestedTimeoutMs: execution.timeoutMs,
    safeForegroundWaitMs: FOREGROUND_SAFE_WAIT_MS,
    hint: `declared foreground budget ${execution.timeoutMs}ms exceeds the safe MCP foreground wait ${FOREGROUND_SAFE_WAIT_MS}ms; the handoff was started as a durable background job — poll handoff_status with its jobId or requestId, then handoff_result`,
  };
}

export function createServer(options = {}) {
  return createServerFactory(createRuntimeServices(options))();
}

export function createServerFactory({ companion, graphs, dynamic, workflowRegistry, routingSettings }, { cacheSchemas = false } = {}) {
  const tools = [];
  const server = {
    registerTool(name, configuration, handler) {
      if (!cacheSchemas) {
        tools.push([name, configuration, handler]);
        return;
      }
      const standard = configuration.inputSchema["~standard"];
      const cached = new Map();
      // The SDK converts schemas at registration and at every tools/list.
      const input = (options) => {
        if (!cached.has(options.target)) cached.set(options.target, standard.jsonSchema.input(options));
        return cached.get(options.target);
      };
      const inputSchema = { "~standard": { ...standard, jsonSchema: { ...standard.jsonSchema, input } } };
      tools.push([name, { ...configuration, inputSchema }, handler]);
    },
  };
  const requestSchema = z.object({
    protocolVersion: z.literal("1.0").optional(),
    requestId: z.string().trim().min(1).describe(
      "Stable caller-generated recovery key; required before any downstream work starts.",
    ),
    target: z.enum(["opencode", "pi", "cursor", "claude", "codex", "gemini", "amp", "acp"]),
    task: z.string().trim().min(1),
    cwd: z.string().trim().min(1),
    context: z.unknown().optional(),
    contextDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    workflow: z.unknown().optional(),
    route: routeInputSchema.optional(),
    execution: z.object({
      background: z.boolean().optional(),
      timeoutMs: z.number().describe("Positive integer up to 86400000; validated by the protocol for structured errors.").optional(),
      sessionId: z.string().optional(),
      addDirs: z.array(z.string().max(1024)).max(MAX_ADD_DIRS).optional().describe("Existing absolute directories for Claude, Codex, Cursor, or Gemini. Codex requires write policy. External write roots require confirmed write approval."),
      attachments: z.array(z.object({ type: z.enum(["image", "file"]), path: z.string().max(1024) }).strict()).max(MAX_ATTACHMENTS).optional().describe("Absolute local paths, up to 256 KiB each. Codex and Pi accept images. OpenCode and capable ACP agents accept images and files."),
      instructions: z.string().min(1).max(MAX_INSTRUCTIONS_BYTES).optional().describe("Append up to 8000 UTF-8 bytes to the Claude or Pi system prompt."),
      sessionAction: z.enum(["resume", "fork"]).optional().describe("Requires sessionId. Resume is the default. Fork uses native support on Claude, Codex, OpenCode, or Pi."),
      maxTurns: z.number().int().positive().optional().describe("Maximum Claude print-mode agentic turns."),
      transport: z.enum(["oneshot", "session"]).optional().describe("Session transport uses the native interactive protocol; unsupported controls never silently fall back to one-shot execution."),
    }).strict().optional(),
    policy: policyInputSchema.optional(),
    metadata: metadataInputSchema.optional(),
  }).strict().describe(
    "Complete Harnest request containing target, task, absolute cwd, context, workflow, route, execution, and policy.",
  );
  const namedRouteSchema = routeInputSchema.extend({ model: z.string().trim().min(1) });
  const readOnlyRequestSchema = requestSchema.safeExtend({
    target: z.enum(READ_ONLY_TARGETS).describe("Read-only-capable downstream harness; Amp and generic ACP are write-only."),
  });
  const referenceSchema = z.object({
    jobId: z.string().trim().min(1).optional(),
    requestId: z.string().trim().min(1).optional(),
  }).refine((value) => Boolean(value.jobId || value.requestId), {
    message: "jobId or requestId is required",
  });

  const response = (receipt) => ({
    content: [{ type: "text", text: JSON.stringify(receipt, null, 2) }],
    structuredContent: { receipt },
  });
  const controlResponse = (control) => ({
    content: [{ type: "text", text: JSON.stringify(control, null, 2) }],
    structuredContent: { control },
  });
  const dataResponse = (key, value) => ({
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: { [key]: value },
  });
  const failure = (error) => {
    const details = error?.details && typeof error.details === "object" ? error.details : null;
    const kind = typeof details?.kind === "string" && details.kind
      ? details.kind
      : (error?.name && error.name !== "Error" ? error.name : "Error");
    const message = error instanceof Error ? error.message : String(error);
    const body = { error: { kind, message }, runtime: runtimeInfo() };
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
      structuredContent: body,
    };
  };

  registerGraphTools(server, graphs, { dataResponse, failure });
  registerDynamicTools(server, dynamic, { registry: workflowRegistry, dataResponse, failure });
  registerRoutingTools(server, {
    settings: routingSettings,
    dataResponse, failure,
  });

  server.registerTool(
    "handoff_workflow",
    {
      title: "Hand off a complete workflow",
      description:
        "Run one complete workflow in OpenCode, Pi, Cursor, Claude, Codex, Gemini, Amp, or a trusted locally registered ACP agent and return a parent-visible receipt. Codex one-shot accepts route.profile and route.serviceTier. Claude one-shot accepts route.agent and route.serviceTier fast. Generic ACP is opt-in through route.agent and accepts advertised model, variant, and options controls. ACP is write-only and rejects provider pins, granular tools, cost budgets, persistent session transport, and live controls. For bounded independent work longer than one turn — not quick questions or in-session edits. Use background=true for durable status/result retrieval. A foreground execution.timeoutMs above the safe MCP foreground wait (55s, below the common 60s client tool timeout) is converted to a durable background job automatically; its receipt carries execution.foregroundConverted=true and the caller polls handoff_status instead of waiting. On guarded hosts, any write-capable policy requires metadata.harnest.writeApproved=true after the lead confirms scope.",
      inputSchema: z.object({ request: requestSchema }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ request }) => {
      try {
        const conversion = foregroundTimeoutConversion(request);
        if (!conversion) return response(await companion.start(request));
        const metadata = request.metadata && typeof request.metadata === "object" && !Array.isArray(request.metadata) ? request.metadata : {};
        const harnest = metadata.harnest && typeof metadata.harnest === "object" && !Array.isArray(metadata.harnest) ? metadata.harnest : {};
        return response(await companion.start({
          ...request,
          execution: { ...request.execution, background: true },
          metadata: {
            ...metadata,
            harnest: {
              ...harnest,
              execution: { foregroundConverted: true, convertedAt: new Date().toISOString(), ...conversion },
            },
          },
        }));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "handoff_compare",
    {
      title: "Compare multiple model routes",
      description: "Send one identical read-only task and context to 2-16 independently resolved model routes. Returns a durable receipt per lane so the lead can compare agreement, disagreement, evidence, usage, and failures without losing successful lanes.",
      inputSchema: z.object({
        request: readOnlyRequestSchema,
        candidates: z.array(z.object({
          name: z.string().regex(/^[A-Za-z0-9._-]+$/),
          target: z.enum(READ_ONLY_TARGETS).optional(),
          route: namedRouteSchema,
        })).min(2).max(16),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (input) => {
      try {
        return dataResponse("comparison", await companion.compare(input));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "handoff_review",
    {
      title: "Review work with multiple models",
      description: "Run 2-8 read-only reviewer lanes against one rubric with a shared findings board and lane-to-lane messages, then tally scores. Loops opinion-convergence only — it never implements. Returns consolidated findings for the lead to apply, then re-invoke with previous. Completes when the average reaches threshold (default 9).",
      inputSchema: z.object({
        request: readOnlyRequestSchema,
        reviewers: z.array(z.object({
          name: z.string().regex(/^[A-Za-z0-9._-]+$/),
          target: z.enum(READ_ONLY_TARGETS).optional(),
          route: namedRouteSchema,
        })).min(2).max(8),
        rubric: z.array(z.union([
          z.string().trim().min(1),
          z.object({
            factor: z.string().trim().min(1),
            weight: z.number().positive().optional(),
          }),
        ])).min(1).optional(),
        threshold: z.number().min(0).max(10).optional(),
        rounds: z.number().int().min(1).max(3).optional(),
        previous: z.object({
          summary: z.string().optional(),
          scores: z.record(z.string(), z.number()).optional(),
        }).catchall(z.unknown()).optional(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (input) => {
      try {
        return dataResponse("review", await companion.review(input));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "handoff_post",
    {
      title: "Post to a peer board",
      description: "Send a message to other subagents on a shared topic (a requestId, feature name, or lane name agreed out of band). Any worker with the topic can read it; no job binding, no delivery targeting.",
      inputSchema: z.object({
        topic: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
        from: z.string().trim().min(1).max(120),
        message: z.string().trim().min(1),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (input) => {
      try {
        return dataResponse("post", await companion.postToBoard(input));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "handoff_read",
    {
      title: "Read a peer board",
      description: "Read new messages from a shared topic. Poll with afterSequence=the previous nextSequence; only new entries enter context.",
      inputSchema: z.object({
        topic: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
        afterSequence: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (input) => {
      try {
        const { afterSequence, limit, ...reference } = input;
        return dataResponse("board", await companion.readBoard(reference, { afterSequence, limit }));
      } catch (error) {
        return failure(error);
      }
    },
  );

  for (const [name, title, description, operation, inputSchema] of [
    ["handoff_status", "Get handoff status", "Poll compact state for a handoff job by jobId or requestId; terminal states precede handoff_result.", (input) => companion.statusReference(input), referenceSchema],
    ["handoff_result", "Get terminal handoff result", "Terminal receipt for a settled job; verify requestId, context digest, route, session identity, and final text.", (input) => companion.resultReference(input), referenceSchema],
    [
      "handoff_cancel",
      "Cancel a running handoff",
      "Cancel a queued or running handoff. Cross-process cancellation records a request; poll until the owner acknowledges adapter settlement. Unacknowledged cancellation becomes partial, not cancelled.",
      ({ jobId }) => companion.cancel(jobId),
      z.object({ jobId: z.string().trim().min(1) }),
    ],
  ]) {
    server.registerTool(
      name,
      {
        title,
        description,
        inputSchema,
        annotations: {
          readOnlyHint: name !== "handoff_cancel",
          destructiveHint: name === "handoff_cancel",
        },
      },
      async (input) => {
        try {
          return response(await operation(input));
        } catch (error) {
          return failure(error);
        }
      },
    );
  }

  server.registerTool(
    "handoff_message",
    {
      title: "Send guidance to a running handoff",
      description: "Durably steer the next agent step or queue a follow-up in the active downstream session.",
      inputSchema: z.object({
        jobId: z.string().trim().min(1),
        commandId: z.string().trim().min(1),
        message: z.string().trim().min(1),
        delivery: z.enum(["steer", "follow_up"]).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ jobId, ...input }) => {
      try {
        return controlResponse(await companion.message(jobId, input));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "handoff_trace",
    {
      title: "Read handoff transcript events",
      description: "Read a bounded, redacted tail or only events after a known sequence. Poll with afterSequence=the previous nextSequence every 1-2s for live semantic progress without replaying the full trace. The native child-agent transcript (Claude/Codex/OpenCode worker thread) is the canonical live view; this trace is the durable, pollable mirror for hosts without one (Pi, Cursor IDE) and for recovery after the lead context dies.",
      inputSchema: referenceSchema.safeExtend({
        afterSequence: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ afterSequence, limit, ...reference }) => {
      try {
        return dataResponse("trace", await companion.traceReference(reference, { afterSequence, limit }));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "handoff_sessions",
    {
      title: "List handoff sessions",
      description: "List recent durable handoff receipts, including downstream session/workflow IDs and semantic progress.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).optional(),
        state: z.enum(["queued", "running", "completed", "failed", "cancelled", "partial"]).optional(),
        target: z.enum(["opencode", "pi", "cursor", "claude", "codex", "gemini", "amp", "acp"]).optional(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (input) => {
      try {
        return dataResponse("sessions", await companion.sessions(input));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "handoff_fleet",
    {
      title: "View the running agent fleet",
      description: "Show how many handoff agents are active, what each is doing (progress, last activity, recent messages), and how to steer it right now (live, pending, or resume). Poll this to watch every subagent at once.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).optional(),
        state: z.enum(["queued", "running", "completed", "failed", "cancelled", "partial"]).optional(),
        target: z.enum(["opencode", "pi", "cursor", "claude", "codex", "gemini", "amp", "acp"]).optional(),
        recent: z.number().int().min(0).max(10).optional(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (input) => {
      try {
        return dataResponse("fleet", await companion.fleet(input));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "handoff_reroute",
    {
      title: "Change the route for a running handoff",
      description: "Apply a provider/model change to the next model request, optionally with steering guidance.",
      inputSchema: z.object({
        jobId: z.string().trim().min(1),
        commandId: z.string().trim().min(1),
        route: z.object({
          provider: z.string().trim().min(1),
          model: z.string().trim().min(1),
          variant: z.string().trim().min(1).optional(),
          thinking: z.union([z.string(), z.boolean()]).optional(),
          harnessVersion: z.enum(["v1", "v2"]).optional(),
        }).strict(),
        message: z.string().trim().min(1).optional(),
        delivery: z.enum(["steer", "follow_up"]).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ jobId, ...input }) => {
      try {
        return controlResponse(await companion.reroute(jobId, input));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "handoff_resume",
    {
      title: "Resume a terminal handoff",
      description: "Resume a partial or failed read-only handoff once, after reviewing its trace; write-capable retries need lead approval. Pass background=true when the resumed budget may exceed the safe foreground wait.",
      inputSchema: z.object({
        jobId: z.string().trim().min(1),
        background: z.boolean().optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ jobId, background }) => {
      try {
        return response(
          await companion.resume(jobId, {
            execution: background === undefined ? {} : { background },
          }),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "handoff_host_info",
    {
      title: "Host launch info",
      description: "Report how Harnest handoffs must be launched from the calling host: direct vs native child session, worker names, routing resolver state, and live-control semantics per target.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async () => {
      try {
        const router = process.env.HARNEST_ROUTER || readLocalConfig().routing?.resolverModule || null;
        return dataResponse("host", {
          mcpServerName: "harnest",
          routingPreferences: {
            tools: ["handoff_routing_get", "handoff_routing_configure", "handoff_routing_preview"],
            usage: "Read settings and revision, edit base preferences or a named preset, then preview the actual resolved route. metadata.routing.preset selects a preset for one request; null selects base.",
          },
          graphWorkflows: {
            coordinator: "harnest",
            execution: "mixed-harness DAG; one complete handoff per node",
            tools: ["handoff_graph_validate", "handoff_graph_start", "handoff_graph_status", "handoff_graph_result", "handoff_graph_cancel", "handoff_graph_resume"],
            maxNodes: 256,
            maxConcurrency: 6,
            recovery: "explicit selective resume; completed nodes retained; inspect child job IDs with status/trace",
            visibility: "graph status lists all nodes; native child-agent panels depend on the calling host",
          },
          runtime: runtimeInfo(),
          dynamicWorkflows: {
            tools: ["validate", "start", "status", "result", "history", "inspect", "control", "resume", "revisions", "save", "list", "get", "delete", "invoke"].map((name) => `handoff_dynamic_${name}`),
            execution: "isolated JavaScript with agent, pipeline, parallel, phase, log and args",
            recovery: "ordered-prefix replay; failed or changed invocation invalidates the suffix; write retries need explicit approval",
            maxAgents: 1000, maxHelperItems: 4096, maxConcurrency: 6,
            viewer: "node scripts/dynamic-view.mjs [runId]",
          },
          sessionTransports: {
            selection: "execution.transport=session; native credentials; no silent one-shot fallback",
            claude: "Agent SDK streaming input; delivery is not consumption; setModel has native acknowledgement",
            codex: "app-server; turn/steer acknowledged; next-turn messages remain queued until observed",
            cursor: "ACP; negotiated resume and cancellation; active-turn message/steer unsupported",
            gemini: "unsupported; prompt-only one-shot execution",
            amp: "unsupported; prompt-only one-shot execution",
            acp: "unsupported; generic ACP uses attached prompt turns and native resume negotiation without Harnest persistent transport",
            usageLimitWaiting: "Claude SDK does not inherit interactive subscription reset waiting",
          },
          writeApproval: {
            marker: "metadata.harnest.writeApproved=true",
            appliesTo: "write-capable handoff_workflow and handoff_graph_start calls on guarded hosts, including policy.write=true, policy.readOnly=false, and policy.allowWrites=true",
            scope: "The lead confirms the intended write scope before setting the marker; there is no separate writeScope protocol field.",
          },
          nestedHandoffs: "A nested handoff remains subject to the child host's approval and sandbox restrictions and cannot widen them.",
          launchPath: {
            direct: "Call handoff_workflow directly as an MCP tool when child visibility is not needed.",
            claude: "Invoke the native workflow-rescue subagent (or harnest:opencode-worker / harnest:pi-worker / harnest:cursor-worker / harnest:claude-worker / harnest:codex-worker / harnest:gemini-worker / harnest:amp-worker / harnest:acp-worker) via the Agent tool so the receipt returns through the subagent transcript; the worker pages status/trace and returns the durable receipt verbatim.",
            codex: "For Codex-to-Codex, call handoff_workflow directly. For other targets, call it directly or spawn the matching native worker for a visible child thread: opencode_worker, pi_worker, cursor_worker, claude_worker, gemini_worker, amp_worker, or acp_worker.",
            opencode: "Call harnest_handoff_workflow directly, or launch the task tool with the matching worker subagent for a visible child session.",
            pi: "Call handoff_workflow directly; Pi has no child-agent surface, bounded status/trace pages ARE the operator view.",
            cursor: "Call handoff_workflow directly as an MCP tool (Cursor MCP servers are team/workspace configured). For visibility, run one cursor-worker background agent per handoff and poll status/trace; Cursor subagents do not inherit UI MCP servers in automations, so prefer direct calls.",
          },
          workers: [
            { agent: "opencode-worker", target: "opencode", notes: "Name the target (or auto) and policy picks the model; set route.model only when the user names one. Live steer/reroute requires route.harnessVersion v2; V1 controls fail closed." },
            { agent: "pi-worker", target: "pi", notes: "Route or profile default is fine. Live steer/reroute supported." },
            { agent: "cursor-worker", target: "cursor", notes: "One-shot print mode with stream-json deltas in trace. Read-only maps to --mode ask; write uses --force. Resume via execution.sessionId; no live message/reroute." },
            { agent: "claude-worker", target: "claude", notes: "One-shot print mode with stream-json deltas in trace. Read-only maps to --permission-mode plan; write uses acceptEdits. Supports route.agent and route.serviceTier fast. Supports maxCostUsd via --max-budget-usd. Resume via execution.sessionId; no live message/reroute." },
            { agent: "codex-worker", target: "codex", notes: "One-shot exec with JSONL events in trace. Supports route.profile and route.serviceTier. Read-only maps to --sandbox read-only; write uses workspace-write (never danger-full-access). Resume via execution.sessionId; no live message/reroute." },
            { agent: "gemini-worker", target: "gemini", notes: "Prompt-only one-shot with isolated native policy for read or approved write work. Rejects granular tools, cost budgets, persistent session transport, and live controls." },
            { agent: "amp-worker", target: "amp", notes: "Prompt-only attached local execution on macOS or Linux, including when the whole MCP server runs inside WSL. Requires approved write policy; route.variant accepts low, medium, high, or ultra. Rejects read-only work, model/provider pins, persistent session transport, and live controls." },
            { agent: "acp-worker", target: "acp", notes: "One generic worker for a trusted local ACP registration selected by route.agent. Requires approved write policy. Only native advertised model, variant, and options choices are accepted. Native authentication stays native. Provider pins, automatic installation, persistent session transport, and live controls are unsupported." },
          ],
          controlSemantics: {
            acknowledged: "applied",
            uncertain: "transport acknowledgement lost; reconcile from downstream trace",
            v1Opencode: "live message/reroute fail closed by design; use V2 or Pi",
            cursor: "oneshot rejects live controls; session uses ACP cancellation and negotiated model reroute, but rejects mid-turn messages",
            claude: "oneshot rejects live controls; session uses SDK streaming guidance with UUID consumption evidence and native setModel acknowledgement",
            codex: "oneshot rejects live controls; session uses app-server turn/steer and owned next-turn messages",
            gemini: "oneshot rejects live controls; resume uses the native session identity when supplied",
            amp: "oneshot rejects live controls; resume uses the native session identity when supplied",
            acp: "generic attached ACP supports cancellation only; message and reroute controls are unsupported",
          },
          routingResolverConfigured: Boolean(router),
          routingResolverPath: router,
          routingResolver: typeof companion.routeResolver.diagnostics === "function"
            ? await companion.routeResolver.diagnostics()
            : null,
          liveTrace: "Poll handoff_trace with afterSequence=previous nextSequence every 1-2s; every parent update must name trace.progress phase/current/recent/lastMeaningfulAt. Heartbeat-only activity is stalled, not progress.",
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  return () => {
    const protocol = new McpServer(
      { name: "harnest", version: "0.1.0" },
      {
        instructions: "One harness owns each handoff. For mixed-harness dependency graphs, validate then start with handoff_graph_validate/handoff_graph_start, retain graphId, poll graph status and inspect individual child traces. Preserve completed nodes when resuming unsuccessful graphs. For one handoff use requestId+cwd+context+workflow+route+policy, start background, poll handoff_trace with afterSequence, return handoff_result verbatim. Never merge or deploy unless policy grants it. Call handoff_host_info when unsure of the launch path.",
      },
    );
    for (const definition of tools) protocol.registerTool(...definition);
    return protocol;
  };
}

export async function main() {
  await serveStdio(createServerFactory(createRuntimeServices()), { legacy: "serve" });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`harnest MCP failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
