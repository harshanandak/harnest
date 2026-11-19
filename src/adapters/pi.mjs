import { assertPromptOnlyWorkflow } from "../one-shot-policy.mjs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harnessLaunch } from "../config.mjs";
import { NativeLaunchError, spawnNativeCommand } from "../launch-command.mjs";
import { attachmentMimeType, executionError, readAttachment, validateAdapterExecution } from "../execution-controls.mjs";
import { requireExecutionFlags } from "./execution-help.mjs";
import {
  boundedProviderText,
  classifyProviderFailure,
  mergeProcessEnv,
  providerErrorFromEvent,
  runProcess,
  terminateProcessTree,
} from "../process.mjs";
import { normalizePolicyControls } from "../protocol.mjs";
import { structuredResult } from "../result.mjs";
import { summarizeUsage } from "../usage.mjs";
import { isClaudeRoute } from "../model-policy.mjs";
export { isClaudeRoute } from "../model-policy.mjs";

const DEFAULT_TIMEOUT_MS = 3_600_000;
const READ_TOOLS = ["read", "grep", "find", "ls"];
const WRITE_TOOLS = ["bash", "edit", "write"];
const MAX_LINE_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_PROTOCOL_TEXT_CHARS = 1024 * 1024;
const MAX_FINAL_TEXT_CHARS = 64_000;
const MAX_EVENT_TYPES = 256;
const MAX_EVENT_TYPE_CHARS = 256;
const MAX_PENDING_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_PENDING_STDOUT_CHUNKS = 256;

function retainedText(value) {
  const text = typeof value === "string" ? value : "";
  return {
    text: text.length > MAX_PROTOCOL_TEXT_CHARS ? "" : text,
    overflow: text.length > MAX_PROTOCOL_TEXT_CHARS,
    nonempty: Boolean(text.trim()),
  };
}

function diagnostic(value) {
  return boundedProviderText(typeof value === "string" ? value : JSON.stringify(value), 4000);
}

function retainedState(value) {
  if (!isObject(value)) return null;
  // Retain identity, route, status and usage after delivering progress.
  return Object.fromEntries(["sessionId", "model", "thinkingLevel", "workflowRunId", "runId", "status", "totalUsage", "usage"]
    .filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
}

export class PiAdapterError extends Error {
  constructor(message, kind, details = {}) {
    super(message);
    this.name = "PiAdapterError";
    this.details = { kind, ...details };
  }
}

// Claude models run only in the Claude Code CLI (target "claude"). Pi must
// never spend on them — neither at start nor via a live reroute — so both
// paths fail closed as policy instead of burning another meter.
// Bare Claude family aliases (sonnet/opus/haiku) unambiguously name Claude
// models in this system's model vocabulary, so they are blocked too.
function rejectClaudeRoute(route) {
  if (!isClaudeRoute(route)) return;
  throw new PiAdapterError('Pi cannot run Claude models; request target "claude" (Claude Code CLI) instead', "policy", {
    hint: 'use target "claude" with route.model naming the Claude model or alias',
  });
}

function firstProviderName(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

// Pi resolves provider credentials through its own auth store; Harnest
// only names the provider and the command that fixes the missing credential,
// never a value.
function piProviderHint(classification, provider) {
  const name = provider || "the requested provider";
  if (classification.category === "region") {
    return `the ${name} provider rejected this run for a regional or opt-in restriction; enable the provider for this region or reroute`;
  }
  if (classification.category === "billing") {
    return `the ${name} provider reported an exhausted or unpaid balance; top up the provider account or reroute`;
  }
  if (classification.kind === "unavailable") {
    return `Pi reported the requested model as unavailable from ${name}; verify the model id in the provider catalog`;
  }
  return `Pi has no ready ${name} credential; run \`pi auth login --provider ${provider || "<provider>"}\` so Pi can resolve its own provider credential — Harnest never reads, stores, or forwards provider secrets`;
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && typeof part.text === "string") return part.text;
      return "";
    })
    .join("");
}

