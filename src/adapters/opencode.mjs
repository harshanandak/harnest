// Explicit workflow.spec requests use opencode-taskflow's pinned host-neutral
// core, imported lazily so a plain OpenCode task never needs the optional
// Taskflow packages installed. The core is the same taskflow_run
// implementation and lets this adapter supply the injected executable/spawn
// seam required by the companion contract.
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestContext, normalizePolicyControls } from "../protocol.mjs";
import {
  ProcessError,
  boundedProviderText,
  classifyProviderFailure,
  mergeProcessEnv,
  parseJsonLine,
  providerErrorFromEvent,
  runProcess,
} from "../process.mjs";
import { harnessLaunch, openCodeEnvironment } from "../config.mjs";
import { NativeLaunchError, spawnNativeCommand } from "../launch-command.mjs";
import { executionError, stageAttachments, validateAdapterExecution } from "../execution-controls.mjs";
import { requireExecutionFlags } from "./execution-help.mjs";
import { compactText, structuredResult } from "../result.mjs";
import { summarizeUsage } from "../usage.mjs";
import { OpenCodeControl } from "./opencode-control.mjs";
import { assertNoClaudeRoute, assertNoClaudeWorkflow } from "../model-policy.mjs";

const BASELINE_READ_TOOLS = ["read", "grep", "glob", "list"];
const SCOPED_V1_VERSION = "1.18.18";
const TOOL_ALIASES = { find: "glob", ls: "list" };
const MAX_PROTOCOL_TEXT_CHARS = 1024 * 1024;
const MAX_FINAL_TEXT_CHARS = 64_000;
const MAX_EVENT_TYPES = 256;
const MAX_EVENT_TYPE_CHARS = 256;

function retainFinalText(state, text, replace = false) {
  if (replace) {
    state.finalText = "";
    state.finalTextOverflow = false;
  }
  if (state.finalTextOverflow) return;
  if (state.finalText.length + text.length > MAX_PROTOCOL_TEXT_CHARS) {
    state.finalText = "";
    state.finalTextOverflow = true;
    return;
  }
  state.finalText += text;
}

function finalResult(text, extras) {
  const result = structuredResult(text, extras);
  // structuredResult compacts diagnostics, but a truncated final answer cannot
  // satisfy the adapter's completion contract.
  if (result.finalText.length > MAX_FINAL_TEXT_CHARS) {
    throw adapterError("OpenCode final output exceeds the result limit", "output-limit", { maxChars: MAX_FINAL_TEXT_CHARS });
  }
  return result;
}

function observeEventSummary(state, event) {
  state.eventSummary.count += 1;
  const type = event?.type ?? event?.event?.type ?? event?.event?.event?.type;
  if (typeof type !== "string" || state.eventTypes.has(type)) return;
  // Keep first-occurrence order even when a type leaves the last-20 sample.
  if (type.length > MAX_EVENT_TYPE_CHARS || state.eventTypes.size >= MAX_EVENT_TYPES) {
    state.summaryFailure ||= adapterError("OpenCode event types exceed the summary limit", "output-limit", {
      maxEventTypes: MAX_EVENT_TYPES, maxEventTypeChars: MAX_EVENT_TYPE_CHARS,
    });
    return;
  }
  state.eventTypes.add(type);
  state.eventSummary.types.push(type);
  if (state.eventSummary.types.length > 20) state.eventSummary.types.shift();
}

function policyConfig(policy = {}, inlineConfig, scopedAgent) {
  let base = {};
  if (inlineConfig) {
    try {
      base = JSON.parse(inlineConfig);
    } catch {
      throw new TypeError("OPENCODE_CONFIG_CONTENT must be valid JSON so the handoff policy can be enforced");
    }
  }
  const allowed = new Set(BASELINE_READ_TOOLS);
  if (policy.write) {
    for (const tool of Array.isArray(policy.tools) ? policy.tools : []) allowed.add(TOOL_ALIASES[tool] || tool);
  }
  const denied = policy.tools?.deny ?? [];
  for (const tool of denied) allowed.delete(tool);
  const denyRules = denied.map((tool) => [tool, "deny"]);
  const permission = Object.fromEntries([["*", "deny"], ...[...allowed].map((tool) => [tool, "allow"]), ...denyRules]);
  if (scopedAgent) {
    // V1 applies agent rules last. Add only denies at that layer.
    base.agent = { ...base.agent, [scopedAgent]: { mode: "primary", permission: Object.fromEntries(denyRules) } };
  }
  return JSON.stringify({
    ...base,
    permission,
  });
}

const USAGE_KEYS = ["input", "output", "cacheRead", "cacheWrite", "cost", "contextTokens", "turns"];

function emptyUsage() {
  return Object.fromEntries(USAGE_KEYS.map((key) => [key, 0]));
}

function addNumber(target, key, value) {
  const n = typeof value === "number" && Number.isFinite(value) ? value : Number(value);
  if (Number.isFinite(n)) target[key] += n;
}

