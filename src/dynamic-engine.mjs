/**
 * Dynamic workflow script engine.
 *
 * Evaluates an author-supplied JavaScript workflow inside a pinned QuickJS
 * WebAssembly runtime and bridges the guest to host callbacks. The engine is
 * deliberately self-contained: it owns no persistence, routing, or job state.
 * The durable runner owns replay and passes an injected `onAgent` callback.
 *
 * Integration API (see docs/dynamic-workflows-contract.md):
 *   validateScript(source, limits?) -> { meta, body }
 *   runScript({ source, args, onAgent, onPhase, onLog, onIdle, signal, limits }) -> JSON
 *
 * `onIdle` is invoked whenever the guest has no pending jobs and is blocked on
 * host callbacks (after every host microtask turn); the durable runner uses it
 * to flush replay deliveries without timing guesses.
 *
 * Guest globals: agent, pipeline, parallel, phase, log, args.
 *
 * Ordering contract
 * -----------------
 * `phase(title)` and `log(message)` are invoked synchronously at the moment the
 * guest calls them, so invocation order matches guest order. Their returns are
 * promises, so `await phase(...)` also observes completion. Every `agent(...)`
 * waits for all previously enqueued phase/log callbacks to settle before
 * `onAgent` is dispatched, which keeps callback effects ordered before the next
 * agent even when the script does not await phase/log.
 *
 * Errors
 * ------
 * Every engine failure is a DynamicEngineError with `code` and `details.kind`
 * (`aborted`, `timeout`, `out_of_memory`, `stack_overflow`, `limit_exceeded`,
 * `invalid_json`, `guest_error`, ...). Synchronous argument and limit failures
 * throw inside the guest at the call site, so guest code that catches them sees
 * the message text; when they abort the script the host error also carries the
 * structured kind. Once the wall deadline or CPU slice has been flagged, host
 * callbacks become inert (no dispatch, no throw) while the pending interrupt
 * unwinds the guest; the run then fails with the structured timeout or
 * cpu-limit error. Asynchronous host callback failures reject the guest promise
 * and are delivered as guest data errors without host object identity.
 *
 * Limits contract (stable field names)
 * ------------------------------------
 * runScript accepts a `limits` object overriding any field of `DEFAULT_LIMITS`.
 * Unknown fields are ignored so the runner can evolve without breaking. Every
 * exceeded bound produces a DynamicEngineError with `details.kind`, never a
 * silent truncation.
 *
 * Isolation
 * ---------
 * No module loader is installed, imports are rejected by the Acorn pre-parse
 * before any guest bytecode runs, and only JSON values cross the boundary.
 * Date and Math.random are replaced with throwing, non-reconfigurable bindings.
 * Wall-clock deadlines, CPU interrupts, a memory limit, and a stack cap bound
 * runaway guest code. The runner supplies any deterministic time or randomness
 * through `args`.
 */

import { parse } from "acorn";
import {
  DefaultIntrinsics,
  newQuickJSWASMModuleFromVariant,
} from "quickjs-emscripten-core";
import quickjsVariant from "@jitl/quickjs-wasmfile-release-sync";

export const DYNAMIC_ENGINE_API_VERSION = 1;

export const DEFAULT_LIMITS = Object.freeze({
  /** Maximum workflow source bytes accepted by validateScript. */
  maxSourceBytes: 1_000_000,
  /** Maximum serialized `args` bytes. */
  maxInputBytes: 1_000_000,
  /** Maximum serialized final output bytes. */
  maxResultBytes: 4_000_000,
  /** Maximum serialized `agent` prompt + options bytes. */
  maxCallbackBytes: 1_000_000,
  /** Maximum serialized single agent result bytes. */
  maxAgentResultBytes: 2_000_000,
  /** Maximum JSON nesting depth accepted in either direction. */
  maxDepth: 64,
  /** Maximum agent() invocations counted per run. */
  maxAgents: 1000,
  /** Maximum concurrent callback workers for pipeline/parallel. */
  maxConcurrency: 8,
  /** Maximum agent() calls outstanding at one time. */
  maxOutstandingCallbacks: 256,
  /** Maximum items accepted by one pipeline/parallel call. */
  maxHelperItems: 4096,
  /** Maximum pipeline/parallel/phase/log calls per run. */
  maxHelperCalls: 100_000,
  /** Maximum log() calls per run. */
  maxLogs: 10_000,
  /** Maximum bytes in one log() message. */
  maxLogMessageBytes: 8192,
  /** Maximum total log() bytes per run. */
  maxLogBytes: 262_144,
  /** Maximum phase() calls per run. */
  maxPhases: 1000,
  /** Guest heap cap in bytes. */
  memoryLimitBytes: 256 * 1024 * 1024,
  /** Guest stack cap in bytes. */
  stackSizeBytes: 1024 * 1024,
  /** Absolute guest wall-clock deadline in milliseconds. */
  timeoutMs: 30_000,
  /** Maximum uninterrupted guest CPU execution between host entries. A guest
   * loop cannot rely on host timers, so the QuickJS interrupt handler enforces
   * this budget independently of the total timeoutMs deadline. */
  maxCpuSliceMs: 250,
  /** Maximum microtask drain iterations (promise-storm guard). */
  maxDriveTicks: 2_000_000,
  /** Maximum guest jobs executed in one pump (promise-storm guard). */
  maxPendingJobsPerPump: 100_000,
});

const LIMIT_KEYS = new Set(Object.keys(DEFAULT_LIMITS));

export class DynamicEngineError extends Error {
  constructor(message, { code = "engine_error", details = {} } = {}) {
    super(message);
    this.name = "DynamicEngineError";
    this.code = code;
    this.details = details;
  }
}

function fail(kind, message, details = {}) {
  return new DynamicEngineError(message, {
    code: details.code ?? kind,
    details: { kind, ...details },
  });
}

const encoder = new TextEncoder();

function byteLength(value) {
  if (typeof value !== "string") value = String(value);
  return encoder.encode(value).length;
}

const MAX_ERROR_TEXT_BYTES = 65_536;

function boundText(text, maxBytes = MAX_ERROR_TEXT_BYTES) {
  if (typeof text !== "string") return text;
  const bytes = byteLength(text);
  if (bytes <= maxBytes) return text;
  let end = Math.min(text.length, maxBytes);
  while (end > 0 && byteLength(text.slice(0, end)) > maxBytes) end -= 1;
  return `${text.slice(0, end)}…[truncated ${bytes - maxBytes} bytes]`;
}

