// Cursor ACP session adapter.
//
// The existing `cursor.mjs` adapter runs one `cursor-agent -p` process per
// handoff. This adapter owns a real Agent Client Protocol session over stdio
// (`cursor-agent acp`) so a caller can resume a native session, observe
// streamed updates, cancel a live turn, and reroute the model for the next
// request. The protocol is newline-delimited JSON-RPC 2.0
// (https://agentclientprotocol.com/protocol/transports).
//
// Truthfulness boundaries this adapter refuses to cross:
// - It advertises no `fs` and no `terminal` client capabilities, so the agent
//   must execute its own tools. A client-capability call is answered with a
//   JSON-RPC method-not-found error; this adapter never performs host-side IO
//   on the agent's behalf.
// - Read-only requires a provable read-only mode (exact `ask` or `plan`
//   config-option value) acknowledged before the prompt is sent. Permission
//   rejection stays as a second boundary, but read-only never relies on it
//   alone: a permissive agent may not emit permission requests at all.
//   Cursor documents `plan` and `ask` as read-only modes
//   (https://cursor.com/docs/cli/acp, retrieved 2026-09-19).
// - There is no documented mid-turn steering or queued follow-up
//   acknowledgement in ACP. `control` fails closed for message delivery. The
//   only supported live controls are native `session/cancel` (waited to
//   prompt settle) and model reroute through a negotiated config option.
// - Missing resume capability fails; it never silently starts a new session.
// - Unknown usage counters stay null. ACP reports session context window and
//   cumulative cost, not always token in/out.

import { validateAdapterExecution } from "../execution-controls.mjs";
import { aborted } from "node:util";

import { harnessLaunch } from "../config.mjs";
import { NativeLaunchError, spawnNativeCommand } from "../launch-command.mjs";
import { assertNoClaudeRoute } from "../model-policy.mjs";
import { digestContext, hasToolPolicy } from "../protocol.mjs";
import {
  boundedProviderText,
  classifyProviderFailure,
  mergeProcessEnv,
  redactSecrets,
  terminateProcessTree,
} from "../process.mjs";
import { structuredResult } from "../result.mjs";
import { summarizeUsage } from "../usage.mjs";

export const CURSOR_SESSION_PROTOCOL_VERSION = 1;
export const DEFAULT_TIMEOUT_MS = 3_600_000;
export const DEFAULT_CANCEL_TIMEOUT_MS = 15_000;
export const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
export const DEFAULT_SESSION_LOAD_TIMEOUT_MS = 90_000;
export const DEFAULT_IDLE_TIMEOUT_MS = 300_000;

const MAX_LINE_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_PENDING_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_PENDING_STDOUT_CHUNKS = 256;
const MAX_PENDING_REQUESTS = 64;
const MAX_FINAL_CHARS = 1_048_576;
const MAX_PROGRESS_TEXT_CHARS = 2_000;
const MAX_EVENT_TYPES = 20;

// Client capabilities this transport implements. `false` is the honest value
// for fs/terminal: the adapter does not proxy file or shell access. Resume and
// load are negotiated from the agent's initialize response at runtime.
export const SESSION_CAPABILITIES = Object.freeze({
  transport: "acp-stdio",
  protocolVersion: CURSOR_SESSION_PROTOCOL_VERSION,
  prompt: true,
  cancel: true,
  steer: false,
  followUp: false,
  resume: "negotiated",
  load: "negotiated",
  model: "negotiated-session-config-option",
  mode: "negotiated-session-mode",
  fsReadTextFile: false,
  fsWriteTextFile: false,
  terminal: false,
  authentication: "native",
  usage: "session-usage-update",
});

export class CursorSessionAdapterError extends Error {
  constructor(message, kind, details = {}) {
    super(message);
    this.name = "CursorSessionAdapterError";
    this.details = { kind, ...details };
  }
}

class AcpProtocolError extends Error {
  constructor(message, { code = null, data = null, method = null } = {}) {
    super(boundedProviderText(message) || "ACP request failed");
    this.name = "AcpProtocolError";
    this.code = Number.isFinite(Number(code)) ? Number(code) : null;
    this.data = data ?? null;
    this.method = method;
    const status = Number(data?.status ?? data?.statusCode ?? data?.httpStatus);
    this.status = Number.isFinite(status) ? status : null;
  }
}

// Raw requests may carry policy aliases; normalizeRequest already collapses
// them, but direct adapter callers must not be able to flip read-only to write
// by using `allowWrites`.
function policyWrites(policy = {}) {
  if (typeof policy.write === "boolean") return policy.write;
  if (typeof policy.readOnly === "boolean") return !policy.readOnly;
  if (typeof policy.allowWrites === "boolean") return policy.allowWrites;
  return false;
}

function adapterError(message, kind, details = {}) {
  return new CursorSessionAdapterError(message, kind, details);
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error ?? "");
}

// Mirrors CursorProvider.resolveCursorAcpBaseModelId: parameterized model
// values carry a bracketed suffix (`<model>[<config>]`) that must be stripped
// before the value is sent to session/set_config_option.
export function resolveCursorAcpBaseModelId(model) {
  const trimmed = typeof model === "string" ? model.trim() : "";
  const base = trimmed.length > 0 ? trimmed : "default";
  return base.includes("[") ? base.slice(0, base.indexOf("[")) : base;
}

function modelSelection(requestRoute = {}) {
  const model = typeof requestRoute.model === "string" && requestRoute.model.trim()
    ? requestRoute.model.trim()
    : null;
  const provider = typeof requestRoute.provider === "string" && requestRoute.provider.trim()
    ? requestRoute.provider.trim()
    : null;
  return { provider, model, base: model ? resolveCursorAcpBaseModelId(model) : null };
}

