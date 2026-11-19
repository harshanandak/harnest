import { spawn as nodeSpawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { attachmentMimeType, executionError, readAttachment, validateAdapterExecution } from "../execution-controls.mjs";
import { isAbsolute, relative, resolve } from "node:path";

import { resolveAcpAgent } from "../acp-registry.mjs";
import { boundedProviderText, classifyProviderFailure, mergeProcessEnv, redactSecrets } from "../process.mjs";
import { ACP_ROUTE_FIELDS, hasToolPolicy, normalizeRoute } from "../protocol.mjs";
import { structuredResult } from "../result.mjs";
import { AcpRpcError, AcpTransport } from "./acp-transport.mjs";

export const ACP_PROTOCOL_VERSIONS = Object.freeze([2, 1]);
export const ACP_CAPABILITIES = Object.freeze({
  transport: "acp-stdio",
  protocolVersions: ACP_PROTOCOL_VERSIONS,
  prompt: true,
  cancel: true,
  resume: "negotiated",
  authentication: "native",
  readOnly: false,
  modelSelection: "negotiated",
  liveMessages: false,
  liveReroute: false,
  usage: "context-and-session-cost-only",
});

const CLIENT_INFO = Object.freeze({
  name: "harnest",
  title: "Harnest",
  version: "0.1.0",
});
const DEFAULT_TIMEOUT_MS = 3_600_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_CANCEL_TIMEOUT_MS = 15_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 5_000;
const MAX_FINAL_TEXT_CHARS = 64_000;
const MAX_PROGRESS_TEXT_CHARS = 2_000;
const MAX_EVENT_TYPES = 20;
const MAX_MESSAGES = 256;
const MAX_SESSION_ID_CHARS = 1_000;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finitePositive(value, fallback, label) {
  const result = value === undefined ? fallback : value;
  if (!Number.isFinite(result) || result <= 0) throw new RangeError(`${label} must be a positive finite number`);
  return result;
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error ?? "");
}

export class AcpAdapterError extends Error {
  constructor(message, kind, details = {}) {
    super(message);
    this.name = "AcpAdapterError";
    this.details = { kind, ...details };
  }
}

function adapterError(message, kind, details = {}) {
  return new AcpAdapterError(message, kind, details);
}

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function exactSessionId(value) {
  if (!hasText(value) || value.length > MAX_SESSION_ID_CHARS) {
    throw adapterError("ACP session response did not include a valid bounded sessionId", "protocol", {
      field: "sessionId",
    });
  }
  if (redactSecrets(value) !== value) {
    throw adapterError("ACP sessionId cannot be persisted safely because it contains recognized credential material", "protocol", {
      field: "sessionId",
    });
  }
  return value;
}

function assertPolicy(request) {
  if (request?.target !== undefined && request.target !== "acp") {
    throw adapterError('ACPAdapter accepts only target "acp"', "policy", { field: "target" });
  }
  if (request?.route?.harness !== undefined && request.route.harness !== "acp") {
    throw adapterError('ACPAdapter requires route.harness "acp"', "policy", { field: "route.harness" });
  }
  if (!hasText(request?.route?.agent)) {
    throw adapterError("ACP requests require route.agent selecting a trusted local registration", "policy", { field: "route.agent" });
  }
  if (request?.policy?.write !== true) {
    throw adapterError("Generic ACP is write-only and requires normalized policy.write=true", "policy", { field: "policy.write" });
  }
  if (request?.metadata?.harnest?.writeApproved !== true) {
    throw adapterError("Generic ACP requires metadata.harnest.writeApproved=true before native startup", "policy", {
      field: "metadata.harnest.writeApproved",
    });
  }
  if (hasToolPolicy(request?.policy?.tools)) {
    throw adapterError("Generic ACP cannot enforce policy.tools; granular tool policy is unsupported", "policy", { field: "policy.tools" });
  }
  if (request?.policy?.maxCostUsd != null) {
    throw adapterError("Generic ACP cannot enforce policy.maxCostUsd", "policy", { field: "policy.maxCostUsd" });
  }
  if (request?.workflow?.spec != null || request?.workflow?.nodes != null) {
    throw adapterError("Generic ACP cannot execute structured workflows", "policy", { field: "workflow" });
  }
  if (request?.execution?.transport === "session") {
    throw adapterError("Generic ACP owns one attached stdio process per handoff; persistent transport is unsupported", "policy", {
      field: "execution.transport",
    });
  }
  for (const [field, value] of Object.entries(request?.route ?? {})) {
    if (field === "harness" || ACP_ROUTE_FIELDS.includes(field) || value === undefined) continue;
    throw adapterError(`Generic ACP does not support route.${field}`, "policy", {
      field: `route.${field}`,
    });
  }
  const { harness, ...route } = request.route;
  try {
    normalizeRoute(route);
  } catch (error) {
    throw adapterError(error.message, "policy");
  }
}

function selectValues(option) {
  if (option?.type !== "select" || !Array.isArray(option.options)) return [];
  return option.options.flatMap((entry) => Array.isArray(entry?.options) && typeof entry.group === "string"
    ? entry.options.map((item) => item?.value) : [entry?.value]);
}

