// Dynamic workflow protocol: validation, normalization, stable identifiers and
// the exact status/history projections fixed by docs/dynamic-workflows-contract.md.
//
// This module is pure (no IO beyond an existence check for cwd). The runner
// owns persistence and dispatch; the engine owns guest execution. Nothing here
// forwards host objects, credentials or module paths into a script.
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { digestContext, inheritPolicyControls, MAX_CONTEXT_BYTES, MAX_TIMEOUT_MS, POLICY_FIELDS, SESSION_TARGETS, stableJson, TARGETS } from "./protocol.mjs";
import { assertGraphLeaf, bytes, compactError, cwdOverlaps, mergeData } from "./graph-protocol.mjs";
import { addUsageToTotals, emptyUsageTotals } from "./usage.mjs";

export { bytes, compactError, cwdOverlaps, mergeData };

export const RUN_ACTIVE = new Set(["queued", "running", "pausing", "paused", "waiting", "stopping"]);
export const RUN_TERMINAL = new Set(["completed", "failed", "cancelled", "partial"]);
export const INVOCATION_TERMINAL = new Set(["completed", "failed", "cancelled", "partial"]);
export const CONTROL_ACTIONS = new Set(["pause", "continue", "stop", "stop-agent", "restart-agent", "steer", "reroute"]);
export const CONTROL_TERMINAL = new Set(["applied", "rejected", "uncertain"]);

// Contract ceilings for scale, cache and usage.
export const MAX_AGENT_CALLS = 1000;
export const MAX_COLLECTION_ITEMS = 4096;
export const DEFAULT_CONCURRENCY = 4;
export const MAX_CONCURRENCY = 6;
export const DEFAULT_TIMEOUT_MS = 3_600_000;
export const DEFAULT_PREFIX_STAGGER_MS = 5_000;
export const MAX_SOURCE_BYTES = 400_000;
export const MAX_SPEC_BYTES = 2_000_000;
export const MAX_REQUEST_ID_LENGTH = 200;
export const MAX_LABEL_LENGTH = 120;
export const MAX_PHASE_LENGTH = 120;
export const DEFAULT_PHASE_LIMIT = 20;
export const MAX_PHASE_LIMIT = 100;
export const MAX_SCHEMA_BYTES = 100_000;

const ROUTE_FIELDS = new Set(["provider", "model", "agent", "variant", "thinking", "harnessVersion", "serverUrl"]);
const AGENT_TARGETS = new Set([...TARGETS, "auto"]);
const EXECUTION_KEYS = ["background", "timeoutMs", "maxConcurrency", "maxAgents", "prefixStaggerMs", "transport", "providerWait"];
const AGENT_OPTION_KEYS = ["label", "target", "route", "cwd", "context", "metadata", "schema", "execution", "policy"];
const AGENT_EXECUTION_KEYS = ["timeoutMs", "transport"];
// Targets whose interactive/session transport the core selects when a dynamic
// child does not pin one explicitly. One-shot remains available with an
// explicit execution.transport.
export { SESSION_TARGETS };
// Canonical core spelling is "oneshot"; "session" selects the pooled native
// session transport.
export const TRANSPORTS = new Set(["session", "oneshot"]);

export const dynamicError = (kind, message, details = {}) => Object.assign(new Error(message), { details: { kind, ...details } });
export const runIdFor = (requestId) => `dyn-${digestContext(requestId)}`;
export const childRequestIdFor = (runId, ordinal, attempt = 1) => `${runId}:${ordinal}:${attempt}`;
export const invocationIdFor = (ordinal) => `inv-${ordinal}`;