function addUsage(target, source, reported = null) {
  if (!source || typeof source !== "object") return;
  for (const key of USAGE_KEYS) {
    if (source[key] == null) continue;
    if (key === "contextTokens") {
      const value = Number(source[key]);
      if (Number.isFinite(value) && value > 0) {
        target[key] = value;
        if (reported) reported[key] = true;
      }
    } else {
      addNumber(target, key, source[key]);
      if (reported && Number.isFinite(Number(source[key]))) reported[key] = true;
    }
  }
}

function textFromValue(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textFromValue).filter(Boolean).join("");
  if (!value || typeof value !== "object") return "";
  for (const key of ["text", "finalText", "finalOutput", "output", "content", "message"]) {
    const text = textFromValue(value[key]);
    if (text) return text;
  }
  return "";
}

function eventSessionId(event) {
  if (!event || typeof event !== "object") return null;
  for (const key of ["sessionID", "sessionId", "session_id"]) {
    if (typeof event[key] === "string" && event[key]) return event[key];
  }
  const info = event.properties?.info || event.info;
  if (typeof info?.id === "string" && info.id) return info.id;
  if (typeof event.part?.sessionID === "string" && event.part.sessionID) return event.part.sessionID;
  if (typeof event.part?.sessionId === "string" && event.part.sessionId) return event.part.sessionId;
  return null;
}

function eventWorkflowRunId(event) {
  if (!event || typeof event !== "object") return null;
  for (const key of ["workflowRunId", "workflow_run_id", "runId", "run_id"]) {
    if (typeof event[key] === "string" && event[key]) return event[key];
  }
  return null;
}

/**
 * Fold the JSON object emitted by `opencode run --format json`.
 * OpenCode's stable stream is step_start/text/tool_use/step_finish/error;
 * the extra result/session forms keep this tolerant of newer CLI releases.
 */
export function foldOpenCodeEvent(state, event) {
  if (!event || typeof event !== "object") return null;
  const sessionId = eventSessionId(event);
  if (sessionId) state.sessionId = sessionId;
  const workflowRunId = eventWorkflowRunId(event);
  if (workflowRunId) state.workflowRunId = workflowRunId;

  const part = event.part && typeof event.part === "object" ? event.part : null;
  const type = String(event.type || part?.type || "");
  let activity = "";
  if (type === "tool_use" || type === "tool" || type === "tool-call") {
    retainFinalText(state, "", true);
    activity = textFromValue(part?.state?.title) || textFromValue(part?.tool) || "tool";
  } else if (type === "text" || type === "message.part.updated" || type === "assistant") {
    const text = textFromValue(part) || textFromValue(event.text) || textFromValue(event.content);
    if (text) retainFinalText(state, text);
    activity = state.finalText.slice(0, 2000).trim();
  } else if (["result", "final", "final_output", "final-output"].includes(type)) {
    const text = textFromValue(event.result) || textFromValue(event.output) || textFromValue(event);
    if (text) retainFinalText(state, text, true);
    activity = state.finalText.slice(0, 2000).trim();
  } else if (type === "step_finish" || type === "step-finish") {
    state.terminalSeen = true;
    state.usage.turns += 1;
    const tokens = part?.tokens || event.tokens || event.usage?.tokens;
    if (tokens) {
      const reported = (state.usageReported ??= {});
      if (tokens.input != null) reported.input = true;
      addNumber(state.usage, "input", tokens.input);
      if (tokens.output != null || tokens.reasoning != null) reported.output = true;
      addNumber(state.usage, "output", tokens.output);
      addNumber(state.usage, "output", tokens.reasoning);
      const cacheRead = tokens.cache?.read ?? tokens.cacheRead;
      const cacheWrite = tokens.cache?.write ?? tokens.cacheWrite;
      if (cacheRead != null) reported.cacheRead = true;
      if (cacheWrite != null) reported.cacheWrite = true;
      addNumber(state.usage, "cacheRead", cacheRead);
      addNumber(state.usage, "cacheWrite", cacheWrite);
      const total = Number(tokens.total);
      if (Number.isFinite(total) && total > 0) state.usage.contextTokens = total;
    }
    const cost = part?.cost ?? event.cost ?? event.usage?.cost;
    if (cost != null) (state.usageReported ??= {}).cost = true;
    addNumber(state.usage, "cost", cost);
    activity = state.finalText.slice(0, 2000).trim();
  } else if (type === "usage" || type === "message.usage") {
    addUsage(state.usage, event.usage || event, (state.usageReported ??= {}));
    activity = state.finalText.slice(0, 2000).trim();
  } else if (type === "error") {
    if (!classifyProviderFailure(state.providerError || {})) state.providerError = providerErrorFromEvent(event);
    state.fatalError ||= boundedProviderText(textFromValue(event.error?.data?.message) ||
      textFromValue(event.error?.message) || textFromValue(event.error?.name) || "OpenCode run failed", 4000);
    activity = `error: ${state.fatalError}`;
  }
  if (activity) state.lastActivity = activity.slice(0, 2000).replace(/\s+/g, " ").trim();
  return {
    type,
    event,
    sessionId: state.sessionId,
    workflowRunId: state.workflowRunId,
    finalText: state.finalText,
    usage: { ...state.usage },
    // The accumulator zero-initializes every key; consumers that normalize
    // usage need to know which keys an event actually supplied.
    usageReported: state.usageReported ? { ...state.usageReported } : null,
    text: state.lastActivity,
  };
}

