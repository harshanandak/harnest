import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  open,
  lstat,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { realpathSync, statSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { StringDecoder } from "node:string_decoder";

import { resolveWindowsPathCommand } from "./launch-command.mjs";
import { redactSecrets, terminateProcessTree } from "./process.mjs";

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_LINE_NUMBER = 1_000_000;
const MAX_LINE_LIMIT = 100_000;
const DEFAULT_TERMINAL_OUTPUT_BYTES = 1024 * 1024;
const MAX_TERMINAL_OUTPUT_BYTES = 1024 * 1024;
const MAX_COMMAND_CHARS = 32 * 1024;
const MAX_ARGUMENTS = 4096;
const MAX_ARGUMENT_BYTES = 256 * 1024;
const MAX_SESSION_ID_CHARS = 512;
const MAX_PROGRESS_CHARS = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const TERMINATION_GRACE_MS = 1000;
const TERMINAL_ENV_NAMES = new Set([
  "PATH", "HOME", "USERPROFILE", "TEMP", "TMP", "TMPDIR", "SHELL", "TERM",
  "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "PATHEXT", "APPDATA", "LOCALAPPDATA",
  "LANG", "LANGUAGE", "LC_ALL", "LC_COLLATE", "LC_CTYPE", "LC_MESSAGES", "LC_MONETARY", "LC_NUMERIC", "LC_TIME",
]);

export const ACP_V1_CLIENT_CAPABILITIES = Object.freeze({
  fs: Object.freeze({ readTextFile: true, writeTextFile: true }),
  terminal: false,
});

function terminalEnvironment() {
  const caseInsensitive = process.platform === "win32";
  return Object.fromEntries(Object.keys(process.env)
    .filter((name) => TERMINAL_ENV_NAMES.has(caseInsensitive ? name.toUpperCase() : name))
    .map((name) => [name, process.env[name]]));
}

const RPC_CODES = Object.freeze({
  INVALID_PARAMS: -32602,
  METHOD_NOT_FOUND: -32601,
});

export class AcpClientServiceError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "AcpClientServiceError";
    this.code = code;
    this.rpcCode = RPC_CODES[code] ?? -32000;
    this.details = details;
  }
}

function serviceError(message, code, details) {
  return new AcpClientServiceError(message, code, details);
}

function paramsObject(params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw serviceError("ACP client request params must be an object", "INVALID_PARAMS");
  }
  return params;
}

function requiredString(value, name, maxChars = 32 * 1024) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxChars) {
    throw serviceError(`${name} must be a non-empty bounded string`, "INVALID_PARAMS", { field: name });
  }
  return value;
}

function sessionIdFrom(params) {
  return requiredString(params.sessionId, "sessionId", MAX_SESSION_ID_CHARS);
}

function boundedInteger(value, name, { minimum, maximum, fallback }) {
  const selected = value === undefined || value === null ? fallback : value;
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
    throw serviceError(`${name} is outside the supported integer range`, "INVALID_PARAMS", {
      field: name,
      minimum,
      maximum,
    });
  }
  return selected;
}

function pathKey(path) {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isContained(root, candidate) {
  const rootKey = pathKey(root);
  const candidateKey = pathKey(candidate);
  const rel = relative(rootKey, candidateKey);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function assertContained(root, candidate) {
  if (!isContained(root, candidate)) {
    throw serviceError("path resolves outside the configured working directory", "PATH_OUTSIDE_CWD");
  }
}

function pathSegments(path) {
  return resolve(path).split(/[\\/]+/u).filter(Boolean).map((part) => part.toLowerCase());
}

function isCredentialPath(path) {
  const segments = pathSegments(path);
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === ".agent-secrets" || segment === ".ssh") return true;
    if (segment === ".zoho" && segments[index + 1] === "credentials") return true;
    if (segment === ".env" || (segment.startsWith(".env.") && !segment.endsWith(".example"))) return true;
    if (/^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/u.test(segment)) return true;
    if (/\.(?:pem|p12|pfx)$/u.test(segment)) return true;
  }
  return false;
}

function assertNonCredentialPath(path) {
  if (isCredentialPath(path)) {
    throw serviceError("credential paths are not available through ACP filesystem callbacks", "CREDENTIAL_PATH");
  }
}

function absolutePath(value, name = "path") {
  const path = requiredString(value, name);
  if (!isAbsolute(path)) {
    throw serviceError(`${name} must be absolute`, "INVALID_PARAMS", { field: name });
  }
  return resolve(path);
}