function only(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw dynamicError("validation", `${label} must be an object`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw dynamicError("validation", `${label}.${key} is unsupported`);
  return value;
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw dynamicError("validation", `${label} must be an object`);
  return value;
}

function text(value, label, max = null) {
  if (typeof value !== "string" || !value.trim()) throw dynamicError("validation", `${label} is required`);
  const trimmed = value.trim();
  if (max !== null && trimmed.length > max) throw dynamicError("validation", `${label} must be at most ${max} characters`);
  return trimmed;
}

export function normalizeRoute(input = {}, label = "route") {
  only(input, [...ROUTE_FIELDS], label);
  for (const [key, value] of Object.entries(input)) {
    if (key === "thinking") {
      if (typeof value === "boolean") continue;
      if (typeof value === "string" && value.trim()) continue;
      throw dynamicError("validation", `invalid ${label}.thinking`);
    }
    if (typeof value !== "string" || !value.trim()) throw dynamicError("validation", `invalid ${label}.${key}`);
  }
  return { ...input };
}

export function normalizePolicy(input = {}, parent) {
  const policy = input ?? {};
  only(policy, POLICY_FIELDS, "policy");
  for (const key of ["write", "readOnly", "allowWrites"]) {
    if (policy[key] !== undefined && typeof policy[key] !== "boolean") throw dynamicError("validation", `policy.${key} must be boolean`);
  }
  const aliases = [policy.write, policy.readOnly === undefined ? undefined : !policy.readOnly, policy.allowWrites].filter((value) => value !== undefined);
  if (aliases.some((value) => value !== aliases[0])) throw dynamicError("policy", "contradictory write policy aliases");
  const result = {
    write: aliases[0] ?? parent?.write ?? false,
    ...inheritPolicyControls(policy, parent, (message) => dynamicError("policy", message)),
    maxCostUsd: policy.maxCostUsd ?? parent?.maxCostUsd ?? null,
  };
  if (result.maxCostUsd !== null && (!Number.isFinite(result.maxCostUsd) || result.maxCostUsd <= 0)) {
    throw dynamicError("validation", "policy.maxCostUsd must be positive");
  }
  if (parent && result.write && !parent.write) throw dynamicError("policy", "agent call cannot escalate write policy");
  if (parent?.maxCostUsd != null && result.maxCostUsd > parent.maxCostUsd) throw dynamicError("policy", "agent call cannot increase cost ceiling");
  return result;
}

async function directory(cwd, label) {
  if (typeof cwd !== "string" || !isAbsolute(cwd) || !(await stat(cwd).catch(() => null))?.isDirectory()) {
    throw dynamicError("validation", `${label} must be an existing absolute directory`);
  }
  return realpath(cwd);
}

function target(value, label) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !AGENT_TARGETS.has(value)) {
    throw dynamicError("validation", `${label} must be opencode, pi, cursor, claude, codex, gemini, amp, acp, or auto`);
  }
  return value;
}

export function normalizeExecution(input = {}, label = "execution") {
  only(input, EXECUTION_KEYS, label);
  if (input.background !== undefined && typeof input.background !== "boolean") throw dynamicError("validation", `${label}.background must be boolean`);
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) throw dynamicError("validation", `${label}.timeoutMs is invalid`);
  const maxConcurrency = input.maxConcurrency ?? DEFAULT_CONCURRENCY;
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > MAX_CONCURRENCY) {
    throw dynamicError("validation", `${label}.maxConcurrency must be between 1 and ${MAX_CONCURRENCY}`);
  }
  const maxAgents = input.maxAgents ?? MAX_AGENT_CALLS;
  if (!Number.isInteger(maxAgents) || maxAgents < 1 || maxAgents > MAX_AGENT_CALLS) {
    throw dynamicError("validation", `${label}.maxAgents must be between 1 and ${MAX_AGENT_CALLS}`);
  }
  const prefixStaggerMs = input.prefixStaggerMs ?? DEFAULT_PREFIX_STAGGER_MS;
  if (!Number.isInteger(prefixStaggerMs) || prefixStaggerMs < 0 || prefixStaggerMs > DEFAULT_PREFIX_STAGGER_MS) {
    throw dynamicError("validation", `${label}.prefixStaggerMs must be between 0 and ${DEFAULT_PREFIX_STAGGER_MS}`);
  }
  if (input.transport !== undefined && !TRANSPORTS.has(input.transport)) {
    throw dynamicError("validation", `${label}.transport must be session or oneshot`);
  }
  if (input.providerWait !== undefined) {
    only(input.providerWait, ["maxRetries"], `${label}.providerWait`);
    if (!Number.isInteger(input.providerWait.maxRetries) || input.providerWait.maxRetries < 0 || input.providerWait.maxRetries > 10) throw dynamicError("validation", `${label}.providerWait.maxRetries must be between 0 and 10`);
  }
  return {
    background: input.background ?? true, timeoutMs, maxConcurrency, maxAgents, prefixStaggerMs,
    // Root transport is the default for every dynamic child; an agent option
    // may narrow/override it explicitly.
    transport: input.transport ?? null,
    ...(input.providerWait === undefined ? {} : { providerWait: { maxRetries: input.providerWait.maxRetries } }),
  };
}