export function parseOpenCodeJsonLine(state, line) {
  if (typeof line !== "string" || !line.trim()) return null;
  try {
    const event = JSON.parse(line);
    return foldOpenCodeEvent(state, event);
  } catch {
    return null;
  }
}

function resolvedModel(route, model) {
  const candidate = route?.model || model;
  if (!candidate) return undefined;
  if (route?.provider && !String(candidate).includes("/")) return `${route.provider}/${candidate}`;
  return String(candidate);
}

function resolvedVariant(route, thinking, variant) {
  if (route?.variant) return String(route.variant);
  if (typeof route?.thinking === "string" && route.thinking.trim()) return route.thinking.trim();
  if (variant) return String(variant);
  if (typeof thinking === "string" && thinking.trim()) return thinking.trim();
  return undefined;
}

function buildArgs(request, { model, agent, thinking, variant, sessionId, prompt, serverUrl, harnessVersion, scopedAgent } = {}) {
  const route = request.route || {};
  const version = harnessVersion === "v2" ? "v2" : "v1";
  const args = ["run"];
  args.push(prompt || "");
  args.push("--format", "json");
  if (version === "v1") args.push("--pure", "--dir", request.cwd);
  const effectiveModel = resolvedModel(route, model);
  if (!effectiveModel) {
    throw new TypeError("OpenCode handoff requires an explicit route.model");
  }
  if (serverUrl) args.push(version === "v2" ? "--server" : "--attach", serverUrl);
  const effectiveVariant = resolvedVariant(route, thinking, variant);
  args.push("--model", version === "v2" && effectiveVariant ? `${effectiveModel}#${effectiveVariant}` : effectiveModel);
  const effectiveAgent = route.agent || agent;
  if (scopedAgent || (effectiveAgent && route.agent)) args.push("--agent", scopedAgent ?? String(effectiveAgent));
  if (version === "v1" && effectiveVariant) args.push("--variant", effectiveVariant);
  else if (route.thinking === true) args.push("--thinking");
  if (sessionId) args.push("--session", sessionId);
  if (request.execution?.sessionAction === "fork") args.push("--fork");
  for (const { path } of request.execution?.attachments ?? []) args.push("--file", path);
  return args;
}

// Field order is a prompt-cache contract: stable context first, then the
// variable task, requestId and route. A provider prefix cache can only match
// leading bytes, so identifiers that change per attempt must not lead.
function handoffEnvelope(request, flowSpec = null, phaseTask = request.task) {
  return {
    protocolVersion: request.protocolVersion || "1.0",
    contextDigest: request.contextDigest || digestContext(request.context),
    context: request.context ?? null,
    flowSpec,
    cwd: request.cwd,
    policy: request.policy || { write: false, tools: [], maxCostUsd: null },
    task: phaseTask,
    requestId: request.requestId,
    route: request.route || {},
  };
}

function promptFor(request, flowSpec, phaseTask, systemPrompt = "") {
  const envelope = JSON.stringify(handoffEnvelope(request, flowSpec, phaseTask));
  const intro = "Execute the complete assigned workflow phase. Preserve the request and context identifiers exactly. Return the final answer for this phase.";
  return [systemPrompt.trim(), intro, envelope].filter(Boolean).join("\n\n");
}

function taskflowText(response) {
  let text = "";
  for (const item of response?.content || []) {
    if (item?.type !== "text" || typeof item.text !== "string") continue;
    if (text.length + item.text.length + 1 > MAX_PROTOCOL_TEXT_CHARS + 8000) {
      throw adapterError("OpenCode taskflow response exceeds the retained protocol limit", "output-limit", { maxChars: MAX_PROTOCOL_TEXT_CHARS + 8000 });
    }
    text += `${text ? "\n" : ""}${item.text}`;
  }
  return text;
}

function extractWorkflowRunId(text) {
  let runId = null;
  for (const match of String(text || "").matchAll(/\brun\s+([A-Za-z0-9._-]+)/g)) runId = match[1];
  return runId;
}

function extractWorkflowFinalText(text) {
  let output = String(text || "");
  const marker = output.match(/(?:^|\n)---\s+[^\n]+\s+---\s*\n/);
  if (marker) output = output.slice(marker.index + marker[0].length);
  output = output.replace(/^✓\s+taskflow complete\s*\n+/u, "");
  output = output.replace(/^✗\s+taskflow did not fully succeed\s*\n+/u, "");
  output = output.replace(/\n\n—\s+\d+\s+turns?\b[\s\S]*$/u, "");
  return output.trim();
}

