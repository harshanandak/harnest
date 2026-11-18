import { spawn as nodeSpawn } from "node:child_process";

import { boundedProviderText, mergeProcessEnv, terminateProcessTree } from "../process.mjs";

const DEFAULT_MAX_LINE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_MAX_PENDING_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_PENDING_CHUNKS = 256;
const MAX_PENDING_REQUESTS = 64;
const MAX_SEEN_IDS = 4096;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value, fallback, name) {
  const result = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(result) || result <= 0) throw new RangeError(`${name} must be a positive safe integer`);
  return result;
}

function messageText(error) {
  return error instanceof Error ? error.message : String(error ?? "");
}

function transportError(message, kind = "transport", details = {}) {
  return Object.assign(new Error(message), { name: "AcpTransportError", details: { kind, ...details } });
}

export class AcpRpcError extends Error {
  constructor(message, { code = null, data = null, method = null } = {}) {
    super(boundedProviderText(message, 1_000) || "ACP request failed");
    this.name = "AcpRpcError";
    this.code = Number.isFinite(Number(code)) ? Number(code) : null;
    this.data = data ?? null;
    this.method = method;
  }
}

/**
 * Bounded newline-delimited JSON-RPC transport for one owned ACP process.
 * Incoming handlers are awaited in wire order so durable progress callbacks
 * apply backpressure to stdout instead of accumulating promises.
 */
export class AcpTransport {
  constructor(options = {}) {
    this.command = options.command;
    this.args = Array.isArray(options.args) ? [...options.args] : [];
    this.cwd = options.cwd;
    this.env = mergeProcessEnv(options.env);
    this.spawn = options.spawn || options.spawnFn || nodeSpawn;
    this.maxLineBytes = positiveInteger(options.maxLineBytes, DEFAULT_MAX_LINE_BYTES, "maxLineBytes");
    this.maxStderrBytes = positiveInteger(options.maxStderrBytes, DEFAULT_MAX_STDERR_BYTES, "maxStderrBytes");
    this.maxPendingBytes = positiveInteger(options.maxPendingStdoutBytes, DEFAULT_MAX_PENDING_BYTES, "maxPendingStdoutBytes");
    this.maxPendingChunks = positiveInteger(options.maxPendingStdoutChunks, DEFAULT_MAX_PENDING_CHUNKS, "maxPendingStdoutChunks");
    this.pauseBytes = Math.max(1, Math.floor(this.maxPendingBytes / 2));
    this.resumeBytes = Math.max(0, Math.floor(this.maxPendingBytes / 4));
    this.child = null;
    this.closed = false;
    this.closing = false;
    this.failed = null;
    this.exitInfo = null;
    this.closeObserved = false;
    this.nextId = 0;
    this.pending = new Map();
    this.seenIncomingIds = new Set();
    this.seenIncomingOrder = [];
    this.settledResponseIds = new Set();
    this.responseOrder = [];
    this.stdoutQueue = [];
    this.queuedBytes = 0;
    this.draining = false;
    this.lineParts = [];
    this.lineBytes = 0;
    this.stderrChunks = [];
    this.stderrBytes = 0;
    this.onRequest = null;
    this.onNotification = null;
    this.teardown = null;
    this.failurePromise = new Promise((resolve) => { this.resolveFailure = resolve; });
  }

  setHandlers({ onRequest, onNotification } = {}) {
    this.onRequest = typeof onRequest === "function" ? onRequest : null;
    this.onNotification = typeof onNotification === "function" ? onNotification : null;
  }

  failure() {
    return this.failurePromise;
  }

