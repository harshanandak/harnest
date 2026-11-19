import { assertPromptOnlyWorkflow } from "../one-shot-policy.mjs";
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
import { harnessLaunch, isOpenCodeV2Version } from "../config.mjs";
import { NativeLaunchError, spawnNativeCommand } from "../launch-command.mjs";
import { executionError, stageAttachments, validateAdapterExecution } from "../execution-controls.mjs";
import { requireExecutionFlags } from "./execution-help.mjs";
import { structuredResult } from "../result.mjs";
import { summarizeUsage } from "../usage.mjs";
import { OpenCodeControl } from "./opencode-control.mjs";
import { assertAdapterPolicy, assertAdapterRoute, openCodeUsesSharedService } from "../model-policy.mjs";

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

function buildArgs(request, { model, agent, thinking, variant, sessionId, prompt, serverUrl } = {}) {
  const route = request.route || {};
  const args = ["run"];
  args.push(prompt || "");
  args.push("--format", "json");
  const effectiveModel = resolvedModel(route, model);
  if (!effectiveModel) {
    throw new TypeError("OpenCode handoff requires an explicit route.model");
  }
  if (serverUrl) args.push("--server", serverUrl);
  const effectiveVariant = resolvedVariant(route, thinking, variant);
  args.push("--model", effectiveVariant ? `${effectiveModel}#${effectiveVariant}` : effectiveModel);
  const effectiveAgent = route.agent || agent;
  if (effectiveAgent && route.agent) args.push("--agent", String(effectiveAgent));
  if (route.thinking === true) args.push("--thinking");
  if (sessionId) args.push("--session", sessionId);
  if (request.execution?.sessionAction === "fork") args.push("--fork");
  for (const { path } of request.execution?.attachments ?? []) args.push("--file", path);
  return args;
}

// Field order is a prompt-cache contract: stable context first, then the
// variable task, requestId and route. A provider prefix cache can only match
// leading bytes, so identifiers that change per attempt must not lead.
function handoffEnvelope(request) {
  return {
    protocolVersion: request.protocolVersion || "1.0",
    contextDigest: request.contextDigest || digestContext(request.context),
    context: request.context ?? null,
    cwd: request.cwd,
    policy: request.policy || { write: false, tools: [], maxCostUsd: null },
    task: request.task,
    requestId: request.requestId,
    route: request.route || {},
  };
}

function promptFor(request) {
  const envelope = JSON.stringify(handoffEnvelope(request));
  const intro = "Execute the assigned task. Preserve the request and context identifiers exactly. Return the final answer.";
  return [intro, envelope].join("\n\n");
}

