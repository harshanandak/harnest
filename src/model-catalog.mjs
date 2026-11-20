// Bounded metadata-only model catalog discovery for all registered targets.
//
// getCatalog({target, route, cwd}) returns one catalog snapshot per
// target+provider+cwd, coalesced across concurrent callers and
// cached in memory with TTL refresh. Failures back off and serve
// explicitly-stale data only after a first success; the first failure is
// unavailable, never a hollow stale shell.
//
// Row identity: row.id is always the BARE model id matching route.model, with
// provider separate (the parent strips/restores prefixes). Verified against
// live `opencode api model.list`: Model.Info.id is already bare.
// The selectable ID can differ from Model.Info.modelID. Preserve the
// latter as row.alias.
// Thinking comes only from verified variant/effort ids whose semantics align
// with route.thinking; anything else is omitted, never invented.
//
// Sources (exact strings in `source`):
//   OpenCode V2: `<launcher> api model.list` (rich Model.Info: cost,
//     variants, enabled) with fallback to `<launcher> models` (bare ids).
//   pi:       `pi --list-models` table (strict columns; thinking levels from
//             pi's own --help, granted only when the row asserts support)
//   cursor:   `cursor-agent --list-models` (`id - description`; safe-id gated,
//             effort suffixes preserved verbatim)
//   codex:    app-server `initialize` -> `model/list` paged RPC, no threads;
//             custom route.provider values are unsupported by that catalog
//   claude:   managed aliases only (no catalog API exists); parent maps them
//
// Never runs inference, starts no turns/jobs, reads no credentials. Reasons
// are generic target:code pairs; raw stderr and process exceptions never
// reach callers. Cost is only reported when the catalog states it.

import { harnessLaunch, isOpenCodeV2Version } from "./config.mjs";
import { spawnNativeCommand } from "./launch-command.mjs";
import { HARNESS_VERSIONS, TARGETS } from "./protocol.mjs";

export const CATALOG_TTL_MS = 3_600_000;
export const CATALOG_RETRY_MS = 60_000;
// Pi's metadata-only CLI cold start measured 17.6s on Windows. Match the
// existing native catalog probe budget; this is separate from job deadlines.
export const CATALOG_TIMEOUT_MS = 30_000;
export const CATALOG_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
export const CATALOG_MAX_ROWS = 4_096;
export const CATALOG_MAX_CACHE_ENTRIES = 128;
export const CATALOG_MAX_RPC_PENDING = 256;

// Thinking levels verified from `pi --help` (--thinking). Granted only where
// a catalog asserts support for that model; never invented per model.
export const KNOWN_THINKING_LEVELS = Object.freeze(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

// Verified from `claude --help`: "--model ... an alias for the latest model
// (e.g. 'fable', 'opus', or 'sonnet') or a model's full name".
export const CLAUDE_MANAGED_ALIASES = Object.freeze(["opus", "sonnet", "fable"]);

// Native launch env vars per harness (mirrors config.mjs; catalog env/config
// take precedence, process env remains the fallback inside harnessLaunch).
const LAUNCH_ENV_VARS = Object.freeze({
  pi: "HARNEST_PI",
  cursor: "HARNEST_CURSOR",
  claude: "HARNEST_CLAUDE",
  codex: "HARNEST_CODEX",
  amp: "HARNEST_AMP",
});

const BARE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+:/-]*$/;
const PROVIDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function code(target, reason) {
  return `${target}:${reason}`;
}

function fail(target, source, reason, now) {
  return { models: [], reason, source, at: new Date(now()).toISOString(), status: "unavailable" };
}

// UTF-16/redirect mojibake guard: strip NULs and BOM before parsing.
function decodeCatalogText(value) {
  return String(value ?? "").replace(/\0/g, "").replace(/^﻿/, "");
}

// --- pure parsers (fixture-testable) ---------------------------------------

