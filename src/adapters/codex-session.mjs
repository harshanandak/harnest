// Codex interactive session adapter: one owner per `codex app-server` process
// speaking newline-delimited JSON-RPC over stdio. Protocol shapes are pinned to
// T3 Code origin/main 7a326c24 (`apps/server/src/provider/Layers/CodexSessionRuntime.ts`
// and `packages/effect-codex-app-server/src/_generated/schema.gen.ts`):
// initialize/initialized, thread/start|thread/resume, turn/start|turn/steer|
// turn/interrupt, and the thread/turn/item/tokenUsage/error notifications.
//
// Deliberately dependency-free: no Effect runtime, no app-server package. The
// transport below is a bounded request map plus an incremental line framer so a
// wedged peer cannot grow memory without limit.

import { validateAdapterExecution } from "../execution-controls.mjs";
import { NativeLaunchError, spawnNativeCommand } from "../launch-command.mjs";
import { resolve as resolvePath } from "node:path";

import { harnessLaunch } from "../config.mjs";
import { assertNoClaudeRoute } from "../model-policy.mjs";
import { routeControlError } from "../protocol.mjs";
import { assertPromptOnlyWorkflow } from "../one-shot-policy.mjs";
import { digestContext, hasToolPolicy } from "../protocol.mjs";
import {
  boundedProviderText,
  classifyProviderFailure,
  mergeProcessEnv,
  providerErrorFromEvent,
  redactSecrets,
  terminateProcessTree,
} from "../process.mjs";
import { structuredResult } from "../result.mjs";
import { summarizeUsage } from "../usage.mjs";

const PROVIDER = "openai/codex";
const CLIENT_NAME = "harnest";
const CLIENT_TITLE = "Harnest";
const CLIENT_VERSION = "0.1.1";

const DEFAULT_RPC_TIMEOUT_MS = 30_000;
const DEFAULT_IDLE_CLOSE_MS = 300_000;
const DEFAULT_MAX_LINE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_QUEUED_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_QUEUED_FRAMES = 256;
const DEFAULT_MAX_PENDING_REQUESTS = 256;
const DEFAULT_MAX_FOLLOW_UPS = 16;
const DEFAULT_MAX_FOLLOW_UP_BYTES = 256 * 1024;
const MAX_EVENT_TYPES = 256;
const EVENT_TYPES_REPORTED = 20;
const MAX_DELTA_CHARS = 256 * 1024;
const MAX_PROGRESS_TEXT = 2_000;
const MAX_STDERR_BYTES = 64 * 1024;
const CLOSE_GRACE_MS = 2_000;
const INTERRUPT_GRACE_MS = 5_000;

const MODEL_PATTERN = /^[a-zA-Z0-9._/[\]=,+-]+$/;
const EFFORT_PATTERN = /^[a-z0-9_-]+$/i;

export const CODEX_SESSION_SUPPORTED_POLICY_HELP = "codex app-server maps read-only policy to sandbox readOnly and write policy to workspaceWrite over the canonical cwd. dangerFullAccess and approval bypasses are never used. Granular policy.tools and policy.maxCostUsd have no app-server equivalent and are rejected before the process starts.";

/**
 * Truthful capability descriptor for the lead's transport/capability map.
 * `reroute` deliberately carries the "next-turn-with-message" form: app-server
 * exposes no model-only switch for an already-running turn.
 */
export const SESSION_CAPABILITIES = Object.freeze({
  harness: "codex",
  transport: "session",
  protocol: "codex-app-server",
  resume: true,
  interrupt: true,
  steer: true,
  followUp: "local-bounded",
  followUpQueue: "drained-after-turn",
  nativeFollowUp: false,
  reroute: "next-turn-with-message",
  modelChange: "next-turn",
  sandboxPolicies: Object.freeze(["read-only", "workspace-write"]),
  oneShotFallback: false,
});

function sessionError(message, kind, details = {}) {
  const error = new Error(message);
  error.name = "CodexSessionAdapterError";
  error.details = { kind, ...details };
  return error;
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
  }, Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 3_600_000);
  return {
    signal: controller.signal,
    state: {
      get timedOut() { return timedOut; },
      get aborted() { return controller.signal.aborted; },
    },
    dispose() {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", abort);
    },
  };
}

function isPolicySupported(policy = {}) {
  if (hasToolPolicy(policy.tools)) {
    return { supported: false, reason: "policy.tools granular filtering has no codex app-server request equivalent" };
  }
  if (policy.maxCostUsd != null) {
    return { supported: false, reason: "policy.maxCostUsd budget enforcement has no codex app-server request equivalent" };
  }
  return { supported: true };
}

function resolveModel(route = {}) {
  const model = typeof route.model === "string" && route.model.trim() ? route.model.trim() : null;
  if (model && !MODEL_PATTERN.test(model)) {
    throw sessionError("Codex route model contains unsupported characters", "policy", { model });
  }
  return model;
}

// Codex matches ReasoningEffort case-sensitively (lowercase only); normalize
// once and echo the same value in the receipt route, as the one-shot adapter does.
function resolveEffort(route = {}) {
  const thinking = typeof route?.thinking === "string" && route.thinking.trim()
    ? route.thinking.trim().toLowerCase()
    : null;
  if (thinking && !EFFORT_PATTERN.test(thinking)) {
    throw sessionError("Codex route thinking contains unsupported characters", "policy", { thinking });
  }
  return thinking;
}

function policyDescriptor(policy = {}, cwd) {
  const write = policy.write === true;
  return {
    write,
    key: write ? "workspace-write" : "read-only",
    // Thread-level SandboxMode and turn-level SandboxPolicy are distinct
    // generated schemas; both use the exact wire literals, never dangerFullAccess.
    sandbox: write ? "workspace-write" : "read-only",
    sandboxPolicy: write
      ? { type: "workspaceWrite", writableRoots: [cwd] }
      : { type: "readOnly" },
  };
}

function routeKeyOf(route = {}, model, effort) {
  return JSON.stringify({
    provider: typeof route.provider === "string" ? route.provider : null,
    model: model ?? null,
    effort: effort ?? null,
    serverUrl: typeof route.serverUrl === "string" ? route.serverUrl : null,
    harnessVersion: typeof route.harnessVersion === "string" ? route.harnessVersion : null,
  });
}

// Field order is a prompt-cache contract shared with the one-shot adapter:
// stable context first, then the variable task, requestId and route. Identifiers
// that change per attempt must not lead the prefix.
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
  const intro = "Execute the complete assigned workflow. Preserve the request and context identifiers exactly. Return the final answer for this phase.";
  return `${intro}\n\n${envelope}`;
}

