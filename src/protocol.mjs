import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

export const PROTOCOL_VERSION = "1.0";
export const TARGETS = new Set(["opencode", "pi", "cursor", "claude", "codex", "gemini", "amp", "acp"]);
export const SESSION_TARGETS = new Set(["claude", "codex", "cursor"]);
export const ROUTE_FIELDS = Object.freeze(["provider", "model", "agent", "variant", "thinking", "harnessVersion", "serverUrl"]);
export const HARNESS_VERSIONS = Object.freeze(["v1", "v2"]);
export const POLICY_FIELDS = Object.freeze(["write", "readOnly", "allowWrites", "tools", "maxCostUsd", "mode", "sandbox"]);
export const EXACT_TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
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

function normalizeRoute(inputRoute) {
  const route = strictObject(inputRoute ?? {}, ROUTE_FIELDS, "route");
  for (const key of ["provider", "model", "agent", "variant", "serverUrl"]) {
    if (route[key] !== undefined && (typeof route[key] !== "string" || route[key].trim().length === 0)) {
      throw invalid(`route.${key} must be a non-empty string`);
    }
  }
  if (route.thinking !== undefined && (typeof route.thinking !== "boolean" && (typeof route.thinking !== "string" || route.thinking.trim().length === 0))) {
    throw invalid("route.thinking must be a non-empty string or boolean");
  }
  if (route.harnessVersion !== undefined && !HARNESS_VERSIONS.includes(route.harnessVersion)) {
    throw invalid("route.harnessVersion must be v1 or v2");
  }
  return route;
}

export function normalizePolicyControls(policy) {
  const tools = policy.tools ?? [];
  if (Array.isArray(tools)) {
    if (tools.some((tool) => typeof tool !== "string" || !tool.trim())) {
      throw invalid("policy.tools must be an array of non-empty strings");
    }
  } else {
    if (typeof tools !== "object") throw invalid("policy.tools must be an array of non-empty strings or an allow/deny object");
    strictObject(tools, ["allow", "deny"], "policy.tools");
    if (!Object.keys(tools).length) throw invalid("policy.tools must specify allow or deny");
    for (const [key, names] of Object.entries(tools)) {
      if (!Array.isArray(names) || names.some((name) => typeof name !== "string" || !EXACT_TOOL_NAME.test(name))) {
        throw invalid(`policy.tools.${key} must be an array of exact native tool names`);
      }
    }
  }
  const { mode, sandbox } = policy;
  if (mode !== undefined && mode !== "plan") throw invalid("policy.mode must be plan");
  if (sandbox !== undefined && typeof sandbox !== "boolean") throw invalid("policy.sandbox must be a boolean");
  return { tools, ...(mode === undefined ? {} : { mode }), ...(sandbox === undefined ? {} : { sandbox }) };
}

export function hasToolPolicy(tools) {
  return Array.isArray(tools) ? tools.length > 0 : tools != null;
}

export function inheritPolicyControls(input, parent, policyError) {
  const controls = normalizePolicyControls({
    tools: input.tools ?? parent?.tools,
    mode: input.mode === undefined ? parent?.mode : input.mode,
    sandbox: input.sandbox === undefined ? parent?.sandbox : input.sandbox,
  });
  const inherited = parent?.tools;
  const tools = controls.tools;
  if (hasToolPolicy(inherited)) {
    if (Array.isArray(inherited) !== Array.isArray(tools)) {
      throw policyError("child cannot change inherited tool policy format");
    }
    if (Array.isArray(inherited)) {
      if (!tools.length || tools.some((tool) => !inherited.includes(tool))) {
        throw policyError("child cannot widen allowed tools");
      }
    } else {
      const allow = tools.allow ?? inherited.allow;
      if (inherited.allow && allow.some((tool) => !inherited.allow.includes(tool))) {
        throw policyError("child cannot widen allowed tools");
      }
      controls.tools = {
        ...(allow === undefined ? {} : { allow }),
        deny: [...new Set([...(inherited.deny ?? []), ...(tools.deny ?? [])])],
      };
    }
  }
  if (parent?.sandbox === true && controls.sandbox !== true) throw policyError("child cannot disable inherited sandbox");
  return controls;
}

function normalizePolicy(inputPolicy) {
  const policy = strictObject(inputPolicy ?? {}, POLICY_FIELDS, "policy");
  const controls = normalizePolicyControls(policy);
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
  return {
    write: hasDerived && !hasWrite ? derived : Boolean(rawWrite),
    ...controls,
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

  const route = normalizeRoute(input.route);
  const policy = normalizePolicy(input.policy);
  if (policy.mode !== undefined || policy.sandbox !== undefined) {
    const field = policy.mode !== undefined ? "mode" : "sandbox";
    if (input.target !== "cursor" || transport === "session") {
      throw invalid(`policy.${field} is supported only by Cursor print mode`);
    }
  }
  if (input.target === "acp") {
    if (!route.agent) throw invalid("ACP requires route.agent naming a trusted local registration");
    const unsupportedRoute = ROUTE_FIELDS.filter((field) => field !== "agent" && route[field] !== undefined);
    if (unsupportedRoute.length) throw invalid(`ACP route supports only route.agent; unsupported: ${unsupportedRoute.join(", ")}`);
    if (input.workflow != null) throw invalid("ACP does not support structured workflows");
    if (policy.write !== true) throw invalid("ACP is write-only; policy.write must be true");
    if (hasToolPolicy(policy.tools)) throw invalid("ACP does not support granular policy.tools");
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