async function applySessionRoute(transport, sessionId, session, route, rpcOptions) {
  let config = Array.isArray(session?.configOptions) ? session.configOptions : [];
  const applied = new Map();
  const fail = (field, reason) => adapterError(`ACP ${field} ${reason}`, "policy", { field });
  const set = async (method, parameters, field) => {
    try {
      return await transport.request(method, { sessionId, ...parameters }, rpcOptions);
    } catch (error) {
      if (!(error instanceof AcpRpcError)) throw error;
      throw fail(field, `was rejected by ${method} (RPC code ${error.code})`);
    }
  };
  const setOption = async (option, value, field) => {
    const boolean = option?.type === "boolean" && typeof value === "boolean";
    if (!option || typeof option.id !== "string" ||
        !(boolean || typeof value === "string" && selectValues(option).includes(value))) {
      throw fail(field, "is not an advertised ACP configuration choice");
    }
    if (applied.has(option.id)) throw fail(field, "duplicates a dedicated route control");
    const response = await set("session/set_config_option", {
      configId: option.id, ...(boolean ? { type: "boolean" } : {}), value,
    }, field);
    if (!Array.isArray(response?.configOptions)) throw fail(field, "was not confirmed by the agent");
    config = response.configOptions;
    applied.set(option.id, { field, value });
  };
  const setSelection = async (field, category, value, advertised, advertisedIdKey, parameterIdKey, method) => {
    if (value === undefined) return;
    const option = config.find((item) => item?.category === category);
    if (option) {
      await setOption(option, value, field);
    } else if (Array.isArray(advertised) && advertised.some((entry) => entry?.[advertisedIdKey] === value)) {
      if (!isObject(await set(method, { [parameterIdKey]: value }, field))) {
        throw fail(field, "was not acknowledged by the agent");
      }
    } else {
      throw fail(field, "is not advertised by this ACP session");
    }
  };
  // ACP config options supersede the legacy mode API and can affect later option choices.
  await setSelection("route.model", "model", route.model, session?.models?.availableModels, "modelId", "modelId", "session/set_model");
  await setSelection("route.variant", "mode", route.variant, session?.modes?.availableModes, "id", "modeId", "session/set_mode");
  for (const [id, value] of Object.entries(route.options ?? {})) {
    const option = config.find((item) => item?.id === id);
    if ((option?.category === "model" && route.model !== undefined) ||
        (option?.category === "mode" && route.variant !== undefined)) {
      throw fail("route.options", "duplicates a dedicated route control");
    }
    await setOption(option, value, "route.options");
  }
  for (const [id, { field, value }] of applied) {
    if (config.find((option) => option?.id === id)?.currentValue !== value) {
      throw fail(field, "was not confirmed by the agent");
    }
  }
}

function promptEnvelope(request) {
  return {
    protocolVersion: request.protocolVersion || "1.0",
    contextDigest: request.contextDigest,
    context: request.context ?? null,
    cwd: request.cwd,
    policy: request.policy,
    metadata: request.metadata ?? null,
    task: request.task,
    requestId: request.requestId,
    route: request.route,
  };
}

function promptText(request) {
  return [
    "Execute the assigned task directly in this native ACP session. Return the complete final answer for this handoff.",
    "Preserve the request and context identifiers. Harnest already schedules graph dependencies; use direct-dependency results from the context rather than starting another workflow.",
    JSON.stringify(promptEnvelope(request)),
  ].join("\n\n");
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(contentText).join("");
  if (!isObject(content)) return "";
  if (content.type === "text" && typeof content.text === "string") return content.text;
  return "";
}

function usageFromUpdate(update) {
  if (!isObject(update)) return null;
  const usage = { semantics: "cumulative-session-context" };
  let present = false;
  if (Number.isSafeInteger(update.used) && update.used >= 0) {
    usage.contextWindowUsed = update.used;
    present = true;
  }
  if (Number.isSafeInteger(update.size) && update.size >= 0) {
    usage.contextWindowSize = update.size;
    present = true;
  }
  if (isObject(update.cost) && Number.isFinite(update.cost.amount) && hasText(update.cost.currency)) {
    const currency = update.cost.currency.trim();
    usage.cost = { amount: update.cost.amount, currency: /^[A-Z]{3}$/.test(currency) ? currency : null };
    usage.costSemantics = "cumulative-session";
    present = true;
  }
  return present ? usage : null;
}

function usageSummary() {
  // ACP's usage_update is cumulative session context occupancy and cumulative
  // session cost. It does not establish per-attempt input, output, cache, or
  // USD cost deltas, especially after resume.
  return {
    inputTokens: null,
    uncachedInputTokens: null,
    inputSemantics: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    costUsd: null,
  };
}

class EventSummary {
  constructor() {
    this.count = 0;
    this.types = [];
  }

  add(type) {
    this.count += 1;
    if (!hasText(type) || this.types.includes(type)) return;
    this.types.push(type.slice(0, 128));
    if (this.types.length > MAX_EVENT_TYPES) this.types.shift();
  }

  snapshot() {
    return { count: this.count, types: [...this.types] };
  }
}

class AcpRunState {
  constructor({ protocolVersion, transport, onProgress, workflowRunId, agentId }) {
    this.protocolVersion = protocolVersion;
    this.transport = transport;
    this.onProgress = typeof onProgress === "function" ? onProgress : null;
    this.workflowRunId = workflowRunId;
    this.agentId = agentId;
    this.sessionId = null;
    this.provisionalSessionId = null;
    this.turnActive = false;
    this.messages = new Map();
    this.messageOrder = [];
    this.usage = null;
    this.summary = new EventSummary();
    this.idle = null;
    this.promptAccepted = false;
    this.promptMessageId = null;
    this.acknowledgedMessageId = null;
    this.foregroundStarted = false;
    this.terminalSettled = false;
    this.terminalPromise = new Promise((resolve) => { this.resolveTerminal = resolve; });
    this.cancelRequested = false;
  }