function normalizeToken(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// Cursor ACP documents three core modes: `agent` (full tool access),
// `plan` (planning, read-only behavior) and `ask` (Q&A/read-only behavior)
// (https://cursor.com/docs/cli/acp, retrieved 2026-09-19). T3 Code negotiates
// Cursor's mode through the `mode` session config option, which is also the
// only surface that acknowledges a mode change synchronously.
//
// Selection matches exact protocol ids/values only. Human-readable names and
// descriptions never grant a permission boundary, so a permissive mode named
// "Ask anything" or described as read-only cannot be mistaken for one.
const READ_ONLY_MODE_IDS = ["ask", "plan"];
const IMPLEMENT_MODE_IDS = ["agent", "code", "default"];

function modeEntryId(entry) {
  if (!isObject(entry)) return null;
  if (typeof entry.id === "string" && entry.id.trim()) return entry.id.trim();
  if (typeof entry.value === "string" && entry.value.trim()) return entry.value.trim();
  return null;
}

function normalizeModeCandidates(modes) {
  const list = Array.isArray(modes) ? modes : [];
  const candidates = [];
  const seen = new Set();
  for (const entry of list) {
    const id = modeEntryId(entry);
    if (!id) continue;
    const token = normalizeToken(id);
    if (!token || seen.has(token)) continue;
    seen.add(token);
    candidates.push({ id, token });
  }
  return candidates;
}

function exactModeMatch(modes, aliases) {
  const candidates = normalizeModeCandidates(modes);
  for (const alias of aliases) {
    const token = normalizeToken(alias);
    const match = candidates.find((candidate) => candidate.token === token);
    if (match) return match;
  }
  return null;
}

export function findModeByAliases(modes, aliases) {
  return exactModeMatch(modes, aliases) ?? undefined;
}

export function isPlanMode(mode) {
  return exactModeMatch([mode], ["plan", "architect"]) !== null;
}

/**
 * Exact-id mode selection. `modes` may be SessionMode entries or resolved
 * config-option values. Read-only resolves only the documented read-only ids
 * (`ask`, `plan`); write resolves only the documented full-access ids.
 * Descriptions and partial names are ignored by design.
 */
export function desiredModeId(policyWrite, modes) {
  const match = exactModeMatch(modes, policyWrite ? IMPLEMENT_MODE_IDS : READ_ONLY_MODE_IDS);
  return match?.id ?? null;
}

function configOptionValues(option) {
  const values = [];
  const visit = (entry) => {
    if (!isObject(entry)) return;
    if (Array.isArray(entry.options)) {
      for (const child of entry.options) visit(child);
      return;
    }
    if (typeof entry.value === "string") values.push({ value: entry.value, name: typeof entry.name === "string" ? entry.name : entry.value });
  };
  if (Array.isArray(option?.options)) for (const entry of option.options) visit(entry);
  return values;
}

function findSelectOption(configOptions, predicate) {
  const list = Array.isArray(configOptions) ? configOptions : [];
  return list.find((option) => isObject(option) && option.type === "select" && predicate(option)) ?? null;
}

// A model selector is identified by the reserved `model` category or the
// reserved `model` id, never by a fuzzy name match.
export function findModelConfigOption(configOptions) {
  return findSelectOption(configOptions, (option) => option.category === "model" || option.id === "model");
}

function findModeConfigOption(configOptions) {
  return findSelectOption(configOptions, (option) => option.category === "mode" || option.id === "mode");
}

function modelMatchTokens(baseModel) {
  const trimmed = typeof baseModel === "string" ? baseModel.trim() : "";
  if (!trimmed) return [];
  // Parameterized model values carry a bracketed config suffix; the wire value
  // is the base id (`model-id[high]` -> `model-id`). Providers may also qualify
  // with `provider/model`, so the last segment is an accepted token.
  const withoutConfig = trimmed.includes("[") ? trimmed.slice(0, trimmed.indexOf("[")) : trimmed;
  const segment = withoutConfig.includes("/") ? withoutConfig.slice(withoutConfig.lastIndexOf("/") + 1) : withoutConfig;
  return [...new Set([normalizeToken(withoutConfig), normalizeToken(segment)])].filter(Boolean);
}

/**
 * Resolve the exact advertised value to send for a requested model. When the
 * agent advertises options, a model that is not advertised fails closed rather
 * than silently running a different model.
 */
export function resolveConfigOptionValue(option, baseModel) {
  const values = configOptionValues(option);
  if (!values.length) return { value: baseModel, matched: true };
  const tokens = modelMatchTokens(baseModel);
  const match = values.find((entry) => tokens.includes(normalizeToken(entry.value)) || tokens.includes(normalizeToken(entry.name)));
  return match ? { value: match.value, matched: true } : { value: baseModel, matched: false };
}

function configOptionMatchesModel(option, baseModel) {
  return modelMatchTokens(baseModel).length > 0 && resolveConfigOptionValue(option, baseModel).matched;
}

// Agent tool kinds that cannot modify the workspace. `other` and a missing
// kind are treated as potentially mutating so read-only rejects them.
const SAFE_READ_TOOL_KINDS = new Set(["read", "search", "think", "fetch"]);

export function toolRequiresWrite(toolKind) {
  const kind = typeof toolKind === "string" ? toolKind.trim().toLowerCase() : "";
  return !SAFE_READ_TOOL_KINDS.has(kind);
}

function pickPermissionOption(options, kinds) {
  const list = Array.isArray(options) ? options : [];
  for (const kind of kinds) {
    const match = list.find((option) => isObject(option) && option.kind === kind && typeof option.optionId === "string" && option.optionId);
    if (match) return match.optionId;
  }
  return null;
}

/**
 * Pure permission decision used by the request handler and by tests.
 * `policyWrite` false rejects mutating tools with a reject option; a missing
 * reject option cannot be silently ignored, so the turn is cancelled and the
 * caller records that read-only could not be enforced.
 */
export function permissionDecision({ policyWrite, toolKind, options, cancelled = false } = {}) {
  if (cancelled) return { outcome: { outcome: "cancelled" }, decision: "cancelled", enforced: true };
  const mutating = toolRequiresWrite(toolKind);
  if (!policyWrite) {
    if (mutating) {
      const reject = pickPermissionOption(options, ["reject_once", "reject_always"]);
      if (reject !== null) return { outcome: { outcome: "selected", optionId: reject }, decision: "rejected", enforced: true };
      // No reject option offered: fail closed by cancelling the turn. The
      // caller records that read-only enforcement could not be proven.
      return { outcome: { outcome: "cancelled" }, decision: "cancelled", enforced: false };
    }
    const allowRead = pickPermissionOption(options, ["allow_once", "allow_always"]);
    if (allowRead !== null) return { outcome: { outcome: "selected", optionId: allowRead }, decision: "allowed", enforced: true };
    return { outcome: { outcome: "cancelled" }, decision: "cancelled", enforced: false };
  }
  const allow = pickPermissionOption(options, ["allow_always", "allow_once"]);
  if (allow !== null) return { outcome: { outcome: "selected", optionId: allow }, decision: "allowed", enforced: true };
  return { outcome: { outcome: "cancelled" }, decision: "cancelled", enforced: false };
}

function pickAuthMethod(authMethods) {
  const list = Array.isArray(authMethods) ? authMethods.filter(isObject) : [];
  const agentType = list.filter((method) => method.type === undefined || method.type === null || method.type === "agent");
  const preferred = agentType.find((method) => method.id === "cursor_login") ?? agentType[0];
  return preferred ?? null;
}

export function negotiateCapabilities(initializeResult) {
  const capabilities = isObject(initializeResult?.agentCapabilities) ? initializeResult.agentCapabilities : {};
  const sessionCapabilities = isObject(capabilities.sessionCapabilities) ? capabilities.sessionCapabilities : {};
  return Object.freeze({
    protocolVersion: Number.isFinite(Number(initializeResult?.protocolVersion)) ? Number(initializeResult.protocolVersion) : null,
    loadSession: capabilities.loadSession === true,
    resume: Boolean(sessionCapabilities.resume),
    close: Boolean(sessionCapabilities.close),
    promptImage: capabilities.promptCapabilities?.image === true,
    promptAudio: capabilities.promptCapabilities?.audio === true,
    promptEmbeddedContext: capabilities.promptCapabilities?.embeddedContext === true,
    authMethods: Array.isArray(initializeResult?.authMethods)
      ? initializeResult.authMethods.filter(isObject).map((method) => ({ id: method.id, type: method.type ?? "agent" })).filter((method) => typeof method.id === "string")
      : [],
    agentInfo: isObject(initializeResult?.agentInfo) ? initializeResult.agentInfo : null,
  });
}

function requiresMutatingTurn(stopReason) {
  return stopReason === "max_tokens" || stopReason === "max_turn_requests" || stopReason === "refusal";
}

function permissionToolLabel(toolCall) {
  if (!isObject(toolCall)) return "tool call";
  const title = typeof toolCall.title === "string" && toolCall.title.trim() ? toolCall.title.trim() : null;
  const name = typeof toolCall.name === "string" && toolCall.name.trim() ? toolCall.name.trim() : null;
  return title ?? name ?? "tool call";
}

function usageFromSessionUpdate(update) {
  if (!isObject(update)) return null;
  const usage = {};
  let present = false;
  if (typeof update.used === "number" && Number.isFinite(update.used)) {
    usage.contextWindowUsed = update.used;
    present = true;
  }
  if (typeof update.size === "number" && Number.isFinite(update.size)) {
    usage.contextWindowSize = update.size;
    present = true;
  }
  if (isObject(update.cost) && typeof update.cost.amount === "number" && Number.isFinite(update.cost.amount)) {
    usage.cost = { amount: update.cost.amount, currency: typeof update.cost.currency === "string" ? update.cost.currency : null };
    usage.totalCostUsd = update.cost.currency === "USD" ? update.cost.amount : null;
    present = true;
  }
  return present ? usage : null;
}

function mergeUsage(current, next) {
  if (!next) return current ?? null;
  return { ...(current ?? {}), ...next };
}

function contentText(content) {
  if (!isObject(content)) return "";
  if (content.type === "text" && typeof content.text === "string") return content.text;
  return "";
}

function promptEnvelope(request) {
  // Field order is a prompt-cache contract: stable context first, then the
  // variable task and identifiers. See docs/adapter-contract.md.
  return {
    protocolVersion: request.protocolVersion || "1.0",
    contextDigest: request.contextDigest || digestContext(request.context),
    context: request.context ?? null,
    flowSpec: request.workflow?.spec || null,
    cwd: request.cwd,
    policy: request.policy || { write: false, tools: [], maxCostUsd: null },
    task: request.task,
    requestId: request.requestId,
    route: request.route || {},
  };
}

function promptText(request) {
  const envelope = JSON.stringify(promptEnvelope(request));
  const intro = "Execute the complete assigned workflow. Preserve the request and context identifiers exactly. Return the final answer for this phase.";
  return `${intro}\n\n${envelope}`;
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
    timedOut = true;
    controller.abort();
  }, timeoutMs || DEFAULT_TIMEOUT_MS);
  return {
    signal: controller.signal,
    get timedOut() { return timedOut; },
    get aborted() { return controller.signal.aborted; },
    dispose() {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", abort);
    },
  };
}