  async start() {
    if (this.child) throw transportError("ACP transport has already started");
    let child;
    try {
      child = this.spawn(this.command, this.args, {
        cwd: this.cwd,
        env: this.env,
        windowsHide: true,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      throw transportError(`ACP process could not start: ${boundedProviderText(messageText(error))}`, "transport", { cause: error });
    }
    this.child = child;
    child.stdout?.on?.("data", (chunk) => this.#acceptStdout(chunk));
    child.stderr?.on?.("data", (chunk) => this.#acceptStderr(chunk));
    child.stdin?.on?.("error", (error) => {
      if (this.closing || this.closed) return;
      this.fail(transportError(`ACP stdin failed: ${boundedProviderText(messageText(error))}`, "transport", {
        cause: error,
        stderr: this.stderr(),
      }));
    });
    child.stdout?.on?.("error", (error) => {
      if (this.closing || this.closed) return;
      this.fail(transportError(`ACP stdout failed: ${boundedProviderText(messageText(error))}`, "transport", { cause: error }));
    });
    child.stderr?.on?.("error", (error) => {
      if (this.closing || this.closed) return;
      this.fail(transportError(`ACP stderr failed: ${boundedProviderText(messageText(error))}`, "transport", { cause: error }));
    });
    child.once?.("error", (error) => {
      this.exitInfo = { code: error?.code ?? null, signal: null };
      this.fail(transportError(`ACP process failed: ${boundedProviderText(messageText(error))}`, "transport", {
        cause: error,
        stderr: this.stderr(),
      }));
    });
    child.once?.("close", (code, signal) => {
      this.closeObserved = true;
      this.exitInfo = { code: code ?? null, signal: signal ?? null };
      if (!this.closing && !this.closed) {
        this.fail(transportError("ACP process closed before the request completed", "transport", {
          code: code ?? null,
          signal: signal ?? null,
          stderr: this.stderr(),
        }));
      }
    });
  }

  #acceptStderr(value) {
    if (this.closed) return;
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    if (!chunk.length) return;
    this.stderrChunks.push(chunk);
    this.stderrBytes += chunk.length;
    while (this.stderrBytes > this.maxStderrBytes && this.stderrChunks.length) {
      const first = this.stderrChunks[0];
      const excess = this.stderrBytes - this.maxStderrBytes;
      if (first.length <= excess) {
        this.stderrChunks.shift();
        this.stderrBytes -= first.length;
      } else {
        this.stderrChunks[0] = first.subarray(excess);
        this.stderrBytes -= excess;
      }
    }
  }

  stderr() {
    return boundedProviderText(Buffer.concat(this.stderrChunks, this.stderrBytes).toString("utf8"), 4_000) || null;
  }

  #acceptStdout(value) {
    if (this.closed || this.failed) return;
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    if (!chunk.length) return;
    this.stdoutQueue.push(chunk);
    this.queuedBytes += chunk.length;
    if (this.queuedBytes > this.maxPendingBytes || this.stdoutQueue.length > this.maxPendingChunks) {
      this.fail(transportError("ACP stdout backlog exceeds the delivery limit", "output-limit", {
        maxPendingBytes: this.maxPendingBytes,
        maxPendingChunks: this.maxPendingChunks,
      }));
      return;
    }
    if (this.queuedBytes > this.pauseBytes) this.child?.stdout?.pause?.();
    if (!this.draining) void this.#drainStdout();
  }

  async #drainStdout() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (!this.closed && !this.failed && this.stdoutQueue.length) {
        const chunk = this.stdoutQueue.shift();
        this.queuedBytes -= chunk.length;
        let offset = 0;
        while (offset < chunk.length) {
          const newline = chunk.indexOf(10, offset);
          const end = newline < 0 ? chunk.length : newline;
          const segment = chunk.subarray(offset, end);
          if (this.lineBytes + segment.length > this.maxLineBytes) {
            this.fail(transportError("ACP stdout line exceeds maxLineBytes", "output-limit", {
              maxLineBytes: this.maxLineBytes,
            }));
            return;
          }
          if (segment.length) {
            this.lineParts.push(segment);
            this.lineBytes += segment.length;
          }
          offset = newline < 0 ? chunk.length : newline + 1;
          if (newline >= 0) {
            let line = "";
            if (this.lineBytes) {
              try {
                line = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(this.lineParts, this.lineBytes));
              } catch (error) {
                throw transportError("ACP stdout contains invalid UTF-8", "transport", { cause: error });
              }
            }
            this.lineParts = [];
            this.lineBytes = 0;
            await this.#handleLine(line);
            if (this.closed || this.failed) return;
          }
        }
      }
    } catch (error) {
      this.fail(error?.details?.kind ? error : transportError(
        `ACP message handler failed: ${boundedProviderText(messageText(error))}`,
        "transport",
        { cause: error },
      ));
    } finally {
      this.draining = false;
      if (!this.closed && !this.failed && this.queuedBytes <= this.resumeBytes) this.child?.stdout?.resume?.();
    }
  }

  async #handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw transportError("ACP wrote a non-JSON line to stdout", "transport", {
        line: boundedProviderText(trimmed, 400),
      });
    }
    if (!Array.isArray(parsed)) {
      const response = await this.#handleMessage(parsed, false);
      if (response) await this.write(response);
      return;
    }
    if (parsed.length === 0) {
      await this.write(this.#invalidRequest());
      return;
    }
    if (parsed.length > 1_000) {
      throw transportError("ACP wrote an invalid JSON-RPC batch", "transport");
    }
    const responses = [];
    for (const message of parsed) {
      const response = await this.#handleMessage(message, true);
      if (response) responses.push(response);
    }
    if (responses.length) await this.write(responses);
  }

  #invalidRequest() {
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } };
  }

  async #handleMessage(message, inBatch) {
    if (!isObject(message) || message.jsonrpc !== "2.0") {
      if (inBatch) return this.#invalidRequest();
      throw transportError("ACP wrote an invalid JSON-RPC message", "transport");
    }
    const hasId = Object.hasOwn(message, "id");
    if (hasId && message.id !== null && typeof message.id !== "string" && !Number.isSafeInteger(message.id)) {
      if (inBatch) return this.#invalidRequest();
      throw transportError("ACP wrote a JSON-RPC message with an invalid id", "transport");
    }
    const hasMethodProperty = Object.hasOwn(message, "method");
    const hasMethod = typeof message.method === "string" && message.method.length > 0;
    if (hasMethodProperty && !hasMethod) {
      if (inBatch) return this.#invalidRequest();
      throw transportError("ACP wrote a JSON-RPC message with an invalid method", "transport");
    }
    if (hasId && !hasMethod && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) {
      this.#resolveResponse(message);
      return null;
    }
    if (!hasMethod) {
      if (inBatch) return this.#invalidRequest();
      throw transportError("ACP wrote a message with neither method nor response id", "transport");
    }
    if (!hasId) {
      if (this.onNotification) await this.onNotification(message.method, message.params ?? {}, message);
      return null;
    }
    const token = `${typeof message.id}:${String(message.id)}`;
    if (this.seenIncomingIds.has(token)) {
      throw transportError(`ACP reused duplicate request id ${boundedProviderText(String(message.id), 100)}`, "transport");
    }
    this.#remember(this.seenIncomingIds, this.seenIncomingOrder, token);
    if (!this.onRequest) {
      return {
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: `method not found: ${message.method}` },
      };
    }
    try {
      const result = await this.onRequest(message.method, message.params ?? {}, message);
      return { jsonrpc: "2.0", id: message.id, result: result ?? {} };
    } catch (error) {
      if (error?.details?.fatal === true || error?.details?.phase === "progress") throw error;
      return {
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: Number.isFinite(Number(error?.rpcCode)) ? Number(error.rpcCode) : -32603,
          message: boundedProviderText(messageText(error), 1_000) || "ACP client callback failed",
          ...(error?.data === undefined || error?.data === null ? {} : { data: error.data }),
        },
      };
    }
  }

  #remember(set, order, token) {
    set.add(token);
    order.push(token);
    if (order.length > MAX_SEEN_IDS) set.delete(order.shift());
  }

  #resolveResponse(message) {
    const token = `${typeof message.id}:${String(message.id)}`;
    const pending = this.pending.get(token);
    if (!pending) {
      if (this.settledResponseIds.has(token)) {
        throw transportError(`ACP sent duplicate response id ${boundedProviderText(String(message.id), 100)}`, "transport");
      }
      throw transportError(`ACP sent unknown response id ${boundedProviderText(String(message.id), 100)}`, "transport");
    }
    this.pending.delete(token);
    clearTimeout(pending.timer);
    pending.signal?.removeEventListener?.("abort", pending.onAbort);
    this.#remember(this.settledResponseIds, this.responseOrder, token);
    if (isObject(message.error)) {
      pending.reject(new AcpRpcError(message.error.message, {
        code: message.error.code,
        data: message.error.data,
        method: pending.method,
      }));
      return;
    }
    if (!Object.hasOwn(message, "result")) {
      pending.reject(transportError(`ACP response for ${pending.method} has neither result nor error`, "transport"));
      return;
    }
    pending.resolve(message.result);
  }

  async write(message) {
    if (this.closed || this.closing || this.failed || !this.child?.stdin?.write) {
      throw this.failed ?? transportError("ACP connection is not writable", "transport", { uncertain: true });
    }
    const payload = `${JSON.stringify(message)}\n`;
    await new Promise((resolve, reject) => {
      let settled = false;
      const done = (error) => {
        if (settled) return;
        settled = true;
        if (error) reject(transportError(`ACP stdin write failed: ${boundedProviderText(messageText(error))}`, "transport", { cause: error }));
        else resolve();
      };
      try {
        this.child.stdin.write(payload, done);
      } catch (error) {
        done(error);
      }
    });
  }

  request(method, params, { signal, timeoutMs = 30_000 } = {}) {
    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      return Promise.reject(transportError("ACP has too many pending requests", "transport", { method }));
    }
    const id = ++this.nextId;
    const token = `number:${id}`;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(transportError(`ACP ${method} aborted`, "abort", { aborted: true, method }));
        return;
      }
      const entry = { method, resolve, reject, signal, onAbort: null, timer: null };
      entry.onAbort = () => {
        if (!this.pending.delete(token)) return;
        clearTimeout(entry.timer);
        reject(transportError(`ACP ${method} aborted`, "abort", { aborted: true, method }));
      };
      signal?.addEventListener?.("abort", entry.onAbort, { once: true });
      entry.timer = setTimeout(() => {
        if (!this.pending.delete(token)) return;
        signal?.removeEventListener?.("abort", entry.onAbort);
        reject(transportError(`ACP ${method} timed out`, "timeout", { timedOut: true, method }));
      }, timeoutMs);
      this.pending.set(token, entry);
      this.write({ jsonrpc: "2.0", id, method, params: params ?? {} }).catch((error) => {
        if (!this.pending.delete(token)) return;
        clearTimeout(entry.timer);
        signal?.removeEventListener?.("abort", entry.onAbort);
        reject(error);
      });
    });
  }

  notify(method, params) {
    return this.write({ jsonrpc: "2.0", method, params: params ?? {} });
  }

  respond(id, result) {
    return this.write({ jsonrpc: "2.0", id, result: result ?? {} });
  }

  respondError(id, code, message, data) {
    return this.write({
      jsonrpc: "2.0",
      id,
      error: { code, message, ...(data === undefined || data === null ? {} : { data }) },
    });
  }

  fail(error) {
    if (this.failed || this.closed) return;
    this.failed = error?.details?.kind ? error : transportError(messageText(error), "transport", { cause: error });
    this.resolveFailure(this.failed);
    for (const [token, entry] of this.pending) {
      this.pending.delete(token);
      clearTimeout(entry.timer);
      entry.signal?.removeEventListener?.("abort", entry.onAbort);
      entry.reject(this.failed);
    }
  }

  close() {
    if (this.teardown) return this.teardown;
    this.closing = true;
    for (const [token, entry] of this.pending) {
      this.pending.delete(token);
      clearTimeout(entry.timer);
      entry.signal?.removeEventListener?.("abort", entry.onAbort);
      entry.reject(transportError("ACP connection closed before response", "transport", { uncertain: true }));
    }
    const child = this.child;
    this.teardown = new Promise((resolve, reject) => {
      if (!child || this.closeObserved) {
        this.closed = true;
        resolve();
        return;
      }
      let timer;
      let forceTimer;
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(forceTimer);
        this.closed = true;
        resolve();
      };
      child.once?.("close", done);
      // ACP stdio processes should exit when their input closes. Give that
      // cooperative path a short window before terminating the owned child;
      // on Windows this also avoids racing an asynchronous taskkill helper.
      try { child.stdin?.end?.(); } catch { /* Force termination below. */ }
      forceTimer = setTimeout(() => terminateProcessTree(child), 250);
      forceTimer.unref?.();
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        clearTimeout(forceTimer);
        this.closed = true;
        reject(transportError("ACP process exit was not observed after termination", "transport", {
          phase: "cleanup",
          unsafeResume: true,
          exitObserved: false,
        }));
      }, 2_000);
    });
    return this.teardown;
  }
}

export const ACP_TRANSPORT_LIMITS = Object.freeze({
  maxLineBytes: DEFAULT_MAX_LINE_BYTES,
  maxStderrBytes: DEFAULT_MAX_STDERR_BYTES,
  maxPendingStdoutBytes: DEFAULT_MAX_PENDING_BYTES,
  maxPendingStdoutChunks: DEFAULT_MAX_PENDING_CHUNKS,
});