  setSession(sessionId) {
    const exact = exactSessionId(sessionId);
    if (this.provisionalSessionId && this.provisionalSessionId !== exact) {
      throw adapterError("ACP session response disagrees with an earlier session/update id", "transport", { fatal: true });
    }
    this.sessionId = exact;
  }

  beginTurn() {
    this.turnActive = true;
    this.messages.clear();
    this.messageOrder = [];
    this.idle = null;
    this.promptAccepted = false;
    this.promptMessageId = null;
    this.acknowledgedMessageId = null;
    this.foregroundStarted = false;
    this.terminalSettled = false;
    this.terminalPromise = new Promise((resolve) => { this.resolveTerminal = resolve; });
  }

  acceptPrompt(messageId) {
    if (!hasText(messageId)) throw adapterError("ACP v2 prompt response did not acknowledge a messageId", "protocol");
    if (this.acknowledgedMessageId && this.acknowledgedMessageId !== messageId) {
      throw adapterError("ACP v2 prompt response messageId disagrees with the user_message acknowledgement", "protocol", {
        fatal: true,
      });
    }
    this.promptMessageId = messageId;
    this.promptAccepted = true;
    if (this.#foregroundCorrelated() && this.foregroundStarted && this.idle) this.#settleTerminal(this.idle);
  }

  markV1Terminal(response) {
    this.#settleTerminal({ stopReason: response?.stopReason ?? null });
  }

  #settleTerminal(value) {
    if (this.terminalSettled) return;
    this.terminalSettled = true;
    this.resolveTerminal(value);
  }

  waitForTerminal() {
    return this.terminalPromise;
  }

  async onNotification(method, params) {
    if (method !== "session/update") return;
    if (!isObject(params) || !isObject(params.update)) {
      throw adapterError("ACP sent session/update for an unknown session", "transport", { fatal: true });
    }
    const incomingSessionId = exactSessionId(params.sessionId);
    if (!this.sessionId) this.provisionalSessionId ??= incomingSessionId;
    if (incomingSessionId !== (this.sessionId ?? this.provisionalSessionId)) {
      throw adapterError("ACP sent session/update for an unknown session", "transport", { fatal: true });
    }
    const update = params.update;
    const type = hasText(update.sessionUpdate) ? boundedProviderText(update.sessionUpdate, 128) : "unknown";
    this.summary.add(type);
    if (type === "usage_update") this.usage = { ...(this.usage ?? {}), ...(usageFromUpdate(update) ?? {}) };
    if (this.turnActive && this.protocolVersion === 2 && ["user_message", "user_message_chunk"].includes(type)) {
      this.#acknowledgePrompt(update.messageId);
    }
    const foregroundOutput = this.turnActive && (this.protocolVersion === 1 || this.#foregroundOpen());
    if (foregroundOutput && type === "agent_message_chunk") this.#appendMessage(update.messageId, contentText(update.content));
    if (foregroundOutput && type === "agent_message" && Object.hasOwn(update, "content")) {
      this.#replaceMessage(update.messageId, contentText(update.content));
    }
    if (this.turnActive && this.protocolVersion === 2 && type === "state_update" && update.state === "running"
      && this.acknowledgedMessageId && !this.idle) {
      this.foregroundStarted = true;
    }
    if (this.turnActive && this.protocolVersion === 2 && type === "state_update" && update.state === "idle"
      && this.acknowledgedMessageId && this.foregroundStarted && !this.idle) {
      this.idle = { stopReason: hasText(update.stopReason) ? update.stopReason : null, error: update.error ?? null };
      if (this.#foregroundCorrelated()) this.#settleTerminal(this.idle);
    }
    await this.#progress(type, update);
  }

  #acknowledgePrompt(messageId) {
    const id = this.#messageId(messageId);
    if (this.acknowledgedMessageId && this.acknowledgedMessageId !== id) {
      throw adapterError("ACP v2 sent conflicting user_message acknowledgements for one prompt", "protocol", { fatal: true });
    }
    if (this.promptMessageId && this.promptMessageId !== id) {
      throw adapterError("ACP v2 user_message acknowledgement disagrees with the prompt response messageId", "protocol", {
        fatal: true,
      });
    }
    if (this.acknowledgedMessageId) return;
    this.acknowledgedMessageId = id;
    this.messages.clear();
    this.messageOrder = [];
    this.idle = null;
    this.foregroundStarted = false;
  }

  #foregroundCorrelated() {
    return this.promptAccepted && this.promptMessageId === this.acknowledgedMessageId;
  }