function protocolFailure(error, sessionState = {}) {
  if (error instanceof CursorSessionAdapterError) return error;
  if (error instanceof AcpProtocolError) {
    const classification = classifyProviderFailure({ type: null, message: error.message, status: error.status ?? null });
    if (classification) {
      const label = classification.kind === "provider-auth" ? "provider authorization" : "model availability";
      return adapterError(`Cursor ${label} failure for cursor: ${boundedProviderText(error.message)}`, classification.kind, {
        category: classification.category,
        provider: "cursor",
        status: error.status ?? null,
        providerError: { type: null, message: boundedProviderText(error.message), status: error.status ?? null },
        hint: "verify Cursor authentication with `cursor-agent login`",
      });
    }
    if (error.code === -32000) {
      return adapterError("Cursor ACP requires authentication before this session can be used", "provider-auth", {
        category: "auth",
        provider: "cursor",
        status: null,
        hint: "run `cursor-agent login`; Harnest never reads or forwards provider credentials",
      });
    }
    return adapterError(`Cursor ACP request ${error.method || "failed"}: ${boundedProviderText(error.message)}`, "downstream", {
      rpcCode: error.code,
      method: error.method,
    });
  }
  const state = sessionState || {};
  if (state.timedOut || error?.details?.timedOut) {
    return adapterError("Cursor ACP execution timed out", "timeout", { timedOut: true, aborted: false });
  }
  if (state.aborted || error?.details?.aborted || error?.code === -32800) {
    return adapterError("Cursor ACP execution aborted", "abort", { aborted: true, timedOut: false });
  }
  return adapterError(`Cursor ACP transport failure: ${boundedProviderText(errorMessage(error))}`, "transport", {
    hint: "install cursor-agent and ensure it is on PATH, or set HARNEST_CURSOR",
  });
}

/**
 * Low-level ACP JSON-RPC connection over a child's stdio. Exported so tests can
 * exercise framing, byte caps and backpressure without a paid model.
 */
export class AcpTransport {
  constructor(options = {}) {
    this.command = options.command;
    this.args = Array.isArray(options.args) ? options.args : [];
    this.cwd = options.cwd;
    this.env = options.env;
    this.spawnFn = options.spawnFn || spawnNativeCommand;
    this.maxLineBytes = options.maxLineBytes || MAX_LINE_BYTES;
    this.maxStderrBytes = options.maxStderrBytes || MAX_STDERR_BYTES;
    this.maxPendingStdoutBytes = options.maxPendingStdoutBytes || MAX_PENDING_STDOUT_BYTES;
    this.maxPendingStdoutChunks = options.maxPendingStdoutChunks || MAX_PENDING_STDOUT_CHUNKS;
    this.pauseBytes = Math.floor(this.maxPendingStdoutBytes / 2);
    this.resumeBytes = Math.floor(this.maxPendingStdoutBytes / 4);
    this.child = null;
    this.stderrText = "";
    this.pending = new Map();
    this.requestHandlers = new Map();
    this.notificationHandlers = new Map();
    this.defaultRequestHandler = null;
    this.defaultNotificationHandler = null;
    this.nextId = 0;
    this.closed = false;
    this.failed = null;
    this.exitInfo = null;
    this.draining = false;
    this.stdoutQueue = [];
    this.queuedBytes = 0;
    this.lineSegments = [];
    this.lineBytes = 0;
    this.teardownPromise = null;
  }

  setHandlers({ onNotification, onRequest } = {}) {
    this.defaultNotificationHandler = typeof onNotification === "function" ? onNotification : null;
    this.defaultRequestHandler = typeof onRequest === "function" ? onRequest : null;
  }