function boundedProgressText(value, maxChars = MAX_PROGRESS_TEXT) {
  const text = redactSecrets(value);
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

/** Retains at most MAX_EVENT_TYPES unique method names in first-occurrence order. */
class EventSummary {
  constructor() {
    this.count = 0;
    this.types = [];
    this.truncated = false;
  }

  record(type) {
    this.count += 1;
    if (typeof type !== "string" || !type || this.types.includes(type)) return;
    if (this.types.length >= MAX_EVENT_TYPES) {
      this.truncated = true;
      return;
    }
    this.types.push(type);
  }

  snapshot() {
    return {
      count: this.count,
      types: this.types.slice(-EVENT_TYPES_REPORTED),
      typesTruncated: this.truncated,
    };
  }
}

/** Bounded stderr tail; only diagnostic, never a completion source. */
class TailBuffer {
  constructor(limit) {
    this.limit = limit;
    this.chunks = [];
    this.bytes = 0;
  }

  append(chunk) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    this.chunks.push(buffer);
    this.bytes += buffer.length;
    while (this.bytes > this.limit && this.chunks.length > 1) {
      this.bytes -= this.chunks.shift().length;
    }
    if (this.bytes > this.limit) {
      const trimmed = this.chunks[0].subarray(this.chunks[0].length - this.limit);
      this.chunks[0] = trimmed;
      this.bytes = trimmed.length;
    }
  }

  text() {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

/**
 * Incremental newline framer. A single frame larger than maxLineBytes fails
 * with kind output-limit instead of buffering without bound.
 */
class LineFramer {
  constructor({ maxLineBytes, onLine, onOverflow }) {
    this.maxLineBytes = maxLineBytes;
    this.onLine = onLine;
    this.onOverflow = onOverflow;
    this.parts = [];
    this.bytes = 0;
  }

  push(chunk) {
    const start = 0;
    let offset = start;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      const size = end - offset;
      if (this.bytes + size > this.maxLineBytes) {
        this.onOverflow();
        return;
      }
      this.parts.push(chunk.subarray(offset, end));
      this.bytes += size;
      if (newline < 0) return;
      const line = Buffer.concat(this.parts).toString("utf8").replace(/\r$/, "");
      this.parts = [];
      this.bytes = 0;
      this.onLine(line);
      offset = newline + 1;
    }
  }

  flush() {
    if (!this.bytes) return;
    const line = Buffer.concat(this.parts).toString("utf8").replace(/\r$/, "");
    this.parts = [];
    this.bytes = 0;
    this.onLine(line);
  }
}

function codexErrorInfoName(info) {
  if (!info) return null;
  if (typeof info === "string") return info;
  if (typeof info === "object") return Object.keys(info)[0] ?? null;
  return null;
}

function statusFromCodexErrorInfo(info) {
  if (!info || typeof info !== "object") return null;
  for (const value of Object.values(info)) {
    const status = Number(value?.httpStatusCode);
    if (Number.isFinite(status)) return status;
  }
  return null;
}

function providerFailureDetails(kind, category, message, status, info) {
  return {
    kind,
    category,
    provider: PROVIDER,
    status: status ?? null,
    providerError: { type: codexErrorInfoName(info), message, status: status ?? null },
    codexErrorInfo: codexErrorInfoName(info),
    hint: kind === "unavailable"
      ? "codex reported the requested model as unavailable; verify route.model against the models this account can access"
      : category === "region"
        ? "the OpenAI provider rejected this run for a regional or opt-in restriction; enable the provider for this region or reroute"
        : category === "billing"
          ? "the OpenAI account reported an exhausted balance or a usage limit; top up or wait for the limit to reset, then retry"
          : "codex has no usable OpenAI credential; run `codex login` — Harnest never reads, stores, or forwards provider secrets",
  };
}

function providerFailureFromTurnError(error) {
  if (!error || typeof error !== "object") return null;
  const message = boundedProviderText(error.message || error.additionalDetails || "Codex reported an error");
  const info = error.codexErrorInfo ?? null;
  const name = codexErrorInfoName(info);
  const status = statusFromCodexErrorInfo(info);
  if (name === "unauthorized") {
    return sessionError(
      `Codex provider authorization failure for ${PROVIDER}${status ? ` (HTTP ${status})` : ""}: ${message}`,
      "provider-auth",
      providerFailureDetails("provider-auth", "auth", message, status ?? 401, info),
    );
  }
  if (name === "usageLimitExceeded" || name === "sessionBudgetExceeded") {
    return sessionError(
      `Codex provider usage limit for ${PROVIDER}: ${message}`,
      "provider-auth",
      providerFailureDetails("provider-auth", "billing", message, status, info),
    );
  }
  const classification = classifyProviderFailure({ message, status });
  if (classification) {
    const label = classification.kind === "provider-auth" ? "provider authorization" : "model availability";
    return sessionError(
      `Codex ${label} failure for ${PROVIDER}${status !== null ? ` (HTTP ${status})` : ""}: ${message}`,
      classification.kind,
      providerFailureDetails(classification.kind, classification.category, message, status, info),
    );
  }
  if (name) {
    return sessionError(`Codex turn failed: ${message}`, "downstream", providerFailureDetails("downstream", null, message, status, info));
  }
  return null;
}

function providerFailureFromNotification(params = {}) {
  const failure = providerFailureFromTurnError(params.error);
  if (failure) return failure;
  const fallback = providerErrorFromEvent(params);
  if (!fallback) return null;
  const classification = classifyProviderFailure(fallback);
  if (!classification) return null;
  return sessionError(
    `Codex provider failure for ${PROVIDER}: ${fallback.message || "request failed"}`,
    classification.kind,
    providerFailureDetails(classification.kind, classification.category, fallback.message, fallback.status, null),
  );
}

function providerFailureFromStderr(stderr) {
  const text = String(stderr || "");
  const lines = text.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line) continue;
    const statusMatch = /\b(?:http(?:\s+status)?|status(?:\s+code)?)[\s:=]*(401|402|403|404|429)\b/i.exec(line)
      || /\b(401|402|403)\b/.exec(line);
    const status = statusMatch ? Number(statusMatch[1]) : null;
    const classification = classifyProviderFailure({ message: line, status });
    if (!classification) continue;
    const message = boundedProviderText(line);
    return sessionError(
      `Codex ${classification.kind === "provider-auth" ? "provider authorization" : "model availability"} failure for ${PROVIDER}${status !== null ? ` (HTTP ${status})` : ""}: ${message}`,
      classification.kind,
      providerFailureDetails(classification.kind, classification.category, message, status, null),
    );
  }
  return null;
}

function usageFromBreakdown(breakdown) {
  if (!breakdown || typeof breakdown !== "object") return null;
  const usage = {};
  const assign = (key, value) => {
    if (Number.isFinite(value) && value >= 0) usage[key] = value;
  };
  assign("input_tokens", breakdown.inputTokens);
  assign("cached_input_tokens", breakdown.cachedInputTokens);
  assign("output_tokens", breakdown.outputTokens);
  assign("reasoning_output_tokens", breakdown.reasoningOutputTokens);
  assign("total_tokens", breakdown.totalTokens);
  assign("cache_write_tokens", breakdown.cacheWriteInputTokens);
  return Object.keys(usage).length ? usage : null;
}

/**
 * Sum per-turn Codex usage. Each turn reports its own `last` breakdown, so
 * summing turns is accurate; thread-cumulative `total` values are never used.
 */
function addUsageTotals(base, addition) {
  if (!addition || typeof addition !== "object") return base ?? null;
  const totals = { ...(base || {}) };
  for (const [key, value] of Object.entries(addition)) {
    if (Number.isFinite(value)) totals[key] = (totals[key] || 0) + value;
  }
  return Object.keys(totals).length ? totals : null;
}

function finalAgentMessageText(items) {
  if (!Array.isArray(items)) return null;
  let text = null;
  for (const item of items) {
    if (item && item.type === "agentMessage" && typeof item.text === "string" && item.text.trim()) {
      text = item.text;
    }
  }
  return text;
}

/**
 * One live `codex app-server` process with one owner. Turn lifecycle:
 * turn/start -> turn/started -> item/agentMessage/delta + item/completed ->
 * turn/completed. Cancel uses turn/interrupt, then bounded child cleanup of
 * only this process.
 */