  #foregroundOpen() {
    return Boolean(this.acknowledgedMessageId && this.foregroundStarted && !this.idle);
  }

  #messageId(value) {
    if (hasText(value)) return value;
    if (this.protocolVersion === 1) return "__v1_stream__";
    throw adapterError("ACP v2 agent message update omitted the required messageId", "protocol", { fatal: true });
  }

  #touchMessage(id) {
    if (this.messages.has(id)) return this.messages.get(id);
    if (this.messageOrder.length >= MAX_MESSAGES) {
      const removed = this.messageOrder.shift();
      this.messages.delete(removed);
    }
    const record = { text: "", overflow: false };
    this.messages.set(id, record);
    this.messageOrder.push(id);
    return record;
  }

  #appendMessage(messageId, text) {
    if (!text) return;
    text = redactSecrets(text);
    const record = this.#touchMessage(this.#messageId(messageId));
    if (record.overflow) return;
    if (record.text.length + text.length > MAX_FINAL_TEXT_CHARS) {
      record.text = "";
      record.overflow = true;
      return;
    }
    record.text += text;
  }

  #replaceMessage(messageId, text) {
    text = redactSecrets(text);
    const record = this.#touchMessage(this.#messageId(messageId));
    record.overflow = text.length > MAX_FINAL_TEXT_CHARS;
    record.text = record.overflow ? "" : text;
  }

  finalMessage() {
    for (let index = this.messageOrder.length - 1; index >= 0; index -= 1) {
      const record = this.messages.get(this.messageOrder[index]);
      if (record?.overflow) return { text: "", overflow: true };
      if (hasText(record?.text)) return { text: record.text.trim(), overflow: false };
    }
    return { text: "", overflow: false };
  }

  async #progress(type, update) {
    if (!this.onProgress) return;
    let event;
    if (["agent_message_chunk", "agent_message"].includes(type)) {
      if (!this.turnActive || (this.protocolVersion === 2 && !this.#foregroundOpen())) return;
      const text = redactSecrets(contentText(update.content)).slice(0, MAX_PROGRESS_TEXT_CHARS);
      if (!text) return;
      event = { type: "acp_delta", text };
    } else if (type === "usage_update") {
      event = { type: "usage", usage: this.usage };
    } else if (["tool_call", "tool_call_update"].includes(type)) {
      if (this.protocolVersion === 2 && !this.#foregroundOpen()) return;
      const phase = boundedProviderText(update.status ?? (type === "tool_call" ? "started" : "updated"), 64);
      event = {
        type: "acp_tool",
        toolName: boundedProviderText(update.name ?? update.title ?? update.kind ?? "tool", 128),
        status: phase,
        phase,
      };
    } else {
      return;
    }
    try {
      await this.onProgress({
        ...event,
        sessionId: this.sessionId,
        workflowRunId: this.workflowRunId,
        ...(event.usage === undefined && this.usage ? { usage: this.usage } : {}),
      });
    } catch (error) {
      throw adapterError(`ACP progress persistence failed: ${boundedProviderText(errorText(error))}`, "transport", {
        phase: "progress",
        fatal: true,
        cause: error,
      });
    }
  }
}

function pathInside(root, candidate) {
  if (!hasText(root) || !hasText(candidate) || !isAbsolute(candidate)) return false;
  const base = resolve(root);
  const target = resolve(candidate);
  const rel = relative(base, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function knownPermissionOperation(version, params, cwd) {
  if (version === 2 && params?.subject?.type === "command") {
    return hasText(params.subject.command) && pathInside(cwd, params.subject.cwd);
  }
  if (version === 2 && params?.subject?.type === "tool_call") {
    return hasText(params.subject.toolCall?.toolCallId)
      && ["read", "edit", "delete", "move", "search", "execute"].includes(params.subject.toolCall?.kind);
  }
  if (version === 2) return false;
  return hasText(params?.toolCall?.toolCallId)
    && ["read", "edit", "delete", "move", "search", "execute"].includes(params?.toolCall?.kind);
}

function permissionOutcome(version, params, cancelled, cwd) {
  if (cancelled) return { outcome: { outcome: "cancelled" } };
  const options = Array.isArray(params?.options) ? params.options : [];
  const preferred = knownPermissionOperation(version, params, cwd)
    ? options.find((option) => option?.kind === "allow_once" && hasText(option.optionId))
    : null;
  const denied = options.find((option) => option?.kind === "reject_once" && hasText(option.optionId))
    ?? options.find((option) => option?.kind === "reject_always" && hasText(option.optionId));
  const selected = preferred ?? denied;
  if (!selected) return { outcome: { outcome: "cancelled" } };
  return { outcome: { outcome: "selected", optionId: selected.optionId } };
}

function executionDeadline(parentSignal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  if (parentSignal?.aborted) controller.abort();
  else parentSignal?.addEventListener?.("abort", abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    get timedOut() { return timedOut; },
    dispose() {
      clearTimeout(timer);
      parentSignal?.removeEventListener?.("abort", abort);
    },
  };
}

function abortFailure(signal) {
  let onAbort;
  const promise = new Promise((_, reject) => {
    onAbort = () => reject(adapterError("ACP execution aborted", "abort", { aborted: true }));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  return {
    promise,
    dispose() { signal.removeEventListener("abort", onAbort); },
  };
}

function agentCapabilities(version, initializeResult) {
  if (version === 2) return isObject(initializeResult?.capabilities) ? initializeResult.capabilities : {};
  return isObject(initializeResult?.agentCapabilities) ? initializeResult.agentCapabilities : {};
}

function protocolGeneration(initializeResult) {
  const hasInfo = Object.hasOwn(initializeResult ?? {}, "info");
  const hasV1Fields = Object.hasOwn(initializeResult ?? {}, "agentCapabilities")
    || Object.hasOwn(initializeResult ?? {}, "agentInfo");
  const hasV2Capabilities = Object.hasOwn(initializeResult ?? {}, "capabilities");
  if ((hasInfo || hasV2Capabilities) && hasV1Fields) {
    throw adapterError("ACP initialize response mixed v1 and v2 generation fields", "protocol");
  }
  if (hasInfo) {
    if (!isObject(initializeResult?.info)) {
      throw adapterError("ACP v2 initialize response omitted required agent implementation info", "protocol", { field: "info" });
    }
    return 2;
  }
  return 1;
}

function agentInfo(version, initializeResult) {
  const value = version === 2 ? initializeResult?.info : initializeResult?.agentInfo;
  if (!isObject(value)) return null;
  return {
    name: hasText(value.name) ? redactSecrets(value.name).slice(0, 256) : null,
    title: hasText(value.title) ? redactSecrets(value.title).slice(0, 256) : null,
    version: hasText(value.version) ? redactSecrets(value.version).slice(0, 128) : null,
  };
}

function resumeSupported(version, capabilities) {
  if (version === 1) return capabilities.loadSession === true;
  // In v2 an object-valued session capability advertises the full baseline
  // session surface, including resume. Omitted/null means no session methods.
  return isObject(capabilities.session);
}

function initializeParams(version, clientCapabilities) {
  if (version === 2) return { protocolVersion: 2, capabilities: {}, info: CLIENT_INFO };
  return { protocolVersion: 1, clientCapabilities, clientInfo: CLIENT_INFO };
}

async function defaultClientServicesFactory(options) {
  const { createAcpClientServices } = await import("../acp-client-services.mjs");
  return createAcpClientServices(options);
}

function normalizedError(error, { state, deadline, agentId } = {}) {
  let result = error;
  if (deadline?.timedOut && result?.details?.kind === "abort") {
    result = adapterError("ACP execution timed out", "timeout", { timedOut: true, aborted: false });
  }
  if (!(result instanceof AcpAdapterError) && result?.details?.kind !== "validation") {
    if (result instanceof AcpRpcError) {
      const classification = classifyProviderFailure({ message: result.message, status: result.data?.status ?? null });
      result = classification
        ? adapterError(`ACP agent ${agentId} reported ${boundedProviderText(result.message)}`, classification.kind, {
          category: classification.category,
          provider: agentId,
          rpcCode: result.code,
        })
        : adapterError(`ACP ${result.method || "request"} failed: ${boundedProviderText(result.message)}`, "downstream", {
          rpcCode: result.code,
          method: result.method,
        });
    } else if (deadline?.timedOut || result?.details?.kind === "timeout") {
      result = adapterError("ACP execution timed out", "timeout", { timedOut: true, aborted: false });
    } else if (deadline?.signal?.aborted || result?.details?.kind === "abort") {
      result = adapterError("ACP execution aborted", "abort", { aborted: true, timedOut: false });
    } else {
      result = adapterError(`ACP transport failure: ${boundedProviderText(errorText(result))}`, result?.details?.kind || "transport", {
        cause: result,
      });
    }
  }
  result.details = {
    ...result.details,
    sessionId: result.details?.sessionId ?? state?.sessionId ?? state?.provisionalSessionId ?? null,
    usage: result.details?.usage ?? state?.usage ?? null,
    usageSummary: result.details?.usageSummary ?? usageSummary(),
  };
  return result;
}

export class ACPAdapter {
  constructor(options = {}) {
    this.registrations = options.registrations;
    this.command = hasText(options.command) ? options.command.trim() : null;
    this.args = Array.isArray(options.args) ? [...options.args] : [];
    this.protocolVersion = options.protocolVersion ?? 2;
    this.spawn = options.spawn || options.spawnFn || nodeSpawn;
    this.env = mergeProcessEnv(options.env);
    this.timeoutMs = finitePositive(options.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs");
    this.startupTimeoutMs = finitePositive(options.startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS, "startupTimeoutMs");
    this.cancelTimeoutMs = finitePositive(options.cancelTimeoutMs, DEFAULT_CANCEL_TIMEOUT_MS, "cancelTimeoutMs");
    this.cleanupTimeoutMs = finitePositive(options.cleanupTimeoutMs, DEFAULT_CLEANUP_TIMEOUT_MS, "cleanupTimeoutMs");
    this.maxLineBytes = options.maxLineBytes;
    this.maxStderrBytes = options.maxStderrBytes;
    this.maxPendingStdoutBytes = options.maxPendingStdoutBytes;
    this.maxPendingStdoutChunks = options.maxPendingStdoutChunks;
    this.clientServicesFactory = options.clientServicesFactory || defaultClientServicesFactory;
    this.active = null;
  }

  async #registration(request) {
    if (this.command) {
      if (![1, 2].includes(this.protocolVersion)) throw adapterError("ACP test seam protocolVersion must be 1 or 2", "configuration");
      return { id: request.route.agent, command: this.command, args: this.args, trusted: true, protocolVersion: this.protocolVersion };
    }
    try {
      return await resolveAcpAgent(request.route.agent, { registrations: this.registrations });
    } catch (error) {
      throw adapterError(errorText(error), "configuration", {
        registrationKind: error?.details?.kind ?? null,
        agent: request.route.agent,
      });
    }
  }

  #transport(registration, request) {
    return new AcpTransport({
      command: registration.command,
      args: registration.args,
      cwd: request.cwd,
      env: this.env,
      spawn: this.spawn,
      maxLineBytes: this.maxLineBytes,
      maxStderrBytes: this.maxStderrBytes,
      maxPendingStdoutBytes: this.maxPendingStdoutBytes,
      maxPendingStdoutChunks: this.maxPendingStdoutChunks,
    });
  }

  async run(request, { signal, onProgress } = {}) {
    request = validateAdapterExecution(request, "acp");
    assertPolicy(request);
    const requestedResumeId = request.execution?.sessionId;
    const resumeId = requestedResumeId === undefined || requestedResumeId === null || requestedResumeId === ""
      ? null
      : exactSessionId(requestedResumeId);
    const registration = await this.#registration(request);
    const requestedVersion = registration.protocolVersion ?? 2;
    if (![1, 2].includes(requestedVersion)) {
      throw adapterError(`ACP registration ${registration.id} has unsupported protocolVersion ${requestedVersion}`, "configuration");
    }
    const deadline = executionDeadline(signal, request.execution?.timeoutMs ?? this.timeoutMs);
    const workflowRunId = `acp:${request.requestId}`;
    let transport;
    let services = null;
    let state = null;
    let cancelPromise = null;
    let capabilities = {};
    let identity = null;
    let fallbackWithoutServices = false;
    let nativeCloseSupported = false;
    let cleanupSessionId = null;
    let negotiatedVersion = null;
    let wireProtocolVersion = null;
    let promptPromise = null;
    let promptResponse = null;
    let cancellationHandled = false;
    let terminalAbort = null;
    let caughtError = null;
    const sendCancel = async () => {
      if (!transport || !state?.sessionId || state.cancelRequested) return;
      state.cancelRequested = true;
      await transport.notify("session/cancel", { sessionId: state.sessionId });
    };
    const onAbort = () => {
      cancelPromise ||= sendCancel();
      void cancelPromise.catch(() => undefined);
    };
    const confirmCancellation = async () => {
      cancellationHandled = true;
      let timer;
      const unacknowledged = (cause = null) => adapterError(
        "ACP cancellation was not acknowledged before the confirmation timeout",
        "cancel-unacknowledged",
        {
          uncertain: true,
          timeoutMs: this.cancelTimeoutMs,
          ...(cause ? { confirmationError: redactSecrets(boundedProviderText(errorText(cause), 1_000)) } : {}),
        },
      );
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(unacknowledged()), this.cancelTimeoutMs);
      });
      try {
        await Promise.race([(cancelPromise ||= sendCancel()), timeout]);
        if (negotiatedVersion === 1) {
          const response = promptResponse ?? await Promise.race([
            promptPromise,
            transport.failure().then((error) => { throw error; }),
            timeout,
          ]);
          if (response?.stopReason !== "cancelled") throw unacknowledged();
          return;
        }
        const response = promptResponse ?? await Promise.race([
          promptPromise,
          transport.failure().then((error) => { throw error; }),
          timeout,
        ]);
        if (!hasText(response?.messageId)) throw unacknowledged();
        if (!state.promptAccepted) state.acceptPrompt(response.messageId);
        const terminal = await Promise.race([
          state.waitForTerminal(),
          transport.failure().then((error) => { throw error; }),
          timeout,
        ]);
        if (terminal?.stopReason !== "cancelled") throw unacknowledged();
      } catch (error) {
        if (error?.details?.kind === "cancel-unacknowledged") throw error;
        throw unacknowledged(error);
      } finally {
        clearTimeout(timer);
      }
    };
    deadline.signal.addEventListener("abort", onAbort, { once: true });
    try {
      if (requestedVersion === 1) {
        services = await this.clientServicesFactory({
          cwd: request.cwd,
          signal: deadline.signal,
          onProgress,
          write: request.policy.write,
          writeApproved: request.metadata.harnest.writeApproved,
          timeoutMs: request.execution?.timeoutMs ?? this.timeoutMs,
          spawnFn: this.spawn,
        });
        if (!isObject(services?.capabilities) || typeof services?.handleRequest !== "function" || typeof services?.close !== "function") {
          throw adapterError("ACP v1 client services factory returned an invalid service contract", "configuration");
        }
      }
      transport = this.#transport(registration, request);
      await transport.start();
      const initializeResult = await transport.request(
        "initialize",
        initializeParams(requestedVersion, services?.capabilities ?? {}),
        { signal: deadline.signal, timeoutMs: this.startupTimeoutMs },
      );
      wireProtocolVersion = initializeResult?.protocolVersion;
      if (!Number.isInteger(wireProtocolVersion) || ![1, 2].includes(wireProtocolVersion)) {
        const wireType = Array.isArray(wireProtocolVersion) ? "array" : typeof wireProtocolVersion;
        const wireDisplay = ["number", "boolean", "string"].includes(wireType)
          ? boundedProviderText(redactSecrets(String(wireProtocolVersion)), 64)
          : wireType;
        throw adapterError(`ACP agent negotiated unsupported protocol version ${wireDisplay}`, "protocol", {
          protocolVersion: wireType === "string"
            ? boundedProviderText(redactSecrets(wireProtocolVersion), 64)
            : (["number", "boolean"].includes(wireType) ? wireProtocolVersion : null),
          protocolVersionType: wireType,
        });
      }
      negotiatedVersion = protocolGeneration(initializeResult);
      if (wireProtocolVersion === 1 && negotiatedVersion !== 1) {
        throw adapterError("ACP wire protocolVersion 1 returned a v2 generation response", "protocol", {
          protocolVersion: wireProtocolVersion,
          protocolGeneration: negotiatedVersion,
        });
      }
      if (requestedVersion === 1 && negotiatedVersion !== 1) {
        throw adapterError(`ACP registration pins protocolVersion 1 but the agent selected generation ${negotiatedVersion}`, "protocol", {
          protocolVersion: wireProtocolVersion,
          protocolGeneration: negotiatedVersion,
          hint: "correct the trusted local registration protocolVersion; Harnest does not restart or guess",
        });
      }
      if (requestedVersion === 2 && negotiatedVersion === 1) fallbackWithoutServices = true;
      capabilities = agentCapabilities(negotiatedVersion, initializeResult);
      const attachments = request.execution.attachments ?? [];
      const supported = negotiatedVersion === 2 ? capabilities.session?.prompt : capabilities.promptCapabilities;
      for (const { type } of attachments) {
        const capability = type === "image" ? "image" : "embeddedContext";
        if (!(negotiatedVersion === 2 ? isObject(supported?.[capability]) : supported?.[capability] === true)) {
          throw executionError("attachments", `ACP agent did not advertise ${capability}`);
        }
      }
      const content = await Promise.all(attachments.map(async ({ type, path }) => {
        const data = (await readAttachment(path)).toString("base64");
        if (type === "image") return { type, mimeType: attachmentMimeType(path), data };
        return { type: "resource", resource: { uri: pathToFileURL(path).href, blob: data } };
      }));
      identity = agentInfo(negotiatedVersion, initializeResult);
      if (negotiatedVersion === 2 && (!isObject(initializeResult?.info)
        || !hasText(initializeResult.info.name) || !hasText(initializeResult.info.version))) {
        throw adapterError("ACP v2 initialize response omitted required agent implementation info", "protocol", {
          field: "info",
        });
      }
      if (negotiatedVersion === 2 && !isObject(capabilities.session)) {
        throw adapterError("ACP v2 agent did not advertise the required session capability", "unsupported", {
          capability: "session",
        });
      }
      nativeCloseSupported = negotiatedVersion === 2
        || (negotiatedVersion === 1 && isObject(capabilities?.sessionCapabilities?.close));
      state = new AcpRunState({
        protocolVersion: negotiatedVersion,
        transport,
        onProgress,
        workflowRunId,
        agentId: registration.id,
      });
      const v1ServiceMethods = new Set([
        "fs/read_text_file",
        "fs/write_text_file",
        "terminal/create",
        "terminal/output",
        "terminal/release",
        "terminal/wait_for_exit",
        "terminal/kill",
      ]);
      transport.setHandlers({
        onNotification: (method, params) => state.onNotification(method, params),
        onRequest: async (method, params) => {
          if (method === "session/request_permission") {
            if (params?.sessionId !== state.sessionId) {
              throw Object.assign(new Error("permission request belongs to another session"), { rpcCode: -32602 });
            }
            return permissionOutcome(negotiatedVersion, params, state.cancelRequested || deadline.signal.aborted, request.cwd);
          }
          if (negotiatedVersion === 1 && v1ServiceMethods.has(method)) {
            if (params?.sessionId !== state.sessionId) {
              throw Object.assign(new Error("client callback belongs to another session"), { rpcCode: -32602 });
            }
            if (!services || fallbackWithoutServices) {
              throw Object.assign(new Error(
                "v1 client services were not advertised; pin protocolVersion: 1 in the trusted local registration if this agent requires them",
              ), { rpcCode: -32601 });
            }
            return services.handleRequest(method, params);
          }
          throw Object.assign(new Error(`method not found: ${method}`), { rpcCode: -32601 });
        },
      });

      let session;
      if (resumeId) {
        if (!resumeSupported(negotiatedVersion, capabilities)) {
          throw adapterError(
            `ACP protocol v${negotiatedVersion} agent does not advertise native resume; refusing to start a fresh session`,
            "unsupported",
            { sessionId: resumeId },
          );
        }
        cleanupSessionId = resumeId;
        state.setSession(resumeId);
        if (negotiatedVersion === 1) {
          session = await transport.request("session/load", {
            sessionId: resumeId,
            cwd: request.cwd,
            mcpServers: [],
          }, { signal: deadline.signal, timeoutMs: this.startupTimeoutMs });
        } else {
          session = await transport.request("session/resume", {
            sessionId: resumeId,
            cwd: request.cwd,
            mcpServers: [],
          }, { signal: deadline.signal, timeoutMs: this.startupTimeoutMs });
        }
      } else {
        session = await transport.request("session/new", {
          cwd: request.cwd,
          mcpServers: [],
        }, { signal: deadline.signal, timeoutMs: this.startupTimeoutMs });
        if (typeof session?.sessionId === "string" && session.sessionId.length > 0) cleanupSessionId = session.sessionId;
        state.setSession(session?.sessionId);
      }

      await applySessionRoute(transport, state.sessionId, session, request.route, {
        signal: deadline.signal, timeoutMs: this.startupTimeoutMs,
      });
      state.beginTurn();
      this.active = { transport, state, registration };
      const executionTimeoutMs = request.execution?.timeoutMs ?? this.timeoutMs;
      const promptTimeoutMs = Math.min(2_147_483_647, executionTimeoutMs + this.cancelTimeoutMs + 1_000);
      promptPromise = transport.request("session/prompt", {
        sessionId: state.sessionId,
        prompt: [{ type: "text", text: promptText(request) }, ...content],
      }, { timeoutMs: promptTimeoutMs });
      terminalAbort = abortFailure(deadline.signal);
      promptResponse = await Promise.race([
        promptPromise,
        transport.failure().then((error) => { throw error; }),
        terminalAbort.promise,
      ]);
      const response = promptResponse;
      let terminal;
      if (negotiatedVersion === 1) {
        if (!hasText(response?.stopReason)) throw adapterError("ACP v1 prompt response omitted stopReason", "protocol");
        state.markV1Terminal(response);
        terminal = response;
      } else {
        if (!hasText(response?.messageId)) {
          throw adapterError("ACP v2 prompt response did not acknowledge a messageId", "protocol");
        }
        state.acceptPrompt(response.messageId);
        terminal = await Promise.race([
          state.waitForTerminal(),
          transport.failure().then((error) => { throw error; }),
          terminalAbort.promise,
        ]);
      }
      if (deadline.signal.aborted) throw adapterError("ACP execution aborted", "abort", { aborted: true });
      const stopReason = terminal?.stopReason ?? null;
      if (stopReason === "cancelled") {
        throw adapterError("ACP prompt was cancelled", "abort", { aborted: true, stopReason });
      }
      if (stopReason !== "end_turn") {
        throw adapterError(`ACP prompt did not complete successfully (stopReason=${stopReason ?? "unreported"})`, "downstream", {
          stopReason,
          downstreamError: terminal?.error == null
            ? null
            : boundedProviderText(typeof terminal.error === "string" ? terminal.error : JSON.stringify(terminal.error), 4_000),
        });
      }
      const final = state.finalMessage();
      if (final.overflow) {
        throw adapterError(`ACP final output exceeds ${MAX_FINAL_TEXT_CHARS} characters`, "output-limit", {
          maxFinalTextChars: MAX_FINAL_TEXT_CHARS,
        });
      }
      if (!hasText(final.text)) {
        throw adapterError("ACP completed without a non-empty final agent message", "downstream", { stopReason });
      }
      const route = {
        ...request.route,
        harness: "acp",
        agent: registration.id,
        transport: "acp-stdio",
        protocolVersion: negotiatedVersion,
        wireProtocolVersion,
        ...(registration.registryId ? { registryId: registration.registryId } : {}),
        ...(registration.version ? { registeredVersion: registration.version } : {}),
      };
      return {
        sessionId: state.sessionId,
        workflowRunId,
        route,
        result: structuredResult(final.text, {
          agent: registration.id,
          agentInfo: identity,
          stopReason,
          eventSummary: state.summary.snapshot(),
          nativeSessionId: state.sessionId,
        }),
        usage: state.usage,
        usageSummary: usageSummary(),
      };
    } catch (error) {
      let failure = error;
      if (deadline.signal.aborted && state?.sessionId && promptPromise && !cancellationHandled) {
        try {
          await confirmCancellation();
          failure = adapterError("ACP execution aborted", "abort", { aborted: true, cancelAcknowledged: true });
        } catch (confirmationError) {
          failure = confirmationError;
        }
      }
      caughtError = normalizedError(failure, { state, deadline, agentId: registration.id });
      throw caughtError;
    } finally {
      deadline.signal.removeEventListener("abort", onAbort);
      deadline.dispose();
      terminalAbort?.dispose();
      if (this.active?.transport === transport) this.active = null;
      const cleanupFailures = [];
      const observedSessionId = cleanupSessionId ?? state?.sessionId ?? state?.provisionalSessionId ?? null;
      if (nativeCloseSupported && observedSessionId !== null) {
        try {
          await transport?.request?.("session/close", { sessionId: observedSessionId }, {
            timeoutMs: this.cleanupTimeoutMs,
          });
        } catch (error) {
          cleanupFailures.push({
            component: "session",
            message: redactSecrets(boundedProviderText(errorText(error))),
          });
        }
      }
      try { await transport?.close?.(); }
      catch (error) { cleanupFailures.push({ component: "process", message: redactSecrets(boundedProviderText(errorText(error))) }); }
      try { await services?.close?.(); }
      catch (error) { cleanupFailures.push({ component: "client-services", message: redactSecrets(boundedProviderText(errorText(error))) }); }
      if (cleanupFailures.length) {
        if (caughtError) {
          caughtError.details = { ...caughtError.details, cleanupError: cleanupFailures, unsafeResume: true };
        } else {
          throw adapterError("ACP result could not be accepted because owned-resource cleanup was not verified", "transport", {
            cleanupError: cleanupFailures,
            unsafeResume: true,
            sessionId: state?.sessionId ?? state?.provisionalSessionId ?? null,
            usage: state?.usage ?? null,
            usageSummary: usageSummary(),
          });
        }
      }
    }
  }

  async control(command = {}) {
    const active = this.active;
    if (!active) throw adapterError("ACP session is not active", "not-ready");
    if (!["cancel", "stop"].includes(command.kind)) {
      throw adapterError("Generic ACP supports only native cancellation during an active run", "unsupported-control", {
        commandId: command.commandId ?? null,
      });
    }
    active.state.cancelRequested = true;
    await active.transport.notify("session/cancel", { sessionId: active.state.sessionId });
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), this.cancelTimeoutMs);
    });
    const terminal = await Promise.race([active.state.waitForTerminal(), timeout]);
    clearTimeout(timer);
    if (!terminal) {
      await active.transport.close();
      throw adapterError("ACP cancellation was not acknowledged before the timeout", "cancel-unacknowledged", {
        uncertain: true,
        sessionId: active.state.sessionId,
        timeoutMs: this.cancelTimeoutMs,
      });
    }
    return {
      harness: "acp",
      command: "session/cancel",
      delivery: "native",
      settled: true,
      stopReason: terminal.stopReason ?? null,
    };
  }

  async close() {
    const active = this.active;
    if (!active) return;
    await active.transport.close();
    if (this.active === active) this.active = null;
  }
}

export { AcpRpcError, AcpTransport } from "./acp-transport.mjs";