export function normalizeSchema(schema, label = "schema") {
  if (schema === null || schema === undefined) return null;
  if (schema === true) return true;
  if (schema === false) throw dynamicError("validation", `${label} is a false schema and can never be satisfied`);
  if (typeof schema !== "object" || Array.isArray(schema)) throw dynamicError("validation", `${label} must be an object, boolean, or null`);
  if (bytes(schema) > MAX_SCHEMA_BYTES) throw dynamicError("validation", `${label} exceeds ${MAX_SCHEMA_BYTES} bytes`);
  // Provably contradictory shapes are rejected before any model launch. A key
  // required by a closed object is satisfiable when a patternProperties
  // pattern also accepts it, so patterns must be consulted before failing.
  if (schema.type === "object" && schema.additionalProperties === false && Array.isArray(schema.required) && schema.required.length) {
    const declared = new Set(Object.keys(schema.properties ?? {}));
    const patterns = Object.keys(schema.patternProperties ?? {});
    const allowedByPattern = (key) => patterns.some((pattern) => {
      try { return new RegExp(pattern).test(key); } catch { return false; }
    });
    if (schema.required.some((key) => !declared.has(key) && !allowedByPattern(key))) {
      throw dynamicError("validation", `${label} requires properties it also forbids (additionalProperties: false with no matching patternProperties)`);
    }
  }
  for (const [minimum, maximum] of [["minimum", "maximum"], ["minLength", "maxLength"], ["minItems", "maxItems"], ["minProperties", "maxProperties"]]) {
    const low = schema[minimum];
    const high = schema[maximum];
    if (typeof low === "number" && typeof high === "number" && low > high) {
      throw dynamicError("validation", `${label}.${minimum} (${low}) exceeds ${label}.${maximum} (${high})`);
    }
  }
  if (typeof schema.exclusiveMinimum === "number" && typeof schema.exclusiveMaximum === "number" && schema.exclusiveMinimum >= schema.exclusiveMaximum) {
    throw dynamicError("validation", `${label}.exclusiveMinimum must be less than exclusiveMaximum`);
  }
  if (Array.isArray(schema.enum) && schema.enum.length === 0) throw dynamicError("validation", `${label}.enum is empty and can never be satisfied`);
  if (schema.not && typeof schema.not === "object" && !Array.isArray(schema.not) && Object.keys(schema.not).length === 0) {
    throw dynamicError("validation", `${label}.not is an empty schema and can never be satisfied`);
  }
  return schema;
}

export async function normalizeDynamicSpec(input) {
  let size;
  try { size = bytes(input); } catch { throw dynamicError("validation", "spec must be JSON"); }
  if (size > MAX_SPEC_BYTES) throw dynamicError("validation", `spec must be at most ${MAX_SPEC_BYTES} bytes`);
  only(input, ["requestId", "name", "source", "args", "cwd", "target", "route", "policy", "context", "metadata", "execution"], "spec");
  const requestId = text(input.requestId, "requestId");
  if (requestId.length > MAX_REQUEST_ID_LENGTH) throw dynamicError("validation", `requestId must be at most ${MAX_REQUEST_ID_LENGTH} characters`);
  const name = input.name === undefined ? null : text(input.name, "name", MAX_LABEL_LENGTH);
  const source = text(input.source, "source");
  if (bytes(source) > MAX_SOURCE_BYTES) throw dynamicError("validation", `source must be at most ${MAX_SOURCE_BYTES} bytes`);
  const cwd = await directory(input.cwd, "cwd");
  const rootTarget = target(input.target, "target");
  const route = normalizeRoute(input.route ?? {});
  const policy = normalizePolicy(input.policy);
  const context = object(input.context ?? {}, "context");
  const metadata = object(input.metadata ?? {}, "metadata");
  if (bytes(context) > MAX_CONTEXT_BYTES) throw dynamicError("validation", "context exceeds context byte limit");
  if (bytes(metadata) > MAX_CONTEXT_BYTES) throw dynamicError("validation", "metadata exceeds context byte limit");
  const args = input.args ?? null;
  if (bytes(args) > MAX_CONTEXT_BYTES) throw dynamicError("validation", "args exceeds context byte limit");
  const execution = normalizeExecution(input.execution);
  return {
    requestId, name, source, args, cwd, target: rootTarget, route, policy, context, metadata, execution,
    scriptDigest: digestContext(source), argsDigest: digestContext(args),
  };
}