function safeDispose(disposable) {
  try {
    disposable?.dispose?.();
  } catch {
    /* already disposed or owned by a torn-down context */
  }
}

// ---------------------------------------------------------------------------
// JSON boundary
// ---------------------------------------------------------------------------

function cloneJson(value, L, label, maxBytes, depth = 0, ancestors = new Set(), path = "$") {
  if (depth > L.maxDepth) {
    throw fail("invalid_json", `${label} exceeds max depth ${L.maxDepth} at ${path}`, {
      location: path,
    });
  }
  if (value === null) return null;
  const type = typeof value;
  if (type === "string" || type === "boolean") return value;
  if (type === "number") {
    if (!Number.isFinite(value)) {
      throw fail("invalid_json", `${label} contains a non-finite number at ${path}`, {
        location: path,
      });
    }
    return value;
  }
  if (type === "undefined" || type === "bigint" || type === "function" || type === "symbol") {
    throw fail("invalid_json", `${label} contains ${type} at ${path}; JSON values only`, {
      location: path,
    });
  }
  if (type !== "object") {
    throw fail("invalid_json", `${label} contains unsupported value at ${path}`, { location: path });
  }
  if (ancestors.has(value)) {
    throw fail("invalid_json", `${label} contains a circular reference at ${path}`, {
      location: path,
    });
  }
  ancestors.add(value);
  try {
    let out;
    if (Array.isArray(value)) {
      out = new Array(value.length);
      for (let i = 0; i < value.length; i++) {
        out[i] = cloneJson(value[i], L, label, maxBytes, depth + 1, ancestors, `${path}[${i}]`);
      }
    } else {
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw fail("invalid_json", `${label} contains a non-plain object at ${path}`, {
          location: path,
        });
      }
      out = {};
      for (const key of Object.keys(value)) {
        if (key === "__proto__") {
          throw fail("invalid_json", `${label} contains a forbidden "__proto__" key at ${path}`, {
            location: path,
          });
        }
        Object.defineProperty(out, key, {
          value: cloneJson(value[key], L, label, maxBytes, depth + 1, ancestors, `${path}.${key}`),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    }
    return out;
  } finally {
    ancestors.delete(value);
  }
}

function assertJson(value, L, label, maxBytes = L.maxResultBytes) {
  const cloned = cloneJson(value, L, label, maxBytes);
  const bytes = byteLength(JSON.stringify(cloned));
  if (maxBytes !== Infinity && bytes > maxBytes) {
    throw fail("limit_exceeded", `${label} is ${bytes} bytes; limit is ${maxBytes}`, {
      bytes,
      limit: maxBytes,
      label,
    });
  }
  return cloned;
}

function jsonToGuest(ctx, value, L, depth = 0) {
  if (depth > L.maxDepth) {
    throw fail("invalid_json", `value exceeds max depth ${L.maxDepth}`, {});
  }
  if (value === null || value === undefined) return ctx.null;
  const type = typeof value;
  if (type === "boolean") return value ? ctx.true : ctx.false;
  if (type === "number") return ctx.newNumber(value);
  if (type === "string") return ctx.newString(value);
  if (Array.isArray(value)) {
    const array = ctx.newArray();
    try {
      for (let i = 0; i < value.length; i++) {
        const child = jsonToGuest(ctx, value[i], L, depth + 1);
        ctx.defineProp(array, i, {
          value: child,
          enumerable: true,
          writable: true,
          configurable: true,
        });
        child.dispose();
      }
      return array;
    } catch (error) {
      safeDispose(array);
      throw error;
    }
  }
  if (type === "object") {
    const object = ctx.newObject();
    try {
      for (const key of Object.keys(value)) {
        const child = jsonToGuest(ctx, value[key], L, depth + 1);
        ctx.defineProp(object, key, {
          value: child,
          enumerable: true,
          writable: true,
          configurable: true,
        });
        child.dispose();
      }
      return object;
    } catch (error) {
      safeDispose(object);
      throw error;
    }
  }
  throw fail("invalid_json", `cannot convert ${type} to a guest value`, {});
}

function safeDump(ctx, handle) {
  try {
    return ctx.dump(handle);
  } catch (error) {
    return { name: "Error", message: String(error?.message ?? error) };
  }
}

function guestHandleToJson(ctx, handle, L, label, maxBytes) {
  const type = ctx.typeof(handle);
  if (type === "undefined") return null;
  if (type === "function" || type === "symbol" || type === "bigint") {
    throw fail("invalid_json", `${label} must be JSON-compatible; got ${type}`, { label, type });
  }
  const dumped = safeDump(ctx, handle);
  return assertJson(dumped, L, label, maxBytes);
}

function normalizeGuestError(dumped) {
  if (dumped && typeof dumped === "object") {
    return {
      name: dumped.name ? String(dumped.name) : "Error",
      message: boundText(dumped.message !== undefined ? String(dumped.message) : ""),
      stack: dumped.stack ? boundText(String(dumped.stack), 4096) : undefined,
    };
  }
  return { name: "Error", message: boundText(String(dumped)), stack: undefined };
}

function guestRuntimeError(dumped, state, hint = null) {
  if (state.aborted) {
    return state.abortError ?? fail("aborted", "dynamic workflow aborted", {});
  }
  if (state.timedOut) {
    return fail("timeout", "dynamic workflow exceeded its deadline", {});
  }
  const info = normalizeGuestError(dumped);
  if (hint && info.message === hint.message) {
    return hint;
  }
  if (info.name === "InternalError" && /out of memory/i.test(info.message)) {
    return fail("out_of_memory", `guest ran out of memory: ${info.message}`, {
      guestName: info.name,
      guestMessage: info.message,
    });
  }
  if (info.name === "InternalError" && /stack overflow/i.test(info.message)) {
    return fail("stack_overflow", `guest exceeded the stack limit: ${info.message}`, {
      guestName: info.name,
      guestMessage: info.message,
    });
  }
  if (info.name === "InternalError" && /interrupted/i.test(info.message)) {
    return fail("interrupted", "guest execution was interrupted", { guestName: info.name });
  }
  return fail("guest_error", `${info.name}: ${info.message}`, {
    guestName: info.name,
    guestMessage: info.message,
    stack: info.stack,
  });
}

// ---------------------------------------------------------------------------
// Metadata pre-parse (Acorn, no execution)
// ---------------------------------------------------------------------------

const META_KEYS = new Set(["name", "description", "phases"]);

function literalValue(node, label) {
  if (!node) throw fail("invalid_metadata", `${label} must be a literal`, {});
  switch (node.type) {
    case "Literal":
      if (node.regex) throw fail("invalid_metadata", `${label} cannot contain a regular expression`, {});
      return node.value;
    case "TemplateLiteral":
      if (node.expressions.length > 0) {
        throw fail("invalid_metadata", `${label} template must not contain expressions`, {});
      }
      return node.quasis.map((q) => q.value.cooked).join("");
    case "ArrayExpression":
      return node.elements.map((element, index) =>
        literalValue(element, `${label}[${index}]`),
      );
    case "ObjectExpression":
      return objectLiteralValue(node, label);
    case "UnaryExpression":
      if (node.operator === "-" && node.argument.type === "Literal") {
        const value = node.argument.value;
        if (typeof value === "number") return -value;
      }
      throw fail("invalid_metadata", `${label} must be a literal`, {});
    default:
      throw fail("invalid_metadata", `${label} must be a literal; got ${node.type}`, {});
  }
}

function objectLiteralValue(node, label) {
  const out = {};
  for (const property of node.properties) {
    if (property.type !== "Property" || property.computed || property.kind !== "init" || property.method) {
      throw fail("invalid_metadata", `${label} must contain plain key/value properties`, {});
    }
    let key;
    if (property.key.type === "Identifier") key = property.key.name;
    else if (property.key.type === "Literal" && typeof property.key.value === "string") {
      key = property.key.value;
    } else {
      throw fail("invalid_metadata", `${label} keys must be identifiers or strings`, {});
    }
    if (key === "__proto__") {
      throw fail("invalid_metadata", `${label} may not contain a "__proto__" key`, {});
    }
    Object.defineProperty(out, key, {
      value: literalValue(property.value, `${label}.${key}`),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

function normalizeMeta(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw fail("invalid_metadata", "meta must be a literal object", {});
  }
  for (const key of Object.keys(value)) {
    if (!META_KEYS.has(key)) {
      throw fail("invalid_metadata", `meta contains unknown field "${key}"`, { field: key });
    }
  }
  if (typeof value.name !== "string" || value.name.trim() === "") {
    throw fail("invalid_metadata", 'meta.name must be a non-empty string', {});
  }
  const meta = { name: value.name };
  if (value.description !== undefined) {
    if (typeof value.description !== "string") {
      throw fail("invalid_metadata", "meta.description must be a string", {});
    }
    meta.description = value.description;
  }
  if (value.phases !== undefined) {
    if (!Array.isArray(value.phases) || value.phases.some((phase) => typeof phase !== "string")) {
      throw fail("invalid_metadata", "meta.phases must be an array of strings", {});
    }
    meta.phases = [...value.phases];
  }
  return meta;
}

function metaDeclaration(declaration) {
  return (
    declaration &&
    declaration.type === "VariableDeclaration" &&
    declaration.kind === "const" &&
    declaration.declarations.length === 1 &&
    declaration.declarations[0].id.type === "Identifier" &&
    declaration.declarations[0].id.name === "meta" &&
    declaration.declarations[0].init
  );
}

function walkAst(node, visit) {
  if (!node || typeof node.type !== "string") return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end" || key === "loc" || key === "range") continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item.type === "string") walkAst(item, visit);
      }
    } else if (child && typeof child.type === "string") {
      walkAst(child, visit);
    }
  }
}

/**
 * Parse and validate a workflow script without executing it.
 *
 * Returns `{ meta, body }` where `meta` is the literal metadata object (or
 * `null` when absent) and `body` is the source with the meta export blanked so
 * line numbers are preserved. Imports, dynamic imports, import.meta, extra
 * exports, and non-literal metadata are rejected here, before any guest code
 * can run.
 */
export function validateScript(source, limits = DEFAULT_LIMITS) {
  const L = mergeLimits(limits);
  if (typeof source !== "string") {
    throw fail("invalid_script", "workflow source must be a string", {});
  }
  const sourceBytes = byteLength(source);
  if (sourceBytes > L.maxSourceBytes) {
    throw fail("limit_exceeded", `workflow source is ${sourceBytes} bytes; limit is ${L.maxSourceBytes}`, {
      bytes: sourceBytes,
      limit: L.maxSourceBytes,
    });
  }

  let ast;
  try {
    ast = parse(source, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      locations: true,
    });
  } catch (error) {
    throw fail("syntax_error", `workflow syntax error: ${error.message}`, {
      line: error.loc ? error.loc.line : undefined,
      column: error.loc ? error.loc.column : undefined,
    });
  }

  let metaNode = null;
  let metaCount = 0;
  for (const statement of ast.body) {
    if (statement.type === "ImportDeclaration") {
      throw fail("import_not_allowed", "workflow scripts may not import modules", {
        line: statement.loc?.start?.line,
      });
    }
    if (statement.type === "ExportAllDeclaration" || statement.type === "ExportDefaultDeclaration") {
      throw fail("export_not_allowed", "workflow scripts may not use export/export default", {
        line: statement.loc?.start?.line,
      });
    }
    if (statement.type === "ExportNamedDeclaration") {
      if (statement.source) {
        throw fail("import_not_allowed", "workflow scripts may not re-export modules", {});
      }
      if (metaDeclaration(statement.declaration)) {
        metaCount += 1;
        metaNode = statement;
      } else {
        throw fail("export_not_allowed", "only a single `export const meta = {...}` is allowed", {
          line: statement.loc?.start?.line,
        });
      }
    }
  }

  walkAst(ast, (node) => {
    if (node.type === "ImportExpression") {
      throw fail("import_not_allowed", "workflow scripts may not use dynamic import()", {
        line: node.loc?.start?.line,
      });
    }
    if (node.type === "MetaProperty" && node.meta?.name === "import") {
      throw fail("import_not_allowed", "workflow scripts may not use import.meta", {
        line: node.loc?.start?.line,
      });
    }
  });

  if (metaCount > 1) {
    throw fail("invalid_metadata", "workflow scripts may declare meta only once", {});
  }

  let meta = null;
  if (metaNode) {
    const init = metaNode.declaration.declarations[0].init;
    meta = normalizeMeta(literalValue(init, "meta"));
  }

  let body = source;
  if (metaNode) {
    const before = source.slice(0, metaNode.start);
    const blanked = source.slice(metaNode.start, metaNode.end).replace(/[^\n\r]/g, " ");
    const after = source.slice(metaNode.end);
    body = before + blanked + after;
  }

  return { meta, body };
}

// ---------------------------------------------------------------------------
// QuickJS module (lazy, memoized)
// ---------------------------------------------------------------------------

let modulePromise = null;

function loadQuickJS() {
  if (!modulePromise) {
    modulePromise = newQuickJSWASMModuleFromVariant(quickjsVariant).catch((error) => {
      modulePromise = null;
      throw fail("engine_unavailable", `failed to load the QuickJS engine: ${error.message}`, {});
    });
  }
  return modulePromise;
}

// ---------------------------------------------------------------------------
// Guest program assembly
// ---------------------------------------------------------------------------

const HARDENING_SOURCE = `
(function () {
  "use strict";
  function blockedDate() {
    throw new Error("Date is not available in dynamic workflows; pass deterministic timestamps through args");
  }
  Object.defineProperty(blockedDate, "now", {
    value: function now() {
      throw new Error("Date.now is not available in dynamic workflows; pass deterministic timestamps through args");
    },
    writable: false, enumerable: false, configurable: false,
  });
  Object.defineProperty(blockedDate, "parse", {
    value: function parse() { throw new Error("Date.parse is not available in dynamic workflows"); },
    writable: false, enumerable: false, configurable: false,
  });
  Object.defineProperty(blockedDate, "UTC", {
    value: function UTC() { throw new Error("Date.UTC is not available in dynamic workflows"); },
    writable: false, enumerable: false, configurable: false,
  });
  Object.freeze(blockedDate);
  Object.defineProperty(globalThis, "Date", {
    value: blockedDate, writable: false, enumerable: false, configurable: false,
  });
  Object.defineProperty(Math, "random", {
    value: function random() {
      throw new Error("Math.random is not available in dynamic workflows; pass randomness through args");
    },
    writable: false, enumerable: false, configurable: false,
  });
  Object.freeze(Math);
})();
`;

const FREEZE_ARGS_SOURCE = `
(function () {
  "use strict";
  (function freeze(value) {
    if (value && typeof value === "object") {
      Object.freeze(value);
      for (const key of Object.keys(value)) freeze(value[key]);
    }
  })(args);
})();
`;

function buildProgram(body) {
  return [
    '"use strict";',
    HARDENING_SOURCE,
    FREEZE_ARGS_SOURCE,
    "(async () => {",
    body,
    "})()",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

function mergeLimits(overrides) {
  if (overrides === undefined || overrides === null) return DEFAULT_LIMITS;
  if (typeof overrides !== "object") {
    throw fail("config_error", "limits must be an object", {});
  }
  const merged = { ...DEFAULT_LIMITS };
  for (const [key, value] of Object.entries(overrides)) {
    if (!LIMIT_KEYS.has(key)) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw fail("config_error", `limit "${key}" must be a non-negative finite number`, { field: key });
    }
    merged[key] = value;
  }
  return merged;
}

// ---------------------------------------------------------------------------
// runScript
// ---------------------------------------------------------------------------

/**
 * Execute a workflow script against host callbacks.
 *
 * @param {object} options
 * @param {string} options.source Workflow source (with optional literal meta).
 * @param {unknown} [options.args] JSON arguments exposed as the read-only `args` global.
 * @param {(prompt: string, options: object|null) => Promise<unknown>} options.onAgent
 *   Dispatches one agent; resolves to a JSON value or null.
 * @param {(title: string) => unknown} [options.onPhase] Called for each phase(title).
 * @param {(message: string) => unknown} [options.onLog] Called for each log(message).
 * @param {() => unknown} [options.onIdle] Called when the guest is quiescent and
 *   blocked on host callbacks; may be async. Replay runners flush cached
 *   deliveries here instead of guessing batch boundaries with timers.
 * @param {AbortSignal} [options.signal] Cancellation signal.
 * @param {object} [options.limits] Overrides for DEFAULT_LIMITS.
 * @returns {Promise<unknown>} The JSON-compatible final script value.
 */
export async function runScript(options = {}) {
  const { source, args, onAgent, onPhase, onLog, onIdle, signal } = options;
  const L = mergeLimits(options.limits);

  if (typeof onAgent !== "function") {
    throw fail("config_error", "runScript requires an onAgent callback", {});
  }
  const { meta, body } = validateScript(source, L);
  const argsJson = args === undefined || args === null ? null : assertJson(args, L, "args", L.maxInputBytes);

  const QuickJS = await loadQuickJS();
  const rt = QuickJS.newRuntime();
  rt.setMemoryLimit(L.memoryLimitBytes);
  rt.setMaxStackSize(L.stackSizeBytes);

  const ctx = rt.newContext({
    intrinsics: { ...DefaultIntrinsics, Date: false },
  });

  const state = {
    disposed: false,
    aborted: false,
    timedOut: false,
    cpuLimited: null,
    cpuSliceStartedAt: 0,
    abortError: null,
    deadline: Date.now() + L.timeoutMs,
  };

  const counters = { agents: 0, helpers: 0, logs: 0, logBytes: 0, phases: 0 };
  const deferreds = new Set();
  const retained = new Set();
  const pendingAgents = new Set();
  const helperTasks = new Set();
  const unawaitedErrors = [];
  let metaChain = Promise.resolve();
  let metaError = null;
  let pendingMeta = 0;
  let topLevelSettled = false;
  let fatalHint = null;
  let ctxAlive = true;
  let jsonValidator = null;
  let guestDepth = 0;
  let progressRevision = 0;
  const progressWaiters = new Set();

  function notifyProgress() {
    progressRevision += 1;
    for (const wake of [...progressWaiters]) wake();
  }

  const abortListener = () => {
    if (state.aborted) return;
    state.aborted = true;
    state.abortError = fail("aborted", "dynamic workflow aborted", {});
    notifyProgress();
  };

  function registerDeferred(deferred) {
    deferreds.add(deferred);
    return deferred;
  }

  // Reentrant validation shares the outer guest entry's CPU slice. Host waits
  // do not accrue guest CPU; the total wall deadline remains independent.
  function runGuest(callback) {
    if (guestDepth === 0) state.cpuSliceStartedAt = Date.now();
    guestDepth += 1;
    try { return callback(); }
    finally { guestDepth -= 1; }
  }

  function cpuLimitError() {
    return fail("cpu-limit", `guest exceeded the ${L.maxCpuSliceMs}ms CPU slice without yielding`, { limit: L.maxCpuSliceMs });
  }

  function throwIfCpuLimited() {
    if (state.cpuLimited) throw cpuLimitError();
  }

  // Once the deadline or CPU slice has been flagged, the interrupt handler is
  // already unwinding the guest. Host callbacks must then stay inert: creating
  // guest promises or throwing into the VM from this point re-enters QuickJS
  // while the interrupt is pending, and quickjs-emscripten 0.32 can trap inside
  // QTS_Eval (issue 15 clock probe). Returning a plain value leaves the VM
  // untouched until the pending interrupt aborts the script.
  function limitReached() {
    return state.timedOut || state.cpuLimited;
  }

  function assertLive() {
    if (state.cpuLimited) throw cpuLimitError();
    if (state.disposed) {
      throw fail("internal_error", "workflow engine disposed", {});
    }
    if (state.aborted) {
      throw state.abortError ?? fail("aborted", "dynamic workflow aborted", {});
    }
    if (!state.timedOut && Date.now() > state.deadline) {
      state.timedOut = true;
    }
    if (state.timedOut) {
      throw fail("timeout", `dynamic workflow exceeded ${L.timeoutMs}ms`, { timeoutMs: L.timeoutMs });
    }
  }

  function resolveDeferred(deferred, handle) {
    if (state.disposed || !ctxAlive) {
      if (handle) safeDispose(handle);
      return;
    }
    try {
      if (handle) deferred.resolve(handle);
      else deferred.resolve();
      notifyProgress();
    } catch {
      /* late settle after teardown */
    }
  }

  function hostErrorToGuest(error) {
    const name = error instanceof DynamicEngineError ? "Error" : error?.name ? String(error.name) : "Error";
    const message = boundText(error?.message ? String(error.message) : String(error));
    const handle = ctx.newError({ name, message });
    if (error instanceof DynamicEngineError) {
      const props = { kind: error.details?.kind, code: error.code };
      for (const [key, value] of Object.entries(props)) {
        if (value === undefined) continue;
        let child = null;
        try {
          child = jsonToGuest(ctx, value, L);
          ctx.defineProp(handle, key, {
            value: child,
            enumerable: true,
            writable: false,
            configurable: false,
          });
        } catch {
          /* best-effort diagnostics only */
        } finally {
          safeDispose(child);
        }
      }
    }
    return handle;
  }

  function hintFatal(error) {
    if (
      error instanceof DynamicEngineError &&
      error.details?.kind !== "aborted" &&
      error.details?.kind !== "timeout" &&
      !fatalHint
    ) {
      fatalHint = error;
    }
    return error;
  }

  function throwSync(deferred, error) {
    deferreds.delete(deferred);
    safeDispose(deferred);
    throw hintFatal(error);
  }

  function rejectDeferred(deferred, error) {
    if (state.disposed || !ctxAlive) return;
    hintFatal(error);
    let handle = null;
    try {
      handle = hostErrorToGuest(error);
      deferred.reject(handle);
    } catch {
      try {
        deferred.reject();
      } catch {
        /* already settled */
      }
    } finally {
      safeDispose(handle);
      notifyProgress();
    }
  }

  function enqueueMeta(run) {
    pendingMeta += 1;
    const guarded = () => {
      if (state.disposed) throw fail("internal_error", "workflow engine disposed", {});
      return run();
    };
    const promise = metaChain.then(guarded, guarded);
    const settled = () => { pendingMeta -= 1; notifyProgress(); };
    promise.then(settled, settled);
    metaChain = promise.catch((error) => {
      if (!metaError) metaError = error;
    });
    return promise;
  }

  function pumpJobs() {
    let executed = 0;
    while (rt.hasPendingJob()) {
      assertLive();
      const result = runGuest(() => rt.executePendingJobs(1));
      if (state.cpuLimited) {
        result.dispose();
        throw cpuLimitError();
      }
      if (result.error) {
        const dumped = safeDump(ctx, result.error);
        result.dispose();
        throw guestRuntimeError(dumped, state, fatalHint);
      }
      result.dispose();
      executed += 1;
      notifyProgress();
      if (executed > L.maxPendingJobsPerPump) {
        throw fail("limit_exceeded", `guest queued more than ${L.maxPendingJobsPerPump} jobs in one pump`, {
          limit: L.maxPendingJobsPerPump,
        });
      }
    }
  }

  function hostTick() {
    return new Promise((resolve) => {
      if (typeof setImmediate === "function") setImmediate(resolve);
      else setTimeout(resolve, 0);
    });
  }

  async function driveUntil(isDone) {
    let iterations = 0;
    while (!isDone()) {
      const revision = progressRevision;
      assertLive();
      pumpJobs();
      if (isDone()) break;
      assertLive();
      await hostTick();
      // Flush guest continuations that host microtasks scheduled, then report
      // quiescence: no pending guest job means the script is blocked on host
      // callbacks and has registered every callback it can for this turn.
      pumpJobs();
      if (!isDone() && !rt.hasPendingJob() && typeof onIdle === "function") {
        try {
          await onIdle();
        } catch (error) {
          throw hintFatal(error);
        }
        pumpJobs();
      }
      iterations = progressRevision === revision ? iterations + 1 : 0;
      if (iterations > L.maxDriveTicks) {
        throw fail("limit_exceeded", "workflow made no progress while awaiting a guest promise", {
          limit: L.maxDriveTicks,
        });
      }
      if (!isDone() && !rt.hasPendingJob() && (pendingAgents.size > 0 || pendingMeta > 0) && progressRevision === revision) {
        await new Promise((resolve) => {
          const wake = () => { clearTimeout(timer); progressWaiters.delete(wake); resolve(); };
          const timer = setTimeout(wake, Math.max(1, Math.min(50, state.deadline - Date.now())));
          progressWaiters.add(wake);
        });
      }
    }
  }

  async function settleGuestValue(handle) {
    let abandoned = false;
    let owned = handle;
    try {
      assertLive();
      const native = ctx.resolvePromise(owned);
      owned.dispose();
      owned = null;
      let settled = false;
      let outcome = null;
      native.then(
        (result) => {
          if (!ctxAlive) return;
          if (abandoned) {
            safeDispose(result);
            return;
          }
          settled = true;
          outcome = result;
        },
        () => {
          settled = true;
        },
      );
      try {
        await driveUntil(() => settled);
      } catch (error) {
        abandoned = true;
        if (ctxAlive) safeDispose(outcome);
        throw error;
      }
      assertLive();
      if (!outcome) {
        throw fail("internal_error", "guest promise settled without a result", {});
      }
      if (outcome.error) {
        const dumped = safeDump(ctx, outcome.error);
        outcome.dispose();
        throw guestRuntimeError(dumped, state, fatalHint);
      }
      let json;
      try {
        assertGuestJson(outcome.value, "result");
        json = guestHandleToJson(ctx, outcome.value, L, "result", L.maxResultBytes);
      } finally {
        outcome.dispose();
      }
      return json;
    } finally {
      safeDispose(owned);
    }
  }

  function readGuestString(handle, what) {
    const type = ctx.typeof(handle);
    if (type === "string") return ctx.getString(handle);
    if (type === "number" || type === "boolean") return String(ctx.dump(handle));
    throw fail("invalid_argument", `${what} must be a string`, { type });
  }

  function installJsonValidator() {
    const source = `(function validateJson(value) {
      const seen = new Set();
      (function check(item, depth) {
        if (item === null || item === undefined) {
          if (depth > 0 && item === undefined) {
            throw new TypeError("value contains undefined, which JSON cannot represent");
          }
          return;
        }
        const type = typeof item;
        if (type === "string" || type === "number" || type === "boolean") return;
        if (type !== "object") {
          throw new TypeError("value is not JSON-compatible: " + type);
        }
        if (seen.has(item)) throw new TypeError("value contains a circular reference");
        seen.add(item);
        if (Array.isArray(item)) {
          for (const child of item) check(child, depth + 1);
        } else {
          for (const key of Object.keys(item)) check(item[key], depth + 1);
        }
        seen.delete(item);
      })(value, 0);
    })`;
    const result = runGuest(() => ctx.evalCode(source, "json-validator.js", { type: "global" }));
    if (state.cpuLimited) {
      result.dispose();
      throw cpuLimitError();
    }
    if (result.error) {
      const dumped = safeDump(ctx, result.error);
      result.dispose();
      throw fail(
        "internal_error",
        `failed to install the guest JSON validator: ${normalizeGuestError(dumped).message}`,
        {},
      );
    }
    jsonValidator = result.value.dup();
    result.dispose();
    retained.add(jsonValidator);
  }

  function assertGuestJson(handle, label) {
    if (!jsonValidator) return;
    const result = runGuest(() => ctx.callFunction(jsonValidator, ctx.undefined, handle));
    if (state.cpuLimited) {
      result.dispose();
      throw cpuLimitError();
    }
    if (result.error) {
      const dumped = safeDump(ctx, result.error);
      result.dispose();
      throw fail(
        "invalid_json",
        `${label} is not JSON-compatible: ${normalizeGuestError(dumped).message}`,
        { label },
      );
    }
    result.dispose();
  }

  function drainUnawaited() {
    if (pendingAgents.size === 0) return Promise.resolve();
    return (async () => {
      while (pendingAgents.size > 0) {
        assertLive();
        pumpJobs();
        await Promise.race([Promise.allSettled([...pendingAgents]), hostTick()]);
        // Unawaited callbacks can still need a replay flush (a fire-and-forget
        // reused call); report quiescence while host callbacks are pending.
        if (pendingAgents.size > 0 && !rt.hasPendingJob() && typeof onIdle === "function") {
          try {
            await onIdle();
          } catch (error) {
            throw hintFatal(error);
          }
          pumpJobs();
        }
      }
    })();
  }

  // -- host function installation -------------------------------------------

  function installAgent() {
    const handle = ctx.newFunction("agent", (promptHandle, optionsHandle) => {
      if (limitReached()) return ctx.undefined;
      const deferred = registerDeferred(ctx.newPromise());
      try {
        assertLive();
        const prompt = readGuestString(promptHandle, "agent prompt");
        if (optionsHandle !== undefined) assertGuestJson(optionsHandle, "agent options");
        const options =
          optionsHandle === undefined
            ? null
            : guestHandleToJson(ctx, optionsHandle, L, "agent options", L.maxCallbackBytes);
        const payloadBytes = byteLength(prompt) + byteLength(JSON.stringify(options ?? null));
        if (payloadBytes > L.maxCallbackBytes) {
          throw fail("limit_exceeded", `agent call is ${payloadBytes} bytes; limit is ${L.maxCallbackBytes}`, {
            bytes: payloadBytes,
            limit: L.maxCallbackBytes,
          });
        }
        if (counters.agents + 1 > L.maxAgents) {
          throw fail("limit_exceeded", `agent call limit of ${L.maxAgents} reached`, {
            limit: L.maxAgents,
          });
        }
        if (pendingAgents.size + 1 > L.maxOutstandingCallbacks) {
          throw fail("limit_exceeded", `more than ${L.maxOutstandingCallbacks} agent calls are outstanding`, {
            limit: L.maxOutstandingCallbacks,
          });
        }
        counters.agents += 1;

        const hostPromise = (async () => {
          await metaChain;
          if (metaError) throw metaError;
          assertLive();
          return await onAgent(prompt, options);
        })();
        pendingAgents.add(hostPromise);

        hostPromise.then(
          (result) => {
            try {
              if (!ctxAlive || state.aborted || state.disposed) return;
              if (result !== null && result !== undefined && typeof result !== "object" && typeof result !== "string" && typeof result !== "number" && typeof result !== "boolean") {
                throw fail("invalid_output", "onAgent must resolve to a JSON value or null", {});
              }
              const normalized = result === undefined ? null : assertJson(result, L, "agent result", L.maxAgentResultBytes);
              const guestValue = jsonToGuest(ctx, normalized, L);
              resolveDeferred(deferred, guestValue);
              guestValue.dispose();
            } catch (error) {
              rejectDeferred(deferred, error);
            } finally {
              pendingAgents.delete(hostPromise);
            }
          },
          (error) => {
            pendingAgents.delete(hostPromise);
            if (!ctxAlive || state.disposed) return;
            if (topLevelSettled) unawaitedErrors.push(error);
            rejectDeferred(deferred, error);
          },
        );
      } catch (error) {
        throwSync(deferred, error);
      }
      return deferred.handle;
    });
    ctx.setProp(ctx.global, "agent", handle);
    handle.dispose();
  }

  function installPhase() {
    const handle = ctx.newFunction("phase", (titleHandle) => {
      if (limitReached()) return ctx.undefined;
      const deferred = registerDeferred(ctx.newPromise());
      try {
        assertLive();
        if (counters.phases + 1 > L.maxPhases) {
          throw fail("limit_exceeded", `phase limit of ${L.maxPhases} reached`, { limit: L.maxPhases });
        }
        const title = readGuestString(titleHandle, "phase title");
        counters.phases += 1;
        if (typeof onPhase === "function") {
          const promise = enqueueMeta(() => onPhase(title));
          promise.then(
            () => resolveDeferred(deferred),
            (error) => rejectDeferred(deferred, error),
          );
        } else {
          resolveDeferred(deferred);
        }
      } catch (error) {
        throwSync(deferred, error);
      }
      return deferred.handle;
    });
    ctx.setProp(ctx.global, "phase", handle);
    handle.dispose();
  }

  function installLog() {
    const handle = ctx.newFunction("log", (messageHandle) => {
      if (limitReached()) return ctx.undefined;
      const deferred = registerDeferred(ctx.newPromise());
      try {
        assertLive();
        if (counters.logs + 1 > L.maxLogs) {
          throw fail("limit_exceeded", `log call limit of ${L.maxLogs} reached`, { limit: L.maxLogs });
        }
        const message = readGuestString(messageHandle, "log message");
        const messageBytes = byteLength(message);
        if (messageBytes > L.maxLogMessageBytes) {
          throw fail("limit_exceeded", `log message is ${messageBytes} bytes; limit is ${L.maxLogMessageBytes}`, {
            bytes: messageBytes,
            limit: L.maxLogMessageBytes,
          });
        }
        if (counters.logBytes + messageBytes > L.maxLogBytes) {
          throw fail("limit_exceeded", `total log bytes exceed ${L.maxLogBytes}`, { limit: L.maxLogBytes });
        }
        counters.logs += 1;
        counters.logBytes += messageBytes;
        if (typeof onLog === "function") {
          const promise = enqueueMeta(() => onLog(message));
          promise.then(
            () => resolveDeferred(deferred),
            (error) => rejectDeferred(deferred, error),
          );
        } else {
          resolveDeferred(deferred);
        }
      } catch (error) {
        throwSync(deferred, error);
      }
      return deferred.handle;
    });
    ctx.setProp(ctx.global, "log", handle);
    handle.dispose();
  }

  function installCollection(name) {
    const handle = ctx.newFunction(name, (inputHandle, callbackHandle) => {
      if (limitReached()) return ctx.undefined;
      const deferred = registerDeferred(ctx.newPromise());
      let callback = null;
      try {
        assertLive();
        if (counters.helpers + 1 > L.maxHelperCalls) {
          throw fail("limit_exceeded", `${name} call limit of ${L.maxHelperCalls} reached`, {
            limit: L.maxHelperCalls,
          });
        }
        counters.helpers += 1;
        if (callbackHandle === undefined || ctx.typeof(callbackHandle) !== "function") {
          throw fail("invalid_argument", `${name} requires a callback function`, {});
        }
        assertGuestJson(inputHandle, `${name} input`);
        const input = assertJson(ctx.dump(inputHandle), L, `${name} input`);
        if (!Array.isArray(input)) {
          throw fail("invalid_argument", `${name} expects an array`, {});
        }
        if (input.length > L.maxHelperItems) {
          throw fail("limit_exceeded", `${name} received ${input.length} items; limit is ${L.maxHelperItems}`, {
            items: input.length,
            limit: L.maxHelperItems,
          });
        }
        callback = callbackHandle.dup();
        retained.add(callback);
        const items = input;
        const total = items.length;

        const runCollection = async () => {
          const results = new Array(total);
          let next = 0;
          const worker = async () => {
            for (;;) {
              const index = next;
              next += 1;
              if (index >= total) return;
              assertLive();
              let argument = null;
              let callResult;
              try {
                argument = jsonToGuest(ctx, items[index], L);
                callResult = runGuest(() => ctx.callFunction(callback, ctx.undefined, argument));
              } finally {
                safeDispose(argument);
              }
              if (state.cpuLimited) {
                callResult.dispose();
                throw cpuLimitError();
              }
              if (callResult.error) {
                const dumped = safeDump(ctx, callResult.error);
                callResult.dispose();
                throw guestRuntimeError(dumped, state, fatalHint);
              }
              const valueHandle = callResult.value.dup();
              callResult.dispose();
              results[index] = await settleGuestValue(valueHandle);
            }
          };
          const workerCount = Math.max(1, Math.min(L.maxConcurrency, total));
          await Promise.all(Array.from({ length: workerCount }, () => worker()));
          assertLive();
          const arrayHandle = jsonToGuest(ctx, results, L);
          resolveDeferred(deferred, arrayHandle);
          arrayHandle.dispose();
        };

        const task = runCollection()
          .catch((error) => {
            if (state.disposed) return;
            rejectDeferred(deferred, error);
          })
          .finally(() => {
            retained.delete(callback);
            safeDispose(callback);
          });
        helperTasks.add(task);
        task.then(
          () => helperTasks.delete(task),
          () => helperTasks.delete(task),
        );
      } catch (error) {
        if (callback) {
          retained.delete(callback);
          safeDispose(callback);
        }
        throwSync(deferred, error);
      }
      return deferred.handle;
    });
    ctx.setProp(ctx.global, name, handle);
    handle.dispose();
  }

  function installParallel() {
    const handle = ctx.newFunction("parallel", (tasksHandle) => {
      if (limitReached()) return ctx.undefined;
      const deferred = registerDeferred(ctx.newPromise());
      const callbacks = [];
      try {
        assertLive();
        if (counters.helpers + 1 > L.maxHelperCalls) {
          throw fail("limit_exceeded", `parallel call limit of ${L.maxHelperCalls} reached`, {
            limit: L.maxHelperCalls,
          });
        }
        counters.helpers += 1;
        if (ctx.typeof(tasksHandle) !== "object") {
          throw fail("invalid_argument", "parallel expects an array of task functions", {});
        }
        const length = ctx.getLength(tasksHandle);
        if (typeof length !== "number") {
          throw fail("invalid_argument", "parallel expects an array of task functions", {});
        }
        if (length > L.maxHelperItems) {
          throw fail("limit_exceeded", `parallel received ${length} tasks; limit is ${L.maxHelperItems}`, {
            items: length,
            limit: L.maxHelperItems,
          });
        }
        for (let index = 0; index < length; index++) {
          const functionHandle = ctx.getProp(tasksHandle, index);
          try {
            if (ctx.typeof(functionHandle) !== "function") {
              throw fail("invalid_argument", `parallel task ${index} must be a function`, { index });
            }
            const arity = ctx.getProp(functionHandle, "length");
            try {
              if (ctx.typeof(arity) === "number" && ctx.getNumber(arity) > 0) {
                throw fail("invalid_argument", `parallel task ${index} must take no arguments`, { index });
              }
            } finally {
              safeDispose(arity);
            }
            const copy = functionHandle.dup();
            callbacks.push(copy);
            retained.add(copy);
          } finally {
            safeDispose(functionHandle);
          }
        }

        const tasks = callbacks;
        const total = tasks.length;
        const runParallel = async () => {
          const results = new Array(total);
          let next = 0;
          const worker = async () => {
            for (;;) {
              const index = next;
              next += 1;
              if (index >= total) return;
              assertLive();
              const callResult = runGuest(() => ctx.callFunction(tasks[index], ctx.undefined));
              if (state.cpuLimited) {
                callResult.dispose();
                throw cpuLimitError();
              }
              if (callResult.error) {
                const dumped = safeDump(ctx, callResult.error);
                callResult.dispose();
                throw guestRuntimeError(dumped, state, fatalHint);
              }
              const valueHandle = callResult.value.dup();
              callResult.dispose();
              results[index] = await settleGuestValue(valueHandle);
            }
          };
          const workerCount = Math.max(1, Math.min(L.maxConcurrency, total));
          await Promise.all(Array.from({ length: workerCount }, () => worker()));
          assertLive();
          const arrayHandle = jsonToGuest(ctx, results, L);
          resolveDeferred(deferred, arrayHandle);
          arrayHandle.dispose();
        };

        const task = runParallel()
          .catch((error) => {
            if (state.disposed) return;
            rejectDeferred(deferred, error);
          })
          .finally(() => {
            for (const item of tasks) {
              retained.delete(item);
              safeDispose(item);
            }
          });
        helperTasks.add(task);
        task.then(
          () => helperTasks.delete(task),
          () => helperTasks.delete(task),
        );
      } catch (error) {
        for (const item of callbacks) {
          retained.delete(item);
          safeDispose(item);
        }
        throwSync(deferred, error);
      }
      return deferred.handle;
    });
    ctx.setProp(ctx.global, "parallel", handle);
    handle.dispose();
  }

  function installArgs() {
    const argsHandle = argsJson === null ? ctx.null : jsonToGuest(ctx, argsJson, L);
    try {
      ctx.defineProp(ctx.global, "args", {
        value: argsHandle,
        writable: false,
        enumerable: true,
        configurable: false,
      });
    } finally {
      safeDispose(argsHandle);
    }
  }

  async function teardown() {
    state.disposed = true;
    notifyProgress();
    if (signal && abortListener) {
      try {
        signal.removeEventListener("abort", abortListener);
      } catch {
        /* ignore */
      }
    }
    try {
      rt.removeInterruptHandler();
    } catch {
      /* ignore */
    }
    if (helperTasks.size > 0) {
      try {
        await Promise.race([
          Promise.allSettled([...helperTasks]),
          new Promise((resolve) => setTimeout(resolve, 2000)),
        ]);
      } catch {
        /* helpers are already unwinding */
      }
    }
    ctxAlive = false;
    for (const deferred of deferreds) safeDispose(deferred);
    deferreds.clear();
    for (const handle of retained) safeDispose(handle);
    retained.clear();
    try {
      ctx.dispose();
    } catch {
      /* ignore */
    }
    try {
      rt.dispose();
    } catch {
      /* ignore */
    }
  }

  try {
    if (signal) {
      if (signal.aborted) abortListener();
      else signal.addEventListener("abort", abortListener, { once: true });
    }
    // Fail before any guest bytecode or WASM work when already cancelled.
    assertLive();

    rt.setInterruptHandler(() => {
      if (state.disposed || state.aborted) return true;
      if (Date.now() > state.deadline) {
        state.timedOut = true;
        return true;
      }
      if (state.cpuSliceStartedAt > 0 && Date.now() - state.cpuSliceStartedAt > L.maxCpuSliceMs) {
        state.cpuLimited = { sliceMs: L.maxCpuSliceMs, at: Date.now() };
        return true;
      }
      return false;
    });

    installAgent();
    installPhase();
    installLog();
    installCollection("pipeline");
    installParallel();
    installArgs();
    installJsonValidator();

    const program = buildProgram(body);
    const evalResult = runGuest(() => ctx.evalCode(program, "workflow.js", { type: "global" }));
    if (state.cpuLimited) {
      evalResult.dispose();
      throw cpuLimitError();
    }
    if (evalResult.error) {
      const dumped = safeDump(ctx, evalResult.error);
      evalResult.dispose();
      throw guestRuntimeError(dumped, state, fatalHint);
    }
    const promiseHandle = evalResult.value.dup();
    evalResult.dispose();

    const result = await settleGuestValue(promiseHandle);
    topLevelSettled = true;
    const pendingAtReturn = pendingAgents.size;
    await drainUnawaited();
    if (unawaitedErrors.length > 0) {
      const first = unawaitedErrors[0];
      throw fail(
        "unawaited_agent_failed",
        `workflow returned while ${pendingAtReturn} unawaited agent call(s) were running and at least one failed: ${first?.message ?? first}`,
        { count: unawaitedErrors.length },
      );
    }
    return result;
  } finally {
    await teardown();
  }
}