  start() {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = this.spawnFn(this.command, this.args, {
          cwd: this.cwd,
          env: this.env,
          windowsHide: true,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error) {
        reject(error instanceof NativeLaunchError ? error
          : adapterError(`Cursor ACP could not start: ${boundedProviderText(errorMessage(error))}`, "transport", {
            hint: "install cursor-agent and ensure it is on PATH, or set HARNEST_CURSOR",
          }));
        return;
      }
      this.child = child;
      child.stdout?.on?.("data", (chunk) => this.onStdout(chunk));
      child.stderr?.on?.("data", (chunk) => this.onStderr(chunk));
      child.once?.("error", (error) => {
        this.exitInfo = { code: error?.code ?? null, signal: null, error };
        this.fail(adapterError(`Cursor ACP process failed: ${boundedProviderText(errorMessage(error))}`, "transport", {
          hint: "install cursor-agent and ensure it is on PATH, or set HARNEST_CURSOR",
        }));
      });
      child.once?.("close", (code, signalName) => {
        this.exitInfo = { code: code ?? null, signal: signalName ?? null, error: null };
        if (!this.closed) {
          this.fail(adapterError("Cursor ACP connection closed before the request completed", "transport", {
            code: code ?? null,
            signal: signalName ?? null,
            stderr: boundedProviderText(this.stderrText) || null,
          }));
        }
      });
      resolve();
    });
  }

  onStderr(chunk) {
    if (this.closed) return;
    this.stderrText = `${this.stderrText}${Buffer.from(chunk).toString("utf8")}`;
    if (this.stderrText.length > this.maxStderrBytes) this.stderrText = this.stderrText.slice(-this.maxStderrBytes);
  }

  onStdout(chunk) {
    if (this.closed || this.failed) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (!buffer.length) return;
    this.queuedBytes += buffer.length;
    this.stdoutQueue.push(buffer);
    if (this.queuedBytes > this.maxPendingStdoutBytes || this.stdoutQueue.length > this.maxPendingStdoutChunks) {
      this.fail(adapterError("Cursor ACP stdout backlog exceeds the delivery limit", "output-limit", {
        stream: "stdout",
        maxPendingBytes: this.maxPendingStdoutBytes,
        maxPendingChunks: this.maxPendingStdoutChunks,
      }));
      return;
    }
    if (this.queuedBytes > this.pauseBytes) this.child?.stdout?.pause?.();
    if (!this.draining) void this.drainStdout();
  }

  async drainStdout() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (!this.failed && !this.closed && this.stdoutQueue.length) {
        const chunk = this.stdoutQueue[0];
        let offset = 0;
        while (offset < chunk.length) {
          const newline = chunk.indexOf(10, offset);
          const end = newline < 0 ? chunk.length : newline;
          const segment = chunk.subarray(offset, end);
          if (this.lineBytes + segment.length > this.maxLineBytes) {
            this.queuedBytes -= chunk.length;
            this.stdoutQueue.shift();
            this.fail(adapterError("Cursor ACP stdout line exceeds maxLineBytes", "output-limit", {
              stream: "stdout",
              maxLineBytes: this.maxLineBytes,
            }));
            return;
          }
          if (segment.length) {
            this.lineSegments.push(segment);
            this.lineBytes += segment.length;
          }
          offset = newline < 0 ? chunk.length : newline + 1;
          if (newline >= 0) {
            const line = this.lineBytes ? Buffer.concat(this.lineSegments, this.lineBytes).toString("utf8") : "";
            this.lineSegments = [];
            this.lineBytes = 0;
            await this.handleLine(line);
            if (this.failed || this.closed) return;
          }
        }
        this.queuedBytes -= chunk.length;
        this.stdoutQueue.shift();
      }
    } finally {
      this.draining = false;
      if (!this.failed && !this.closed && this.queuedBytes <= this.resumeBytes) this.child?.stdout?.resume?.();
    }
  }

  async handleLine(line) {
    const trimmed = typeof line === "string" ? line.trim() : "";
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      this.fail(adapterError("Cursor ACP wrote a non-JSON line to stdout", "transport", {
        line: boundedProviderText(trimmed).slice(0, 400),
      }));
      return;
    }
    if (!isObject(message) || message.jsonrpc !== "2.0") {
      this.fail(adapterError("Cursor ACP wrote an invalid JSON-RPC message", "transport", {
        line: boundedProviderText(trimmed).slice(0, 400),
      }));
      return;
    }
    if (message.id !== undefined && message.id !== null && typeof message.method !== "string") {
      this.resolveResponse(message);
      return;
    }
    if (typeof message.method === "string") {
      await this.handleIncoming(message);
      return;
    }
    this.fail(adapterError("Cursor ACP wrote a message with neither method nor response id", "transport"));
  }

  resolveResponse(message) {
    const pending = this.pending.get(message.id);
    if (!pending) return; // Late or unknown response: ignore without crashing.
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    pending.signal?.removeEventListener?.("abort", pending.onAbort);
    if (message.error) {
      pending.reject(new AcpProtocolError(message.error.message ?? "ACP error", {
        code: message.error.code,
        data: message.error.data,
        method: pending.method,
      }));
    } else {
      pending.resolve(message.result ?? {});
    }
  }

  async handleIncoming(message) {
    const hasId = message.id !== undefined && message.id !== null;
    if (!hasId) {
      const handler = this.notificationHandlers.get(message.method) || this.defaultNotificationHandler;
      if (!handler) return;
      try {
        await handler(message.params ?? {}, message);
      } catch (error) {
        this.fail(error instanceof CursorSessionAdapterError
          ? error
          : adapterError(`Cursor ACP notification handler failed: ${boundedProviderText(errorMessage(error))}`, "transport", { cause: error }));
      }
      return;
    }
    const handler = this.requestHandlers.get(message.method) || this.defaultRequestHandler;
    if (!handler) {
      this.respondError(message.id, -32601, `method not found: ${message.method}`);
      return;
    }
    try {
      const result = await handler(message.params ?? {}, message);
      this.respond(message.id, result ?? {});
    } catch (error) {
      // A progress/persistence callback failure is a transport failure for the
      // whole run, not an agent-visible RPC error.
      if (error instanceof CursorSessionAdapterError && error.details?.phase === "progress") {
        this.fail(error);
        return;
      }
      this.respondError(message.id, Number.isFinite(Number(error?.rpcCode)) ? Number(error.rpcCode) : -32603,
        boundedProviderText(errorMessage(error)) || "Cursor ACP request handler failed",
        error?.data ?? null);
    }
  }

  respond(id, result) {
    this.write({ jsonrpc: "2.0", id, result: result ?? {} });
  }

  respondError(id, code, message, data = null) {
    this.write({ jsonrpc: "2.0", id, error: { code, message, ...(data !== null ? { data } : {}) } });
  }

  notify(method, params) {
    this.write({ jsonrpc: "2.0", method, params: params ?? {} });
  }

  write(message) {
    if (this.closed || !this.child?.stdin?.write) {
      throw adapterError("Cursor ACP connection is not writable", "transport", { uncertain: true });
    }
    try {
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      this.fail(adapterError(`Cursor ACP write failed: ${boundedProviderText(errorMessage(error))}`, "transport", { cause: error }));
      throw error instanceof CursorSessionAdapterError ? error : adapterError("Cursor ACP write failed", "transport", { cause: error });
    }
  }

  request(method, params, { timeoutMs, signal } = {}) {
    if (this.closed) return Promise.reject(adapterError("Cursor ACP connection is closed", "transport"));
    if (this.failed) return Promise.reject(this.failed);
    if (!this.child?.stdin?.write) return Promise.reject(adapterError("Cursor ACP connection is not ready", "transport"));
    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      return Promise.reject(adapterError("Cursor ACP has too many pending requests", "transport", { method }));
    }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, method, timer: null, signal: null, onAbort: null };
      if (signal) {
        entry.signal = signal;
        entry.onAbort = () => {
          if (!this.pending.has(id)) return;
          this.pending.delete(id);
          clearTimeout(entry.timer);
          reject(adapterError("Cursor ACP request aborted", "abort", { aborted: true, method }));
        };
        if (signal.aborted) {
          reject(adapterError("Cursor ACP request aborted", "abort", { aborted: true, method }));
          return;
        }
        signal.addEventListener("abort", entry.onAbort, { once: true });
      }
      if (timeoutMs) {
        entry.timer = setTimeout(() => {
          if (!this.pending.has(id)) return;
          this.pending.delete(id);
          signal?.removeEventListener?.("abort", entry.onAbort);
          reject(adapterError(`Cursor ACP ${method} timed out`, "timeout", { timedOut: true, method }));
        }, timeoutMs);
      }
      this.pending.set(id, entry);
      try {
        this.write({ jsonrpc: "2.0", id, method, params: params ?? {} });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(entry.timer);
        signal?.removeEventListener?.("abort", entry.onAbort);
        reject(error);
      }
    });
  }

  fail(error) {
    if (this.failed) return;
    this.failed = error instanceof CursorSessionAdapterError
      ? error
      : adapterError(errorMessage(error), "transport", { cause: error });
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.signal?.removeEventListener?.("abort", entry.onAbort);
      entry.reject(this.failed);
    }
  }

  // Idempotent teardown. Only the child this transport spawned is terminated;
  // the parent session/host process is never targeted. The teardown promise is
  // retained so repeat calls resolve immediately instead of re-waiting.
  close() {
    this.closed = true;
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.signal?.removeEventListener?.("abort", entry.onAbort);
      entry.reject(adapterError("Cursor ACP connection closed before response", "transport", { uncertain: true }));
    }
    if (this.teardownPromise) return this.teardownPromise;
    const child = this.child;
    if (!child) return Promise.resolve();
    this.teardownPromise = new Promise((resolve) => {
      let timer;
      const done = () => { clearTimeout(timer); resolve(); };
      child.once?.("close", done);
      terminateProcessTree(child);
      timer = setTimeout(done, 2_000);
    });
    return this.teardownPromise;
  }
}

function assertNoGraph(workflow) {
  if (workflow?.spec == null && workflow?.nodes == null) return;
  throw adapterError(
    "cursor ACP session transport cannot execute a Taskflow graph; select pi or opencode for workflow.spec/workflow.nodes",
    "policy",
  );
}

function assertThinkingUnsupported(route) {
  const thinking = route?.thinking;
  if (thinking == null || (typeof thinking === "string" && !thinking.trim())) return;
  throw adapterError(
    "Cursor ACP session transport does not map route.thinking; encode thinking in route.model (for example a thinking-capable model ID) instead",
    "policy",
    { thinking, hint: "set route.model to a thinking-capable model ID" },
  );
}

