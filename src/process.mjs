import { spawn as nodeSpawn } from "node:child_process";
import { withoutHarnestToken } from "./daemon-env.mjs";
import { NativeLaunchError, spawnNativeCommand, windowsSystemCommand } from "./launch-command.mjs";

export class ProcessError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ProcessError";
    this.details = details;
  }
}

const MAX_PROVIDER_TEXT_CHARS = 400;

// Harness children inherit the parent environment: a read-only policy changes
// what a run may write, never whether it can authenticate. Provider
// credentials (HOME/USERPROFILE/APPDATA/PATH, OPENCODE_API_KEY,
// OPENCODE_GO_API_KEY, ...) are resolved by the spawned harness itself, so
// overrides merge over process.env instead of replacing it. Values are never
// logged.
export function mergeProcessEnv(overrides = {}) {
  const env = { ...process.env };
  for (const [key, value] of Object.entries(overrides || {})) {
    if (value === undefined || value === null) continue;
    env[key] = value;
  }
  return withoutHarnestToken(env);
}

function redactedCredential(text, start, authorization) {
  const scheme = authorization && /^(?:bearer|basic)\s+/i.exec(text.slice(start));
  if (scheme) start += scheme[0].length;
  const opening = /^(\\*)(["'])/.exec(text.slice(start));
  if (!opening) {
    const token = /^[^\s,"';}]+/.exec(text.slice(start));
    return { end: start + (token?.[0].length || 0), text: token ? "[REDACTED]" : "" };
  }
  const depth = opening[1].length;
  const quote = opening[2];
  let end = start + opening[0].length;
  while (end < text.length && !/[\r\n]/.test(text[end])) {
    const escapeStart = end;
    while (text[end] === "\\") end++;
    const escapes = end - escapeStart;
    if (text[end] === quote) {
      // Fewer escapes belong to the enclosing JSON string. Only paired
      // backslash units at this encoding depth can precede a closing quote.
      if (escapes < depth) return { end: escapeStart, text: `${opening[0]}[REDACTED]` };
      if ((escapes - depth) % (2 * (depth + 1)) === 0) {
        return { end: end + 1, text: `${opening[0]}[REDACTED]${opening[0]}` };
      }
    }
    if (end >= text.length || /[\r\n]/.test(text[end])) break;
    end++;
  }
  // Truncated diagnostics still contain credentials. Preserve the missing
  // delimiter and the next line rather than requiring a closing quote.
  return { end, text: `${opening[0]}[REDACTED]` };
}

// Decode individual JSON string tokens, not the whole document, to preserve
// formatting and safely handle diagnostics that have been serialized repeatedly.
export function redactSecrets(value) {
  const text = typeof value === "string" ? value : "";
  const markers = /"|\b(?:(?:authorization|proxy-authorization|api[-_ ]?key|token|secret|password)(?:\\*["'])?\s*[:=]\s*|(?:bearer|basic)\s+)/gi;
  const parts = [];
  let copied = 0;
  let scanStrings = true;
  let match;
  while ((match = markers.exec(text))) {
    let prefix = match[0];
    let authorization = /^(?:proxy-)?authorization\b/i.test(prefix);
    if (prefix.startsWith('"')) {
      if (!scanStrings) continue;
      let end = markers.lastIndex;
      while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      if (end >= text.length) {
        // The remaining quotes are escaped inside this incomplete token.
        // Scan its credential markers once, without retrying every suffix.
        scanStrings = false;
        continue;
      }
      markers.lastIndex = end + 1;
      prefix = text.slice(match.index, markers.lastIndex);
      let decoded;
      let json = true;
      try { decoded = JSON.parse(prefix); }
      catch { decoded = prefix.slice(1, -1); json = false; }
      const field = /^(?:authorization|proxy-authorization|api[-_ ]?key|token|secret|password)$/i.test(decoded)
        && /^\s*:\s*/.exec(text.slice(markers.lastIndex));
      if (!field) {
        const redacted = redactSecrets(decoded);
        parts.push(text.slice(copied, match.index), redacted === decoded ? prefix : json ? JSON.stringify(redacted) : `"${redacted}"`);
        copied = markers.lastIndex;
        continue;
      }
      prefix += field[0];
      markers.lastIndex += field[0].length;
      authorization = /^(?:proxy-)?authorization$/i.test(decoded);
    }
    const redacted = redactedCredential(text, markers.lastIndex, authorization);
    parts.push(text.slice(copied, match.index), prefix, redacted.text);
    copied = markers.lastIndex = redacted.end;
  }
  return (parts.join("") + text.slice(copied))
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/\b(?:gh[pousr]|glpat|xox[baprs])[-_][A-Za-z0-9_-]{10,}\b/g, "[REDACTED]");
}

export function boundedProviderText(value, maxChars = MAX_PROVIDER_TEXT_CHARS) {
  const redacted = redactSecrets(value).replace(/\s+/g, " ").trim();
  if (!redacted) return "";
  return redacted.length > maxChars ? `${redacted.slice(0, maxChars)}…` : redacted;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

export function normalizeProviderErrorType(value) {
  const text = firstString(value);
  if (!text) return null;
  if (/^provider[._-]?auth/i.test(text) || /^auth(?:entication)?[._-]?error/i.test(text)) return "provider.auth";
  if (/^provider[._-]?region/i.test(text) || /^region[._-]?error/i.test(text)) return "provider.region";
  if (/^model[._-]?not[._-]?found/i.test(text) || /^not[._-]?found[._-]?error/i.test(text)) return "model.not_found";
  if (/^model[._-]?unavailable/i.test(text)) return "model.unavailable";
  return text;
}

/**
 * Extract the provider error payload from a harness error event. OpenCode
 * emits {"type":"error","error":{"type":"provider.auth","message":"...",
 * "status":401}}; Pi reports the same shape through its JSONL error events.
 * Returns { type, message, status } or null when the event carries no error.
 */
export function providerErrorFromEvent(event) {
  if (!event || typeof event !== "object") return null;
  const raw = event.error && typeof event.error === "object" ? event.error : null;
  const data = raw?.data && typeof raw.data === "object" ? raw.data : null;
  const nested = data?.error && typeof data.error === "object" ? data.error : null;
  const type = firstString(raw?.type, data?.type, raw?.name, data?.name, nested?.type);
  const message = firstString(
    raw?.message,
    data?.message,
    nested?.message,
    typeof event.error === "string" ? event.error : null,
    typeof event.message === "string" ? event.message : null,
  );
  const status = firstFiniteNumber(raw?.status, raw?.statusCode, data?.status, data?.statusCode, nested?.status, nested?.statusCode, event.status);
  if (!type && !message && status === null) return null;
  return { type: normalizeProviderErrorType(type), message: boundedProviderText(message), status };
}

/**
 * Classify a provider/model failure reported by a harness child. Kinds:
 * - "provider-auth" for authentication, billing, and region/opt-in rejections
 * - "unavailable" for model-not-found / unavailable
 * - null for anything else, so the adapter keeps its own downstream mapping.
 */
export function classifyProviderFailure(input = {}) {
  const type = typeof input.type === "string" ? input.type.toLowerCase() : "";
  const message = typeof input.message === "string" ? input.message : "";
  const status = firstFiniteNumber(input.status);
  const haystack = `${type} ${message}`.toLowerCase();
  const region = /provider[._-]?region/.test(type)
    || /(^|[^a-z])region([^a-z]|$)/.test(haystack)
    || /\bopt[\s-]?in\b/.test(haystack);
  const billing = /insufficient\s+(?:balance|credit|credits|funds|quota)/.test(haystack)
    || /\bbilling\b/.test(haystack)
    || /payment\s+required/.test(haystack);
  const auth = /provider[._-]?auth/.test(type)
    || (status !== null && [401, 402, 403].includes(status))
    || /\binvalid\s+api[\s_-]?key\b/.test(haystack)
    || /\b(?:missing|no|without)\s+(?:api[\s_-]?key|credentials?)\b/.test(haystack)
    || /\bcredentials?\s+(?:are\s+)?(?:not\s+(?:configured|ready|set|found)|missing|required)\b/.test(haystack)
    || /\bcredentials?_not_configured\b/.test(haystack)
    || /\bunauthori[sz]ed\b/.test(haystack)
    || /\bunauthenticated\b/.test(haystack)
    || /\bnot\s+authenticated\b/.test(haystack)
    || /\bauthentication\s+(?:failed|required|error)\b/.test(haystack)
    || /\bnot\s+logged\s+in\b/.test(haystack)
    || /\bapi[\s_-]?key\b/.test(haystack)
    || billing
    || region;
  if (auth) {
    return { kind: "provider-auth", category: region ? "region" : billing ? "billing" : "auth" };
  }
  const modelMentioned = /\bmodel\b/.test(haystack);
  const unavailable = /model[._-]?not[._-]?found/.test(type)
    || /model[._-]?unavailable/.test(type)
    || /model[._-]?unsupported/.test(type)
    || /\bunknown\s+model\b/.test(haystack)
    || /\bno\s+such\s+model\b/.test(haystack)
    || /\bunsupported\s+model\b/.test(haystack)
    || (modelMentioned && /\bnot\s+found\b/.test(haystack))
    || (modelMentioned && /\bunavailable\b/.test(haystack))
    || (modelMentioned && /\bdoes\s+not\s+exist\b/.test(haystack))
    || /\bnot\s+found\b/.test(haystack)
    || /\bdoes\s+not\s+exist\b/.test(haystack);
  if (unavailable) return { kind: "unavailable", category: "not-found" };
  return null;
}

function killChild(child) {
  try { child.kill(); } catch { /* The process already exited. */ }
}

function killWindowsTree(child) {
  const isRunning = () => !child.killed && child.exitCode == null && child.signalCode == null;
  // A failed spawn can emit both error and close.
  let warned = false;
  const onFailure = () => {
    if (warned) return;
    warned = true;
    console.warn("Windows process tree cleanup failed. Descendants may survive.");
    if (isRunning()) killChild(child);
  };
  if (!isRunning()) {
    onFailure();
    return;
  }
  try {
    const killer = nodeSpawn(windowsSystemCommand("taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true, shell: false, stdio: "ignore", timeout: 3000,
    });
    killer.on("error", onFailure);
    killer.once("close", (code) => { if (code !== 0) onFailure(); });
    killer.unref?.();
  } catch { onFailure(); }
}

export function terminateProcessTree(child) {
  if (!child || child.killed) return;
  if (process.platform === "win32" && Number.isInteger(child.pid) && child.pid > 0) {
    killWindowsTree(child);
    return true;
  }
  killChild(child);
}

function byteLimit(value, fallback, name) {
  const limit = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError(`${name} must be a finite positive integer`);
  return limit;
}

function outputTail(limit) {
  let buffer;
  let cursor = 0;
  let bytes = 0;
  return {
    append(chunk) {
      bytes += chunk.length;
      if (!chunk.length) return;
      buffer ||= Buffer.allocUnsafe(limit);
      if (chunk.length >= limit) {
        chunk.copy(buffer, 0, chunk.length - limit);
        cursor = 0;
      } else {
        const first = Math.min(chunk.length, limit - cursor);
        chunk.copy(buffer, cursor, 0, first);
        chunk.copy(buffer, 0, first);
        cursor = (cursor + chunk.length) % limit;
      }
    },
    snapshot() {
      const truncated = bytes > limit;
      const tail = !buffer ? Buffer.alloc(0) : bytes < limit ? buffer.subarray(0, bytes)
        : Buffer.concat([buffer.subarray(cursor), buffer.subarray(0, cursor)], limit);
      let start = 0;
      // A byte tail can begin inside a UTF-8 code point. Drop its continuation
      // bytes rather than manufacturing replacement characters at the cut.
      if (truncated) while (start < tail.length && (tail[start] & 0xc0) === 0x80) start++;
      return { text: tail.toString("utf8", start), bytes, truncated };
    },
  };
}

export async function runProcess(command, args, options = {}) {
  const maxStdoutBytes = byteLimit(options.maxStdoutBytes, 1024 * 1024, "maxStdoutBytes");
  const maxStderrBytes = byteLimit(options.maxStderrBytes, 64 * 1024, "maxStderrBytes");
  const maxLineBytes = byteLimit(options.maxLineBytes, 2 * 1024 * 1024, "maxLineBytes");
  const stdout = outputTail(maxStdoutBytes);
  const stderr = outputTail(maxStderrBytes);
  const output = (code = null, signal = null) => {
    const out = stdout.snapshot();
    const err = stderr.snapshot();
    return {
      code, signal,
      stdout: out.text, stderr: err.text,
      stdoutBytes: out.bytes, stderrBytes: err.bytes,
      stdoutTruncated: out.truncated, stderrTruncated: err.truncated,
    };
  };
  if (options.signal?.aborted) throw new ProcessError("process aborted", { ...output(), kind: "abort", aborted: true });
  return new Promise((resolve, reject) => {
    const spawnFn = options.spawnFn || spawnNativeCommand;
    let child;
    try {
      child = spawnFn(command, args, {
        cwd: options.cwd,
        env: mergeProcessEnv(options.env),
        windowsHide: true,
        shell: false,
        stdio: [options.stdinLines ? "pipe" : "ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(error instanceof NativeLaunchError ? error
        : new ProcessError(error.message, { ...output(), kind: "transport", code: error.code ?? null, cause: error }));
      return;
    }
    let settled = false;
    let exited = false;
    let closed = false;
    let closeCode;
    let closeSignal;
    let finishing = false;
    let failure;
    let lineBuffer;
    let lineBytes = 0;
    let pendingChunk;
    const pendingEvents = [];
    let pendingEventBytes = 0;
    const maxPendingStdoutBytes = 4 * 1024 * 1024;
    const maxPendingStdoutChunks = 256;
    let pendingCallback = false;
    let batchPromises = [];
    let batchLines = 0;
    let batchBytes = 0;
    let reading = false;
    const readableMode = typeof child.stdout?.read === "function";
    let input;
    let inputEnded = false;
    let timer;
    let killTimer;

    const stopInput = () => {
      child.stdin?.removeListener?.("drain", sendInput);
      const iterator = input;
      input = null;
      try { iterator?.return?.(); } catch { /* Preserve the original failure. */ }
      child.stdin?.destroy?.();
    };
    const fail = (error) => {
      if (settled || failure) return;
      failure = error;
      pendingChunk = null;
      pendingEvents.length = 0;
      pendingEventBytes = 0;
      pendingCallback = false;
      batchPromises = [];
      batchLines = batchBytes = 0;
      stopInput();
      // Windows tree cleanup handles its own timeouts and direct-child fallback.
      if (!exited && !closed && !terminateProcessTree(child)) {
        // SIGTERM may be ignored; do not resolve a failed run while it is alive.
        killTimer = setTimeout(() => {
          if (!exited && !closed) {
            try { child.kill("SIGKILL"); } catch { /* Already exited. */ }
          }
        }, 1000);
        killTimer.unref?.();
      }
      if (readableMode) drainStdout();
      else child.stdout?.resume?.();
      finishIfReady();
    };
    const abort = () => fail(new ProcessError("process aborted", { kind: "abort", aborted: true }));
    const stdinError = (error) => fail(new ProcessError(`harness stdin write failed: ${error.message}`, {
      kind: "transport", code: error.code ?? null, cause: error,
    }));
    const sendInput = () => {
      try {
        while (input && !settled && !failure && !exited && !child.stdin?.destroyed) {
          const next = input.next();
          if (settled || failure || exited || child.stdin?.destroyed) return;
          if (next.done) {
            input = null;
            inputEnded = true;
            child.stdin.end();
            return;
          }
          if (child.stdin.write(`${next.value}\n`) === false) {
            child.stdin.once("drain", sendInput);
            return;
          }
        }
      } catch (error) {
        stdinError(error);
      }
    };
    const callbackFailed = (error) => fail(new ProcessError(`stdout callback failed: ${error?.message ?? String(error)}`, { kind: "transport", cause: error }));
    const emitLine = (line) => {
      try {
        const result = options.onStdoutLine?.(line.replace(/\r$/, ""));
        if (result && typeof result.then === "function") {
          const observed = Promise.resolve(result).then(undefined, callbackFailed);
          if (!failure && !settled) batchPromises.push(observed);
        }
      } catch (error) { callbackFailed(error); }
    };

    function flushBatch() {
      const promises = batchPromises;
      batchPromises = [];
      batchLines = batchBytes = 0;
      if (!promises.length || failure || settled) return;
      pendingCallback = true;
      child.stdout?.pause?.();
      // A closed child no longer keeps Node alive. Pending callbacks still
      // own the original deadline, even if one of them never settles.
      timer?.ref?.();
      Promise.all(promises).then(() => {
        if (settled || failure) return;
        pendingCallback = false;
        timer?.unref?.();
        if (readableMode) drainStdout();
        else {
          drainEventQueue();
          if (!pendingCallback) child.stdout?.resume?.();
        }
      }, callbackFailed);
    }
    child.on("error", (error) => fail(new ProcessError(error.message, {
      kind: "transport",
      code: error?.code ?? null,
      hint: "harness executable failed to start; verify it is installed and on PATH",
      cause: error,
    })));
    // Keep this listener through close: pending writes can fail asynchronously
    // even after exit or cancellation has stopped the input producer.
    child.stdin?.on?.("error", stdinError);
    child.stdin?.on?.("close", () => {
      if (input && !inputEnded && !exited && !failure && !settled) {
        stdinError(Object.assign(new Error("stdin closed before all input was sent"), { code: "ERR_STREAM_PREMATURE_CLOSE" }));
      }
      stopInput();
    });
    child.on("exit", () => { exited = true; stopInput(); });
    child.stderr?.on("data", (chunk) => { if (!settled) stderr.append(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); });
    function parsePending() {
      while (pendingChunk && !pendingCallback && !failure && !settled) {
        const { chunk, offset } = pendingChunk;
        const newline = chunk.indexOf(10, offset);
        const end = newline < 0 ? chunk.length : newline;
        const size = end - offset;
        if (lineBytes + size > maxLineBytes) {
          fail(new ProcessError("stdout line exceeds maxLineBytes", {
            kind: "output-limit", stream: "stdout", maxLineBytes,
          }));
          lineBuffer = null;
          return;
        }
        const completeBytes = lineBytes + size + 1;
        // Complete lines cannot be split. A line above 64 KiB gets a batch
        // alone and is still bounded by maxLineBytes.
        if (newline >= 0 && batchLines && batchBytes + completeBytes > 64 * 1024) {
          flushBatch();
          if (pendingCallback) return;
        }
        let line;
        if (options.onStdoutLine) {
          if (!lineBytes && newline >= 0) {
            line = chunk.toString("utf8", offset, end);
          } else {
            lineBuffer ||= Buffer.allocUnsafe(maxLineBytes);
            chunk.copy(lineBuffer, lineBytes, offset, end);
            if (newline >= 0) line = lineBuffer.toString("utf8", 0, lineBytes + size);
          }
        }
        lineBytes = newline < 0 ? lineBytes + size : 0;
        pendingChunk.offset = end + 1;
        if (pendingChunk.offset >= chunk.length) pendingChunk = null;
        if (line !== undefined) {
          batchLines++;
          batchBytes += completeBytes;
          emitLine(line);
        }
        if (batchLines >= 100 || batchBytes >= 64 * 1024) flushBatch();
      }
      if (!pendingChunk && !pendingCallback) flushBatch();
    }

    function consumeChunk(value, captured = false) {
      if (settled) return;
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (!captured) stdout.append(chunk);
      if (!failure && chunk.length) {
        pendingChunk = { chunk, offset: 0 };
        parsePending();
      }
    }

    function queueEventChunk(value) {
      if (settled) return;
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      stdout.append(chunk);
      if (failure || !chunk.length) return;
      const retainedBytes = pendingEventBytes + (pendingChunk?.chunk.length || 0);
      const retainedChunks = pendingEvents.length + (pendingChunk ? 1 : 0);
      if (retainedBytes + chunk.length > maxPendingStdoutBytes || retainedChunks + 1 > maxPendingStdoutChunks) {
        fail(new ProcessError("stdout callback backlog exceeds limit", {
          kind: "output-limit", stream: "stdout", maxPendingStdoutBytes, maxPendingStdoutChunks,
        }));
        return;
      }
      // Copy views so a small queued slice cannot retain an unbounded backing buffer.
      pendingEvents.push(Buffer.from(chunk));
      pendingEventBytes += chunk.length;
      drainEventQueue();
    }

    function drainEventQueue() {
      if (reading || pendingCallback || settled) return;
      reading = true;
      try {
        parsePending();
        while (!pendingCallback && !settled && pendingEvents.length) {
          const chunk = pendingEvents.shift();
          pendingEventBytes -= chunk.length;
          consumeChunk(chunk, true);
        }
      } finally { reading = false; }
      finishIfReady();
    }

    function drainStdout() {
      if (reading || pendingCallback || settled) return;
      reading = true;
      try {
        parsePending();
        let chunk;
        while (!pendingCallback && !settled && (chunk = child.stdout.read()) !== null) consumeChunk(chunk);
      } catch (error) {
        fail(new ProcessError(`stdout read failed: ${error?.message ?? String(error)}`, { kind: "transport", cause: error }));
      } finally { reading = false; }
      finishIfReady();
    }

    // Readable mode leaves subsequent chunks in the stream's bounded buffer
    // while a callback batch is pending, even when child exit flushes stdio.
    if (readableMode) child.stdout.on("readable", drainStdout);
    else child.stdout?.on("data", queueEventChunk);

    function finishIfReady() {
      if (!closed || settled || finishing) return;
      finishing = true;
      if (lineBytes && !failure && !pendingCallback && !pendingChunk && !pendingEvents.length && options.onStdoutLine) {
        const line = lineBuffer.toString("utf8", 0, lineBytes);
        lineBytes = 0;
        emitLine(line);
        flushBatch();
      }
      if (!failure && (pendingCallback || pendingChunk || pendingEvents.length)) {
        finishing = false;
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abort);
      stopInput();
      lineBuffer = null;
      pendingChunk = null;
      pendingEvents.length = 0;
      pendingEventBytes = 0;
      const result = output(closeCode, closeSignal);
      if (failure) {
        failure.details = { ...result, ...failure.details, exitCode: closeCode };
        reject(failure);
      } else if (closeCode !== 0) {
        reject(new ProcessError(`process exited with code ${closeCode}`, result));
      } else {
        resolve(result);
      }
      finishing = false;
    }

    child.on("close", (code, signal) => {
      if (closed) return;
      exited = closed = true;
      closeCode = code;
      closeSignal = signal;
      stopInput();
      finishIfReady();
    });

    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    timer = setTimeout(() => fail(new ProcessError("process timed out", { kind: "timeout", timedOut: true })), options.timeoutMs ?? 3_600_000);
    timer.unref?.();
    if (options.stdinLines && !failure) {
      try {
        input = options.stdinLines[Symbol.iterator]();
        sendInput();
      } catch (error) {
        stdinError(error);
      }
    }
  });
}

export function parseJsonLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}
