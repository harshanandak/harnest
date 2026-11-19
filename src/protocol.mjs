import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { normalizeExecutionControls } from "./execution-controls.mjs";

export const PROTOCOL_VERSION = "1.0";
export const TARGETS = new Set(["opencode", "pi", "cursor", "claude", "codex", "gemini", "amp", "acp"]);
export const SESSION_TARGETS = new Set(["claude", "codex", "cursor"]);
export const ROUTE_FIELDS = Object.freeze(["provider", "model", "agent", "variant", "thinking", "harnessVersion", "serverUrl", "serviceTier", "profile", "options"]);
export const ACP_ROUTE_FIELDS = Object.freeze(["agent", "model", "variant", "options"]);
export const CODEX_SERVICE_TIERS = Object.freeze(["default", "fast", "priority", "flex"]);
export const CODEX_PROFILE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
export const MAX_ROUTE_OPTIONS = 16;
export const MAX_ROUTE_OPTION_ID = 128;
export const MAX_ROUTE_OPTION_VALUE = 256;
export const RESERVED_ROUTE_OPTION_IDS = Object.freeze(["__proto__", "prototype", "constructor"]);
export const HARNESS_VERSIONS = Object.freeze(["v1", "v2"]);
export const POLICY_FIELDS = Object.freeze(["write", "readOnly", "allowWrites", "tools", "maxCostUsd"]);
function invalid(message) {
  return Object.assign(new TypeError(message), { details: { kind: "validation" } });
}

export const TERMINAL_STATES = new Set(["completed", "failed", "cancelled", "partial"]);
// Fail-fast input caps: oversized payloads would otherwise blow the Windows
// ~32k argv limit (prompt travels as one argv element) or bloat job files.
export const MAX_TASK_BYTES = 100_000;
export const MAX_CONTEXT_BYTES = 400_000;
export const MAX_MESSAGE_BYTES = 50_000;
export const MAX_TIMEOUT_MS = 86_400_000;