function textFromMessage(message) {
  if (!message || typeof message !== "object") return "";
  if (typeof message.text === "string") return message.text;
  return textFromContent(message.content);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function routeArgs(route = {}) {
  const args = [];
  if (typeof route.provider === "string" && route.provider.trim()) {
    args.push("--provider", route.provider.trim());
  }
  if (typeof route.model === "string" && route.model.trim()) {
    args.push("--model", route.model.trim());
  }
  if (typeof route.thinking === "string" && route.thinking.trim()) {
    args.push("--thinking", route.thinking.trim());
  }
  return args;
}

// Field order is a prompt-cache contract: stable context first, then the
// variable task, requestId and route. A provider prefix cache can only match
// leading bytes, so identifiers that change per attempt must not lead.
function requestPrompt(request) {
  const envelope = {
    contextDigest: request.contextDigest,
    context: request.context,
    policy: request.policy,
    metadata: request.metadata,
    task: request.task,
    route: request.route,
    requestId: request.requestId,
  };
  return [
    ...(request.context?.graph?.graphId && request.context?.graph?.nodeId ? [
      "Execute this single agent-graph node directly. Harnest already owns dependency scheduling; do not create a second workflow to perform this node.",
      "Use the attributed direct-dependency results in context.graph.upstream as data. Return this node's final answer, not another execution plan.",
    ] : [
      "Execute the assigned task directly in this session and return the final answer.",
      "Do not create a separate workflow for this task.",
    ]),
    JSON.stringify(envelope),
  ].join("\n\n");
}

function rpcCommandId(requestId, suffix) {
  return `${requestId}:${suffix}`;
}

function killChild(child) {
  terminateProcessTree(child);
}

function usageFrom(state, stats) {
  if (stats && typeof stats === "object") return stats;
  if (state && typeof state === "object") {
    return state.totalUsage ?? state.usage ?? null;
  }
  return null;
}

class RpcRun {
  constructor({ executable, args, cwd, env, spawnFn, signal, timeoutMs, onProgress, requestId, provider }) {
    this.executable = executable;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.spawnFn = spawnFn;
    this.signal = signal;
    this.timeoutMs = timeoutMs;
    this.onProgress = onProgress;
    this.requestId = requestId;
    this.provider = provider || null;
    this.child = null;
    this.stdoutBuffer = null;
    this.stdoutBytes = 0;
    this.stdoutQueue = [];
    this.queuedStdoutBytes = 0;
    this.drainingStdout = false;
    this.progressPending = false;
    this.pendingResult = null;
    this.closeInfo = null;
    this.exited = false;
    this.stderr = Buffer.alloc(MAX_STDERR_BYTES);
    this.stderrBytes = 0;
    this.stderrCursor = 0;
    this.eventSummary = { count: 0, types: [] };
    this.eventTypes = new Set();
    this.recentEvents = [];
    this.pendingCommands = new Map();
    this.state = null;
    this.stats = null;
    this.lastAssistantText = null;
    this.assistantText = null;
    this.settled = false;
    this.terminalSeen = false;
    this.promptAccepted = false;
    this.abortRequested = false;
    this.timeoutRequested = false;
    this.terminalFinalReceived = false;
    this.terminalUsageReceived = false;
    this.terminalFallbackTimer = null;
    this.resolve = null;
    this.reject = null;
    this.timer = null;
    this.abortListener = () => this.stop("aborted");
  }

  run() {
    return new Promise((resolvePromise, rejectPromise) => {
      this.resolve = resolvePromise;
      this.reject = rejectPromise;
      if (this.signal?.aborted) {
        this.abortRequested = true;
        this.finishReject(new PiAdapterError("Pi RPC run aborted", "aborted", { aborted: true }));
        return;
      }
      try {
        this.child = this.spawnFn(this.executable, this.args, {
          cwd: this.cwd,
          env: this.env,
          windowsHide: true,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error) {
        this.finishReject(error instanceof NativeLaunchError ? error
          : new PiAdapterError(error.message, "transport", { cause: error }));
        return;
      }

      this.child.on("error", (error) => {
        if (this.abortRequested || this.timeoutRequested) return;
        this.finishReject(new PiAdapterError(error.message, "transport", { cause: error, stderr: this.stderrText() }));
      });
      this.child.on("exit", () => { this.exited = true; });
      this.child.on("close", (code, closeSignal) => {
        if (this.settled) return;
        this.closeInfo = { code, signal: closeSignal };
        this.drainStdout();
      });
      this.child.stderr?.on("data", (chunk) => this.onStderr(chunk));
      this.child.stdout?.on("data", (chunk) => this.onStdout(chunk));
      this.signal?.addEventListener("abort", this.abortListener, { once: true });
      // The run still owns this deadline after the child closes if progress
      // persistence is pending. Cleanup releases it on every terminal path.
      this.timer = setTimeout(() => this.stop("timeout"), this.timeoutMs || DEFAULT_TIMEOUT_MS);
      this.send({ type: "get_state", id: rpcCommandId(this.requestId, "state") });
    });
  }

  setPrompt(message, images, forkSource) {
    this.prompt = { type: "prompt", id: this.requestId, message, ...(images.length ? { images } : {}) };
    this.forkSource = forkSource;
    return this;
  }

  stderrText() {
    const tail = this.stderrBytes < MAX_STDERR_BYTES ? this.stderr.subarray(0, this.stderrBytes)
      : Buffer.concat([this.stderr.subarray(this.stderrCursor), this.stderr.subarray(0, this.stderrCursor)]);
    let start = 0;
    if (this.stderrBytes > MAX_STDERR_BYTES) while (start < tail.length && (tail[start] & 0xc0) === 0x80) start++;
    return tail.toString("utf8", start);
  }

  onStderr(value) {
    if (this.settled) return;
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    this.stderrBytes += chunk.length;
    if (chunk.length >= MAX_STDERR_BYTES) {
      chunk.copy(this.stderr, 0, chunk.length - MAX_STDERR_BYTES);
      this.stderrCursor = 0;
    } else {
      const first = Math.min(chunk.length, MAX_STDERR_BYTES - this.stderrCursor);
      chunk.copy(this.stderr, this.stderrCursor, 0, first);
      chunk.copy(this.stderr, 0, first);
      this.stderrCursor = (this.stderrCursor + chunk.length) % MAX_STDERR_BYTES;
    }
  }

  send(command) {
    if (this.settled || this.exited || this.closeInfo || !this.child?.stdin?.write) return false;
    try {
      this.child.stdin.write(`${JSON.stringify(command)}\n`);
      return true;
    } catch (error) {
      this.finishReject(new PiAdapterError(error.message, "transport", { cause: error, stderr: this.stderrText() }));
      return false;
    }
  }

  sendAndWait(command, timeoutMs = 30_000) {
    if (!command?.id) throw new TypeError("Pi RPC control command requires id");
    if (this.pendingCommands.has(command.id)) return this.pendingCommands.get(command.id).promise;
    if (this.settled || !this.child?.stdin?.write) {
      throw new PiAdapterError("Pi RPC control channel is not active", "control", { command: command.type });
    }
    if (this.pendingCommands.size >= 256) {
      throw new PiAdapterError("Pi RPC has too many pending control commands", "control", { command: command.type });
    }
    let resolveCommand;
    let rejectCommand;
    const promise = new Promise((resolve, reject) => {
      resolveCommand = resolve;
      rejectCommand = reject;
    });
    const timer = setTimeout(() => {
      this.pendingCommands.delete(command.id);
      rejectCommand(new PiAdapterError(`Pi RPC ${command.type} acknowledgement timed out`, "control", {
        command: command.type,
        uncertain: true,
      }));
    }, timeoutMs);
    timer.unref?.();
    this.pendingCommands.set(command.id, { promise, resolve: resolveCommand, reject: rejectCommand, timer });
    if (!this.send(command)) {
      clearTimeout(timer);
      this.pendingCommands.delete(command.id);
      rejectCommand(new PiAdapterError(`Pi RPC ${command.type} could not be sent`, "control", { command: command.type }));
    }
    return promise;
  }

  onStdout(value) {
    if (this.settled) return;
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    if (!chunk.length) return;
    if (this.queuedStdoutBytes + chunk.length > MAX_PENDING_STDOUT_BYTES || this.stdoutQueue.length >= MAX_PENDING_STDOUT_CHUNKS) {
      this.finishReject(new PiAdapterError("Pi stdout backlog exceeds the progress delivery limit", "output-limit", {
        stream: "stdout", maxPendingBytes: MAX_PENDING_STDOUT_BYTES, maxPendingChunks: MAX_PENDING_STDOUT_CHUNKS,
      }));
      return;
    }
    this.stdoutQueue.push({ chunk, offset: 0 });
    this.queuedStdoutBytes += chunk.length;
    this.drainStdout();
  }

  drainStdout() {
    if (this.settled || this.progressPending || this.drainingStdout) return;
    this.drainingStdout = true;
    try {
      while (this.stdoutQueue.length && !this.settled && !this.progressPending) {
        const entry = this.stdoutQueue[0];
        const { chunk, offset } = entry;
        const newline = chunk.indexOf(10, offset);
        const end = newline < 0 ? chunk.length : newline;
        const size = end - offset;
        if (this.stdoutBytes + size > MAX_LINE_BYTES) {
          this.finishReject(new PiAdapterError("Pi stdout line exceeds maxLineBytes", "output-limit", {
            stream: "stdout", maxLineBytes: MAX_LINE_BYTES,
          }));
          return;
        }
        let line;
        if (!this.stdoutBytes && newline >= 0) line = chunk.toString("utf8", offset, end);
        else {
          this.stdoutBuffer ||= Buffer.allocUnsafe(MAX_LINE_BYTES);
          chunk.copy(this.stdoutBuffer, this.stdoutBytes, offset, end);
          this.stdoutBytes += size;
          if (newline >= 0) {
            line = this.stdoutBuffer.toString("utf8", 0, this.stdoutBytes);
            this.stdoutBytes = 0;
          }
        }
        entry.offset = newline < 0 ? chunk.length : newline + 1;
        this.queuedStdoutBytes -= entry.offset - offset;
        if (entry.offset === chunk.length) this.stdoutQueue.shift();
        if (line !== undefined) this.handleLine(line);
      }
    } finally {
      this.drainingStdout = false;
    }
    if (this.settled || this.progressPending) return;
    if (this.closeInfo) {
      this.flushStdout();
      if (this.progressPending) return;
      this.finishClose();
    }
    if (this.pendingResult) this.finishResolve(this.pendingResult);
  }

  finishClose() {
    if (this.settled) return;
    const details = { ...this.closeInfo, stderr: this.stderrText() };
    if (this.abortRequested) {
      this.finishReject(new PiAdapterError("Pi RPC process aborted", "aborted", { ...details, aborted: true }));
    } else if (this.timeoutRequested) {
      this.finishReject(new PiAdapterError("Pi RPC process timed out", "timeout", { ...details, timedOut: true }));
    } else if (!this.progressPending) {
      if (this.terminalSeen) this.finishTerminal();
      else this.finishReject(new PiAdapterError(`Pi RPC process exited before terminal event (code ${details.code})`, "transport", details));
    }
  }

  progressFailure(error) {
    this.finishReject(new PiAdapterError(`Pi progress callback failed: ${diagnostic(error?.message || String(error))}`, "transport", {
      phase: "progress-callback",
    }));
  }

  reportProgress(event) {
    if (this.settled) return false;
    if (!this.onProgress) return true;
    try {
      const completion = this.onProgress(event);
      if (completion && typeof completion.then === "function") {
        // Pause between lines, including lines in the current chunk. A slow
        // persistence callback must not build an unbounded Promise backlog.
        this.progressPending = true;
        Promise.resolve(completion).then(() => {
          this.progressPending = false;
          if (this.settled) return;
          this.drainStdout();
          if (!this.progressPending && !this.settled) this.child.stdout?.resume?.();
        }, (error) => {
          this.progressPending = false;
          this.progressFailure(error);
        }).catch((error) => this.progressFailure(error));
        this.child.stdout?.pause?.();
      }
    } catch (error) {
      this.progressFailure(error);
    }
    return !this.settled;
  }

  flushStdout() {
    if (!this.stdoutBytes || this.settled) return;
    const line = this.stdoutBuffer.toString("utf8", 0, this.stdoutBytes);
    this.stdoutBytes = 0;
    this.stdoutBuffer = null;
    this.handleLine(line);
  }

  handleLine(line) {
    if (!line.trim()) return;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      this.reportProgress({ type: "pi_stdout", line: diagnostic(line) });
      return;
    }
    this.handle(value);
  }

  handle(value) {
    if (this.settled || !isObject(value)) return;
    this.eventSummary.count += 1;
    const type = value.type ?? value.event?.type ?? value.event?.event?.type;
    if (typeof type === "string" && !this.eventTypes.has(type)) {
      if (type.length > MAX_EVENT_TYPE_CHARS || this.eventTypes.size >= MAX_EVENT_TYPES) {
        this.finishReject(new PiAdapterError("Pi event types exceed the summary limit", "output-limit", {
          maxEventTypes: MAX_EVENT_TYPES, maxEventTypeChars: MAX_EVENT_TYPE_CHARS,
        }));
        return;
      }
      this.eventTypes.add(type);
      this.eventSummary.types.push(type);
      if (this.eventSummary.types.length > 20) this.eventSummary.types.shift();
    }
    this.recentEvents.push({ type: typeof type === "string" ? type : null, command: boundedProviderText(value.command, 256), id: boundedProviderText(value.id, 256) });
    if (this.recentEvents.length > 20) this.recentEvents.shift();
    if (!this.reportProgress(value)) return;
    if (value.type === "response") {
      const pending = value.id ? this.pendingCommands.get(value.id) : null;
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingCommands.delete(value.id);
        if (value.success) pending.resolve(value);
        else pending.reject(new PiAdapterError(
          typeof value.error === "string" ? diagnostic(value.error) : `Pi RPC command ${boundedProviderText(value.command, 256)} failed`,
          "control",
          { command: boundedProviderText(value.command, 256), response: diagnostic(value) },
        ));
        return;
      }
      if (!value.success) {
        const message = typeof value.error === "string" ? diagnostic(value.error) : `Pi RPC command ${boundedProviderText(value.command, 256)} failed`;
        if (value.command === "prompt") {
          const providerFailure = this.providerFailure(value, message);
          if (providerFailure) {
            this.finishReject(providerFailure);
            return;
          }
        }
        const kind = value.command === "prompt" ? "downstream" : "transport";
        this.finishReject(new PiAdapterError(message, kind, { command: boundedProviderText(value.command, 256), response: diagnostic(value) }));
        return;
      }
      if (value.command === "prompt") this.promptAccepted = true;
      if (value.command === "get_state") {
        this.state = retainedState(value.data);
        if (value.id === rpcCommandId(this.requestId, "state") && !this.promptDispatched) {
          try {
            if (!this.state?.model?.id || !this.state?.model?.provider) {
              throw new PiAdapterError("Pi did not report its default model before prompt dispatch", "policy");
            }
            if (this.forkSource && (!this.state.sessionId || this.state.sessionId === this.forkSource)) {
              throw executionError("sessionAction", "Pi did not report a new session ID for the fork");
            }
            if (this.prompt.images && !(Array.isArray(this.state.model.input) && this.state.model.input.includes("image"))) {
              throw executionError("attachments", "Pi's active model does not advertise image input");
            }
            rejectClaudeRoute(this.state.model);
          } catch (error) {
            this.finishReject(error);
            return;
          }
          this.promptDispatched = true;
          this.send(this.prompt);
        }
      }
      if (value.command === "get_session_stats") {
        this.stats = value.data ?? null;
        if (this.terminalSeen) this.terminalUsageReceived = true;
      }
      if (value.command === "get_last_assistant_text") {
        this.lastAssistantText = retainedText(value.data?.text);
        if (this.terminalSeen) this.terminalFinalReceived = true;
      }
      if (this.terminalSeen && this.terminalFinalReceived && this.terminalUsageReceived) {
        this.finishTerminal();
      }
      return;
    }
    if (value.type === "message_end") this.observeMessage(value.message);
    if (value.type === "turn_end") this.observeMessage(value.message);
    if (value.type === "agent_end" && Array.isArray(value.messages)) {
      for (const message of value.messages) this.observeMessage(message);
    }
    if (value.type === "agent_settled" && !this.terminalSeen) {
      this.terminalSeen = true;
      this.send({ type: "get_state", id: rpcCommandId(this.requestId, "terminal-state") });
      this.send({ type: "get_last_assistant_text", id: rpcCommandId(this.requestId, "final") });
      this.send({ type: "get_session_stats", id: rpcCommandId(this.requestId, "usage") });
      if (this.settled) return;
      this.terminalFallbackTimer = setTimeout(() => {
        if (!this.settled && (this.lastAssistantText?.nonempty || this.assistantText?.nonempty)) {
          this.finishTerminal();
        }
      }, 1_000);
      this.terminalFallbackTimer.unref?.();
    }
    if (value.type === "extension_error") {
      this.finishReject(new PiAdapterError(diagnostic(value.message) || "Pi extension failed", "downstream", { event: diagnostic(value) }));
    }
  }

  /**
   * Classify an explicit provider/model failure from a Pi JSONL event: an
   * assistant message that stopped with an error, or a failed prompt response.
   * Returns a PiAdapterError with kind "provider-auth" or "unavailable", or
   * null so callers keep their existing downstream/transport mapping.
   */
  providerFailure(source, fallbackReason) {
    const event = typeof source === "string" ? { error: source } : source;
    const extracted = providerErrorFromEvent(event) || providerErrorFromEvent({ error: event?.errorMessage || event?.error });
    if (!extracted) return null;
    const classification = classifyProviderFailure(extracted);
    if (!classification) return null;
    const providerName = firstProviderName(event?.provider, event?.error?.provider, this.state?.model?.provider, this.provider);
    const namedProvider = providerName ? boundedProviderText(providerName, 80) : null;
    const status = extracted.status ?? null;
    const reason = boundedProviderText(extracted.message || fallbackReason || "Pi provider request failed");
    const label = classification.kind === "provider-auth" ? "provider authorization" : "model availability";
    return new PiAdapterError(
      `Pi ${label} failure${namedProvider ? ` for ${namedProvider}` : ""}${status !== null ? ` (HTTP ${status})` : ""}: ${reason}`,
      classification.kind,
      {
        category: classification.category,
        provider: namedProvider,
        status,
        hint: piProviderHint(classification, namedProvider),
      },
    );
  }

  observeMessage(message) {
    if (this.settled) return;
    if (message?.role === "assistant") {
      if (message.stopReason === "error" || message.errorMessage) {
        const reason = diagnostic(message.errorMessage) || "Pi model request failed";
        const providerFailure = this.providerFailure(message, reason);
        if (providerFailure) {
          this.finishReject(providerFailure);
          return;
        }
        this.finishReject(new PiAdapterError(reason, "downstream", { stopReason: message.stopReason || "error" }));
        return;
      }
      const text = textFromMessage(message);
      if (text.trim()) this.assistantText = retainedText(text);
    }
  }

  stop(reason) {
    if (this.settled || this.abortRequested || this.timeoutRequested) return;
    if (reason === "aborted") this.abortRequested = true;
    if (reason === "timeout") this.timeoutRequested = true;
    // Sending abort can synchronously emit terminal events or fail. The stop
    // flags must already be latched before either can attempt settlement.
    if (!this.exited && !this.closeInfo) this.send({ type: "abort", id: rpcCommandId(this.requestId, reason) });
    this.finishClose();
  }

  stopError() {
    if (!this.abortRequested && !this.timeoutRequested) return null;
    return new PiAdapterError(this.abortRequested ? "Pi RPC process aborted" : "Pi RPC process timed out",
      this.abortRequested ? "aborted" : "timeout", {
        ...this.closeInfo,
        stderr: this.stderrText(),
        aborted: this.abortRequested,
        timedOut: this.timeoutRequested,
      });
  }

  finishTerminal() {
    if (!this.terminalSeen || this.settled) return;
    if (this.abortRequested || this.timeoutRequested) {
      this.finishClose();
      return;
    }
    const trailingAssistant = this.lastAssistantText?.nonempty
      ? this.lastAssistantText
      : this.assistantText?.nonempty ? this.assistantText : null;
    if (trailingAssistant?.overflow) {
      this.finishReject(new PiAdapterError("Pi final output exceeds the retained protocol limit", "output-limit", { maxChars: MAX_PROTOCOL_TEXT_CHARS }));
      return;
    }
    const finalText = trailingAssistant?.text || "";
    if (!finalText) {
      this.finishReject(new PiAdapterError("Pi RPC completed without final downstream output", "downstream", {
        terminal: true,
        events: this.recentEvents,
      }));
      return;
    }
    this.finishResolve({
      finalText,
      state: this.state,
      stats: this.stats,
      workflowRunId: this.state?.workflowRunId ?? this.state?.runId ?? null,
      eventSummary: this.eventSummary,
    });
  }

  finishResolve(value) {
    if (this.settled) return;
    if (this.abortRequested || this.timeoutRequested) {
      this.finishClose();
      return;
    }
    if (this.progressPending || this.drainingStdout || this.stdoutQueue.length) {
      this.pendingResult = value;
      return;
    }
    this.settled = true;
    this.cleanup();
    if (!this.exited && !this.closeInfo) killChild(this.child);
    this.resolve(value);
  }

  finishReject(error) {
    if (this.settled) return;
    error = this.stopError() || error;
    this.settled = true;
    this.cleanup();
    if (!this.exited && !this.closeInfo) killChild(this.child);
    this.reject(error);
  }

  cleanup() {
    this.stdoutBuffer = null;
    this.stdoutBytes = 0;
    this.stdoutQueue = [];
    this.queuedStdoutBytes = 0;
    this.pendingResult = null;
    this.child?.stdout?.resume?.();
    clearTimeout(this.timer);
    clearTimeout(this.terminalFallbackTimer);
    this.signal?.removeEventListener("abort", this.abortListener);
    for (const pending of this.pendingCommands.values()) {
      clearTimeout(pending.timer);
      pending.reject(new PiAdapterError("Pi RPC control channel closed before acknowledgement", "control", {
        uncertain: true,
      }));
    }
    this.pendingCommands.clear();
  }
}

export class PiAdapter {
  constructor(options = {}) {
    this.launch = harnessLaunch("pi", options.launch || options.command || options.executable || options.piExecutable);
    this.spawnFn = options.spawnFn || spawnNativeCommand;
    this.env = options.env;
    this.activeRun = null;
  }

  async control(command) {
    if (command.kind === "reroute" && isClaudeRoute(command.route)) rejectClaudeRoute(command.route);
    const deadline = Date.now() + 10_000;
    while (!this.activeRun && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const rpc = this.activeRun;
    if (!rpc) throw new PiAdapterError("Pi RPC control channel is not ready", "control");
    if (command.kind === "message") {
      const type = command.delivery === "follow_up" ? "follow_up" : "steer";
      const response = await rpc.sendAndWait({ type, id: command.commandId, message: command.message });
      return { harness: "pi", command: response.command || type, delivery: command.delivery };
    }
    if (command.kind === "reroute") {
      const modelResponse = await rpc.sendAndWait({
        type: "set_model",
        id: `${command.commandId}:model`,
        provider: command.route.provider,
        modelId: command.route.model,
      });
      let messageResponse = null;
      if (command.message) {
        const type = command.delivery === "follow_up" ? "follow_up" : "steer";
        messageResponse = await rpc.sendAndWait({
          type,
          id: `${command.commandId}:message`,
          message: command.message,
        });
      }
      return {
        harness: "pi",
        command: modelResponse.command || "set_model",
        delivery: command.message ? command.delivery : null,
        messageCommand: messageResponse?.command || null,
        effect: "next_model_request",
      };
    }
    throw new PiAdapterError(`unsupported Pi control kind: ${command.kind}`, "control");
  }

  async run(request, options = {}) {
    assertPromptOnlyWorkflow("pi", request?.workflow);
    request = validateAdapterExecution(request, "pi");
    const { sessionId, sessionAction, instructions, attachments } = request.execution;
    const fork = sessionAction === "fork";
    if (isClaudeRoute(request.route)) rejectClaudeRoute(request.route);
    const { tools: toolPolicy } = normalizePolicyControls(request.policy || {});
    const { allow, deny = [] } = toolPolicy;
    if (allow !== undefined) throw new PiAdapterError("Pi supports policy.tools.deny only for explicit tool policies", "policy");
    if (deny.some((name) => !READ_TOOLS.includes(name) && !WRITE_TOOLS.includes(name))) {
      throw new PiAdapterError("Pi policy.tools.deny accepts only exact built-in tool names", "policy");
    }
    if (deny.length) {
      const help = await runProcess(this.launch.command, [...(this.launch.args || []), "--help"], {
        cwd: request.cwd,
        env: mergeProcessEnv(this.env),
        spawnFn: this.spawnFn,
        signal: options.signal,
        timeoutMs: Math.min(request.execution?.timeoutMs ?? DEFAULT_TIMEOUT_MS, 10_000),
      });
      if (!["--exclude-tools", "--no-extensions", "--no-mcp", "--no-tools"].every((flag) => help.stdout.includes(flag))) {
        throw new PiAdapterError("Installed Pi version cannot enforce policy.tools.deny; required CLI flags are missing", "policy");
      }
    }
    const args = [
      "--mode",
      "rpc",
      ...routeArgs(request.route),
    ];
    const executable = this.launch.command;
    if (sessionId) args.push(fork ? "--fork" : "--session-id", sessionId);
    const tools = new Set(READ_TOOLS);
    if (request.policy?.write) {
      const requested = Array.isArray(toolPolicy) && toolPolicy.length ? toolPolicy : WRITE_TOOLS;
      for (const tool of requested) tools.add(tool);
    }
    for (const name of deny) tools.delete(name);
    if (tools.size) args.push("--tools", [...tools].join(","));
    else args.push("--no-tools");
    if (deny.length) args.push("--exclude-tools", deny.join(","), "--no-extensions", "--no-mcp");
    const env = mergeProcessEnv({ ...(this.launch.env || {}), ...this.env });
    if (fork || instructions !== undefined) {
      await requireExecutionFlags({ launch: this.launch, request, env, spawnFn: this.spawnFn, signal: options.signal }, [], [
        ...(fork ? [["sessionAction", "--fork", "\\s+<path\\|id>"]] : []),
        ...(instructions !== undefined ? [["instructions", "--append-system-prompt"]] : []),
      ]);
    }
    const images = attachments?.length
      ? await Promise.all(attachments.map(async ({ path }) => ({
        type: "image", mimeType: attachmentMimeType(path), data: (await readAttachment(path)).toString("base64"),
      })))
      : [];
    let scratch, rpc;
    try {
      if (instructions !== undefined) {
        // Pi treats the flag value as a filename when it exists.
        scratch = await mkdtemp(join(tmpdir(), "harnest-pi-instructions-"));
        const path = join(scratch, "instructions.txt");
        await writeFile(path, instructions, { mode: 0o600, flag: "wx" });
        args.push("--append-system-prompt", path);
      }
      rpc = new RpcRun({
        executable,
        args: [...(this.launch.args || []), ...args],
        cwd: request.cwd,
        env,
        spawnFn: this.spawnFn,
        signal: options.signal,
        timeoutMs: request.execution?.timeoutMs || DEFAULT_TIMEOUT_MS,
        onProgress: options.onProgress,
        requestId: request.requestId,
        provider: request.route?.provider ?? null,
      }).setPrompt(requestPrompt(request), images, fork ? sessionId : null);
      this.activeRun = rpc;
      const value = await rpc.run();
      const state = value.state || {};
      const model = state.model || {};
      const result = structuredResult(value.finalText, { eventSummary: value.eventSummary });
      if (result.finalText.length > MAX_FINAL_TEXT_CHARS) {
        throw new PiAdapterError("Pi final output exceeds the result limit", "output-limit", { maxChars: MAX_FINAL_TEXT_CHARS });
      }
      return {
        sessionId: state.sessionId ?? (fork ? null : sessionId ?? null),
        workflowRunId: value.workflowRunId,
        route: {
          ...request.route,
          harness: "pi",
          provider: model.provider ?? request.route?.provider ?? null,
          model: model.id ?? request.route?.model ?? null,
          thinking: state.thinkingLevel ?? request.route?.thinking ?? null,
        },
        result,
        usage: usageFrom(value.state, value.stats) || value.stats || null,
        usageSummary: summarizeUsage("pi", usageFrom(value.state, value.stats) || value.stats || null),
      };
    } finally {
      if (this.activeRun === rpc) this.activeRun = null;
      if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