export function parseOpencodeModels(text, maxRows = CATALOG_MAX_ROWS) {
  const models = [];
  for (const line of decodeCatalogText(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Strict provider/model shape: login banners and status lines never pass.
    const match = /^([A-Za-z0-9][A-Za-z0-9_.-]*)\/([A-Za-z0-9][A-Za-z0-9._+:/-]*)$/.exec(trimmed);
    if (!match) continue;
    models.push({ id: match[2], provider: match[1], available: true });
    if (models.length >= maxRows) break;
  }
  return models;
}

function opencodeCost(info) {
  const costs = Array.isArray(info?.cost) ? info.cost : [];
  const base = costs.find((entry) => isObject(entry) && entry.tier == null)
    ?? costs.find((entry) => isObject(entry));
  // Only the untiered entry is honest base pricing; tiered-only catalogs
  // report no cost rather than a misattributed one.
  const plain = isObject(base) && base.tier == null ? base : null;
  if (typeof plain?.input !== "number" || typeof plain?.output !== "number"
    || !Number.isFinite(plain.input) || !Number.isFinite(plain.output)
    || plain.input < 0 || plain.output < 0) return undefined;
  if (plain.input === 0 && plain.output === 0
    && costs.some((entry) => entry.input !== 0 || entry.output !== 0)) return undefined;
  return { input: plain.input, output: plain.output };
}

function opencodeThinking(info) {
  const variants = Array.isArray(info?.variants) ? info.variants : [];
  const thinking = [];
  for (const variant of variants) {
    // Verified live: variant ids are thinking levels ("low", "medium",
    // "high", "xhigh", "max", "minimal") or non-levels ("none"). Only known
    // levels are reported, so route.thinking upgrades keep working.
    const level = typeof variant?.id === "string" ? variant.id.toLowerCase() : "";
    if (KNOWN_THINKING_LEVELS.includes(level) && !thinking.includes(level)) thinking.push(level);
  }
  return thinking.length ? thinking : undefined;
}

export function parseOpencodeApiModels(payload, maxRows = CATALOG_MAX_ROWS) {
  const data = Array.isArray(payload?.data) ? payload.data : [];
  const models = [];
  for (const info of data) {
    if (!isObject(info) || typeof info.modelID !== "string" || !info.modelID
      || typeof info.providerID !== "string" || !PROVIDER_PATTERN.test(info.providerID)) continue;
    // Verified live: info.id is already the bare selectable id; modelID may
    // alias it. Strip only an
    // exact provider prefix, never anything else.
    const rawId = typeof info.id === "string" && info.id ? info.id : info.modelID;
    const prefix = `${info.providerID}/`;
    const bare = rawId.startsWith(prefix) ? rawId.slice(prefix.length) : rawId;
    if (!BARE_ID_PATTERN.test(bare)) continue;
    const entry = {
      id: bare,
      provider: info.providerID,
      available: info.enabled !== false && info.status !== "deprecated",
    };
    // Preserve the selectable catalog alias when it differs from modelID.
    if (info.modelID !== bare) entry.alias = info.modelID;
    const cost = opencodeCost(info);
    if (cost) entry.cost = cost;
    const thinking = opencodeThinking(info);
    if (thinking) entry.thinking = thinking;
    models.push(entry);
    if (models.length >= maxRows) break;
  }
  return models;
}

export function parsePiListModels(text, maxRows = CATALOG_MAX_ROWS) {
  const lines = decodeCatalogText(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  // The header must be present; preamble chatter (auth notices, fetch status)
  // is skipped but can never become a model row.
  const headerIndex = lines.findIndex((line) => /^provider\s+model(\s|$)/.test(line));
  if (headerIndex < 0) return [];
  const models = [];
  for (const line of lines.slice(headerIndex + 1)) {
    const parts = line.split(/\s+/);
    if (parts.length < 6) continue;
    const [provider, model, , , thinking] = parts;
    if (!PROVIDER_PATTERN.test(provider) || !BARE_ID_PATTERN.test(model)) continue;
    models.push({
      id: model,
      provider,
      available: true,
      // "yes" means the model accepts pi's thinking levels (verified set from
      // pi --help); anything else leaves thinking unknown, never invented.
      ...(thinking.toLowerCase() === "yes" ? { thinking: [...KNOWN_THINKING_LEVELS] } : {}),
    });
    if (models.length >= maxRows) break;
  }
  return models;
}

export function parseCursorListModels(text, maxRows = CATALOG_MAX_ROWS) {
  const models = [];
  for (const line of decodeCatalogText(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^available models$/i.test(trimmed)) continue;
    // Effort suffixes (-high, -thinking-xhigh, -fast) are part of the id and
    // are preserved verbatim; family identity is the parent's job. The safe-id
    // gate rejects login banners and tip lines.
    const id = trimmed.split(" - ")[0].trim();
    if (!BARE_ID_PATTERN.test(id)) continue;
    models.push({ id, available: true });
    if (models.length >= maxRows) break;
  }
  return models;
}

export function parseCodexModelList(entries, maxRows = CATALOG_MAX_ROWS) {
  const models = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!isObject(entry)) continue;
    const id = typeof entry.model === "string" && entry.model
      || typeof entry.id === "string" && entry.id;
    if (!id || !BARE_ID_PATTERN.test(id)) continue;
    const efforts = Array.isArray(entry.supportedReasoningEfforts) ? entry.supportedReasoningEfforts : [];
    const thinking = [];
    for (const effort of efforts) {
      const level = typeof effort?.reasoningEffort === "string" ? effort.reasoningEffort.toLowerCase() : "";
      if (KNOWN_THINKING_LEVELS.includes(level) && !thinking.includes(level)) thinking.push(level);
    }
    // Native codex ids are bare (no provider prefix); the adapter passes
    // route.model verbatim, so no provider is attached here.
    models.push({
      id,
      available: entry.hidden !== true,
      ...(thinking.length ? { thinking } : {}),
    });
    if (models.length >= maxRows) break;
  }
  return models;
}