function invalidPath(operation) {
  return serviceError(`unable to resolve ${operation} path`, "INVALID_PATH", { operation });
}

async function canonicalExistingPath(root, requested, operation) {
  assertNonCredentialPath(requested);
  let canonical;
  try {
    canonical = await realpath(requested);
  } catch {
    throw invalidPath(operation);
  }
  assertContained(root, canonical);
  assertNonCredentialPath(canonical);
  return canonical;
}

async function canonicalWritePath(root, requested) {
  assertNonCredentialPath(requested);
  try {
    const canonical = await realpath(requested);
    assertContained(root, canonical);
    assertNonCredentialPath(canonical);
    return { path: canonical, create: false };
  } catch (error) {
    if (error instanceof AcpClientServiceError) throw error;
    if (error?.code !== "ENOENT") throw invalidPath("write");
  }

  // `realpath` also reports ENOENT for dangling symlinks. Treat an existing
  // directory entry as invalid rather than following it during creation.
  try {
    await lstat(requested);
    throw invalidPath("write");
  } catch (error) {
    if (error instanceof AcpClientServiceError) throw error;
    if (error?.code !== "ENOENT") throw invalidPath("write");
  }

  let canonicalParent;
  try {
    canonicalParent = await realpath(dirname(requested));
  } catch {
    throw invalidPath("write");
  }
  assertContained(root, canonicalParent);
  assertNonCredentialPath(canonicalParent);
  const canonical = join(canonicalParent, basename(requested));
  assertContained(root, canonical);
  assertNonCredentialPath(canonical);
  return { path: canonical, create: true };
}

function selectedLines(content, line, limit) {
  if (line === undefined && limit === undefined) return content;
  const parts = content.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  const start = (line ?? 1) - 1;
  if (start >= parts.length || limit === 0) return "";
  return parts.slice(start, limit === undefined ? undefined : start + limit).join("");
}

function outputTail(limit) {
  let buffer = Buffer.alloc(0);
  let totalBytes = 0;
  return {
    append(value) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      totalBytes += chunk.length;
      if (limit === 0) {
        buffer = Buffer.alloc(0);
        return;
      }
      if (chunk.length >= limit) {
        buffer = chunk.subarray(chunk.length - limit);
        return;
      }
      if (buffer.length + chunk.length <= limit) {
        buffer = Buffer.concat([buffer, chunk], buffer.length + chunk.length);
        return;
      }
      const keep = limit - chunk.length;
      buffer = Buffer.concat([buffer.subarray(buffer.length - keep), chunk], limit);
    },
    snapshot() {
      const truncated = totalBytes > limit;
      let start = 0;
      if (truncated) {
        while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
      }
      return { output: buffer.toString("utf8", start), truncated };
    },
  };
}

function progressChunks(text) {
  const chunks = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + MAX_PROGRESS_CHARS);
    if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1])) end -= 1;
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

function exitStatus(code, signal) {
  return {
    exitCode: Number.isInteger(code) && code >= 0 ? code : null,
    signal: typeof signal === "string" && signal ? signal : null,
  };
}

function waitDelay(milliseconds) {
  return new Promise((resolveDelay) => {
    const timer = setTimeout(() => resolveDelay(false), milliseconds);
    timer.unref?.();
  });
}

async function exitedWithin(record, milliseconds) {
  if (record.exit) return true;
  return Promise.race([
    record.exitPromise.then(() => true),
    waitDelay(milliseconds),
  ]);
}

/**
 * ACP v1 client filesystem and terminal callbacks. Version negotiation stays
 * in the adapter; ACP v2 deliberately receives none of these capabilities.
 */