class CodexAppServerSession {
  #adapter;
  #framing;
  #stderr;
  #idleTimer = null;
  #closePromise = null;
  #turnAbortListener = null;
  #pendingProgress = new Set();

  constructor({ adapter, cwd, policy, model, effort, routeKey }) {
    this.#adapter = adapter;
    this.cwd = cwd;
    this.policy = policy;
    this.model = model;
    this.effort = effort;
    this.routeKey = routeKey;
    this.child = null;
    this.threadId = null;
    this.threadSessionId = null;
    this.resolvedModel = null;
    this.status = "starting";
    this.closed = false;
    this.failure = null;
    this.exit = null;
    this.activeTurnId = null;
    this.turns = new Map();
    this.orphanTurns = new Map();
    this.pending = new Map();
    this.notifications = [];
    this.queuedBytes = 0;
    this.draining = false;
    this.nextId = 1;
    this.eventSummary = new EventSummary();
    this.progress = null;
    this.runActive = 0;
    // Locally queued follow-ups: accepted by control() with no native
    // acknowledgement, dispatched only after the active turn settles.
    this.followUps = [];
    this.followUpBytes = 0;
    this.followUpSeq = 0;
    this.runUsageTotals = null;
    this.#stderr = new TailBuffer(MAX_STDERR_BYTES);
    this.#framing = new LineFramer({
      maxLineBytes: adapter.maxLineBytes,
      onLine: (line) => this.#handleLine(line),
      onOverflow: () => this.#fail(sessionError("Codex app-server stdout frame exceeds maxLineBytes", "output-limit", {
        stream: "stdout", maxLineBytes: adapter.maxLineBytes,
      })),
    });
  }

  get busy() {
    return this.turns.size > 0;
  }

  canServe({ sessionId, cwd, policyKey, routeKey }) {
    return Boolean(
      !this.closed
      && !this.failure
      && this.status === "ready"
      && !this.busy
      && this.runActive === 0
      && sessionId
      && sessionId === this.threadId
      && cwd === this.cwd
      && policyKey === this.policy.key
      && routeKey === this.routeKey,
    );
  }

  async start({ requestedSessionId, signal }) {
    const adapter = this.#adapter;
    const args = [
      ...(Array.isArray(adapter.launch.args) ? adapter.launch.args : []),
      "app-server",
    ];
    // Explicit merge, never replacement: the app-server keeps native auth
    // (HOME/APPDATA/OPENAI_API_KEY resolved by codex itself). CLI overrides
    // merge over process.env; no credential value is read or logged here.
    const env = mergeProcessEnv({ ...(adapter.launch.env || {}), ...adapter.env });
    let child;
    try {
      child = adapter.spawnFn(adapter.launch.command, args, {
        cwd: this.cwd,
        env,
        windowsHide: true,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (cause) {
      if (cause instanceof NativeLaunchError) throw cause;
      throw sessionError(`Codex app-server failed to start: ${boundedProviderText(cause?.message || String(cause))}`, "transport", {
        cause,
        hint: "install the codex CLI and ensure it is on PATH, or set HARNEST_CODEX",
      });
    }
    this.child = child;
    this.#wireChild(child);
    try {
      await this.request("initialize", {
        clientInfo: { name: CLIENT_NAME, title: CLIENT_TITLE, version: CLIENT_VERSION },
        capabilities: { experimentalApi: false },
      }, { signal, timeoutMs: adapter.rpcTimeoutMs });
      this.notify("initialized");
      const params = requestedSessionId
        ? {
          threadId: requestedSessionId,
          cwd: this.cwd,
          sandbox: this.policy.sandbox,
          approvalPolicy: "never",
          ...(this.model ? { model: this.model } : {}),
        }
        : {
          cwd: this.cwd,
          sandbox: this.policy.sandbox,
          approvalPolicy: "never",
          ...(this.model ? { model: this.model } : {}),
        };
      // A requested native session is never replaced by a fresh thread: a
      // failed thread/resume throws instead of calling thread/start.
      const opened = await this.request(requestedSessionId ? "thread/resume" : "thread/start", params, {
        signal,
        timeoutMs: adapter.rpcTimeoutMs,
      });
      const thread = opened && typeof opened === "object" ? opened.thread : null;
      const threadId = typeof thread?.id === "string" ? thread.id : null;
      if (!threadId) {
        throw sessionError(`Codex ${requestedSessionId ? "thread/resume" : "thread/start"} did not return a thread id`, "transport", {
          phase: "thread-open",
        });
      }
      this.threadId = threadId;
      this.threadSessionId = typeof thread?.sessionId === "string" ? thread.sessionId : null;
      this.resolvedModel = typeof opened?.model === "string" && opened.model ? opened.model : this.model;
      this.status = "ready";
      this.#scheduleIdleClose();
    } catch (error) {
      await this.close();
      throw error;
    }
    return this;
  }

  #wireChild(child) {
    child.stdout?.on?.("data", (chunk) => {
      if (this.closed) return;
      try {
        this.#framing.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      } catch (cause) {
        this.#fail(sessionError(`Codex app-server stdout parse failed: ${boundedProviderText(cause?.message || String(cause))}`, "transport", { cause }));
      }
    });
    child.stdout?.on?.("end", () => {
      if (this.closed) return;
      try { this.#framing.flush(); } catch { /* failure already recorded */ }
    });
    child.stderr?.on?.("data", (chunk) => {
      if (this.closed) return;
      this.#stderr.append(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.on?.("error", (cause) => {
      this.#stderr.append(`${cause?.message || String(cause)}\n`);
      this.#fail(sessionError(`Codex app-server process error: ${boundedProviderText(cause?.message || String(cause))}`, "transport", {
        cause,
        hint: "install the codex CLI and ensure it is on PATH, or set HARNEST_CODEX",
      }));
    });
    child.on?.("close", (code, signalName) => {
      this.exit = { code, signal: signalName ?? null };
      this.#clearIdleClose();
      if (this.closed) return;
      const details = { code: code ?? null, signal: signalName ?? null, stderr: boundedProviderText(this.#stderr.text(), 4000) };
      if (this.status === "starting" || this.status === "ready") {
        const providerFailure = providerFailureFromStderr(this.#stderr.text());
        this.#fail(providerFailure || sessionError("Codex app-server exited before the session completed", "transport", details));
      } else {
        this.#fail(sessionError("Codex app-server exited before the turn completed", "downstream", details));
      }
    });
  }

  #handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let frame;
    try {
      frame = JSON.parse(trimmed);
    } catch (cause) {
      this.#fail(sessionError("Codex app-server emitted a non-JSON stdout frame", "transport", {
        cause,
        frame: boundedProviderText(trimmed, 200),
      }));
      return;
    }
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
      this.#fail(sessionError("Codex app-server emitted a non-object JSON-RPC frame", "transport", {
        frame: boundedProviderText(trimmed, 200),
      }));
      return;
    }
    const hasId = frame.id !== undefined && frame.id !== null;
    const method = typeof frame.method === "string" ? frame.method : null;
    if (method && hasId) {
      // Server-initiated requests (approvals, elicitations) must never hang the
      // turn behind an unanswered id. Approval policy is "never" and granular
      // policy is rejected before spawn, so an unexpected request fails closed.
      this.eventSummary.record(`server:${method}`);
      try {
        this.#write({ id: frame.id, error: { code: -32601, message: `Harnest does not implement ${method}` } });
      } catch { /* write failure already surfaced through #write callers */ }
      return;
    }
    if (method) {
      this.#enqueueNotification(frame);
      return;
    }
    if (hasId) {
      this.#handleResponse(frame);
      return;
    }
  }

  #enqueueNotification(frame) {
    if (this.closed || this.failure) return;
    const size = JSON.stringify(frame).length;
    if (this.notifications.length + 1 > this.#adapter.maxQueuedFrames || this.queuedBytes + size > this.#adapter.maxQueuedBytes) {
      this.#fail(sessionError("Codex app-server notification backlog exceeds the bounded queue", "output-limit", {
        stream: "stdout",
        maxQueuedFrames: this.#adapter.maxQueuedFrames,
        maxQueuedBytes: this.#adapter.maxQueuedBytes,
      }));
      return;
    }
    this.notifications.push({ frame, size });
    this.queuedBytes += size;
    this.#scheduleDrain();
  }

  #scheduleDrain() {
    if (this.draining || this.closed || this.failure) return;
    this.draining = true;
    this.child?.stdout?.pause?.();
    this.#drain().catch((cause) => {
      const error = cause?.details?.kind
        ? cause
        : sessionError(`Codex notification dispatch failed: ${boundedProviderText(cause?.message || String(cause))}`, "transport", { cause });
      this.#fail(error);
    }).finally(() => {
      this.draining = false;
      if (!this.closed && !this.failure) this.child?.stdout?.resume?.();
    });
  }

  async #drain() {
    while (!this.closed && !this.failure && this.notifications.length) {
      const entry = this.notifications.shift();
      this.queuedBytes -= entry.size;
      await this.#handleNotification(entry.frame);
    }
  }

  #handleResponse(frame) {
    const key = String(frame.id);
    const entry = this.pending.get(key);
    if (!entry) return; // duplicate or late response
    this.#removePending(key);
    if (frame.error && typeof frame.error === "object") {
      const message = boundedProviderText(frame.error.message || "request failed");
      const status = Number.isFinite(Number(frame.error.data?.status)) ? Number(frame.error.data.status) : null;
      // Provider classification is meaningful for session-opening and turn
      // requests; a steering rejection (for example "no active turn") is a
      // control failure, not a model/auth failure.
      const classify = ["initialize", "thread/start", "thread/resume", "turn/start"].includes(entry.method);
      const classification = classify ? classifyProviderFailure({ message, status }) : null;
      if (classification) {
        entry.reject(sessionError(
          `Codex ${entry.method} failed: ${message}`,
          classification.kind,
          providerFailureDetails(classification.kind, classification.category, message, status, null),
        ));
        return;
      }
      entry.reject(sessionError(`Codex ${entry.method} failed: ${message}`, "downstream", {
        method: entry.method,
        code: frame.error.code ?? null,
        rpcMessage: message,
      }));
      return;
    }
    entry.resolve(frame.result);
  }

  #removePending(key) {
    const entry = this.pending.get(key);
    if (!entry) return null;
    this.pending.delete(key);
    clearTimeout(entry.timer);
    if (entry.onAbort && entry.signal) entry.signal.removeEventListener("abort", entry.onAbort);
    return entry;
  }

  #write(message) {
    if (this.closed || this.failure) {
      throw this.failure || sessionError("Codex app-server session is closed", "transport", {});
    }
    if (!this.child?.stdin?.write) {
      throw sessionError("Codex app-server stdin is unavailable", "transport", {});
    }
    const line = `${JSON.stringify(message)}\n`;
    try {
      this.child.stdin.write(line);
    } catch (cause) {
      throw sessionError(`Codex app-server write failed: ${boundedProviderText(cause?.message || String(cause))}`, "transport", { cause });
    }
  }

  request(method, params, { signal, timeoutMs, uncertainOnLoss = false } = {}) {
    return new Promise((resolve, reject) => {
      if (this.closed || this.failure) {
        reject(sessionError(
          `Codex ${method} ${this.closed ? "session is closed" : "session failed"}`,
          this.failure?.details?.kind || "transport",
          { ...(this.failure?.details || {}), method },
        ));
        return;
      }
      if (this.pending.size >= this.#adapter.maxPendingRequests) {
        reject(sessionError(`Codex ${method} exceeds the pending request limit`, "transport", {
          method, maxPendingRequests: this.#adapter.maxPendingRequests,
        }));
        return;
      }
      const id = this.nextId++;
      const key = String(id);
      const entry = { method, resolve, reject, timer: null, onAbort: null, signal: signal ?? null, uncertainOnLoss, written: false };
      const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : this.#adapter.rpcTimeoutMs;
      entry.timer = setTimeout(() => {
        this.pending.delete(key);
        if (entry.signal && entry.onAbort) entry.signal.removeEventListener("abort", entry.onAbort);
        reject(uncertainOnLoss
          ? sessionError(`Codex ${method} acknowledgement timed out`, "control", {
            method, applied: false, uncertain: true, written: entry.written,
          })
          : sessionError(`Codex ${method} request timed out`, "transport", { method, timedOut: true }));
      }, limit);
      if (signal) {
        if (signal.aborted) {
          clearTimeout(entry.timer);
          reject(sessionError(`Codex ${method} request aborted`, "abort", { method, aborted: true }));
          return;
        }
        entry.onAbort = () => {
          this.pending.delete(key);
          clearTimeout(entry.timer);
          reject(sessionError(`Codex ${method} request aborted`, "abort", { method, aborted: true }));
        };
        signal.addEventListener("abort", entry.onAbort, { once: true });
      }
      this.pending.set(key, entry);
      try {
        this.#write({ id, method, ...(params !== undefined ? { params } : {}) });
        entry.written = true;
      } catch (cause) {
        this.#removePending(key);
        reject(cause?.details?.kind
          ? cause
          : sessionError(`Codex ${method} could not be sent`, "transport", { method, cause }));
      }
    });
  }

  notify(method, params) {
    this.#write({ method, ...(params !== undefined ? { params } : {}) });
  }

  #failAllPending(error) {
    for (const key of [...this.pending.keys()]) {
      const entry = this.#removePending(key);
      if (!entry) continue;
      if (entry.uncertainOnLoss) {
        entry.reject(sessionError(`Codex ${entry.method} acknowledgement was lost`, "control", {
          method: entry.method, applied: false, uncertain: true, written: entry.written, cause: error.message,
        }));
      } else {
        entry.reject(sessionError(`Codex ${entry.method} failed: ${error.message}`, error.details?.kind || "transport", {
          ...(error.details || {}), method: entry.method,
        }));
      }
    }
  }

  #fail(error) {
    if (this.closed || this.failure) return;
    this.failure = error;
    this.status = "error";
    this.#clearIdleClose();
    this.#failAllPending(error);
    const stderr = boundedProviderText(this.#stderr.text(), 4000);
    const turnError = error.details?.kind === "output-limit" || error.details?.kind === "transport"
      ? error
      : (providerFailureFromStderr(this.#stderr.text()) || error);
    for (const turn of this.turns.values()) {
      if (!turn.settled) {
        // Keep an already-classified provider failure; otherwise the transfer
        // failure that actually ended the session is the truthful cause.
        const classified = turn.error?.details?.kind === "provider-auth" || turn.error?.details?.kind === "unavailable";
        if (!classified) turn.error = turnError;
        turn.settle({ turn: null, error: turn.error || turnError, stderr });
      }
    }
    this.child?.stdout?.pause?.();
    this.#terminate();
  }

  #terminate() {
    const child = this.child;
    if (!child) return;
    terminateProcessTree(child);
  }

  #scheduleIdleClose() {
    this.#clearIdleClose();
    const idleCloseMs = this.#adapter.idleCloseMs;
    if (this.closed || this.failure) return;
    if (!Number.isFinite(idleCloseMs) || idleCloseMs <= 0) return;
    if (this.busy || this.runActive > 0) return;
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = null;
      void this.close().catch(() => undefined);
    }, idleCloseMs);
    this.#idleTimer.unref?.();
  }

  #clearIdleClose() {
    if (this.#idleTimer) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = null;
    }
  }

  #registerTurn(turnId, ordinal = null) {
    const state = {
      turnId,
      ordinal,
      settled: false,
      completion: null,
      resolveCompletion: null,
      deltas: "",
      deltasTruncated: false,
      finalText: null,
      itemCount: 0,
      usage: null,
      totalUsage: null,
      error: null,
      willRetry: false,
      status: null,
    };
    state.completion = new Promise((resolve) => { state.resolveCompletion = resolve; });
    state.settle = (settlement) => {
      if (state.settled) return;
      state.settled = true;
      state.resolveCompletion(settlement);
      this.turns.delete(turnId);
      this.#scheduleIdleClose();
    };
    this.turns.set(turnId, state);
    const orphan = this.orphanTurns.get(turnId);
    if (orphan) {
      this.orphanTurns.delete(turnId);
      state.settle(orphan);
    }
    return state;
  }

  #settleFromTurn(turn) {
    const settlement = { turn, error: null, stderr: null };
    const status = typeof turn?.status === "string" ? turn.status : null;
    if (status === "failed") {
      settlement.error = providerFailureFromTurnError(turn.error)
        || sessionError("Codex turn failed", "downstream", { turnId: turn?.id ?? null, turnError: boundedProviderText(turn?.error?.message || "", 400) });
    }
    return settlement;
  }

  #handleTurnCompleted(params) {
    if (params?.threadId !== this.threadId) return null;
    const turn = params.turn;
    const turnId = typeof turn?.id === "string" ? turn.id : null;
    if (!turnId) return null;
    if (turnId === this.activeTurnId) this.activeTurnId = null;
    const itemText = finalAgentMessageText(turn?.items);
    const state = this.turns.get(turnId);
    if (!state) {
      if (this.orphanTurns.size >= 32) return null;
      const reported = this.#report({ type: "codex_turn", state: "completed", status: turn?.status ?? null, turnId });
      this.orphanTurns.set(turnId, { ...this.#settleFromTurn(turn), reported });
      return reported;
    }
    state.status = turn?.status ?? null;
    if (itemText) state.finalText = itemText;
    const settlement = this.#settleFromTurn(turn);
    // A failed turn's own error is authoritative; a retryable `error`
    // notification recorded earlier must not override it.
    if (settlement.error) state.error = settlement.error;
    settlement.reported = this.#report({
      type: "codex_turn",
      state: "completed",
      status: turn?.status ?? null,
      turnId,
      ordinal: state.ordinal ?? null,
      usage: state.usage ?? null,
      // Inclusive spending across every turn this run has owned so far.
      usageTotals: addUsageTotals(this.runUsageTotals, state.usage),
    });
    state.settle(settlement);
    return settlement.reported;
  }

  #handleStartedTurn(params) {
    if (params?.threadId !== this.threadId) return null;
    const turnId = typeof params.turn?.id === "string" ? params.turn.id : null;
    const state = turnId ? this.turns.get(turnId) : null;
    if (state) this.activeTurnId = turnId;
    return {
      type: "codex_turn",
      state: "started",
      turnId,
      ordinal: state?.ordinal ?? null,
      model: this.resolvedModel,
      effort: this.effort,
    };
  }

  #handleItemCompleted(params) {
    if (params?.threadId !== this.threadId) return null;
    const state = this.turns.get(params.turnId);
    if (!state) return null;
    state.itemCount += 1;
    const item = params.item;
    if (item?.type === "agentMessage" && typeof item.text === "string" && item.text.trim()) {
      state.finalText = item.text;
      return { type: "codex_message", text: boundedProgressText(item.text), turnId: params.turnId };
    }
    if (item?.type === "commandExecution") {
      return { type: "codex_tool", tool: "commandExecution", status: item.status ?? null, turnId: params.turnId };
    }
    return null;
  }

  // Only item/completed publishes text. Deltas are a final-result fallback.
  #handleAgentDelta(params) {
    if (params?.threadId !== this.threadId) return;
    const state = this.turns.get(params.turnId);
    if (!state) return;
    const delta = typeof params.delta === "string" ? params.delta : "";
    if (!delta) return;
    if (state.deltas.length < MAX_DELTA_CHARS) {
      const room = MAX_DELTA_CHARS - state.deltas.length;
      state.deltas += delta.length > room ? delta.slice(0, room) : delta;
      if (delta.length > room) state.deltasTruncated = true;
    } else {
      state.deltasTruncated = true;
    }
  }

  #handleTokenUsage(params) {
    if (params?.threadId !== this.threadId) return null;
    const usage = usageFromBreakdown(params?.tokenUsage?.last);
    if (!usage) return null;
    const state = params.turnId ? this.turns.get(params.turnId) : null;
    if (!state) return null;
    // `last` is the per-turn breakdown and is reset for each turn: a later
    // event replaces the earlier one instead of merging stale counters.
    state.usage = usage;
    state.totalUsage = usageFromBreakdown(params?.tokenUsage?.total) ?? state.totalUsage;
    return { type: "codex_usage", usage, turnId: params.turnId ?? null, ordinal: state.ordinal ?? null };
  }

  #handleErrorNotification(params) {
    if (params?.threadId !== this.threadId) return null;
    const failure = providerFailureFromNotification(params.error && typeof params.error === "object" ? { error: params.error } : params);
    const state = params.turnId ? this.turns.get(params.turnId) : null;
    if (state && failure) {
      if (!state.error || failure.details?.kind === "provider-auth" || failure.details?.kind === "unavailable") {
        state.error = failure;
      }
      state.willRetry = Boolean(params.willRetry);
    }
    const message = boundedProviderText(params?.error?.message || "Codex reported an error");
    return {
      type: "codex_error",
      kind: failure?.details?.kind ?? "downstream",
      message,
      willRetry: Boolean(params?.willRetry),
      turnId: params?.turnId ?? null,
    };
  }

  async #handleNotification(frame) {
    const method = frame.method;
    this.eventSummary.record(method);
    const params = frame.params && typeof frame.params === "object" ? frame.params : {};
    let event = null;
    switch (method) {
      case "thread/started":
        event = null;
        break;
      case "turn/started":
        event = this.#handleStartedTurn(params);
        break;
      case "turn/completed":
        return this.#handleTurnCompleted(params);
      case "item/completed":
        event = this.#handleItemCompleted(params);
        break;
      case "item/agentMessage/delta":
        this.#handleAgentDelta(params);
        break;
      case "thread/tokenUsage/updated":
        event = this.#handleTokenUsage(params);
        break;
      case "error":
        event = this.#handleErrorNotification(params);
        break;
      default:
        event = null;
        break;
    }
    if (event) await this.#report(event);
  }

  async #report(event) {
    const progress = this.progress;
    if (this.closed || typeof progress !== "function") return;
    const pending = Promise.resolve().then(() => progress(event));
    this.#pendingProgress.add(pending);
    try {
      await pending;
    } catch (cause) {
      throw sessionError(`Codex progress callback failed: ${boundedProviderText(cause?.message || String(cause))}`, "transport", {
        phase: "progress", cause,
      });
    } finally {
      this.#pendingProgress.delete(pending);
    }
  }

  #turnStartParams(text, model, effort) {
    return {
      threadId: this.threadId,
      input: [{ type: "text", text }],
      approvalPolicy: "never",
      cwd: this.cwd,
      sandboxPolicy: this.policy.sandboxPolicy,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
    };
  }

  #followUpLimits() {
    return { maxCount: this.#adapter.maxFollowUps, maxBytes: this.#adapter.maxFollowUpBytes };
  }

  #enqueueFollowUp({ message, model, commandId, source }) {
    const { maxCount, maxBytes } = this.#followUpLimits();
    const bytes = Buffer.byteLength(message, "utf8");
    if (this.followUps.length >= maxCount) {
      throw sessionError(`Codex follow-up queue is full (${maxCount}); no further follow-up was queued`, "control", {
        applied: false, acknowledged: false, rejected: true, queued: false,
        reason: "queue-count", maxFollowUps: maxCount,
      });
    }
    if (this.followUpBytes + bytes > maxBytes) {
      throw sessionError(`Codex follow-up queue byte budget exceeded (${maxBytes} bytes); no further follow-up was queued`, "control", {
        applied: false, acknowledged: false, rejected: true, queued: false,
        reason: "queue-bytes", maxFollowUpBytes: maxBytes,
      });
    }
    this.followUpSeq += 1;
    const entry = {
      id: `follow-up-${this.followUpSeq}`,
      message,
      model: model ?? this.model,
      commandId: commandId ?? null,
      source,
      bytes,
    };
    this.followUps.push(entry);
    this.followUpBytes += bytes;
    this.#emitProgressSoon({
      type: "codex_follow_up",
      state: "queued",
      queueId: entry.id,
      queueLength: this.followUps.length,
      model: entry.model ?? null,
    });
    return entry;
  }

  #shiftFollowUp() {
    const entry = this.followUps.shift();
    if (entry) this.followUpBytes = Math.max(0, this.followUpBytes - entry.bytes);
    return entry ?? null;
  }

  /** Progress born outside the notification drain; never blocks the caller. */
  #emitProgressSoon(event) {
    this.#report(event).catch((cause) => this.#fail(cause));
  }

  /** Teardown progress: the run is already terminal, so failures are swallowed. */
  #emitProgressSafely(event) {
    this.#report(event).catch(() => {});
  }

  /**
   * Owns one run: the primary turn plus every accepted follow-up, drained in
   * order only after the active turn settles, under the same absolute deadline
   * and policy. No native turn is dispatched after this run reaches a terminal
   * outcome, and each accepted turn's usage is aggregated.
   */
  async runTurn({ request, signal, timeoutMs, execution, onProgress }) {
    if (this.closed || this.failure) {
      throw sessionError(this.failure?.message || "Codex session is not available", this.failure?.details?.kind || "transport", { ...(this.failure?.details || {}) });
    }
    if (this.runActive > 0) {
      throw sessionError("Codex session already has an active turn owner", "control", { busy: true });
    }
    this.runActive += 1;
    this.status = "running";
    this.progress = onProgress || null;
    this.followUps = [];
    this.followUpBytes = 0;
    this.runUsageTotals = null;
    const run = { turns: [], usage: null, deltasTruncated: false, finalText: null };
    try {
      let turn = { message: promptFor(request), model: this.model, source: "primary" };
      while (turn) {
        if (signal?.aborted) {
          // Deadline/abort between native turns: never dispatch another paid
          // turn after the run is effectively terminal.
          throw execution?.state.timedOut
            ? sessionError("Codex session execution timed out", "timeout", { turnId: null, usage: run.usage ?? null, timedOut: true, aborted: false })
            : sessionError("Codex session execution aborted", "abort", { turnId: null, usage: run.usage ?? null, timedOut: false, aborted: true });
        }
        const ordinal = run.turns.length + 1;
        if (turn.source !== "primary") {
          this.#emitProgressSoon({
            type: "codex_follow_up",
            state: "dispatched",
            queueId: turn.id,
            queueLength: this.followUps.length,
            model: turn.model ?? null,
          });
        }
        const outcome = await this.#runOneTurn({ turn, ordinal, signal, timeoutMs, execution });
        run.turns.push({
          ordinal,
          turnId: outcome.turnId,
          status: outcome.status,
          source: turn.source,
          usage: outcome.usage ?? null,
        });
        run.usage = addUsageTotals(run.usage, outcome.usage);
        this.runUsageTotals = run.usage;
        run.deltasTruncated = run.deltasTruncated || outcome.deltasTruncated;
        run.finalText = outcome.finalText;
        turn = this.#shiftFollowUp();
      }
      return this.#buildResult({
        request,
        finalText: run.finalText,
        usage: run.usage,
        turns: run.turns,
        deltasTruncated: run.deltasTruncated,
      });
    } catch (error) {
      const dropped = this.followUps.length;
      this.followUps = [];
      this.followUpBytes = 0;
      if (dropped > 0) {
        this.#emitProgressSafely({ type: "codex_follow_up", state: "cancelled", queuedNotRun: dropped });
      }
      const details = { ...(error?.details || {}) };
      // Include the failed/cancelled turn's observed usage in the run total.
      details.usage = addUsageTotals(run.usage, details.usage ?? null);
      details.usageSummary = summarizeUsage("codex", details.usage);
      if (run.turns.length) details.completedTurns = run.turns.length;
      if (dropped > 0) details.queuedNotRun = dropped;
      throw error?.name === "CodexSessionAdapterError"
        ? Object.assign(error, { details })
        : sessionError(error?.message || "Codex session failed", error?.details?.kind || "transport", { ...details, cause: error });
    } finally {
      this.runActive -= 1;
      this.progress = null;
      this.followUps = [];
      this.followUpBytes = 0;
      if (!this.closed && !this.failure && this.status === "running") this.status = "ready";
      this.#scheduleIdleClose();
    }
  }

  /** One native turn: turn/start, await settlement or abort, bounded cleanup. */
  async #runOneTurn({ turn, ordinal, signal, timeoutMs, execution }) {
    let state = null;
    let turnId = null;
    try {
      const response = await this.request("turn/start", this.#turnStartParams(turn.message, turn.model, this.effort), {
        signal,
        timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, this.#adapter.rpcTimeoutMs) : this.#adapter.rpcTimeoutMs,
      });
      turnId = typeof response?.turn?.id === "string" ? response.turn.id : null;
      if (!turnId) {
        throw sessionError("Codex turn/start did not return a turn id", "transport", { phase: "turn-start" });
      }
      this.activeTurnId = turnId;
      state = this.#registerTurn(turnId, ordinal);
      const abortPromise = new Promise((resolve) => {
        this.#turnAbortListener = () => resolve({ aborted: true });
        signal.addEventListener("abort", this.#turnAbortListener, { once: true });
      });
      let settlement;
      try {
        const persistedCompletion = state.completion.then(async (outcome) => {
          await outcome.reported;
          return outcome;
        });
        settlement = await Promise.race([persistedCompletion, abortPromise]);
      } finally {
        if (this.#turnAbortListener) signal.removeEventListener("abort", this.#turnAbortListener);
        this.#turnAbortListener = null;
      }

      if (settlement?.aborted) {
        await this.#cancelTurn(turnId, state);
        const timedOut = Boolean(execution?.state.timedOut);
        throw timedOut
          ? sessionError("Codex session execution timed out", "timeout", { turnId, ordinal, usage: state.usage ?? null, timedOut: true, aborted: false })
          : sessionError("Codex session execution aborted", "abort", { turnId, ordinal, usage: state.usage ?? null, timedOut: false, aborted: true });
      }

      const nativeTurn = settlement?.turn ?? null;
      if (!nativeTurn) {
        throw state.error || settlement?.error || sessionError("Codex session ended before the turn completed", "transport", {
          turnId, ordinal, usage: state.usage ?? null,
        });
      }
      if (nativeTurn.status === "failed") {
        const classified = state.error?.details?.kind === "provider-auth" || state.error?.details?.kind === "unavailable"
          ? state.error
          : null;
        const failure = classified || providerFailureFromTurnError(nativeTurn.error)
          || sessionError("Codex turn failed", "downstream", { turnId });
        throw Object.assign(failure, { details: { ...failure.details, turnId, ordinal, usage: state.usage ?? null } });
      }
      if (nativeTurn.status === "interrupted") {
        const timedOut = Boolean(execution?.state.timedOut);
        throw timedOut
          ? sessionError("Codex session execution timed out", "timeout", { turnId, ordinal, usage: state.usage ?? null, timedOut: true, aborted: false })
          : sessionError("Codex turn was interrupted before completion", "downstream", { turnId, ordinal, usage: state.usage ?? null });
      }
      const finalText = typeof state.finalText === "string" && state.finalText.trim()
        ? state.finalText
        : state.deltas;
      if (!finalText || !finalText.trim()) {
        const providerFailure = providerFailureFromStderr(this.#stderr.text());
        if (providerFailure) throw providerFailure;
        throw sessionError("Codex turn completed without an agent message", "downstream", {
          turnId, ordinal, usage: state.usage ?? null, stderr: boundedProviderText(this.#stderr.text(), 2000),
        });
      }
      return { turnId, ordinal, status: "completed", finalText, usage: state.usage ?? null, deltasTruncated: state.deltasTruncated };
    } catch (error) {
      // A turn/start write can race an abort before a turn id is known. No id
      // means no truthful interrupt target, so the bounded cleanup is stopping
      // only this owned process rather than leaving an unowned turn.
      if (!state && (error?.details?.kind === "abort" || error?.details?.kind === "timeout") && !this.closed) {
        await this.close();
      }
      if (error?.name === "CodexSessionAdapterError" && error.details?.kind) {
        throw Object.assign(error, {
          details: {
            ...error.details,
            turnId: error.details.turnId ?? turnId,
            ordinal: error.details.ordinal ?? ordinal,
            usage: error.details.usage === undefined ? (state?.usage ?? null) : error.details.usage,
          },
        });
      }
      const failure = providerFailureFromStderr(this.#stderr.text());
      if (failure && (!error?.details?.kind || error.details.kind === "downstream")) throw failure;
      throw sessionError(error?.message || "Codex session failed", error?.details?.kind || "transport", {
        ...(error?.details || {}), turnId, ordinal, usage: state?.usage ?? null, cause: error,
      });
    }
  }

  #buildResult({ request, finalText, usage, turns, deltasTruncated }) {
    const route = request.route || {};
    const turnReceipts = (Array.isArray(turns) ? turns : []).map((turn) => ({
      ordinal: turn.ordinal,
      turnId: turn.turnId,
      status: turn.status,
      source: turn.source,
      usage: turn.usage ?? null,
    }));
    return {
      sessionId: this.threadId,
      workflowRunId: `codex:${request.requestId}`,
      route: {
        harness: "codex",
        provider: typeof route.provider === "string" && route.provider ? route.provider : "openai",
        model: this.resolvedModel || this.model || "default",
        variant: null,
        thinking: this.effort,
        transport: "session",
        requested: route,
      },
      result: structuredResult(redactSecrets(finalText), {
        eventSummary: this.eventSummary.snapshot(),
        turns: turnReceipts,
      }),
      usage: usage ?? null,
      usageSummary: summarizeUsage("codex", usage ?? null),
      ...(deltasTruncated ? { resultTruncated: true } : {}),
    };
  }

  async #cancelTurn(turnId, state) {
    if (state?.settled) return;
    try {
      await this.request("turn/interrupt", { threadId: this.threadId, turnId }, { timeoutMs: this.#adapter.rpcTimeoutMs });
    } catch { /* best-effort interrupt; fall through to bounded cleanup */ }
    if (!state?.settled) {
      let timer;
      const grace = new Promise((resolve) => { timer = setTimeout(resolve, INTERRUPT_GRACE_MS); });
      await Promise.race([state.completion, grace]).finally(() => clearTimeout(timer));
    }
    if (!state?.settled) {
      // The peer ignored turn/interrupt. Terminate only this owned process and
      // give close() its bounded grace; never wait unbounded.
      await this.close();
    }
  }

  async control(command, signal) {
    if (this.closed || this.failure) {
      throw sessionError("Codex session is not running; live controls require an active run", "control", {
        applied: false, acknowledged: false, active: false,
      });
    }
    if (this.runActive === 0 || this.status !== "running") {
      throw sessionError("Codex session has no active run to control", "control", {
        applied: false, acknowledged: false, active: false,
        hint: "controls require a running turn; use handoff_resume for a follow-up run",
      });
    }
    const threadId = this.threadId;
    if (command?.kind === "message") {
      if (typeof command.message !== "string" || !command.message.trim()) {
        throw sessionError("Codex control message is required", "control", { applied: false, acknowledged: false });
      }
      if (command.delivery === "follow_up") {
        return this.#queueFollowUp(command, { source: "follow_up", model: null });
      }
      // steer stays native: turn/steer only accepts the turn that is active now.
      if (!this.activeTurnId || !this.turns.has(this.activeTurnId)) {
        throw sessionError("Codex session has no active turn to steer", "control", {
          applied: false, acknowledged: false, active: false,
          hint: "live steering requires an active turn; use delivery follow_up to queue the next turn",
        });
      }
      const response = await this.request("turn/steer", {
        threadId,
        expectedTurnId: this.activeTurnId,
        input: [{ type: "text", text: command.message }],
      }, { signal, timeoutMs: this.#adapter.rpcTimeoutMs, uncertainOnLoss: true });
      return {
        harness: "codex",
        command: "turn/steer",
        delivery: "steer",
        applied: true,
        acknowledged: true,
        queued: false,
        sessionId: threadId,
        turnId: typeof response?.turnId === "string" ? response.turnId : this.activeTurnId,
      };
    }
    if (command?.kind === "reroute") {
      const model = resolveModel(command.route || {});
      if (!model) {
        throw sessionError("Codex reroute requires route.model", "control", { applied: false, acknowledged: false });
      }
      if (typeof command.message !== "string" || !command.message.trim()) {
        // The protocol has no model-only switch for a live turn; the documented
        // path is a queued follow-up turn with the new model.
        throw sessionError("Codex app-server has no model-only live control; send the reroute with a message so it applies to the next queued turn", "unsupported-control", {
          applied: false, acknowledged: false,
          hint: "route.model applies to turn/start; include a follow-up message or set route.model on the next handoff",
        });
      }
      return this.#queueFollowUp(command, { source: "reroute", model });
    }
    throw sessionError(`unsupported Codex control kind: ${command?.kind ?? "unknown"}`, "unsupported-control", { applied: false, acknowledged: false });
  }

  /**
   * Accepts a follow-up into the run-owned local queue. There is no native turn
   * yet, so this is deliberately an `uncertain` control: claiming `applied`
   * would assert delivery the protocol has not acknowledged. The run dispatches
   * it only after the active turn settles, under the same deadline and policy.
   */
  #queueFollowUp(command, { source, model }) {
    const entry = this.#enqueueFollowUp({
      message: command.message.trim(),
      model,
      commandId: command.commandId ?? null,
      source,
    });
    throw sessionError(
      `Codex ${source === "reroute" ? "model reroute" : "follow-up"} was queued locally as ${entry.id}; no native turn acknowledgement exists yet`,
      "control",
      {
        applied: false,
        acknowledged: false,
        uncertain: true,
        queued: true,
        queueId: entry.id,
        queueLength: this.followUps.length,
        model: entry.model ?? null,
        sessionId: this.threadId,
        hint: "the queued turn runs after the active turn settles; delivery stays uncertain until it appears on the wire",
      },
    );
  }

  async close() {
    if (this.closed && this.exit) {
      this.child = null;
      await Promise.allSettled(this.#pendingProgress);
      return;
    }
    if (this.#closePromise) return this.#closePromise;
    if (this.closed && !this.child) return undefined;
    this.#closePromise = (async () => {
      this.closed = true;
      this.status = "closed";
      this.#clearIdleClose();
      const closedError = sessionError("Codex app-server session was closed", "transport", { closed: true });
      this.#failAllPending(closedError);
      for (const turn of this.turns.values()) {
        if (!turn.settled) turn.settle({ turn: null, error: this.failure || closedError, stderr: null });
      }
      const child = this.child;
      if (!child || this.exit) {
        this.child = null;
        return;
      }
      child.stdout?.resume?.();
      const observed = await new Promise((resolve) => {
        const onClose = () => {
          clearTimeout(timer);
          resolve(true);
        };
        const timer = setTimeout(() => {
          child.removeListener?.("close", onClose);
          resolve(false);
        }, CLOSE_GRACE_MS);
        child.once?.("close", onClose);
        terminateProcessTree(child);
      });
      if (!observed) {
        const message = "Codex app-server exit was not observed during session cleanup";
        throw sessionError(message, "transport", { unsafeResume: true, cleanupError: [{ component: "process", message }] });
      }
      this.child = null;
    })().finally(() => Promise.allSettled(this.#pendingProgress));
    return this.#closePromise;
  }
}

export class CodexSessionAdapter {
  constructor(options = {}) {
    const injected = options.launch || options.command || options.executable || options.bin;
    this.launch = harnessLaunch("codex", injected);
    this.spawnFn = options.spawnFn || spawnNativeCommand;
    this.env = options.env || {};
    this.rpcTimeoutMs = options.rpcTimeoutMs || DEFAULT_RPC_TIMEOUT_MS;
    this.idleCloseMs = options.idleCloseMs === undefined ? DEFAULT_IDLE_CLOSE_MS : options.idleCloseMs;
    this.maxLineBytes = options.maxLineBytes || DEFAULT_MAX_LINE_BYTES;
    this.maxQueuedBytes = options.maxQueuedBytes || DEFAULT_MAX_QUEUED_BYTES;
    this.maxQueuedFrames = options.maxQueuedFrames || DEFAULT_MAX_QUEUED_FRAMES;
    this.maxPendingRequests = options.maxPendingRequests || DEFAULT_MAX_PENDING_REQUESTS;
    this.maxFollowUps = options.maxFollowUps || DEFAULT_MAX_FOLLOW_UPS;
    this.maxFollowUpBytes = options.maxFollowUpBytes || DEFAULT_MAX_FOLLOW_UP_BYTES;
    this.session = null;
  }

  async #acquireSession({ request, cwd, policy, model, effort, routeKey, signal }) {
    const requestedSessionId = typeof request.execution?.sessionId === "string" && request.execution.sessionId.trim()
      ? request.execution.sessionId.trim()
      : null;
    const live = this.session;
    if (live && live.canServe({ sessionId: requestedSessionId, cwd, policyKey: policy.key, routeKey })) {
      return live;
    }
    if (live) {
      // Never share one conversation with an unrelated request: a different
      // native session, cwd, policy or route gets its own process.
      await this.close();
    }
    const session = new CodexAppServerSession({ adapter: this, cwd, policy, model, effort, routeKey });
    this.session = session;
    await session.start({ requestedSessionId, signal });
    return session;
  }

  async run(request, { signal, onProgress } = {}) {
    request = validateAdapterExecution(request, "codex", "session");
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      throw new TypeError("request must be an object");
    }
    assertPromptOnlyWorkflow("codex", request.workflow);
    assertNoClaudeRoute("codex", request.route);
    const controlError = routeControlError("codex", request.route, "session");
    if (controlError) throw sessionError(controlError, "policy");
    const support = isPolicySupported(request.policy || {});
    if (!support.supported) {
      throw sessionError(`Codex policy not supported: ${support.reason} — ${CODEX_SESSION_SUPPORTED_POLICY_HELP}`, "policy", { reason: support.reason });
    }
    const cwd = resolvePath(request.cwd);
    const policy = policyDescriptor(request.policy || {}, cwd);
    const model = resolveModel(request.route || {});
    const effort = resolveEffort(request.route || {});
    const routeKey = routeKeyOf(request.route || {}, model, effort);
    const execution = executionSignal(signal, request.execution?.timeoutMs);
    let session = null;
    try {
      session = await this.#acquireSession({ request, cwd, policy, model, effort, routeKey, signal: execution.signal });
      const result = await session.runTurn({
        request,
        signal: execution.signal,
        timeoutMs: request.execution?.timeoutMs,
        execution,
        onProgress,
      });
      return result;
    } catch (error) {
      const details = error?.details || {};
      if (error?.name === "CodexSessionAdapterError" && details.kind) throw error;
      if (details.timedOut || execution.state.timedOut) {
        throw sessionError("Codex session execution timed out", "timeout", {
          ...details, kind: "timeout", timedOut: true, aborted: false,
        });
      }
      if (details.aborted || execution.state.aborted) {
        throw sessionError("Codex session execution aborted", "abort", {
          ...details, kind: "abort", aborted: true,
        });
      }
      const kind = ["transport", "downstream", "policy", "unsupported-control", "output-limit"].includes(details.kind)
        ? details.kind
        : "downstream";
      throw sessionError(error?.message || "Codex session failed", kind, details);
    } finally {
      execution.dispose();
      if (session) session.progress = null;
    }
  }

  async control(command, signal) {
    const session = this.session;
    if (!session) {
      throw sessionError("Codex session is not active; live controls require a running turn", "control", {
        applied: false, active: false,
        hint: "codex app-server controls require a live session; resume with execution.sessionId instead",
      });
    }
    return session.control(command, signal);
  }

  /** Idempotent: stops exactly the process this adapter owns, bounded. */
  async close() {
    const session = this.session;
    await session?.close();
    if (this.session === session) this.session = null;
  }
}

export default CodexSessionAdapter;