// Identity used to reattach to an existing run. execution.background is
// normalized away so the same logical request cannot fork on background mode.
export function specIdentity(spec) {
  return digestContext({
    requestId: spec.requestId, source: spec.source, args: spec.args, cwd: spec.cwd,
    target: spec.target, route: spec.route, policy: spec.policy, context: spec.context,
    metadata: spec.metadata, execution: { ...spec.execution, background: true },
  });
}

// Reject anything a caller could use to smuggle executable modules, a
// workflow, or widened permissions into a dynamically created child.
export function assertDynamicLeaf(request) {
  assertGraphLeaf(request);
  if (request.workflow != null) throw dynamicError("policy", "dynamic agent calls cannot set a workflow");
}

function narrowExecution(input, root, label) {
  only(input, AGENT_EXECUTION_KEYS, label);
  const execution = { ...root };
  if (input.timeoutMs !== undefined) {
    if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > MAX_TIMEOUT_MS) throw dynamicError("validation", `${label}.timeoutMs is invalid`);
    if (input.timeoutMs > (root.timeoutMs ?? DEFAULT_TIMEOUT_MS)) throw dynamicError("policy", `${label}.timeoutMs cannot exceed the root deadline`);
    execution.timeoutMs = input.timeoutMs;
  }
  if (input.transport !== undefined) {
    if (!TRANSPORTS.has(input.transport)) throw dynamicError("validation", `${label}.transport must be session or oneshot`);
    execution.transport = input.transport;
  }
  return execution;
}

export async function normalizeAgentOptions(prompt, options, { ordinal, root } = {}) {
  if (typeof prompt !== "string" || !prompt.trim()) throw dynamicError("validation", "agent prompt is required");
  if (bytes(prompt) > MAX_CONTEXT_BYTES) throw dynamicError("validation", "agent prompt exceeds the context byte limit");
  if (options !== undefined && options !== null && (typeof options !== "object" || Array.isArray(options))) {
    throw dynamicError("validation", "agent options must be an object");
  }
  const input = options ?? {};
  only(input, AGENT_OPTION_KEYS, "agent options");
  const label = input.label === undefined ? `call ${ordinal}` : text(input.label, "agent.label", MAX_LABEL_LENGTH);
  const callTarget = target(input.target, "agent.target");
  const route = { ...root.route, ...normalizeRoute(input.route ?? {}, "agent.route") };
  const cwd = input.cwd === undefined ? root.cwd : await directory(input.cwd, "agent.cwd");
  const policy = normalizePolicy(input.policy ?? {}, root.policy);
  const context = mergeData(root.context, object(input.context ?? {}, "agent.context"));
  const metadata = mergeData(root.metadata, object(input.metadata ?? {}, "agent.metadata"));
  const schema = normalizeSchema(input.schema);
  const execution = input.execution === undefined ? { ...root.execution } : narrowExecution(input.execution, root.execution, "agent.execution");
  return { prompt, label, target: callTarget, route, cwd, policy, context, metadata, schema, execution };
}

// Fingerprint fixed by the plan: effective prompt/context, requested and
// resolved route, effort, output schema and policy. Callers pass the resolved
// target/route so a routing decision change invalidates reuse.
export function invocationFingerprint(call) {
  return digestContext({
    prompt: call.prompt, label: call.label, phase: call.phase ?? null,
    target: call.target ?? null, route: call.route ?? {}, policy: call.policy,
    cwd: call.cwd, context: call.context, schema: call.schema ?? null,
    timeoutMs: call.execution?.timeoutMs ?? null,
  });
}

export function controlIdentity(command) {
  return digestContext({
    action: command.action,
    invocationId: command.invocationId ?? null,
    message: command.message ?? null,
    route: command.route ?? null,
    approveWrites: command.approveWrites ?? null,
  });
}