export function createAcpClientServices({
  cwd,
  signal,
  onProgress,
  write,
  writeApproved,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  spawnFn = nodeSpawn,
} = {}) {
  const terminalEnabled = write === true && writeApproved === true;
  const requestedRoot = absolutePath(cwd, "cwd");
  let root;
  try {
    root = realpathSync.native ? realpathSync.native(requestedRoot) : realpathSync(requestedRoot);
    if (!statSync(root).isDirectory()) throw new Error("not a directory");
  } catch {
    throw serviceError("cwd must resolve to an existing directory", "INVALID_PARAMS", { field: "cwd" });
  }
  timeoutMs = boundedInteger(timeoutMs, "timeoutMs", {
    minimum: 1,
    maximum: MAX_TIMEOUT_MS,
    fallback: DEFAULT_TIMEOUT_MS,
  });
  if (signal !== undefined && (!signal || typeof signal.addEventListener !== "function")) {
    throw serviceError("signal must be an AbortSignal", "INVALID_PARAMS", { field: "signal" });
  }
  if (onProgress !== undefined && typeof onProgress !== "function") {
    throw serviceError("onProgress must be a function", "INVALID_PARAMS", { field: "onProgress" });
  }
  if (typeof spawnFn !== "function") {
    throw serviceError("spawnFn must be a function", "INVALID_PARAMS", { field: "spawnFn" });
  }

  const terminals = new Map();
  let closed = Boolean(signal?.aborted);
  let closePromise = null;
  let resolveProgressShutdown;
  const progressShutdown = new Promise((resolveShutdown) => {
    resolveProgressShutdown = resolveShutdown;
  });
  if (closed) resolveProgressShutdown();

  function assertActive() {
    if (closed || signal?.aborted) {
      throw serviceError("ACP client services are closed", "SERVICE_CLOSED");
    }
  }

  async function terminateOwned(record) {
    if (record.exit) return record.exit;
    if (!record.terminationPromise) {
      record.terminationPromise = (async () => {
        terminateProcessTree(record.child);
        if (!(await exitedWithin(record, TERMINATION_GRACE_MS))) {
          try { record.child.kill?.("SIGKILL"); } catch { /* The owned process may already be gone. */ }
        }
        if (!(await exitedWithin(record, TERMINATION_GRACE_MS))) {
          const error = serviceError("owned terminal process did not exit after termination", "PROCESS_EXIT_UNPROVEN", {
            terminalId: record.id,
          });
          record.failure ||= error;
          throw error;
        }
        return record.exit;
      })();
    }
    return record.terminationPromise;
  }

  async function emitTerminalProgress(event) {
    if (!onProgress || closed) return;
    const details = { phase: "progress", terminalId: event.terminalId };
    let timer;
    try {
      const callback = Promise.resolve().then(() => {
        if (!closed) return onProgress(event);
      });
      await Promise.race([
        callback,
        progressShutdown,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(serviceError("ACP terminal progress delivery timed out", "TIMEOUT", details)), timeoutMs);
          timer.unref?.();
        }),
      ]);
    } catch (error) {
      if (error instanceof AcpClientServiceError) throw error;
      throw serviceError("ACP terminal progress delivery failed", "PROGRESS_FAILED", details);
    } finally {
      clearTimeout(timer);
    }
  }

  async function deliverProgress(record, stream, text) {
    const redacted = redactSecrets(text);
    if (!onProgress || !redacted) return;
    for (const chunk of progressChunks(redacted)) {
      if (closed) return;
      await emitTerminalProgress({
        type: "acp_terminal_output",
        terminalId: record.id,
        sessionId: record.sessionId,
        stream,
        text: chunk,
      });
    }
  }

  function attachStream(record, stream, name) {
    if (!stream?.on) return;
    const decoder = new StringDecoder("utf8");
    const queueProgress = (text) => {
      if (!text) return;
      stream.pause?.();
      record.progressTail = record.progressTail
        .then(() => deliverProgress(record, name, text))
        .catch((error) => {
          record.failure ||= error;
          void terminateOwned(record).catch(() => {});
        })
        .finally(() => stream.resume?.());
    };
    stream.on("data", (value) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      record.output.append(chunk);
      queueProgress(decoder.write(chunk));
    });
    stream.on("end", () => queueProgress(decoder.end()));
  }

  function createRecord(child, sessionId, outputByteLimit) {
    const id = `terminal-${randomUUID()}`;
    let resolveExit;
    const record = {
      id,
      sessionId,
      child,
      output: outputTail(outputByteLimit),
      progressTail: Promise.resolve(),
      exit: null,
      exitPromise: new Promise((resolveValue) => { resolveExit = resolveValue; }),
      failure: null,
      terminationPromise: null,
      timer: null,
    };
    const settleExit = (code, exitSignal) => {
      if (record.exit) return;
      record.exit = exitStatus(code, exitSignal);
      clearTimeout(record.timer);
      resolveExit(record.exit);
    };
    child.once?.("error", () => {
      record.failure ||= serviceError("terminal command failed to start", "TERMINAL_START_FAILED", {
        terminalId: id,
      });
      settleExit(null, null);
    });
    child.once?.("close", settleExit);
    attachStream(record, child.stdout, "stdout");
    attachStream(record, child.stderr, "stderr");
    record.timer = setTimeout(() => {
      if (record.exit) return;
      record.failure ||= serviceError("terminal command timed out", "TIMEOUT", { terminalId: id });
      void terminateOwned(record).catch(() => {});
    }, timeoutMs);
    record.timer.unref?.();
    return record;
  }

  function terminalFor(params) {
    const sessionId = sessionIdFrom(params);
    const terminalId = requiredString(params.terminalId, "terminalId", 256);
    const record = terminals.get(terminalId);
    if (!record) throw serviceError("terminal ID is not owned by this service", "UNKNOWN_TERMINAL");
    if (record.sessionId !== sessionId) {
      throw serviceError("terminal belongs to a different ACP session", "TERMINAL_SESSION_MISMATCH", {
        terminalId,
      });
    }
    return record;
  }

  async function ensureRecordHealthy(record) {
    await record.progressTail;
    if (record.failure) throw record.failure;
  }

  async function readTextFile(params) {
    params = paramsObject(params);
    sessionIdFrom(params);
    const path = absolutePath(params.path);
    const line = params.line === undefined || params.line === null ? undefined : boundedInteger(params.line, "line", {
      minimum: 1,
      maximum: MAX_LINE_NUMBER,
    });
    const limit = params.limit === undefined || params.limit === null ? undefined : boundedInteger(params.limit, "limit", {
      minimum: 0,
      maximum: MAX_LINE_LIMIT,
    });
    assertActive();
    const canonical = await canonicalExistingPath(root, path, "read");
    assertActive();

    let handle;
    try {
      handle = await open(canonical, "r");
      const info = await handle.stat();
      if (!info.isFile()) throw invalidPath("read");
      if (info.size > MAX_FILE_BYTES) {
        throw serviceError("file exceeds the ACP read byte limit", "OUTPUT_LIMIT", { maxBytes: MAX_FILE_BYTES });
      }
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset > MAX_FILE_BYTES) {
        throw serviceError("file exceeds the ACP read byte limit", "OUTPUT_LIMIT", { maxBytes: MAX_FILE_BYTES });
      }
      assertActive();
      return { content: selectedLines(buffer.toString("utf8", 0, offset), line, limit) };
    } catch (error) {
      if (error instanceof AcpClientServiceError) throw error;
      throw invalidPath("read");
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async function writeTextFile(params) {
    params = paramsObject(params);
    sessionIdFrom(params);
    const path = absolutePath(params.path);
    if (typeof params.content !== "string") {
      throw serviceError("content must be a string", "INVALID_PARAMS", { field: "content" });
    }
    if (Buffer.byteLength(params.content, "utf8") > MAX_FILE_BYTES) {
      throw serviceError("content exceeds the ACP write byte limit", "OUTPUT_LIMIT", { maxBytes: MAX_FILE_BYTES });
    }
    assertActive();
    const target = await canonicalWritePath(root, path);
    assertActive();
    try {
      // `wx` closes the symlink-race window for a target that did not exist
      // during canonicalization: any new directory entry makes the write fail.
      await writeFile(target.path, params.content, { encoding: "utf8", flag: target.create ? "wx" : "w" });
    } catch {
      throw invalidPath("write");
    }
    return {};
  }

  async function createTerminal(params) {
    params = paramsObject(params);
    const sessionId = sessionIdFrom(params);
    const command = requiredString(params.command, "command", MAX_COMMAND_CHARS);
    const args = params.args === undefined ? [] : params.args;
    if (!Array.isArray(args) || args.length > MAX_ARGUMENTS || args.some((arg) => typeof arg !== "string")) {
      throw serviceError("args must be a bounded array of strings", "INVALID_PARAMS", { field: "args" });
    }
    if (args.reduce((bytes, arg) => bytes + Buffer.byteLength(arg, "utf8"), 0) > MAX_ARGUMENT_BYTES) {
      throw serviceError("args exceed the terminal argument byte limit", "INVALID_PARAMS", { field: "args" });
    }
    if (params.env !== undefined && (!Array.isArray(params.env) || params.env.length !== 0)) {
      throw serviceError("terminal env overrides are not supported", "INVALID_PARAMS", { field: "env" });
    }
    const outputByteLimit = boundedInteger(params.outputByteLimit, "outputByteLimit", {
      minimum: 0,
      maximum: MAX_TERMINAL_OUTPUT_BYTES,
      fallback: DEFAULT_TERMINAL_OUTPUT_BYTES,
    });
    const requestedCwd = params.cwd === undefined || params.cwd === null ? root : absolutePath(params.cwd, "cwd");
    assertActive();
    const terminalCwd = await canonicalExistingPath(root, requestedCwd, "terminal cwd");
    let cwdInfo;
    try { cwdInfo = await stat(terminalCwd); }
    catch { throw invalidPath("terminal cwd"); }
    if (!cwdInfo.isDirectory()) throw invalidPath("terminal cwd");
    assertActive();
    await emitTerminalProgress({ type: "acp_terminal_command", sessionId, command: redactSecrets(basename(command)) });
    assertActive();

    let child;
    try {
      const env = terminalEnvironment();
      // Pass an absolute executable for Windows bare names, including with an injected launcher.
      const executable = process.platform === "win32" && !/[\\/:]/.test(command)
        ? resolveWindowsPathCommand(command, terminalCwd, env)
        : command;
      if (!executable) throw new Error("terminal command was not found on PATH");
      child = spawnFn(executable, [...args], {
        cwd: terminalCwd,
        env,
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      throw serviceError("terminal command failed to start", "TERMINAL_START_FAILED");
    }
    if (!child || typeof child.on !== "function" || typeof child.kill !== "function") {
      try { terminateProcessTree(child); } catch { /* Invalid process handles have no cleanup surface. */ }
      throw serviceError("terminal launcher returned an invalid process handle", "TERMINAL_START_FAILED");
    }
    const record = createRecord(child, sessionId, outputByteLimit);
    terminals.set(record.id, record);
    if (closed || signal?.aborted) {
      await terminateOwned(record);
      terminals.delete(record.id);
      throw serviceError("ACP client services are closed", "SERVICE_CLOSED");
    }
    return { terminalId: record.id };
  }

  async function terminalOutput(params) {
    params = paramsObject(params);
    assertActive();
    const record = terminalFor(params);
    await ensureRecordHealthy(record);
    const result = record.output.snapshot();
    result.output = redactSecrets(result.output);
    if (record.exit) result.exitStatus = { ...record.exit };
    return result;
  }

  async function waitForTerminalExit(params) {
    params = paramsObject(params);
    assertActive();
    const record = terminalFor(params);
    await record.exitPromise;
    await ensureRecordHealthy(record);
    return { ...record.exit };
  }

  async function killTerminal(params) {
    params = paramsObject(params);
    assertActive();
    const record = terminalFor(params);
    await terminateOwned(record);
    await ensureRecordHealthy(record);
    return {};
  }

  async function releaseTerminal(params) {
    params = paramsObject(params);
    assertActive();
    const record = terminalFor(params);
    try {
      await terminateOwned(record);
      await record.progressTail;
    } finally {
      clearTimeout(record.timer);
      terminals.delete(record.id);
    }
    return {};
  }

  async function handleRequest(method, params) {
    assertActive();
    if (typeof method !== "string" || !method) {
      throw serviceError("ACP client method must be a non-empty string", "INVALID_PARAMS", { field: "method" });
    }
    if (!terminalEnabled && method.startsWith("terminal/")) {
      throw serviceError("ACP terminal requires approved write access", "METHOD_NOT_FOUND", { method });
    }
    switch (method) {
      case "fs/read_text_file": return readTextFile(params);
      case "fs/write_text_file": return writeTextFile(params);
      case "terminal/create": return createTerminal(params);
      case "terminal/output": return terminalOutput(params);
      case "terminal/wait_for_exit": return waitForTerminalExit(params);
      case "terminal/kill": return killTerminal(params);
      case "terminal/release": return releaseTerminal(params);
      default:
        throw serviceError("unsupported ACP client method", "METHOD_NOT_FOUND", { method });
    }
  }

  async function close() {
    if (closePromise) return closePromise;
    closed = true;
    resolveProgressShutdown();
    closePromise = (async () => {
      const records = [...terminals.values()];
      const results = await Promise.allSettled(records.map(async (record) => {
        try {
          await terminateOwned(record);
          await record.progressTail;
        } finally {
          clearTimeout(record.timer);
          terminals.delete(record.id);
        }
      }));
      signal?.removeEventListener?.("abort", abortHandler);
      const rejected = results.find((result) => result.status === "rejected");
      if (rejected) throw rejected.reason;
    })();
    return closePromise;
  }

  const abortHandler = () => { void close().catch(() => {}); };
  signal?.addEventListener?.("abort", abortHandler, { once: true });

  return {
    capabilities: Object.freeze({ ...ACP_V1_CLIENT_CAPABILITIES, terminal: terminalEnabled }),
    handleRequest,
    close,
  };
}