function byteLength(value) {
  try {
    return Buffer.byteLength(typeof value === "string" ? value : stableJson(value), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function stableJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function digestContext(context) {
  return createHash("sha256").update(stableJson(context ?? null)).digest("hex");
}

function strictObject(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(`${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw invalid(`${label}.${key} is unsupported; expected one of ${allowed.join(", ")}`);
  }
  return value;
}

export function normalizeRoute(route, label = "route") {
  strictObject(route, ROUTE_FIELDS, label);
  for (const key of ["provider", "model", "agent", "variant", "serverUrl", "serviceTier", "profile"]) {
    if (route[key] !== undefined && (typeof route[key] !== "string" || route[key].trim().length === 0)) {
      throw invalid(`${label}.${key} must be a non-empty string`);
    }
  }
  if (route.thinking !== undefined && (typeof route.thinking !== "boolean" && (typeof route.thinking !== "string" || route.thinking.trim().length === 0))) {
    throw invalid(`${label}.thinking must be a non-empty string or boolean`);
  }
  if (route.harnessVersion !== undefined && !HARNESS_VERSIONS.includes(route.harnessVersion)) {
    throw invalid(`${label}.harnessVersion must be v1 or v2`);
  }
  if (route.options === undefined) return route;
  const options = route.options;
  if (!options || typeof options !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) {
    throw invalid(`${label}.options must be an object`);
  }
  const entries = Object.entries(options);
  if (entries.length > MAX_ROUTE_OPTIONS) throw invalid(`${label}.options allows at most ${MAX_ROUTE_OPTIONS} entries`);
  for (const [id, value] of entries) {
    if (!id.trim() || id.length > MAX_ROUTE_OPTION_ID || RESERVED_ROUTE_OPTION_IDS.includes(id)) {
      throw invalid(`${label}.options contains an invalid option ID`);
    }
    if (typeof value !== "boolean" && (typeof value !== "string" || value.length > MAX_ROUTE_OPTION_VALUE)) {
      throw invalid(`${label}.options values must be booleans or strings of at most ${MAX_ROUTE_OPTION_VALUE} characters`);
    }
  }
  return { ...route, options: Object.fromEntries(entries) };
}

export function routeControlError(target, route = {}, transport) {
  if (route.profile !== undefined) {
    if (target !== "codex" || transport === "session") return "route.profile requires Codex one-shot execution";
    if (typeof route.profile !== "string" || !CODEX_PROFILE_PATTERN.test(route.profile)) {
      return "route.profile must be a Codex config profile name of up to 128 characters";
    }
  }
  if (route.serviceTier !== undefined) {
    if (!["codex", "claude"].includes(target) || transport === "session") {
      return "route.serviceTier requires Codex or Claude one-shot execution";
    }
    const tiers = target === "codex" ? CODEX_SERVICE_TIERS : ["fast"];
    if (!tiers.includes(route.serviceTier)) return `route.serviceTier for ${target} must be ${tiers.join(", ")}`;
  }
  if (route.options !== undefined && target !== "acp") return "route.options requires a registered ACP agent";
  if (route.agent !== undefined && !["opencode", "claude", "acp"].includes(target)) {
    return "route.agent requires OpenCode, Claude one-shot execution, or a registered ACP agent";
  }
  if (route.agent !== undefined && target === "claude" && transport === "session") {
    return "route.agent requires Claude one-shot execution";
  }
  return null;
}

export function hasNativeRouteControls(target, route) {
  return route?.profile !== undefined || route?.serviceTier !== undefined
    || route?.options !== undefined || (["claude", "acp"].includes(target) && route?.agent !== undefined);
}

function normalizePolicy(inputPolicy) {
  const policy = strictObject(inputPolicy ?? {}, POLICY_FIELDS, "policy");
  if (policy.tools !== undefined && policy.tools !== null && (!Array.isArray(policy.tools) || policy.tools.some((tool) => typeof tool !== "string" || tool.trim().length === 0))) {
    throw invalid("policy.tools must be an array of non-empty strings");
  }
  if (policy.maxCostUsd !== undefined && policy.maxCostUsd !== null && (typeof policy.maxCostUsd !== "number" || !Number.isFinite(policy.maxCostUsd) || policy.maxCostUsd < 0)) {
    throw invalid("policy.maxCostUsd must be a non-negative number");
  }
  const hasWrite = Object.prototype.hasOwnProperty.call(policy, "write");
  const hasReadOnly = Object.prototype.hasOwnProperty.call(policy, "readOnly");
  const hasAllowWrites = Object.prototype.hasOwnProperty.call(policy, "allowWrites");
  const rawWrite = policy.write;
  const rawReadOnly = policy.readOnly;
  const rawAllowWrites = policy.allowWrites;
  if (hasWrite && typeof rawWrite !== "boolean") throw invalid("policy.write must be a boolean");
  if (hasReadOnly && typeof rawReadOnly !== "boolean") throw invalid("policy.readOnly must be a boolean");
  if (hasAllowWrites && typeof rawAllowWrites !== "boolean") throw invalid("policy.allowWrites must be a boolean");

  let derived = null;
  let hasDerived = false;
  if (hasReadOnly || hasAllowWrites) {
    const fromReadOnly = hasReadOnly ? !rawReadOnly : null;
    const fromAllowWrites = hasAllowWrites ? rawAllowWrites : null;
    if (fromReadOnly !== null && fromAllowWrites !== null && fromReadOnly !== fromAllowWrites) {
      throw invalid("contradictory policy aliases: readOnly and allowWrites disagree");
    }
    if (fromReadOnly !== null) {
      derived = fromReadOnly;
      hasDerived = true;
    } else if (fromAllowWrites !== null) {
      derived = fromAllowWrites;
      hasDerived = true;
    }
  }
  if (hasWrite && hasDerived && Boolean(rawWrite) !== derived) {
    throw invalid("contradictory policy: policy.write conflicts with readOnly/allowWrites alias");
  }
  if (hasDerived && !hasWrite) {
    return {
      write: derived,
      tools: policy.tools ?? [],
      maxCostUsd: policy.maxCostUsd ?? null,
    };
  }
  return {
    write: Boolean(rawWrite),
    tools: policy.tools ?? [],
    maxCostUsd: policy.maxCostUsd ?? null,
  };
}

export function normalizeRequest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw invalid("request must be an object");
  }
  if (!TARGETS.has(input.target)) {
    if (input.target === "dsh") {
      throw invalid("dsh is not a downstream target: run DeepSeek models via pi or opencode instead (a DSH lead plugin is only possible once headless gains an MCP surface)");
    }
    throw invalid("target must be opencode, pi, cursor, claude, codex, gemini, amp, or acp");
  }
  if (typeof input.requestId !== "string" || !input.requestId.trim()) throw invalid("requestId is required");
  if (typeof input.task !== "string" || !input.task.trim()) throw invalid("task is required");
  if (byteLength(input.task) > MAX_TASK_BYTES) {
    throw Object.assign(new TypeError(`task exceeds ${MAX_TASK_BYTES} bytes`), { details: { kind: "validation" } });
  }
  if (byteLength(input.context ?? null) > MAX_CONTEXT_BYTES) {
    throw Object.assign(new TypeError(`context exceeds ${MAX_CONTEXT_BYTES} bytes`), { details: { kind: "validation" } });
  }
  if (typeof input.cwd !== "string" || !input.cwd.trim()) throw invalid("cwd is required");

  const cwd = isAbsolute(input.cwd) ? resolve(input.cwd) : resolve(process.cwd(), input.cwd);
  const computedDigest = digestContext(input.context);
  if (input.contextDigest && input.contextDigest !== computedDigest) {
    throw invalid("contextDigest does not match context");
  }

  const timeoutMs = input.execution?.timeoutMs ?? 3_600_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw Object.assign(new TypeError(`execution.timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}`), { details: { kind: "validation" } });
  }
  const transport = input.execution?.transport;
  if (transport !== undefined && !["oneshot", "session"].includes(transport)) {
    throw invalid("execution.transport must be oneshot or session");
  }
  if (transport === "session" && !SESSION_TARGETS.has(input.target)) {
    throw invalid("session transport is supported only for claude, codex, or cursor");
  }

  const route = normalizeRoute(input.route ?? {});
  const controlError = routeControlError(input.target, route, transport);
  if (controlError) throw invalid(controlError);
  const policy = normalizePolicy(input.policy);
  const executionControls = normalizeExecutionControls({ ...input, cwd, policy });
  if (input.target === "acp") {
    if (!route.agent) throw invalid("ACP requires route.agent naming a trusted local registration");
    const unsupportedRoute = ROUTE_FIELDS.filter((field) => !ACP_ROUTE_FIELDS.includes(field) && route[field] !== undefined);
    if (unsupportedRoute.length) throw invalid(`ACP route does not support: ${unsupportedRoute.join(", ")}`);
    if (input.workflow != null) throw invalid("ACP does not support structured workflows");
    if (policy.write !== true) throw invalid("ACP is write-only; policy.write must be true");
    if (policy.tools.length) throw invalid("ACP does not support granular policy.tools");
    if (policy.maxCostUsd != null) throw invalid("ACP does not enforce policy.maxCostUsd");
  }

  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId: input.requestId.trim(),
    target: input.target,
    task: input.task.trim(),
    cwd,
    context: input.context ?? null,
    contextDigest: computedDigest,
    workflow: input.workflow ?? null,
    route,
    execution: {
      background: Boolean(input.execution?.background),
      timeoutMs,
      sessionId: input.execution?.sessionId ?? null,
      ...(transport === undefined ? {} : { transport }),
      ...executionControls,
    },
    policy,
    metadata: input.metadata ?? {},
  };
}

export function createReceipt(request, overrides = {}) {
  const jobId = overrides.jobId || randomUUID();
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId: request.requestId,
    jobId,
    target: request.target,
    contextDigest: request.contextDigest,
    state: overrides.state || "queued",
    createdAt: overrides.createdAt || new Date().toISOString(),
    startedAt: overrides.startedAt ?? null,
    completedAt: overrides.completedAt ?? null,
    sessionId: overrides.sessionId ?? null,
    workflowRunId: overrides.workflowRunId ?? null,
    route: overrides.route ?? request.route,
    routingDecision: overrides.routingDecision ?? request.metadata?.harnest?.routingDecision ?? null,
    ...(request.execution?.transport ? { execution: { transport: request.execution.transport } } : {}),
    result: overrides.result ?? null,
    usage: overrides.usage ?? null,
    error: overrides.error ?? null,
    controls: overrides.controls ?? [],
    trace: overrides.trace ?? {
      ref: `job:${jobId}:events`,
      eventCount: 0,
      lastEventAt: null,
      lastActivity: null,
      progress: null,
    },
    recovery: overrides.recovery ?? {
      lookupKey: request.requestId,
      canResume: false,
      heartbeatAt: null,
    },
  };
}

export function assertReceipt(receipt) {
  if (!receipt || typeof receipt !== "object") throw invalid("receipt must be an object");
  if (!TARGETS.has(receipt.target)) throw invalid("receipt target is invalid");
  if (!receipt.requestId || !receipt.jobId) throw invalid("receipt identifiers are required");
  if (!/^[a-f0-9]{64}$/.test(receipt.contextDigest || "")) {
    throw invalid("receipt contextDigest is invalid");
  }
  if (receipt.state === "completed" && !receipt.result) {
    throw invalid("completed receipt requires result");
  }
  if (["failed", "partial"].includes(receipt.state) && !receipt.error) {
    throw invalid(`${receipt.state} receipt requires error`);
  }
  return receipt;
}

export function terminalReceipt(receipt, state, fields = {}) {
  if (!TERMINAL_STATES.has(state)) throw invalid(`invalid terminal state: ${state}`);
  return assertReceipt({
    ...receipt,
    ...fields,
    state,
    completedAt: fields.completedAt || new Date().toISOString(),
    recovery: {
      ...(receipt.recovery || {}),
      ...(fields.recovery || {}),
      canResume: state !== "completed",
      heartbeatAt: null,
    },
  });
}