export function resumeIdentity({ source, approveWrites } = {}) {
  return digestContext({ source: source ?? null, sourceDigest: source == null ? null : digestContext(source), approveWrites: Boolean(approveWrites) });
}

// Trusted provider usage-limit evidence: the adapter must explicitly classify
// the failure and supply a reset time. Nothing else (auth failures, bare 429s,
// message text) is treated as waitable.
export function usageLimitResetAt(receipt) {
  const details = receipt?.error?.details;
  if (!details || (details.kind !== "usage-limit" && !(details.kind === "provider-limit" && details.usageLimit === true))) return null;
  const raw = details.resetAt;
  if (raw === null || raw === undefined) return null;
  let at = typeof raw === "number" ? raw : Date.parse(String(raw));
  if (!Number.isFinite(at)) return null;
  // Epoch seconds are accepted when they are clearly not milliseconds.
  if (typeof raw === "number" && at < 10_000_000_000) at *= 1000;
  return at;
}

export function controlSummary(command) {
  return {
    commandId: command.commandId,
    action: command.action,
    state: command.state,
    invocationId: command.invocationId ?? null,
    requestedAt: command.requestedAt,
    updatedAt: command.updatedAt,
    appliedAt: command.appliedAt ?? null,
    effect: command.effect ?? null,
    acknowledgement: command.acknowledgement ?? null,
    error: command.error ?? null,
  };
}

function invocationView(call) {
  return {
    id: call.id,
    ordinal: call.ordinal,
    label: call.label,
    phase: call.phase ?? null,
    state: call.state,
    target: call.target ?? null,
    route: call.route ?? {},
    jobId: call.jobId ?? null,
    sessionId: call.sessionId ?? null,
    attempts: Array.isArray(call.attempts) ? call.attempts.length : 0,
    usageSummary: call.usageSummary ?? null,
    progress: call.progress ?? null,
    error: call.error ?? null,
    startedAt: call.startedAt ?? null,
    completedAt: call.completedAt ?? null,
  };
}

function emptyInvocationCounts() {
  return { total: 0, pending: 0, prepared: 0, running: 0, completed: 0, failed: 0, cancelled: 0, partial: 0, invalidated: 0 };
}

export function invocationCounts(record) {
  const counts = emptyInvocationCounts();
  counts.total = record.calls.length;
  for (const call of record.calls) counts[call.state] = (counts[call.state] ?? 0) + 1;
  return counts;
}

export function projectPhases(record, entries) {
  const phases = new Map();
  for (const phase of entries) {
    const title = phase.title ?? phase;
    phases.set(title, {
      title, ordinal: phase.ordinal ?? null, firstAt: phase.firstAt ?? null,
      counts: emptyInvocationCounts(), usageTotals: emptyUsageTotals({ unknownAsNull: true }),
      firstStart: Infinity, lastSettle: -Infinity, missingTime: false, uncertain: false,
    });
  }
  if (!phases.size) return [];

  // Fold the existing attempt history before invocation pagination. A replay
  // may move the current agent to another phase while earlier usage stays put.
  for (const call of record.calls ?? []) {
    const current = phases.get(call.phase);
    if (current) {
      current.counts.total += 1;
      current.counts[call.state] = (current.counts[call.state] ?? 0) + 1;
    }
    const attempts = call.attempts?.length ? call.attempts : [{}];
    const latestAttempt = attempts.at(-1);
    for (const attempt of attempts) {
      const phase = phases.get(attempt.phase === undefined ? call.phase : attempt.phase);
      if (!phase) continue;
      const latest = attempt === latestAttempt;
      if (attempt.uncertain || (latest && call.uncertain)) phase.uncertain = true;
      const started = Date.parse(attempt.startedAt ?? (latest ? call.startedAt : null));
      const settled = Date.parse(attempt.completedAt ?? (latest ? call.completedAt : null));
      const jobId = attempt.jobId === undefined && latest ? call.jobId : attempt.jobId;
      if (!Number.isFinite(started) && !jobId && !attempt.dispatchReserved) continue;
      if (Number.isFinite(started)) phase.firstStart = Math.min(phase.firstStart, started);
      if (Number.isFinite(settled)) phase.lastSettle = Math.max(phase.lastSettle, settled);
      if (!Number.isFinite(started) || !Number.isFinite(settled)) phase.missingTime = true;
      if (!latest || Number.isFinite(settled) || INVOCATION_TERMINAL.has(call.state) || call.state === "invalidated") {
        const summary = attempt.usageSummary === undefined && latest && call.target !== "opencode" ? call.usageSummary : attempt.usageSummary;
        addUsageToTotals(phase.usageTotals, summary);
      }
    }
  }

  return Array.from(phases.values(), ({ firstStart, lastSettle, missingTime, uncertain, ...phase }) => {
    const { counts } = phase;
    const running = RUN_ACTIVE.has(record.state) && (counts.running || (firstStart !== Infinity && (counts.prepared || counts.pending)));
    if (running) phase.usageTotals.partial = true;
    if (uncertain) return { ...phase, elapsed: { state: "unknown", ms: null } };
    if (running) return { ...phase, elapsed: { state: "running", ms: null } };
    if (missingTime || (firstStart !== Infinity && lastSettle < firstStart)) return { ...phase, elapsed: { state: "unknown", ms: null } };
    if (firstStart === Infinity) return { ...phase, elapsed: { state: "not-started", ms: null } };
    return { ...phase, elapsed: { state: "settled", ms: lastSettle - firstStart } };
  });
}