function assertSessionPolicySupported(policy = {}) {
  if (policy.mode !== undefined || policy.sandbox !== undefined) {
    throw adapterError("Explicit policy.mode and policy.sandbox require Cursor print mode", "policy");
  }
  if (hasToolPolicy(policy.tools)) {
    throw adapterError(
      "Cursor ACP session transport has no per-tool filter; policy.tools is rejected rather than silently ignored",
      "policy",
      { reason: "policy.tools granular filtering is not supported by cursor-agent acp" },
    );
  }
  if (policy.maxCostUsd != null) {
    throw adapterError(
      "Cursor ACP session transport cannot enforce policy.maxCostUsd; ACP usage updates are informational only",
      "policy",
      { reason: "policy.maxCostUsd budget enforcement is not supported by cursor-agent acp" },
    );
  }
}

class EventSummary {
  constructor() { this.count = 0; this.types = []; }
  add(type) {
    this.count += 1;
    if (typeof type !== "string" || !type) return;
    if (this.types.includes(type)) return;
    this.types.push(type);
    if (this.types.length > MAX_EVENT_TYPES) this.types.shift();
  }
  snapshot() { return { count: this.count, types: [...this.types].slice(-MAX_EVENT_TYPES) }; }
}

/**
 * One live ACP connection with one native session. Owned by a
 * CursorSessionAdapter instance; reused only for an explicitly matching
 * session id with matching cwd/policy/route.
 */
class AcpSession {
  constructor({ adapter, transport, request, capabilities, cwd, identity }) {
    this.adapter = adapter;
    this.transport = transport;
    this.cwd = cwd;
    this.identity = identity;
    this.capabilities = capabilities;
    this.sessionId = null;
    this.configOptions = [];
    this.modes = null;
    this.currentModeId = null;
    this.model = null;
    this.policyWrite = policyWrites(request.policy);
    this.busy = false;
    this.activePrompt = null; // { settled, stopReason, error, resolveSettled }
    this.finalText = "";
    this.finalOverflow = false;
    this.usage = null;
    this.eventSummary = new EventSummary();
    this.permissionEvents = [];
    this.policyUnenforced = false;
    this.cancelRequested = false;
    this.closed = false;
    this.idleTimer = null;
  }

  markIdle() {
    this.clearIdle();
    const idleMs = this.adapter.idleTimeoutMs;
    if (!idleMs || idleMs <= 0) return;
    this.idleTimer = setTimeout(() => { void this.adapter.close(); }, idleMs);
    this.idleTimer.unref?.();
  }

  clearIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.clearIdle();
    await this.transport.close();
  }

  applySessionSetup(result) {
    if (isObject(result?.configOptions)) this.configOptions = result.configOptions;
    else if (Array.isArray(result?.configOptions)) this.configOptions = result.configOptions;
    if (isObject(result?.modes)) {
      this.modes = result.modes;
      if (typeof result.modes.currentModeId === "string") this.currentModeId = result.modes.currentModeId;
    }
    const modelOption = findModelConfigOption(this.configOptions);
    if (modelOption && typeof modelOption.currentValue === "string") this.model = modelOption.currentValue;
  }

  async applyModelSelection(request) {
    const selection = modelSelection(request.route || {});
    if (!selection.model) return;
    const option = findModelConfigOption(this.configOptions);
    if (!option) {
      throw adapterError(
        "Cursor ACP agent advertised no model config option; refusing to run a different model than requested",
        "policy",
        { model: selection.model, hint: "omit route.model to use the agent default, or verify the agent supports a model selector" },
      );
    }
    const resolved = resolveConfigOptionValue(option, selection.base);
    if (!resolved.matched) {
      throw adapterError(
        `Cursor ACP agent did not advertise the requested model "${selection.model}"`,
        "unavailable",
        { category: "not-found", provider: "cursor", model: selection.model },
      );
    }
    if (typeof option.currentValue === "string" && option.currentValue === resolved.value) {
      this.model = resolved.value;
      return;
    }
    const response = await this.transport.request("session/set_config_option", {
      sessionId: this.sessionId,
      configId: option.id,
      value: resolved.value,
    }, { timeoutMs: this.adapter.startupTimeoutMs });
    this.applySessionSetup(response);
    // The refreshed snapshot is authoritative; keep what the agent reports.
    this.model = findModelConfigOption(this.configOptions)?.currentValue ?? resolved.value;
  }

  #modeCandidates() {
    const modeOption = findModeConfigOption(this.configOptions);
    const fromOption = modeOption ? configOptionValues(modeOption).map((entry) => ({ id: entry.value })) : [];
    const fromState = Array.isArray(this.modes?.availableModes) ? this.modes.availableModes : [];
    return [...fromState, ...fromOption];
  }

  #advertisedModeIds() {
    return normalizeModeCandidates(this.#modeCandidates()).map((candidate) => candidate.id);
  }

  async #setModeOption(modeOption, desired) {
    let response;
    try {
      response = await this.transport.request("session/set_config_option", {
        sessionId: this.sessionId,
        configId: modeOption.id,
        value: desired,
      }, { timeoutMs: this.adapter.startupTimeoutMs });
    } catch (error) {
      throw adapterError(
        `Cursor ACP mode change to "${desired}" failed: ${boundedProviderText(errorMessage(error))}`,
        "policy",
        { requested: desired, sessionId: this.sessionId, cause: error },
      );
    }
    this.applySessionSetup(response);
    return response;
  }

  // The refreshed config snapshot is authoritative. A response without a mode
  // value reports null, so a missing acknowledgement can never read as success.
  #appliedMode(response) {
    const refreshed = findModeConfigOption(response?.configOptions);
    if (refreshed && typeof refreshed.currentValue === "string") return refreshed.currentValue;
    if (isObject(response?.modes) && typeof response.modes.currentModeId === "string") return response.modes.currentModeId;
    return null;
  }

  async applyModeSelection(policyWrite) {
    const modeOption = findModeConfigOption(this.configOptions);
    const candidates = this.#modeCandidates();
    const desired = desiredModeId(policyWrite, candidates);
    if (!policyWrite) {
      // Read-only must be provable before a prompt exists. Permission
      // rejection remains a second boundary, but a permissive agent may never
      // emit permission requests, so read-only never relies on them alone.
      if (!desired) {
        throw adapterError(
          "Cursor ACP agent advertised no exact read-only mode (ask or plan); refusing to dispatch a read-only prompt without a provable read-only mode",
          "policy",
          { advertised: this.#advertisedModeIds(), required: READ_ONLY_MODE_IDS },
        );
      }
      if (!modeOption) {
        throw adapterError(
          "Cursor ACP agent advertised modes without a verifiable mode config option; refusing to dispatch a read-only prompt",
          "policy",
          { advertised: this.#advertisedModeIds(), hint: "the mode config option is the only surface that acknowledges a mode change" },
        );
      }
      if (typeof modeOption.currentValue === "string" && modeOption.currentValue === desired) {
        this.currentModeId = desired;
        return;
      }
      const response = await this.#setModeOption(modeOption, desired);
      const applied = this.#appliedMode(response);
      if (applied !== desired) {
        throw adapterError(
          "Cursor ACP agent did not acknowledge the requested read-only mode",
          "policy",
          { requested: desired, applied, sessionId: this.sessionId },
        );
      }
      this.currentModeId = desired;
      return;
    }
    // Write policy: apply the documented full-access mode when it is
    // advertised and verifiable. Missing modes are not an error because write
    // permission is carried by explicit approvals, not by the mode alone.
    if (!desired) return;
    if (modeOption && typeof modeOption.currentValue === "string" && modeOption.currentValue === desired) {
      this.currentModeId = desired;
      return;
    }
    if (!modeOption && this.currentModeId === desired) return;
    if (modeOption) {
      const response = await this.#setModeOption(modeOption, desired);
      const applied = this.#appliedMode(response);
      if (applied !== desired) {
        throw adapterError(
          "Cursor ACP agent did not acknowledge the requested mode",
          "policy",
          { requested: desired, applied, sessionId: this.sessionId },
        );
      }
      this.currentModeId = desired;
      return;
    }
    if (candidates.length) {
      await this.transport.request("session/set_mode", {
        sessionId: this.sessionId,
        modeId: desired,
      }, { timeoutMs: this.adapter.startupTimeoutMs });
      // session/set_mode has no response payload; no applied state is claimed.
      this.currentModeId = desired;
    }
  }

  reportProgress(event) {
    const onProgress = this.adapter.activeProgress;
    if (!onProgress) return undefined;
    try {
      const pending = onProgress(event);
      if (pending && typeof pending.then === "function") {
        return Promise.resolve(pending).catch((cause) => {
          throw adapterError(`Cursor progress callback failed: ${boundedProviderText(errorMessage(cause))}`, "transport", { phase: "progress", cause });
        });
      }
      return undefined;
    } catch (cause) {
      throw adapterError(`Cursor progress callback failed: ${boundedProviderText(errorMessage(cause))}`, "transport", { phase: "progress", cause });
    }
  }

  onNotification(method, params) {
    if (method === "session/update") return this.onSessionUpdate(params);
    if (method === "cursor/create_plan") {
      this.eventSummary.add("cursor/create_plan");
      this.permissionEvents.push({ type: "plan", text: boundedProviderText(params?.plan ?? "") });
      return this.reportProgress({ type: "cursor_plan", text: redactSecrets(String(params?.plan ?? "")).slice(0, MAX_PROGRESS_TEXT_CHARS), sessionId: this.sessionId, workflowRunId: this.adapter.workflowRunId });
    }
    if (method === "cursor/update_todos") {
      this.eventSummary.add("cursor/update_todos");
      const todos = Array.isArray(params?.todos) ? params.todos : [];
      const step = todos.find((todo) => isObject(todo) && todo.status === "in_progress") ?? todos.find((todo) => isObject(todo));
      return this.reportProgress({ type: "cursor_tasklist", tasklist: todos.slice(0, 100), text: boundedProviderText(step?.content ?? step?.title ?? ""), sessionId: this.sessionId, workflowRunId: this.adapter.workflowRunId });
    }
    if (method === "elicitation/complete") return undefined;
    // Unknown notifications are not protocol errors; they are unmodeled.
    this.eventSummary.add(method);
    return undefined;
  }

  onSessionUpdate(params) {
    const update = isObject(params?.update) ? params.update : null;
    if (!update) return undefined;
    // Late events after a prompt settled (or before it starts) are recorded as
    // unmodeled noise but never folded into a turn's output.
    const active = this.activePrompt;
    if (!active || active.responseReceived) return undefined;
    if (this.sessionId && typeof params.sessionId === "string" && params.sessionId !== this.sessionId) return undefined;
    const kind = typeof update.sessionUpdate === "string" ? update.sessionUpdate : "unknown";
    this.eventSummary.add(kind);
    if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
      const text = contentText(update.content);
      if (!text) return undefined;
      if (kind === "agent_message_chunk" && !this.finalOverflow) {
        this.finalOverflow = this.finalText.length + text.length > MAX_FINAL_CHARS;
        if (!this.finalOverflow) this.finalText += text;
      }
      const type = kind === "agent_message_chunk" ? "cursor_delta" : "cursor_thought";
      const messageId = typeof update.messageId === "string" ? update.messageId : null;
      return this.#appendText(active, type, messageId, text);
    }
    if (kind === "tool_call" || kind === "tool_call_update") {
      return this.reportProgress({ type: "cursor_tool", toolCallId: update.toolCallId ?? null, toolKind: update.kind ?? null, status: update.status ?? null, text: boundedProviderText(update.title ?? update.name ?? ""), sessionId: this.sessionId, workflowRunId: this.adapter.workflowRunId });
    }
    if (kind === "plan") {
      return this.reportProgress({ type: "cursor_plan", text: boundedProviderText((Array.isArray(update.entries) ? update.entries : []).map((entry) => entry?.content).filter(Boolean).join("; ")), sessionId: this.sessionId, workflowRunId: this.adapter.workflowRunId });
    }
    if (kind === "current_mode_update") {
      if (typeof update.currentModeId === "string") this.currentModeId = update.currentModeId;
      return undefined;
    }
    if (kind === "config_option_update") {
      if (Array.isArray(update.configOptions)) this.configOptions = update.configOptions;
      const modelOption = findModelConfigOption(this.configOptions);
      if (modelOption && typeof modelOption.currentValue === "string") this.model = modelOption.currentValue;
      return undefined;
    }
    if (kind === "usage_update") {
      this.usage = mergeUsage(this.usage, usageFromSessionUpdate(update));
      return this.reportProgress({ type: "cursor_usage", usage: this.usage, sessionId: this.sessionId, workflowRunId: this.adapter.workflowRunId });
    }
    return undefined;
  }

  #appendText(active, type, messageId, text) {
    const previous = active.textBlock;
    let pending;
    // ACP chunks may omit message IDs. A text-kind change also ends the block.
    if (previous && (previous.type !== type || (previous.messageId && messageId && previous.messageId !== messageId))) {
      pending = this.#flushText(active);
    }
    const block = active.textBlock ??= { type, messageId, text: "" };
    block.messageId ||= messageId;
    if (block.text !== null) {
      block.text = block.text.length + text.length <= MAX_FINAL_CHARS ? block.text + text : null;
    }
    return pending;
  }

  #flushText(active) {
    const block = active.textBlock;
    active.textBlock = null;
    if (!block?.text) return undefined;
    return this.reportProgress({
      type: block.type,
      text: redactSecrets(block.text).slice(0, MAX_PROGRESS_TEXT_CHARS),
      sessionId: this.sessionId,
      workflowRunId: this.adapter.workflowRunId,
      ...(block.type === "cursor_delta" ? { usage: this.usage } : {}),
    });
  }

  onAgentRequest(method, params) {
    if (method === "session/request_permission") return this.onPermissionRequest(params);
    if (method === "fs/read_text_file") {
      // Client capabilities are not advertised; never perform host IO.
      return Promise.reject(adapterError("fs/read_text_file is not available: this client did not advertise fs.readTextFile", "unsupported-control", { rpcCode: -32601 }));
    }
    if (method === "fs/write_text_file") {
      return Promise.reject(adapterError("fs/write_text_file is not available: this client did not advertise fs.writeTextFile", "unsupported-control", { rpcCode: -32601, denied: true }));
    }
    if (method.startsWith("terminal/")) {
      return Promise.reject(adapterError(`${method} is not available: this client did not advertise terminal support`, "unsupported-control", { rpcCode: -32601, denied: true }));
    }
    return Promise.reject(adapterError(`unsupported ACP request: ${method}`, "unsupported-control", { rpcCode: -32601 }));
  }

  onPermissionRequest(params) {
    const toolCall = isObject(params?.toolCall) ? params.toolCall : {};
    const options = Array.isArray(params?.options) ? params.options : [];
    const decision = permissionDecision({
      policyWrite: this.policyWrite,
      toolKind: toolCall.kind,
      options,
      cancelled: this.cancelRequested,
    });
    if (!decision.enforced && decision.decision === "cancelled") {
      // We could not select a rejecting/permitting option. Fail closed by
      // cancelling the turn and recording that the boundary was not provable.
      this.policyUnenforced = true;
      if (this.activePrompt) this.cancelRequested = true;
      void this.transport.notify("session/cancel", { sessionId: this.sessionId });
    }
    this.permissionEvents.push({
      toolCallId: toolCall.toolCallId ?? null,
      toolKind: toolCall.kind ?? null,
      decision: decision.decision,
      enforced: decision.enforced,
    });
    const progress = this.reportProgress({
      type: "cursor_permission",
      toolCallId: toolCall.toolCallId ?? null,
      toolKind: toolCall.kind ?? null,
      decision: decision.decision,
      enforced: decision.enforced,
      text: boundedProviderText(permissionToolLabel(toolCall)),
      sessionId: this.sessionId,
      workflowRunId: this.adapter.workflowRunId,
    });
    if (progress && typeof progress.then === "function") {
      return progress.then(() => ({ outcome: decision.outcome }));
    }
    return { outcome: decision.outcome };
  }

  settlePrompt({ stopReason = null, error = null } = {}) {
    if (!this.activePrompt) return;
    const active = this.activePrompt;
    this.activePrompt = null;
    this.busy = false;
    this.cancelRequested = false;
    active.stopReason = stopReason;
    active.error = error;
    active.settled();
  }

  async sendPrompt(request, { signal, timeoutMs }) {
    if (this.busy || this.activePrompt) {
      throw adapterError("Cursor ACP session is already running a prompt; one owner per session", "busy", { sessionId: this.sessionId });
    }
    this.busy = true;
    this.finalText = "";
    this.finalOverflow = false;
    this.policyUnenforced = false;
    this.cancelRequested = false;
    this.permissionEvents = [];
    this.eventSummary = new EventSummary();
    let settledResolve;
    const settledPromise = new Promise((resolve) => { settledResolve = resolve; });
    const active = { settled: settledResolve, settledPromise, stopReason: null, error: null, responseReceived: false, textBlock: null };
    this.activePrompt = active;
    try {
      const response = await this.transport.request("session/prompt", {
        sessionId: this.sessionId,
        prompt: [{ type: "text", text: promptText(request) }],
      }, { timeoutMs, signal });
      active.responseReceived = true;
      const stopReason = typeof response?.stopReason === "string" ? response.stopReason : null;
      if (stopReason !== "cancelled") {
        const pending = this.#flushText(active);
        if (pending) {
          await Promise.race([pending, aborted(signal, active)]);
          signal.throwIfAborted();
        }
      }
      this.settlePrompt({ stopReason });
      return response;
    } catch (error) {
      this.settlePrompt({ error });
      throw error;
    }
  }

  async cancel() {
    if (!this.sessionId) throw adapterError("Cursor ACP session is not started", "not-ready");
    const active = this.activePrompt;
    this.cancelRequested = true;
    await this.transport.notify("session/cancel", { sessionId: this.sessionId });
    if (!active) return { stopReason: null, settled: true };
    const timeoutMs = this.adapter.cancelTimeoutMs;
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ settled: false }), timeoutMs); });
    try {
      return await Promise.race([
        active.settledPromise.then(() => ({ settled: true, stopReason: active.stopReason, error: active.error })),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

export class CursorSessionAdapter {
  constructor(options = {}) {
    const injected = options.launch || options.command || options.executable || options.bin;
    this.launch = harnessLaunch("cursor", injected);
    this.spawnFn = options.spawnFn || spawnNativeCommand;
    this.env = options.env || {};
    this.createTransport = typeof options.createTransport === "function" ? options.createTransport : null;
    this.startupTimeoutMs = options.startupTimeoutMs || DEFAULT_STARTUP_TIMEOUT_MS;
    this.sessionLoadTimeoutMs = options.sessionLoadTimeoutMs || DEFAULT_SESSION_LOAD_TIMEOUT_MS;
    this.cancelTimeoutMs = options.cancelTimeoutMs || DEFAULT_CANCEL_TIMEOUT_MS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.maxLineBytes = options.maxLineBytes || MAX_LINE_BYTES;
    this.maxStderrBytes = options.maxStderrBytes || MAX_STDERR_BYTES;
    this.session = null;
    this.activeProgress = null;
    this.capabilities = null;
    this.transports = new Set();
  }

  get capabilitiesSnapshot() {
    return this.session?.capabilities ?? this.capabilities;
  }

  #transportConfig(request, signal) {
    return {
      command: this.launch.command,
      args: [...(Array.isArray(this.launch.args) ? this.launch.args : []), "acp"],
      cwd: request.cwd,
      // Read-only changes what the run may write, never whether the agent can
      // authenticate: the parent environment is inherited and merged.
      env: mergeProcessEnv({ ...(this.launch.env || {}), ...this.env }),
      spawnFn: this.spawnFn,
      signal,
      maxLineBytes: this.maxLineBytes,
      maxStderrBytes: this.maxStderrBytes,
    };
  }

  #buildTransport(request, signal) {
    const config = this.#transportConfig(request, signal);
    const transport = this.createTransport
      ? this.createTransport({ ...config, AcpTransport })
      : new AcpTransport(config);
    if (!transport || typeof transport.request !== "function" || typeof transport.close !== "function") {
      throw adapterError("Cursor ACP transport factory returned an invalid transport", "transport");
    }
    this.transports.add(transport);
    return transport;
  }

  async #openSession(request, signal) {
    const transport = this.#buildTransport(request, signal);
    try {
      await transport.start();
      this.capabilities = null;
      const initializeResult = await transport.request("initialize", {
        protocolVersion: CURSOR_SESSION_PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "harnest", title: "Harnest", version: "0.1.0" },
      }, { timeoutMs: this.startupTimeoutMs, signal });
      const capabilities = negotiateCapabilities(initializeResult);
      this.capabilities = capabilities;
      if (capabilities.protocolVersion !== CURSOR_SESSION_PROTOCOL_VERSION) {
        throw adapterError(`Cursor ACP negotiated unsupported protocol version ${capabilities.protocolVersion}`, "transport", {
          protocolVersion: capabilities.protocolVersion,
        });
      }

      const session = new AcpSession({
        adapter: this,
        transport,
        request,
        capabilities,
        cwd: request.cwd,
        identity: {
          cwd: request.cwd,
          policyWrite: policyWrites(request.policy),
          provider: modelSelection(request.route || {}).provider,
          model: modelSelection(request.route || {}).model,
        },
      });
      transport.setHandlers({
        onNotification: (params, message) => session.onNotification(message.method, params),
        onRequest: (params, message) => session.onAgentRequest(message.method, params),
      });

      const resumeId = typeof request.execution?.sessionId === "string" && request.execution.sessionId.trim()
        ? request.execution.sessionId.trim()
        : null;
      const setup = () => {
        if (!resumeId) {
          return transport.request("session/new", { cwd: request.cwd, mcpServers: [] }, { timeoutMs: this.sessionLoadTimeoutMs, signal });
        }
        if (capabilities.resume) {
          return transport.request("session/resume", { sessionId: resumeId, cwd: request.cwd, mcpServers: [] }, { timeoutMs: this.sessionLoadTimeoutMs, signal });
        }
        if (capabilities.loadSession) {
          return transport.request("session/load", { sessionId: resumeId, cwd: request.cwd, mcpServers: [] }, { timeoutMs: this.sessionLoadTimeoutMs, signal });
        }
        throw adapterError(
          `Cursor ACP agent did not advertise session/resume or loadSession; refusing to silently start a new session for "${resumeId}"`,
          "resume-unsupported",
          { sessionId: resumeId, resumeAdvertised: false, loadAdvertised: false },
        );
      };

      let setupResult;
      try {
        setupResult = await setup();
      } catch (error) {
        const code = Number.isFinite(Number(error?.code)) ? Number(error.code) : null;
        if (code === -32000 && capabilities.authMethods.length > 0) {
          const method = pickAuthMethod(capabilities.authMethods);
          if (!method) {
            throw adapterError(
              "Cursor ACP requires terminal authentication, which this non-interactive client does not advertise",
              "provider-auth",
              { category: "auth", provider: "cursor", authMethods: capabilities.authMethods },
            );
          }
          await transport.request("authenticate", { methodId: method.id }, { timeoutMs: this.startupTimeoutMs, signal });
          setupResult = await setup();
        } else {
          throw error;
        }
      }

      session.sessionId = resumeId || (typeof setupResult?.sessionId === "string" && setupResult.sessionId.trim() ? setupResult.sessionId.trim() : null);
      if (!session.sessionId) {
        throw adapterError("Cursor ACP did not return a session id", "transport");
      }
      session.applySessionSetup(setupResult);
      await session.applyModelSelection(request);
      await session.applyModeSelection(policyWrites(request.policy));
      this.session = session;
      return session;
    } catch (error) {
      this.transports.delete(transport);
      await Promise.resolve(transport.close()).catch(() => undefined);
      throw error;
    }
  }

  #sessionMatches(request) {
    const session = this.session;
    if (!session || session.closed) return false;
    const resumeId = typeof request.execution?.sessionId === "string" && request.execution.sessionId.trim()
      ? request.execution.sessionId.trim()
      : null;
    if (!resumeId || resumeId !== session.sessionId) return false;
    const identity = session.identity;
    const selection = modelSelection(request.route || {});
    return identity.cwd === request.cwd
      && identity.policyWrite === policyWrites(request.policy)
      && (identity.model ?? null) === (selection.model ?? null)
      && (identity.provider ?? null) === (selection.provider ?? null);
  }

  async #acquireSession(request, signal) {
    if (this.session && !this.session.closed) {
      if (this.session.busy || this.session.activePrompt) {
        throw adapterError("Cursor ACP session is already running a prompt", "busy", { sessionId: this.session.sessionId });
      }
      if (this.#sessionMatches(request)) {
        this.session.clearIdle();
        return this.session;
      }
      await this.close();
    }
    return this.#openSession(request, signal);
  }

  async run(request, { signal, onProgress } = {}) {
    request = validateAdapterExecution(request, "cursor", "session");
    if (!request || typeof request !== "object") throw new TypeError("request must be an object");
    assertNoGraph(request.workflow);
    assertNoClaudeRoute("cursor", request.route);
    assertThinkingUnsupported(request.route);
    assertSessionPolicySupported(request.policy || {});

    const execution = executionSignal(signal, request.execution?.timeoutMs);
    this.activeProgress = onProgress ?? null;
    this.workflowRunId = `cursor:${request.requestId}`;
    let session = null;
    try {
      if (execution.signal.aborted) {
        throw execution.timedOut
          ? adapterError("Cursor ACP execution timed out", "timeout", { timedOut: true, aborted: false })
          : adapterError("Cursor ACP execution aborted", "abort", { aborted: true, timedOut: false });
      }
      session = await this.#acquireSession(request, execution.signal);
      session.adapter = this;
      session.workflowRunId = this.workflowRunId;
      session.policyWrite = policyWrites(request.policy);
      const response = await session.sendPrompt(request, {
        signal: execution.signal,
        timeoutMs: request.execution?.timeoutMs || DEFAULT_TIMEOUT_MS,
      });
      if (session.policyUnenforced) {
        throw adapterError(
          "Cursor ACP could not prove read-only enforcement: the agent offered no reject option for a mutating tool",
          "policy",
          { sessionId: session.sessionId, permissions: session.permissionEvents },
        );
      }
      const stopReason = typeof response?.stopReason === "string" ? response.stopReason : null;
      if (stopReason === "cancelled") {
        throw adapterError("Cursor ACP prompt was cancelled", "abort", { aborted: true, stopReason });
      }
      if (requiresMutatingTurn(stopReason)) {
        throw adapterError(`Cursor ACP turn ended early (stopReason=${stopReason})`, "downstream", { stopReason });
      }
      if (session.finalOverflow) {
        throw adapterError("Cursor ACP final output exceeds the result limit", "output-limit", { maxChars: MAX_FINAL_CHARS });
      }
      const finalText = session.finalText.trim();
      if (!finalText) {
        throw adapterError("Cursor ACP completed without final output", "downstream", {
          stopReason,
          sessionId: session.sessionId,
          stderr: boundedProviderText(session.transport.stderrText) || null,
        });
      }
      const selection = modelSelection(request.route || {});
      const result = {
        sessionId: session.sessionId,
        workflowRunId: this.workflowRunId,
        route: {
          harness: "cursor",
          transport: "acp",
          provider: selection.provider || "cursor",
          model: session.model || selection.base || "default",
          variant: null,
          thinking: null,
          requested: request.route || {},
        },
        capabilities: session.capabilities,
        result: structuredResult(redactSecrets(finalText), { eventSummary: session.eventSummary.snapshot() }),
        usage: session.usage,
        usageSummary: summarizeUsage("cursor", session.usage),
      };
      session.markIdle();
      return result;
    } catch (error) {
      if (session) {
        if (session.policyUnenforced || error?.details?.kind === "policy" || error?.details?.kind === "transport"
          || error?.details?.kind === "timeout" || error?.details?.kind === "abort" || error?.details?.kind === "output-limit") {
          await this.close();
        } else {
          session.markIdle();
        }
      }
      throw protocolFailure(error, execution);
    } finally {
      execution.dispose();
      this.activeProgress = null;
    }
  }

  async control(command = {}, signal) {
    const session = this.session;
    if (!session || session.closed) {
      throw adapterError("Cursor ACP session is not active", "not-ready", { hint: "controls require a live session; start a run first" });
    }
    const kind = command.kind;
    if (kind === "cancel" || kind === "stop") {
      const outcome = await session.cancel();
      if (!outcome.settled) {
        // The agent did not confirm cancellation within the timeout. Retire
        // our connection so the abandoned turn cannot run unbounded, and report
        // uncertainty instead of claiming the turn stopped.
        await this.close();
        throw adapterError("Cursor ACP cancellation was not acknowledged before the timeout", "cancel-unacknowledged", {
          sessionId: session.sessionId, uncertain: true, timeoutMs: this.cancelTimeoutMs,
        });
      }
      if (outcome.error && outcome.error?.details?.kind !== "abort") throw protocolFailure(outcome.error, {});
      return { harness: "cursor", command: "session/cancel", delivery: "native", settled: true, stopReason: outcome.stopReason ?? null };
    }
    if (kind === "reroute") {
      const route = isObject(command.route) ? command.route : {};
      const selection = modelSelection(route);
      if (!selection.model) throw adapterError("Cursor ACP reroute requires route.model", "control", { commandId: command.commandId });
      const option = findModelConfigOption(session.configOptions);
      if (!option) {
        throw adapterError("Cursor ACP agent advertised no model selector; live reroute is unsupported", "unsupported-control", {
          commandId: command.commandId, sessionId: session.sessionId,
        });
      }
      const resolved = resolveConfigOptionValue(option, selection.base);
      if (!resolved.matched) {
        throw adapterError(`Cursor ACP agent did not advertise the requested model "${selection.model}"`, "control", {
          commandId: command.commandId, model: selection.model,
        });
      }
      if (typeof option.currentValue === "string" && option.currentValue === resolved.value) {
        return { harness: "cursor", command: "set_config_option", delivery: null, model: resolved.value, effect: "next_model_request", alreadyActive: true };
      }
      const response = await session.transport.request("session/set_config_option", {
        sessionId: session.sessionId,
        configId: option.id,
        value: resolved.value,
      }, { timeoutMs: this.startupTimeoutMs, signal });
      session.applySessionSetup(response);
      session.model = findModelConfigOption(session.configOptions)?.currentValue ?? resolved.value;
      return { harness: "cursor", command: "set_config_option", delivery: null, model: resolved.value, effect: "next_model_request" };
    }
    if (kind === "message") {
      throw adapterError(
        "Cursor ACP has no documented mid-turn steering or queued follow-up acknowledgement; resume the session with a new request instead",
        "unsupported-control",
        { commandId: command.commandId, delivery: command.delivery ?? "steer" },
      );
    }
    throw adapterError(`unsupported Cursor ACP control kind: ${kind}`, "unsupported-control", { commandId: command.commandId });
  }

  // Idempotent cleanup. Closes the owned ACP session/child only; never the
  // parent host process.
  async close() {
    const session = this.session;
    this.session = null;
    if (session) this.transports.delete(session.transport);
    if (session && !session.closed) {
      try { await session.close(); } catch { /* Cleanup is best-effort. */ }
    }
    for (const transport of [...this.transports]) {
      this.transports.delete(transport);
      try { await transport.close(); } catch { /* Cleanup is best-effort. */ }
    }
  }
}

export default CursorSessionAdapter;