function adapterError(message, kind, details = {}) {
  const error = new Error(message);
  error.name = "OpenCodeAdapterError";
  error.details = { kind, ...details };
  return error;
}

function validateHarnessVersion(value) {
  if (value !== undefined && value !== "v1" && value !== "v2") {
    throw adapterError("route.harnessVersion must be v1 or v2", "validation");
  }
  return value ?? "v1";
}

const PROJECT_ID_RECOVERY_GUIDANCE = "OpenCode database is incompatible (no such column: project_id). Back up the OpenCode database, update OpenCode, restart the server, and retry. Do not delete, migrate, or overwrite the database automatically.";

function isProjectIdMismatch(error, details = {}) {
  const candidates = [
    error?.message,
    details?.stderr,
    details?.stdout,
    details?.cause?.message,
    details?.cause?.stderr,
    typeof details?.cause === "string" ? details.cause : "",
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  return candidates.includes("no such column: project_id");
}

function enrichProjectIdError(message, kind, details, originalError) {
  if (!isProjectIdMismatch(originalError, details)) return null;
  const original = message || originalError?.message || "OpenCode process failed";
  const alreadyHasGuidance = original.toLowerCase().includes("back up");
  const enrichedMessage = alreadyHasGuidance ? original : `${original} — ${PROJECT_ID_RECOVERY_GUIDANCE}`;
  return adapterError(enrichedMessage, kind, { ...details, recovery: PROJECT_ID_RECOVERY_GUIDANCE, projectIdMismatch: true });
}

const PRIVATE_SERVER_HINT = "this run used a private OpenCode V2 server (route.serverUrl); the private server may lack the caller's provider authorization — authenticate the provider for that server's own OpenCode profile or use the shared OpenCode background service";

function providerFailureHint(classification) {
  if (classification.category === "region") {
    return "the provider rejected this run for a regional or opt-in restriction; enable the provider for this region or reroute";
  }
  if (classification.category === "billing") {
    return "the provider reported an exhausted or unpaid balance; top up the provider account or reroute";
  }
  if (classification.kind === "unavailable") {
    return "the resolved model is not available to this OpenCode profile; verify the model id and provider catalog entry";
  }
  return "the provider rejected this run; re-authorize the provider in OpenCode's own configuration and retry";
}

/**
 * Turn a folded OpenCode error event — or the captured stdout of a child that
 * exited before the event could be folded — into a classified adapter error.
 * The provider reason is bounded and credential-redacted; the raw payload never
 * reaches the receipt. Returns null when the event carries no classifiable
 * provider/model evidence so the caller keeps its existing downstream mapping.
 */
function providerFailureFromEventState(eventState, { stdout = null, privateServer = false, fallback = null } = {}) {
  let providerError = eventState?.providerError || null;
  if (!providerError && stdout) {
    for (const line of String(stdout).split(/\r?\n/)) {
      const event = parseJsonLine(line);
      if (!event || (event.type !== "error" && !event.error)) continue;
      const candidate = providerErrorFromEvent(event);
      if (candidate) {
        providerError = candidate;
        break;
      }
    }
  }
  if (!providerError) return null;
  const classification = classifyProviderFailure(providerError);
  if (!classification) return null;
  const status = providerError.status ?? null;
  const reason = boundedProviderText(providerError.message || fallback || "provider request failed");
  const label = classification.kind === "provider-auth" ? "provider authorization" : "model availability";
  return adapterError(`OpenCode ${label} failure${status !== null ? ` (HTTP ${status})` : ""}: ${reason}`, classification.kind, {
    event: "error",
    category: classification.category,
    status,
    providerError: { type: providerError.type || null, message: reason, status },
    hint: privateServer ? PRIVATE_SERVER_HINT : providerFailureHint(classification),
    ...(privateServer ? { privateServer: true } : {}),
  });
}

function processFailure(error, state) {
  const details = error?.details || {};
  if (details.kind === "output-limit") return adapterError(error.message, "output-limit", details);
  if (details.timedOut || state?.timedOut) {
    return adapterError("OpenCode execution timed out", "timeout", { ...details, kind: "timeout", timedOut: true, aborted: false });
  }
  if (details.aborted || state?.aborted) {
    return adapterError("OpenCode execution aborted", "abort", { ...details, kind: "abort", aborted: true, timedOut: false });
  }
  const cause = details.cause;
  const transport = error instanceof ProcessError && (!details.code && (!cause || cause.code));
  const kind = ["not-ready", "invalid-control", "not-confirmed", "aborted", "timeout", "transport", "downstream"]
    .includes(details.kind) ? details.kind : (transport ? "transport" : "downstream");
  const message = error?.message || "OpenCode process failed";
  const enriched = enrichProjectIdError(message, kind, details, error);
  if (enriched) return enriched;
  return adapterError(message, kind, details);
}

function executionSignal(parentSignal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  if (parentSignal) {
    if (parentSignal.aborted) controller.abort();
    else parentSignal.addEventListener("abort", abort, { once: true });
  }
  const timer = setTimeout(() => {
    if (controller.signal.aborted) return;
    timedOut = true;
    controller.abort();
  }, timeoutMs || 3_600_000);
  timer.unref?.();
  return {
    signal: controller.signal,
    state: { get timedOut() { return timedOut; }, get aborted() { return controller.signal.aborted; } },
    dispose() {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", abort);
    },
  };
}

export class OpenCodeAdapter {
  constructor(options = {}) {
    this.options = options;
    const injected = options.launch || options.command || options.executable || options.bin;
    this.launch = harnessLaunch("opencode", injected);
    this.launchV2 = harnessLaunch("opencode2", options.launchV2 || options.commandV2 || (injected ? injected : undefined));
    this.spawnFn = options.spawnFn;
    this.env = options.env || {};
    this.fetchFn = options.fetchFn;
    this.controlRuntime = null;
    this.controlStart = null;
    // Memoized only after a successful dynamic import: a load failure must not
    // wedge the adapter if the optional package is installed later.
    this.taskflowCore = null;
  }

  async #loadTaskflowCore() {
    if (this.taskflowCore) return this.taskflowCore;
    let cause;
    try {
      const loaded = await import("taskflow-mcp-core/server");
      this.taskflowCore = loaded;
      return loaded;
    } catch (error) {
      cause = error;
    }
    if (cause?.code === "ERR_MODULE_NOT_FOUND") {
      throw adapterError(
        "OpenCode Taskflow compatibility requires the optional taskflow-mcp-core package",
        "missing-optional-dependency",
        {
          dependency: "taskflow-mcp-core",
          hint: "install optional dependencies (npm install --include=optional) or npm install opencode-taskflow@0.2.10",
          cause: boundedProviderText(cause?.message || String(cause)),
        },
      );
    }
    if (cause?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED") {
      throw adapterError(
        "The installed taskflow-mcp-core does not export ./server (expected 0.2.10)",
        "missing-optional-dependency",
        {
          dependency: "taskflow-mcp-core",
          hint: "install the pinned version: npm install taskflow-mcp-core@0.2.10",
          cause: boundedProviderText(cause?.message || String(cause)),
        },
      );
    }
    throw adapterError(
      `OpenCode Taskflow core failed to load: ${boundedProviderText(cause?.message || String(cause))}`,
      "downstream",
      { dependency: "taskflow-mcp-core", cause: boundedProviderText(cause?.message || String(cause)) },
    );
  }

  async run(request, { signal, onProgress } = {}) {
    assertNoClaudeRoute("opencode", request.route);
    assertNoClaudeWorkflow("opencode", request.workflow);
    if (!request || typeof request !== "object") throw new TypeError("request must be an object");
    request = validateAdapterExecution(request, "opencode");
    const { sessionId, sessionAction, attachments } = request.execution;
    const fork = sessionAction === "fork";
    const harnessVersion = validateHarnessVersion(request.route?.harnessVersion);
    if (!resolvedModel(request.route, request.route?.model)) {
      throw new TypeError("OpenCode handoff requires an explicit route.model");
    }
    const { tools } = normalizePolicyControls(request.policy || {});
    const { allow, deny = [] } = tools;
    if (allow !== undefined) throw adapterError("OpenCode supports policy.tools.deny only for explicit tool policies", "policy");
    if (deny.some((name) => !BASELINE_READ_TOOLS.includes(name))) {
      throw adapterError("OpenCode policy.tools.deny accepts only exact default tool names: read, grep, glob, list", "policy");
    }
    let scopedAgent;
    if (deny.length) {
      if (harnessVersion !== "v1" || this.options.serverUrl || request.route?.serverUrl || request.route?.agent
        || request.execution?.sessionId || request.workflow != null) {
        throw adapterError("OpenCode policy.tools.deny requires a fresh local V1 run with its default agent and no Taskflow", "policy");
      }
      const version = await runProcess(this.launch.command, [...(this.launch.args || []), "--version"], {
        cwd: request.cwd,
        env: openCodeEnvironment(harnessVersion, mergeProcessEnv(this.env)),
        spawnFn: this.spawnFn || spawnNativeCommand,
        signal,
        timeoutMs: Math.min(request.execution?.timeoutMs ?? 10_000, 10_000),
      });
      if (version.stdout.trim() !== SCOPED_V1_VERSION) {
        throw adapterError(`OpenCode policy.tools.deny requires CLI version ${SCOPED_V1_VERSION}`, "policy");
      }
      scopedAgent = `harnest-${randomUUID()}`;
    }
    // A workflow.nodes request must not silently degrade into a plain prompt:
    // node-to-flow translation currently lives in Pi, so fail before any
    // process or control server starts.
    if (request.workflow && request.workflow.spec == null && request.workflow.nodes != null) {
      throw adapterError(
        "OpenCode requires an explicit workflow.spec; workflow.nodes translation is Pi-only",
        "unsupported-workflow",
        { hint: "supply workflow.spec or target pi for workflow.nodes" },
      );
    }
    const flowSpec = request.workflow?.spec ?? null;
    // Explicit workflow.spec needs the optional core. Load it before the
    // execution signal and control server so a missing dependency cannot start
    // a server (or a timeout) it must then unwind; plain runs never load it.
    const taskflowCore = flowSpec !== null ? await this.#loadTaskflowCore() : null;
    const execution = executionSignal(signal, request.execution?.timeoutMs);
    const state = {
      sessionId: fork ? null : sessionId || null,
      workflowRunId: null,
      usage: emptyUsage(),
      eventSummary: { count: 0, types: [] },
      eventTypes: new Set(),
      lastFailure: null,
      scopedAgent,
    };
    const graphNode = Boolean(request.context?.graph?.graphId);
    // Graph nodes attach to the OpenCode background service by default, so each
    // node is a native session the operator can open in the sidebar. A private
    // control server is opt-in via route.serverUrl; host-attached nodes have no
    // live control surface because the graph scheduler owns them.
    const hostAttached = harnessVersion === "v2" && graphNode && !(this.options.serverUrl || request.route?.serverUrl);
    const controlRuntime = harnessVersion === "v2" && !hostAttached ? new OpenCodeControl({
      spawnFn: this.spawnFn,
      fetchFn: this.fetchFn,
      clientFactory: this.options.clientFactory,
      serverPassword: this.options.serverPassword,
      serverUsername: this.options.serverUsername,
      timeoutMs: this.options.controlTimeoutMs || this.options.serverReadyTimeoutMs,
      port: this.options.serverPort,
    }) : null;
    this.activeHarnessVersion = harnessVersion;
    this.hostAttached = hostAttached;
    this.controlRuntime = controlRuntime;
    let scratch;
    try {
      const launch = harnessVersion === "v2" ? this.launchV2 : this.launch;
      const env = openCodeEnvironment(harnessVersion, mergeProcessEnv(this.env));
      await requireExecutionFlags({ launch, request, env, spawnFn: this.spawnFn, signal: execution.signal }, ["run"], [
        ...(fork ? [["sessionAction", "--fork"]] : []),
        ...(attachments?.length ? [["attachments", "--file"]] : []),
      ]);
      this.controlStart = controlRuntime?.start({
        request, version: harnessVersion, launch, env, signal: execution.signal,
        serverUrl: this.options.serverUrl || request.route?.serverUrl,
      });
      if (this.controlStart) await this.controlStart;
      if (flowSpec !== null) {
        return await this.#runWorkflow(request, flowSpec, execution, state, onProgress, taskflowCore);
      }
      request = validateAdapterExecution(request, "opencode");
      if (attachments?.length) {
        scratch = await mkdtemp(join(tmpdir(), "harnest-opencode-input-"));
        request.execution.attachments = await stageAttachments(request.execution.attachments, scratch);
      }
      const result = await this.#runSingle(request, execution, state, onProgress);
      if (fork && (!result.sessionId || result.sessionId === sessionId)) {
        throw executionError("sessionAction", "OpenCode did not report a new session ID for the fork");
      }
      return result;
    } catch (error) {
      if (error instanceof NativeLaunchError || error?.name === "OpenCodeAdapterError" || error?.details?.kind === "validation") throw error;
      throw processFailure(error, { ...execution.state, ...state });
    } finally {
      await controlRuntime?.stop().catch(() => {});
      this.controlRuntime = null;
      this.controlStart = null;
      this.activeHarnessVersion = null;
      this.hostAttached = null;
      execution.dispose();
      if (scratch) await rm(scratch, { recursive: true, force: true });
    }
  }

  async control(command, signal) {
    if (command.kind === "reroute") assertNoClaudeRoute("opencode", command.route);
    if (this.activeHarnessVersion === "v1") {
      throw Object.assign(new Error("OpenCode V1 live control is unsafe in 1.18.18; use current OpenCode or Pi"), {
        name: "OpenCodeControlError",
        details: { kind: "unsupported-control" },
      });
    }
    if (!this.controlRuntime || !this.controlStart) {
      const hostAttached = this.hostAttached;
      throw Object.assign(new Error(hostAttached
        ? "host-attached OpenCode graph nodes are owned by the graph scheduler; use the graph tools to inspect, resume, or cancel"
        : "OpenCode control server is not ready"), {
        name: "OpenCodeControlError",
        details: { kind: hostAttached ? "unsupported-control" : "not-ready" },
      });
    }
    await this.controlStart;
    return this.controlRuntime.control(command, signal);
  }

  async #spawn(request, prompt, execution, state, onProgress, options = {}) {
    if (execution.signal.aborted) {
      throw adapterError(execution.state.timedOut ? "OpenCode execution timed out" : "OpenCode execution aborted", execution.state.timedOut ? "timeout" : "abort", {
        aborted: !execution.state.timedOut,
        timedOut: execution.state.timedOut,
      });
    }
    const eventState = { usage: emptyUsage(), finalText: "", lastActivity: "", terminalSeen: false };
    const emit = (event) => {
      observeEventSummary(state, event);
      if (event.sessionId) state.sessionId = event.sessionId;
      if (event.sessionId) this.controlRuntime?.setSessionId(event.sessionId);
      if (event.workflowRunId) state.workflowRunId = event.workflowRunId;
      return onProgress?.(event);
    };
    const args = buildArgs(request, {
      model: options.model,
      agent: options.agent,
      thinking: options.thinking,
      variant: options.variant,
      sessionId: options.sessionId,
      prompt,
      serverUrl: this.controlRuntime?.serverUrl,
      harnessVersion: request.route?.harnessVersion,
      scopedAgent: state.scopedAgent,
    });
    const activeLaunch = request.route?.harnessVersion === "v2" ? this.launchV2 : this.launch;
    const launchArgs = Array.isArray(activeLaunch.args) ? activeLaunch.args : [];
    const env = openCodeEnvironment(request.route?.harnessVersion, mergeProcessEnv(this.env));
    env.OPENCODE_CONFIG_CONTENT = policyConfig(request.policy, env.OPENCODE_CONFIG_CONTENT, state.scopedAgent);
    if (this.controlRuntime?.serverPassword) {
      env.OPENCODE_SERVER_PASSWORD = this.controlRuntime.serverPassword;
      env.OPENCODE_SERVER_USERNAME = this.controlRuntime.serverUsername;
    }
    const privateServer = Boolean(request.route?.serverUrl || this.options.serverUrl);
    try {
      const result = await runProcess(activeLaunch.command, [...launchArgs, ...args], {
        cwd: request.cwd,
        env,
        spawnFn: this.spawnFn || spawnNativeCommand,
        signal: execution.signal,
        timeoutMs: request.execution?.timeoutMs,
        onStdoutLine: (line) => {
          const parsed = parseOpenCodeJsonLine(eventState, line);
          if (parsed) return emit(parsed);
        },
      });
      addUsage(state.usage, eventState.usage);
      state.usageReported = { ...(state.usageReported || {}), ...(eventState.usageReported || {}) };
      if (state.summaryFailure) throw state.summaryFailure;
      if (eventState.fatalError) {
        const providerFailure = providerFailureFromEventState(eventState, {
          stdout: result.stdout,
          privateServer,
          fallback: eventState.fatalError,
        });
        if (providerFailure) throw providerFailure;
        const enriched = enrichProjectIdError(eventState.fatalError, "downstream", { event: "error", stderr: eventState.fatalError }, { message: eventState.fatalError });
        if (enriched) throw enriched;
        throw adapterError(eventState.fatalError, "downstream", { event: "error" });
      }
      if (eventState.finalTextOverflow) {
        throw adapterError("OpenCode final output exceeds the retained protocol limit", "output-limit", { maxChars: MAX_PROTOCOL_TEXT_CHARS });
      }
      if (!eventState.finalText.trim()) throw adapterError("OpenCode completed without final output", "downstream", { code: result.code });
      return { ...result, eventState };
    } catch (error) {
      if (error instanceof NativeLaunchError) throw error;
      if (error?.details?.kind === "output-limit") {
        const failure = processFailure(error, state);
        state.lastFailure = failure;
        throw failure;
      }
      if (error?.name === "OpenCodeAdapterError" && ["provider-auth", "unavailable"].includes(error.details?.kind)) {
        state.lastFailure = error;
        throw error;
      }
      const aborted = Boolean(error?.details?.aborted || execution.state.aborted);
      const timedOut = Boolean(error?.details?.timedOut || execution.state.timedOut);
      if (!aborted && !timedOut && error?.details?.kind !== "transport") {
        const providerFailure = providerFailureFromEventState(eventState, {
          stdout: error?.details?.stdout,
          privateServer,
          fallback: error?.details?.stderr,
        });
        if (providerFailure) {
          state.lastFailure = providerFailure;
          throw providerFailure;
        }
      }
      const observedError = !aborted && !timedOut && eventState.fatalError && error?.details?.kind !== "transport"
        ? adapterError(eventState.fatalError, "downstream", { ...error?.details, event: "error" })
        : error;
      let failure = processFailure(observedError, { ...execution.state, ...state });
      if (!aborted && !timedOut && privateServer && failure.details?.kind === "downstream" && !failure.details?.projectIdMismatch) {
        const details = { ...(failure.details || {}) };
        delete details.kind;
        delete details.hint;
        failure = adapterError(`${failure.message} — ${PRIVATE_SERVER_HINT}`, "unavailable", {
          ...details,
          privateServer: true,
          hint: PRIVATE_SERVER_HINT,
        });
      }
      state.lastFailure = failure;
      throw failure;
    }
  }

  async #runSingle(request, execution, state, onProgress) {
    const prompt = promptFor(request, null, request.task);
    const result = await this.#spawn(request, prompt, execution, state, onProgress, {
      model: request.route?.model,
      agent: request.route?.agent,
      variant: request.route?.variant,
      thinking: request.route?.thinking,
      sessionId: request.execution?.sessionId,
    });
    return {
      sessionId: state.sessionId,
      workflowRunId: state.workflowRunId,
      route: { harness: "opencode", ...(request.route || {}), model: resolvedModel(request.route, request.route?.model) || null },
      result: finalResult(result.eventState.finalText, {
        eventSummary: state.eventSummary,
      }),
      usage: state.usage,
      usageReported: state.usageReported ? { ...state.usageReported } : null,
      usageSummary: summarizeUsage("opencode", state.usage, { reported: state.usageReported || {} }),
    };
  }

  async #runWorkflow(request, flowSpec, execution, state, onProgress, taskflowCore) {
    // The optional core is loaded (and load failures classified) in run()
    // before any control server or phase process exists.
    const { makeToolHandlers } = taskflowCore;
    const phaseState = { firstSession: true };
    // Each phase envelope carries the shared context exactly once. Folding the
    // rendered root prompt into `task` while also supplying `context` in the
    // same envelope shipped two full copies to every phase process.
    const rootTask = request.task;
    // Only legacy lists and empty deny policies can reach Taskflow.
    const tools = Array.isArray(request.policy?.tools) ? request.policy.tools : [];
    const authorizedTools = new Set(tools);
    const runner = {
      usageAccounting: "available",
      runTask: async (defaultCwd, agents, agentName, task, opts, globalThinking) => {
        const agent = agents.find((candidate) => candidate.name === agentName) || {};
        const phaseTask = `${rootTask}\n\nPhase task:\n${task}`;
        const phaseTools = opts?.tools ?? agent.tools;
        const phaseRequest = {
          ...request,
          cwd: opts?.cwd ?? defaultCwd ?? request.cwd,
          policy: {
            ...request.policy,
            tools: phaseTools
              ? phaseTools.filter((tool) => authorizedTools.has(tool))
              : tools,
          },
        };
        try {
          const result = await this.#spawn(phaseRequest, promptFor(phaseRequest, flowSpec, phaseTask, agent.systemPrompt || ""), execution, state, onProgress, {
            model: request.route?.model || opts?.model || agent.model,
            agent: request.route?.agent,
            variant: request.route?.variant,
            thinking: request.route?.thinking || opts?.thinking || agent.thinking || globalThinking,
            sessionId: phaseState.firstSession ? request.execution?.sessionId : null,
          });
          phaseState.firstSession = false;
          return {
            agent: agentName,
            task,
            exitCode: 0,
            output: result.eventState.finalText.trim(),
            stderr: result.stderr,
            usage: result.eventState.usage,
            model: request.route?.model || opts?.model || agent.model,
            stopReason: "stop",
            completionSource: "process-exit",
          };
        } catch (error) {
          state.lastFailure = error;
          return {
            agent: agentName,
            task,
            exitCode: 1,
            output: "",
            stderr: error.message,
            usage: emptyUsage(),
            model: request.route?.model || opts?.model || agent.model,
            errorMessage: error.message,
            stopReason: error.details?.kind === "abort" ? "abort" : "error",
            completionSource: error.details?.kind === "abort" ? "abort" : "protocol-error",
          };
        }
      },
    };
    const handlers = makeToolHandlers(request.cwd, runner, { host: "opencode" });
    const response = await handlers.taskflow_run({ define: flowSpec }, { signal: execution.signal });
    const raw = taskflowText(response);
    if (response?.isError) {
      if (state.lastFailure) throw state.lastFailure;
      throw adapterError(raw || "OpenCode taskflow failed", "downstream");
    }
    const finalText = extractWorkflowFinalText(raw);
    if (finalText.length > MAX_PROTOCOL_TEXT_CHARS) {
      throw adapterError("OpenCode taskflow final output exceeds the retained protocol limit", "output-limit", { maxChars: MAX_PROTOCOL_TEXT_CHARS });
    }
    if (!finalText || finalText === "(no output)") {
      throw adapterError("OpenCode taskflow completed without final output", "downstream");
    }
    state.workflowRunId ||= extractWorkflowRunId(raw);
    return {
      sessionId: state.sessionId,
      workflowRunId: state.workflowRunId,
      route: { harness: "opencode", ...(request.route || {}), model: resolvedModel(request.route, request.route?.model) || null },
      result: finalResult(finalText, {
        taskflow: compactText(raw),
        eventSummary: state.eventSummary,
      }),
      usage: state.usage,
      usageReported: state.usageReported ? { ...state.usageReported } : null,
      usageSummary: summarizeUsage("opencode", state.usage, { reported: state.usageReported || {} }),
    };
  }
}

export default OpenCodeAdapter;