// Exact status contract. Never includes source, raw prompts, or child results.
// Invocations are ordinal-ordered and pageable so a 1000-call run stays compact.
export function projectStatus(record, {
  includeOutput = false, invocationLimit = null, invocationCursor = null,
  phaseLimit = DEFAULT_PHASE_LIMIT, phaseCursor = null,
} = {}) {
  const all = [...(record.calls ?? [])].sort((left, right) => left.ordinal - right.ordinal);
  let selected = all;
  let nextCursor = null;
  if (Number.isInteger(invocationLimit) && invocationLimit > 0) {
    const after = Number.isInteger(invocationCursor) ? invocationCursor : -1;
    const filtered = all.filter((call) => call.ordinal > after);
    selected = filtered.slice(0, invocationLimit);
    if (filtered.length > invocationLimit && selected.length) nextCursor = selected.at(-1).ordinal;
  }
  const phaseEntries = record.phases ?? [];
  const phaseStart = (phaseCursor ?? -1) + 1;
  const phaseEnd = Math.min(phaseStart + phaseLimit, phaseEntries.length);
  const phases = projectPhases(record, phaseEntries.slice(phaseStart, phaseEnd));
  const status = {
    runId: record.runId,
    requestId: record.requestId,
    name: record.name ?? null,
    state: record.state,
    revision: record.revision ?? 0,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    startedAt: record.startedAt ?? null,
    completedAt: record.completedAt ?? null,
    attempt: record.attempt ?? 1,
    scriptDigest: record.scriptDigest,
    argsDigest: record.argsDigest,
    phases,
    phasesTotal: phaseEntries.length,
    phasesOmitted: phaseEntries.length - phases.length,
    invocations: selected.map(invocationView),
    invocationsTotal: all.length,
    usageTotals: record.usageTotals ?? null,
    progress: record.progress ?? null,
    error: record.error ?? null,
    controls: (record.controls ?? []).map(controlSummary),
  };
  if (phaseEnd < phaseEntries.length) status.phasesNextCursor = phaseEnd - 1;
  if (nextCursor !== null) status.invocationsNextCursor = nextCursor;
  if (record.resumeOf) status.resumeOf = record.resumeOf;
  if (record.recoveryRequired) status.recoveryRequired = true;
  if (includeOutput) status.output = record.output ?? null;
  return status;
}

export function projectHistoryRun(record) {
  return {
    runId: record.runId,
    requestId: record.requestId,
    name: record.name ?? null,
    state: record.state,
    revision: record.revision ?? 0,
    attempt: record.attempt ?? 1,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    completedAt: record.completedAt ?? null,
    scriptDigest: record.scriptDigest,
    argsDigest: record.argsDigest,
    counts: invocationCounts(record),
    usageTotals: record.usageTotals ?? null,
    error: record.error ?? null,
    ...(record.resumeOf ? { resumeOf: record.resumeOf } : {}),
  };
}

export function stableSpec(spec) {
  return JSON.parse(stableJson(spec));
}