// --- process probe (default; injectable for tests) --------------------------

function kill(child) {
  try { child.kill("SIGKILL"); } catch { /* already gone */ }
}

function launchFor(name, { env, config } = {}) {
  const injected = env?.[LAUNCH_ENV_VARS[name]] ?? config?.executables?.[name] ?? undefined;
  const launch = name === "opencode" ? harnessLaunch(name, undefined, { env, config }) : harnessLaunch(name, injected);
  return {
    command: launch.command,
    baseArgs: [...(launch.args || [])],
    env: { ...(env ?? process.env), ...(launch.env || {}) },
  };
}

async function runExec({ command, args, env, cwd, timeoutMs, maxOutputBytes, spawnFn }) {
  let child;
  try {
    child = spawnFn(command, args, {
      cwd, env, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return { status: null, code: "spawn-failed" };
  }
  let outBytes = 0, errBytes = 0, done = false;
  const finish = (resolve, timer, outcome) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    kill(child);
    resolve(outcome);
  };
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(resolve, timer, { status: null, code: "timeout" }), timeoutMs);
    timer.unref?.();
    let stdout = "", stderr = "";
    const onData = (chunk, which) => {
      if (done) return;
      const text = String(chunk);
      if (which === "out") {
        outBytes += Buffer.byteLength(text, "utf8");
        stdout += text;
      } else {
        errBytes += Buffer.byteLength(text, "utf8");
        stderr += text;
      }
      // Either stream overflowing fails fast and releases the buffers.
      if (outBytes + errBytes > maxOutputBytes) {
        stdout = "";
        stderr = "";
        finish(resolve, timer, { status: null, code: "output-limit" });
      }
    };
    child.stdout?.on("data", (chunk) => onData(chunk, "out"));
    child.stderr?.on("data", (chunk) => onData(chunk, "err"));
    child.on("error", () => finish(resolve, timer, { status: null, code: "spawn-failed" }));
    child.on("close", (status) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

// Metadata-only app-server session: initialize -> model/limits read -> destroy.
// Never starts a thread or turn. One deadline covers every page; any child,
// stdin, protocol, overflow, or exit anomaly fails closed with cleanup.
export async function runCodexMetadata({ command, args, env, cwd, timeoutMs, maxOutputBytes, maxRows, spawnFn, method = "model/list", signal }) {
  if (signal?.aborted) return { status: null, code: "aborted" };
  if (!["model/list", "account/rateLimits/read"].includes(method)) return { status: null, code: "unsupported-method" };
  const deadlineAt = performance.now() + timeoutMs;
  let child;
  try {
    child = spawnFn(command, args, {
      cwd, env, windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return { status: null, code: "spawn-failed" };
  }
  const pending = new Map();
  const responses = new Map();
  let buffer = "", outputBytes = 0, nextId = 1, settled = false;
  let failReason = null;
  const deadlineExpired = () => performance.now() >= deadlineAt;
  const cleanup = () => {
    for (const [, waiter] of pending) {
      try { waiter.reject(new Error("closed")); } catch { /* already settled */ }
    }
    pending.clear();
    responses.clear();
    buffer = "";
  };
  const fail = (reason) => {
    if (settled) return;
    settled = true;
    failReason = reason;
    cleanup();
    try { child.stdin?.end(); } catch { /* already closed */ }
    kill(child);
  };
  const pump = (chunk) => {
    if (settled) return;
    if (deadlineExpired()) return fail("timeout");
    outputBytes += Buffer.byteLength(String(chunk), "utf8");
    if (outputBytes > maxOutputBytes) return fail("output-limit");
    buffer += String(chunk);
    if (buffer.length > maxOutputBytes) return fail("output-limit");
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let frame;
      try { frame = JSON.parse(line); } catch { continue; }
      if (!isObject(frame)) continue;
      if (frame.id !== undefined && frame.method === undefined) {
        const waiter = pending.get(frame.id);
        if (waiter) {
          pending.delete(frame.id);
          if (frame.error) waiter.reject(new Error("rpc-error"));
          else waiter.resolve(frame.result);
        } else if (responses.size < CATALOG_MAX_RPC_PENDING) {
          responses.set(frame.id, frame);
        }
      } else if (frame.id !== undefined && typeof frame.method === "string") {
        // Unsolicited server request during a metadata probe: decline so the
        // server never stalls waiting on us.
        try { child.stdin?.write(`${JSON.stringify({ id: frame.id, error: { code: -32601, message: "not implemented" } })}\n`); } catch { fail("stdin-error"); }
      }
    }
  };
  child.stdout?.on("data", pump);
  child.stderr?.on("data", () => {
    // Drained and discarded: diagnostic text may carry secrets and never
    // reaches callers. Only its absence/presence matters, not its content.
  });
  child.on("error", () => fail("spawn-failed"));
  try { child.stdin?.on("error", () => fail("stdin-error")); } catch { /* no stdin */ }
  child.on("close", () => fail("closed-early"));
  const finished = new Promise((resolve) => child.on("close", () => resolve()));
  let deadlineTimer;
  const deadline = new Promise((_, reject) => {
    deadlineTimer = setTimeout(() => reject(new Error("timeout")), Math.max(0, deadlineAt - performance.now()));
    finished.finally(() => clearTimeout(deadlineTimer));
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    if (settled) return reject(new Error(failReason ?? "closed"));
    if (deadlineExpired()) {
      fail("timeout");
      return reject(new Error("timeout"));
    }
    if (pending.size >= CATALOG_MAX_RPC_PENDING) return reject(new Error("protocol-overflow"));
    const id = nextId++;
    pending.set(id, { resolve, reject });
    if (responses.has(id)) {
      const frame = responses.get(id);
      responses.delete(id);
      pending.delete(id);
      if (frame.error) reject(new Error("rpc-error"));
      else resolve(frame.result);
      return;
    }
    try {
      child.stdin?.write(`${JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) })}\n`);
    } catch {
      pending.delete(id);
      fail("stdin-error");
      reject(new Error("stdin-error"));
    }
  });
  const notify = (method, params) => {
    if (settled) return;
    if (deadlineExpired()) return fail("timeout");
    try { child.stdin?.write(`${JSON.stringify({ method, ...(params === undefined ? {} : { params }) })}\n`); } catch { fail("stdin-error"); }
  };
  const onAbort = () => fail("aborted");
  if (signal?.aborted) onAbort();
  else signal?.addEventListener?.("abort", onAbort, { once: true });
  const conversation = (async () => {
    await request("initialize", {
      clientInfo: { name: "harnest", title: "Harnest", version: "0.1.1" },
      capabilities: {},
    });
    notify("initialized");
    if (method === "account/rateLimits/read") return { status: 0, result: await request(method, {}) };
    const entries = [];
    let cursor = null;
    for (;;) {
      const result = await request("model/list", {
        limit: 100, includeHidden: true, ...(cursor ? { cursor } : {}),
      });
      const data = Array.isArray(result?.data) ? result.data : [];
      entries.push(...data);
      cursor = typeof result?.nextCursor === "string" && result.nextCursor ? result.nextCursor : null;
      if (!cursor || entries.length >= maxRows) break;
    }
    return { status: 0, entries: entries.slice(0, maxRows) };
  })();
  try {
    const result = await Promise.race([conversation, deadline]);
    if (deadlineExpired()) throw new Error("timeout");
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const known = new Set(["rpc-error", "protocol-overflow", "stdin-error", "timeout", "closed-early", "output-limit", "spawn-failed", "aborted"]);
    fail(known.has(message) ? message : (failReason ?? "timeout"));
    return { status: null, code: failReason ?? "timeout" };
  } finally {
    clearTimeout(deadlineTimer);
    signal?.removeEventListener?.("abort", onAbort);
    if (!settled) {
      settled = true;
      cleanup();
      try { child.stdin?.end(); } catch { /* already closed */ }
      kill(child);
    }
    const cleanupMs = Math.min(1_000, Math.max(0, deadlineAt - performance.now()));
    if (cleanupMs > 0) {
      let timer;
      const grace = new Promise((resolve) => { timer = setTimeout(resolve, cleanupMs); });
      await Promise.race([finished, grace]).finally(() => clearTimeout(timer));
    }
  }
}

function defaultProbe(spawnFn) {
  return (spec) => (spec.kind === "codex-rpc" ? runCodexMetadata(spec) : runExec(spec));
}

// --- catalog service --------------------------------------------------------

export function createModelCatalog({
  env,
  config,
  probe,
  spawnFn = spawnNativeCommand,
  now = Date.now,
  ttlMs = CATALOG_TTL_MS,
  retryMs = CATALOG_RETRY_MS,
  timeoutMs = CATALOG_TIMEOUT_MS,
  maxOutputBytes = CATALOG_MAX_OUTPUT_BYTES,
  maxRows = CATALOG_MAX_ROWS,
  maxCacheEntries = CATALOG_MAX_CACHE_ENTRIES,
} = {}) {
  const runProbe = probe ?? defaultProbe(spawnFn);
  const cache = new Map(); // key -> { data, expiresAt }
  const failures = new Map(); // key -> { at, reason } (never stores data)
  const inFlight = new Map(); // key -> Promise

  const rememberFailure = (key, reason, timestamp) => {
    failures.delete(key); // refresh insertion order for the bound
    failures.set(key, { at: timestamp, reason });
    while (failures.size > maxCacheEntries) {
      const oldest = failures.keys().next();
      if (oldest.done) break;
      failures.delete(oldest.value);
    }
  };

  const rememberSuccess = (key, data, timestamp) => {
    failures.delete(key);
    cache.delete(key); // refresh insertion order for the bound
    cache.set(key, { data, expiresAt: timestamp + ttlMs });
    while (cache.size > maxCacheEntries) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
  };

  const launchSpec = (target, cwd) => {
    const { command, baseArgs, env: launchEnv } = launchFor(target, { env, config });
    return {
      target, kind: "exec", command, args: baseArgs, env: launchEnv,
      cwd: cwd ?? process.cwd(), timeoutMs, maxOutputBytes, maxRows, label: target, spawnFn,
    };
  };

  async function fetchOpencode(spec, target, deadline) {
    const version = await runProbe({ ...spec, timeoutMs: Math.min(spec.timeoutMs, 5_000), args: [...spec.args, "--version"] });
    if (version.status !== 0 || !isOpenCodeV2Version(version.stdout ?? "")) {
      throw new Error(code(target, version.code ?? "v2-required"));
    }
    const apiTimeout = deadline - now();
    if (!(apiTimeout > 0)) throw new Error(code(target, "timeout"));
    const api = await runProbe({ ...spec, timeoutMs: apiTimeout, args: [...spec.args, "api", "model.list"] });
    if (api.status === 0 && typeof api.stdout === "string") {
      try {
        const payload = JSON.parse(decodeCatalogText(api.stdout));
        if (Array.isArray(payload?.data)) {
          return { models: parseOpencodeApiModels(payload, maxRows), source: `${spec.label} api model.list` };
        }
      } catch { /* fall through to CLI */ }
    } else if (api.status === 0) {
      // Oversized or missing body: still fall through to the CLI.
    }
    const remaining = deadline - now();
    if (!(remaining > 0)) throw new Error(code(target, "timeout"));
    const cli = await runProbe({ ...spec, timeoutMs: remaining, args: [...spec.args, "models"] });
    if (cli.status !== 0) {
      if (cli.code) throw new Error(code(target, cli.code));
      throw new Error(code(target, `exit-${cli.status}`));
    }
    // CLI ids carry no cost: free-only upgrades stay unavailable, honestly.
    return { models: parseOpencodeModels(cli.stdout, maxRows), source: `${spec.label} models` };
  }

  async function fetchCli(spec, target, source, flag, emptyCode) {
    const result = await runProbe({ ...spec, args: [...spec.args, flag] });
    if (result.status !== 0) {
      if (result.code) throw new Error(code(target, result.code));
      throw new Error(code(target, `exit-${result.status}`));
    }
    const models = target === "pi"
      ? parsePiListModels(result.stdout, maxRows)
      : parseCursorListModels(result.stdout, maxRows);
    if (!models.length) throw new Error(code(target, emptyCode));
    return { models, source };
  }

  async function fetchCodex(spec, target, route) {
    const provider = route?.provider;
    // The default catalog covers the native account only; a custom provider
    // must not silently inherit another provider's availability.
    if (provider !== undefined && provider !== null && provider !== "" && provider !== "codex") {
      throw new Error(code(target, "unsupported-provider"));
    }
    const result = await runProbe({ ...spec, kind: "codex-rpc", args: [...spec.args, "app-server"] });
    if (!result.entries) throw new Error(code(target, result.code ?? "rpc-failed"));
    const models = parseCodexModelList(result.entries, maxRows).map((entry) => provider ? { ...entry, provider } : entry);
    return { models, source: "codex app-server model/list" };
  }

  const SOURCES = Object.freeze({
    pi: "pi --list-models",
    cursor: "cursor-agent --list-models",
    claude: "claude:aliases",
  });

  async function refresh(target, route, cwd) {
    const at = new Date(now()).toISOString();
    if (["amp", "acp"].includes(target)) {
      return {
        models: [], source: `${target}:native-catalog-unavailable`, at,
        status: "unavailable", reason: `${target}:native-catalog-unavailable`,
      };
    }
    const spec = launchSpec(target, cwd);
    const deadline = now() + timeoutMs;
    let fetched;
    if (target === "opencode") fetched = await fetchOpencode(spec, target, deadline);
    else if (target === "pi") fetched = await fetchCli(spec, target, SOURCES.pi, "--list-models", "empty-catalog");
    else if (target === "cursor") fetched = await fetchCli(spec, target, SOURCES.cursor, "--list-models", "empty-catalog");
    else if (target === "codex") fetched = await fetchCodex(spec, target, route);
    else if (target === "claude") {
      return { models: [], managed: [...CLAUDE_MANAGED_ALIASES], source: SOURCES.claude, at, status: "available", reason: "claude exposes managed aliases instead of a catalog; the parent maps aliases" };
    } else {
      throw new Error(code("catalog", "unsupported-target"));
    }
    return { models: fetched.models, source: fetched.source, at,
      ...(fetched.models.length >= maxRows
        ? { status: "unavailable", reason: code(target, "row-limit") }
        : { status: "available" }),
    };
  }

  async function getCatalog({ target, route, cwd } = {}) {
    if (typeof target !== "string" || !TARGETS.has(target)) {
      return fail(target, "unknown", code("catalog", "unsupported-target"), now);
    }
    if (target === "opencode" && route?.harnessVersion !== undefined && !HARNESS_VERSIONS.includes(route.harnessVersion)) {
      return fail(target, target, code(target, "v2-required"), now);
    }
    const key = `${target}::${route?.provider ?? ""}::${cwd ?? ""}`;
    const timestamp = now();
    const cached = cache.get(key);
    if (cached && timestamp < cached.expiresAt) return cached.data;
    const failed = failures.get(key);
    if (failed && timestamp < failed.at + retryMs) {
      // Backoff holds with or without cached data: no re-probe, and the
      // original failure code is preserved either way.
      if (cached) {
        return { ...cached.data, status: "stale", reason: failed.reason };
      }
      return fail(target, target, failed.reason, now);
    }
    if (inFlight.has(key)) return inFlight.get(key);
    const pending = (async () => {
      try {
        const data = await refresh(target, route, cwd);
        rememberSuccess(key, data, now());
        return data;
      } catch (error) {
        // Reasons are generic target:code pairs. Injected-probe throws and
        // other raw failures collapse to probe-failed; stderr and exception
        // text never reach callers.
        const raw = error instanceof Error && typeof error.message === "string" ? error.message : "";
        const suffix = raw.startsWith(`${target}:`) ? raw.slice(target.length + 1) : "";
        const known = new Set(["timeout", "output-limit", "spawn-failed", "closed-early", "rpc-error", "stdin-error", "protocol-overflow", "empty-catalog", "unsupported-provider", "rpc-failed"]);
        if (target === "opencode") known.add("v2-required");
        const reason = known.has(suffix) || /^exit-(?:null|-?\d+)$/.test(suffix) ? raw : code(target, "probe-failed");
        rememberFailure(key, reason, now());
        const previous = cache.get(key);
        // Stale only after a first success; the first failure is unavailable.
        if (previous) {
          return { ...previous.data, status: "stale", reason };
        }
        return fail(target, target, reason, now);
      } finally {
        inFlight.delete(key);
      }
    })();
    inFlight.set(key, pending);
    return pending;
  }

  return getCatalog;
}