function adapterError(message, kind, details = {}) {
  const error = new Error(message);
  error.name = "OpenCodeAdapterError";
  error.details = { kind, ...details };
  return error;
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
    this.env = options.env || {};
    this.launch = harnessLaunch("opencode", options.launchV2 || options.commandV2 || injected, {
      env: options.env ? mergeProcessEnv(this.env) : process.env,
    });
    this.spawnFn = options.spawnFn;
    this.fetchFn = options.fetchFn;
    this.controlRuntime = null;
    this.controlStart = null;
    this.running = false;
  }

  async run(request, { signal, onProgress } = {}) {
    if (!request || typeof request !== "object") throw new TypeError("request must be an object");
    assertPromptOnlyWorkflow("opencode", request.workflow);
    assertAdapterRoute("opencode", request.route);
    assertAdapterPolicy("opencode", { ...request.policy, ...normalizePolicyControls(request.policy ?? {}) }, request.execution);
    request = validateAdapterExecution(request, "opencode");
    const { sessionId, sessionAction, attachments } = request.execution;
    const fork = sessionAction === "fork";
    if (!resolvedModel(request.route, request.route?.model)) {
      throw new TypeError("OpenCode handoff requires an explicit route.model");
    }
    if (this.running) throw adapterError("OpenCode adapter already owns an active request", "busy");
    this.running = true;
    const execution = executionSignal(signal, request.execution?.timeoutMs);
    const state = {
      sessionId: fork ? null : sessionId || null,
      workflowRunId: null,
      usage: emptyUsage(),
      eventSummary: { count: 0, types: [] },
      eventTypes: new Set(),
    };
    // Graph nodes attach to the OpenCode background service by default, so each
    // node is a native session the operator can open in the sidebar. A private
    // control server is opt-in via route.serverUrl; host-attached nodes have no
    // live control surface because the graph scheduler owns them.
    const hostAttached = openCodeUsesSharedService(request, this.options.serverUrl);
    const controlRuntime = !hostAttached ? new OpenCodeControl({
      spawnFn: this.spawnFn,
      fetchFn: this.fetchFn,
      clientFactory: this.options.clientFactory,
      serverPassword: this.options.serverPassword,
      serverUsername: this.options.serverUsername,
      timeoutMs: this.options.controlTimeoutMs || this.options.serverReadyTimeoutMs,
      port: this.options.serverPort,
    }) : null;
    this.hostAttached = hostAttached;
    this.controlRuntime = controlRuntime;
    // Controls that arrive during version and flag probes wait for the control server.
    let controlGate = null;
    if (controlRuntime) {
      controlGate = {};
      this.controlStart = new Promise((resolve, reject) => Object.assign(controlGate, { resolve, reject }));
      this.controlStart.catch(() => {});
    }
    let scratch;
    try {
      const launch = this.launch;
      const env = mergeProcessEnv(this.env);
      if (!this.spawnFn) {
        const { stdout } = await runProcess(launch.command, [...(launch.args ?? []), "--version"], {
          cwd: request.cwd, env, spawnFn: spawnNativeCommand, signal: execution.signal, timeoutMs: 5_000,
        });
        if (!isOpenCodeV2Version(stdout)) {
          throw adapterError("OpenCode V2 is required; install @opencode/cli or set HARNEST_OPENCODE_V2 to a V2 executable", "not-ready");
        }
      }
      await requireExecutionFlags({ launch, request, env, spawnFn: this.spawnFn, signal: execution.signal }, ["run"], [
        ...(sessionId ? [["sessionAction", "--session"]] : []),
        ...(fork ? [["sessionAction", "--fork"]] : []),
        ...(attachments?.length ? [["attachments", "--file"]] : []),
      ]);
      if (controlGate) {
        const started = Promise.resolve(controlRuntime.start({
          request, launch, env, signal: execution.signal,
          serverUrl: this.options.serverUrl || request.route?.serverUrl,
        }));
        started.then(controlGate.resolve, controlGate.reject);
        await started;
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
      // No-op once the server started; otherwise release waiting controls.
      controlGate?.reject(Object.assign(new Error("OpenCode run ended before the control server started"), {
        name: "OpenCodeControlError",
        details: { kind: "not-ready" },
      }));
      await controlRuntime?.stop().catch(() => {});
      this.controlRuntime = null;
      this.controlStart = null;
      this.hostAttached = null;
      execution.dispose();
      this.running = false;
      if (scratch) await rm(scratch, { recursive: true, force: true });
    }
  }

  async control(command, signal) {
    if (command.kind === "reroute") assertAdapterRoute("opencode", command.route);
    if (!this.controlRuntime || !this.controlStart) {
      const hostAttached = this.hostAttached;
      throw Object.assign(new Error(hostAttached
        ? "host-attached OpenCode graph nodes are owned by the graph scheduler; use the graph tools to inspect, resume, or cancel"
        : "OpenCode control server is not ready"), {
        name: "OpenCodeControlError",
        details: { kind: hostAttached ? "unsupported-control" : "not-ready" },
      });
    }
    const runtime = this.controlRuntime;
    await this.controlStart;
    return runtime.control(command, signal);
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
    });
    const launchArgs = this.launch.args ?? [];
    const env = mergeProcessEnv(this.env);
    if (this.controlRuntime?.serverPassword) {
      env.OPENCODE_SERVER_PASSWORD = this.controlRuntime.serverPassword;
      env.OPENCODE_SERVER_USERNAME = this.controlRuntime.serverUsername;
    }
    const privateServer = Boolean(request.route?.serverUrl || this.options.serverUrl);
    try {
      const result = await runProcess(this.launch.command, [...launchArgs, ...args], {
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
        throw failure;
      }
      if (error?.name === "OpenCodeAdapterError" && ["provider-auth", "unavailable"].includes(error.details?.kind)) {
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
      throw failure;
    }
  }

  async #runSingle(request, execution, state, onProgress) {
    const prompt = promptFor(request);
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
      route: { harness: "opencode", harnessVersion: "v2", ...(request.route || {}), model: resolvedModel(request.route, request.route?.model) || null },
      result: finalResult(result.eventState.finalText, {
        eventSummary: state.eventSummary,
      }),
      usage: state.usage,
      usageReported: state.usageReported ? { ...state.usageReported } : null,
      usageSummary: summarizeUsage("opencode", state.usage, { reported: state.usageReported || {} }),
    };
  }
}

export default OpenCodeAdapter;
