// Durable dynamic workflow runner.
//
// The runner has two roles:
//   1. Control plane (any host process): validate/start/status/result/history/
//      control/resume. `start` persists the run and hands execution to a
//      detached worker; nothing here owns the run's lifetime.
//   2. Execution owner (one process, normally src/dynamic-worker.mjs): fenced
//      by a durable lease, owns the engine and child Companion handoffs,
//      heartbeats, observes controls and settles the run.
//
// Replay is ordered-prefix: a matching completed call is reused with its
// recorded delivery order; the first failed/changed call invalidates reuse of
// the suffix. Deterministic request IDs plus the JobStore request index
// deduplicate crash recovery, so a re-issued intent cannot launch twice.
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { Companion } from "./companion.mjs";
import { digestContext, normalizeRequest, MAX_MESSAGE_BYTES, stableJson } from "./protocol.mjs";
import { addUsageToTotals, emptyUsageTotals, summarizeUsage } from "./usage.mjs";
import { compactText } from "./result.mjs";
import { mergeProcessEnv } from "./process.mjs";
import { DynamicStore, wait } from "./dynamic-store.mjs";
import {
  assertDynamicLeaf, bytes, childRequestIdFor, compactError, controlIdentity, controlSummary, cwdOverlaps,
  DEFAULT_CONCURRENCY, DEFAULT_PHASE_LIMIT, dynamicError, invocationCounts, invocationFingerprint, invocationIdFor,
  MAX_AGENT_CALLS, MAX_PHASE_LIMIT, MAX_SOURCE_BYTES, normalizeAgentOptions, normalizeDynamicSpec,
  normalizeRoute, projectHistoryRun, projectStatus, runIdFor, SESSION_TARGETS, specIdentity, CONTROL_ACTIONS,
  usageLimitResetAt,
  RUN_ACTIVE, RUN_TERMINAL, INVOCATION_TERMINAL, resumeIdentity,
} from "./dynamic-protocol.mjs";

const now = () => new Date().toISOString();
const MAX_OUTPUT_BYTES = 200_000;
// Engine result cap is intentionally smaller than the runner's stored output
// cap: the engine rejects runaway finals explicitly, the runner bounds what it
// persists even for legitimate large values.
const MAX_ENGINE_RESULT_BYTES = 1_000_000;
const MAX_WARMING_KEYS = 256;
// States whose owner must hold a fenced lease. A queued run has no owner yet,
// so a missing lease is normal and must not be fenced.
const LEASE_STATES = new Set(["running", "pausing", "paused", "waiting", "stopping"]);

// A receipt is unsafe to treat as settled only when a stop was requested and
// never acknowledged, or the failure class leaves the child's true state
// unknown. Mirrors graph.mjs's `uncertain` rule for the shared receipts.
const uncertainReceipt = (receipt) => receipt?.state !== "completed" && (
  receipt?.cancellation?.state === "unacknowledged" || receipt?.cancellation?.state === "requested"
  || ["cancel-unacknowledged", "persistence"].includes(receipt?.error?.details?.kind) || receipt?.error?.details?.uncertain
  || receipt?.cleanupError || receipt?.error?.details?.unsafeResume || receipt?.error?.details?.cleanupError?.length
  || ((receipt?.state === "cancelled" || receipt?.error?.details?.aborted) && receipt?.cancellation?.state !== "acknowledged"));

function setCallUncertainty(call, uncertain) {
  call.uncertain = Boolean(uncertain);
  const attempt = call.attempts?.at(-1);
  if (attempt) attempt.uncertain = call.uncertain;
}

function finishControl(command, fields) {
  Object.assign(command, { error: null, ...fields });
  command.updatedAt = now();
  if (command.state === "applied") command.appliedAt = command.updatedAt;
  return {
    type: "control", at: command.updatedAt, commandId: command.commandId, action: command.action,
    state: command.state, effect: command.effect ?? null, invocationId: command.invocationId ?? null,
  };
}

function undeliveredControl() {
  return { state: "rejected", error: compactError(dynamicError("not-active", "run ended before the control was applied")) };
}

function boundOutput(value) {
  if (value === null || value === undefined) return null;
  let size;
  try { size = bytes(value); } catch { return { truncated: true, reason: "not-json", preview: compactText(String(value), 4_000) }; }
  if (size <= MAX_OUTPUT_BYTES) return value;
  return { truncated: true, bytes: size, limit: MAX_OUTPUT_BYTES, preview: compactText(JSON.stringify(value), 4_000) };
}

function normalizeEngine(module) {
  const engine = module?.default?.runScript ? module.default : module;
  if (typeof engine?.validateScript !== "function" || typeof engine?.runScript !== "function") {
    throw dynamicError("validation", "dynamic engine module must export validateScript and runScript");
  }
  return engine;
}

function findSpecRevision(specs, record) {
  const number = record.scriptRevision ?? (record.scriptDigest == null ? 1 : null);
  return specs?.revisions?.find((revision) => (number == null || revision.revision === number)
    && (record.scriptDigest == null || revision.scriptDigest === record.scriptDigest));
}

let outputSchemas;

function outputSchemaError(schema, result) {
  const invalidJson = () => dynamicError("output-schema", "agent finalText must be JSON when an output schema is supplied");
  if (typeof result?.finalText !== "string") return invalidJson();
  let value;
  try { value = JSON.parse(result.finalText); }
  catch { return invalidJson(); }
  if (schema === true) return null;
  outputSchemas ??= new Ajv2020({ addUsedSchema: false, strictTypes: false, validateFormats: false });
  try {
    const validate = outputSchemas.compile(schema);
    if (validate.$async) return dynamicError("output-schema", "agent output schemas must validate synchronously");
    return validate(value) ? null : dynamicError("output-schema", "agent finalText does not match its output schema");
  } catch {
    return dynamicError("output-schema", "agent output schema could not be applied");
  } finally {
    outputSchemas.removeSchema();
  }
}

function enforceOutputSchema(call, schema = call.schema) {
  if (call.state !== "completed" || schema == null) return false;
  const error = outputSchemaError(schema, call.value);
  if (!error) return false;
  call.state = "failed";
  call.error = compactError(error);
  call.value = null;
  call.deliverySeq = null;
  const attempt = call.attempts.at(-1);
  if (attempt) attempt.state = "failed";
  return true;
}

class Semaphore {
  constructor(limit) { this.limit = limit; this.free = limit; this.queue = []; }
  async acquire() {
    if (this.free > 0) { this.free -= 1; return; }
    await new Promise((resolve) => this.queue.push(resolve));
  }
  release() {
    const next = this.queue.shift();
    if (next) next();
    else this.free += 1;
  }
}

class Gate {
  constructor() { this.waiters = []; }
  wait() { return new Promise((resolve) => this.waiters.push(resolve)); }
  open() { const waiters = this.waiters.splice(0); for (const resolve of waiters) resolve(); }
}

function warmingKey(call) {
  return invocationFingerprint({ ...call, prompt: "", label: "", phase: null });
}

// Single-subscriber wait for an in-process child completion. Each poll tick
// replaces one cancellable waiter; ticks never register another reaction on the
// pending completion (a long child at a short poll would otherwise retain one
// reaction per tick). A completion that lands while the caller runs its
// per-tick guards resolves the next wait immediately.
export function completionWait(completion) {
  let settled = false;
  let receipt;
  let wakeWaiter = null;
  const wake = () => { const resolve = wakeWaiter; wakeWaiter = null; resolve?.(); };
  completion?.then(
    (value) => { receipt = value; settled = true; wake(); },
    () => { settled = true; wake(); },
  );
  return {
    get settled() { return settled; },
    get receipt() { return receipt; },
    waitTick(ms) {
      const waited = new Promise((resolve) => {
        const timer = setTimeout(() => { wakeWaiter = null; resolve(); }, ms);
        wakeWaiter = () => { clearTimeout(timer); resolve(); };
      });
      if (settled) wake();
      return waited;
    },
  };
}

export class DynamicWorkflowRunner {
  constructor({
    companion = new Companion({ detachBackground: false }),
    stateDir,
    workflowDir,
    engine,
    detachBackground = true,
    pollIntervalMs = 50,
    heartbeatIntervalMs = 1_000,
    leaseTimeoutMs = 30_000,
    cancelAckTimeoutMs = 5_000,
    queuedClaimTimeoutMs = 60_000,
    maxDispatchAttempts = 3,
    providerWait = null,
    hooks = {},
    workerPath,
    clock = () => Date.now(),
  } = {}) {
    if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) throw dynamicError("validation", "hooks must be an object");
    this.hooks = hooks;
    this.companion = companion;
    this.store = new DynamicStore(stateDir ?? join(companion.store.root, "dynamic"));
    this.workflowDir = workflowDir ?? null;
    this.engineOverride = engine ?? null;
    this.enginePromise = null;
    this.detachBackground = detachBackground === true;
    this.ownerId = randomUUID();
    this.running = new Map();
    this.clock = clock;
    this.workerPath = workerPath || fileURLToPath(new URL("./dynamic-worker.mjs", import.meta.url));
    if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > 100) throw dynamicError("validation", "pollIntervalMs must be an integer between 1 and 100");
    if (!Number.isInteger(heartbeatIntervalMs) || heartbeatIntervalMs < 1) throw dynamicError("validation", "heartbeatIntervalMs must be a positive integer");
    if (!Number.isInteger(leaseTimeoutMs) || leaseTimeoutMs < 1) throw dynamicError("validation", "leaseTimeoutMs must be a positive integer");
    if (!Number.isInteger(cancelAckTimeoutMs) || cancelAckTimeoutMs < 1) throw dynamicError("validation", "cancelAckTimeoutMs must be a positive integer");
    if (!Number.isInteger(queuedClaimTimeoutMs) || queuedClaimTimeoutMs < 1) throw dynamicError("validation", "queuedClaimTimeoutMs must be a positive integer");
    if (!Number.isInteger(maxDispatchAttempts) || maxDispatchAttempts < 1) throw dynamicError("validation", "maxDispatchAttempts must be a positive integer");
    if (providerWait !== null && providerWait !== undefined && (typeof providerWait !== "object" || Array.isArray(providerWait))) {
      throw dynamicError("validation", "providerWait must be null or an object");
    }
    this.pollIntervalMs = pollIntervalMs;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.leaseTimeoutMs = leaseTimeoutMs;
    this.cancelAckTimeoutMs = cancelAckTimeoutMs;
    this.queuedClaimTimeoutMs = queuedClaimTimeoutMs;
    this.maxDispatchAttempts = maxDispatchAttempts;
    // Provider-limit waiting is opt-in and off by default; the core does not
    // inherit any SDK automatic reset behavior.
    this.providerWait = providerWait
      ? { maxRetries: Number.isInteger(providerWait.maxRetries) ? Math.max(0, Math.min(10, providerWait.maxRetries)) : 1 }
      : null;
  }

  // Engine is loaded lazily on the first real engine call so fake-engine tests
  // and ordinary (non-script) jobs never pay for the QuickJS import.
  async #engine() {
    if (this.engineOverride) return this.engineOverride;
    this.enginePromise ??= import(new URL("./dynamic-engine.mjs", import.meta.url).href).then(normalizeEngine);
    return this.enginePromise;
  }

  #owned(record, active) {
    return Boolean(record?.lease) && record.lease.ownerId === this.ownerId && record.lease.fence === active.fence
      && (record.attempt ?? 1) === active.attempt;
  }

  async #transact(runId, active, work) {
    const result = await this.store.transact(runId, (record) => {
      if (!record) throw dynamicError("not-found", "dynamic run not found");
      if (!this.#owned(record, active)) throw dynamicError("lease-lost", "dynamic run lease lost");
      const outcome = work(record);
      if (!outcome) return null;
      outcome.record.updatedAt = now();
      active.record = outcome.record;
      return outcome;
    });
    return result?.record ?? null;
  }

  async #heartbeat(runId, active) {
    await this.#transact(runId, active, (record) => {
      if (!record.lease) return null;
      record.lease.heartbeatAt = this.clock();
      return { record };
    });
  }

  async #requestCancellation(runId, active, reason) {
    active.stopRequested = true;
    active.stopRequestedAt ||= this.clock();
    try {
      await this.#transact(runId, active, (record) => {
        record.cancellation ??= { state: "requested", requestedAt: now(), reason };
        record.state = "stopping";
        return { record, journal: [{ type: "cancellation", at: record.updatedAt, reason }] };
      });
    } catch (error) { if (error?.details?.kind !== "lease-lost") throw error; }
  }

  // ---- spec / record construction -----------------------------------------

  #rootOptions(spec) {
    return { policy: spec.policy, route: spec.route, target: spec.target, cwd: spec.cwd, context: spec.context, metadata: spec.metadata, execution: spec.execution };
  }

  #newRecord(spec, runId, identity) {
    return {
      runId,
      requestId: spec.requestId,
      name: spec.name,
      state: "queued",
      revision: 0,
      createdAt: now(),
      updatedAt: now(),
      startedAt: null,
      completedAt: null,
      attempt: 1,
      attemptWindows: [],
      deadlineAt: null,
      timeoutMs: spec.execution.timeoutMs,
      maxConcurrency: spec.execution.maxConcurrency,
      maxAgents: spec.execution.maxAgents,
      prefixStaggerMs: spec.execution.prefixStaggerMs,
      background: spec.execution.background,
      engineMeta: null,
      phases: [],
      calls: [],
      warming: [],
      journalSequence: 0,
      deliverySeq: 0,
      dispatchCount: 0,
      dispatch: { attempts: 0, maxAttempts: this.maxDispatchAttempts, lastAttemptAt: null },
      approvedWrites: false,
      waitingFor: null,
      invalidatedFrom: null,
      usageTotals: emptyUsageTotals(),
      progress: null,
      error: null,
      output: null,
      controls: [],
      resumes: [],
      pause: { requested: false, appliedAt: null },
      cancellation: null,
      lease: null,
      recoveryRequired: false,
      resumeOf: null,
    };
  }

  #persistableSpec(spec) {
    return { ...spec, source: spec.source };
  }

  // ---- control plane -------------------------------------------------------

  #reconcilePendingControls(record, { claiming = false } = {}) {
    const journal = [];
    const attempt = record.attempt ?? 1;
    const stopped = record.state === "cancelled" && record.cancellation?.reason === "stop"
      && record.cancellation.state === "acknowledged" && !record.calls.some((call) => call.uncertain);
    for (const command of record.controls ?? []) {
      if (command.state !== "accepted") continue;
      const currentAttempt = (command.attempt ?? command.application?.attempt ?? 1) === attempt;
      if (claiming && currentAttempt && !command.application) continue;
      if (stopped && currentAttempt && command.action === "stop") {
        delete command.application;
        journal.push(finishControl(command, { state: "applied", effect: "cancellation-requested" }));
      } else if (command.application) {
        // Preserve the delivery fence so a late acknowledgement can refine the outcome.
        journal.push(finishControl(command, {
          state: "uncertain",
          error: compactError(dynamicError("interrupted", "control application had not reported an outcome")),
        }));
      } else {
        journal.push(finishControl(command, undeliveredControl()));
      }
    }
    return journal;
  }

  async validate(input) {
    const spec = await normalizeDynamicSpec(input);
    const engine = await this.#engine();
    const meta = await engine.validateScript(spec.source);
    if (!meta || typeof meta !== "object" || (meta.meta != null && typeof meta.meta !== "object")) throw dynamicError("validation", "engine.validateScript must return {meta, body}");
    this.#probeLeaf(spec);
    return {
      valid: true,
      requestId: spec.requestId,
      runId: runIdFor(spec.requestId),
      name: spec.name,
      scriptDigest: spec.scriptDigest,
      argsDigest: spec.argsDigest,
      cwd: spec.cwd,
      target: spec.target,
      route: spec.route,
      policy: spec.policy,
      execution: spec.execution,
      meta: meta.meta,
    };
  }

  #probeLeaf(spec) {
    if (!spec.target && !Object.keys(spec.route).length) return;
    const requested = spec.target === "auto" || spec.target === null ? "pi" : spec.target;
    const request = normalizeRequest({
      requestId: `${runIdFor(spec.requestId)}-probe`,
      target: requested,
      task: "validate",
      cwd: spec.cwd,
      context: spec.context,
      metadata: spec.metadata,
      policy: spec.policy,
      route: spec.route,
      execution: { background: true, timeoutMs: spec.execution.timeoutMs },
    });
    assertDynamicLeaf(request);
  }

  async start(input) {
    const spec = await normalizeDynamicSpec(input);
    const engine = await this.#engine();
    const meta = await engine.validateScript(spec.source);
    if (!meta || typeof meta !== "object" || (meta.meta != null && typeof meta.meta !== "object")) throw dynamicError("validation", "engine.validateScript must return {meta, body}");
    const runId = runIdFor(spec.requestId);
    const identity = specIdentity(spec);
    const existing = await this.store.readRun(runId);
    if (existing) {
      if (existing.specDigest !== identity) throw dynamicError("request-conflict", "requestId already belongs to a different dynamic run");
      return spec.execution.background ? this.status({ runId }) : this.#wait(runId);
    }
    const record = this.#newRecord(spec, runId, identity);
    record.specDigest = identity;
    record.engineMeta = meta.meta ?? null;
    record.scriptRevision = 1;
    const created = await this.store.createRun({
      runId,
      requestId: spec.requestId,
      record,
      specRevision: { revision: 1, scriptDigest: spec.scriptDigest, argsDigest: spec.argsDigest, createdAt: record.createdAt, spec: this.#persistableSpec(spec) },
    });
    if (!created.created) {
      const current = created.record ?? await this.store.readRun(created.runId);
      if (current?.specDigest !== identity) throw dynamicError("request-conflict", "requestId already belongs to a different dynamic run");
      return spec.execution.background ? this.status({ runId: created.runId }) : this.#wait(created.runId);
    }
    return this.#dispatch(runId, spec.execution.background);
  }

  async #dispatch(runId, background) {
    if (background && this.detachBackground && this.#spawnWorker(runId)) {
      return this.status({ runId });
    }
    const launched = this.#launch(runId);
    if (background) return this.status({ runId });
    await launched.promise.catch(() => undefined);
    return this.result({ runId });
  }

  async #wait(runId) {
    for (;;) {
      const status = await this.status({ runId });
      if (RUN_TERMINAL.has(status.state)) return this.result({ runId });
      await wait(this.pollIntervalMs);
    }
  }

  #spawnWorker(runId) {
    try {
      const child = spawn(process.execPath, [this.workerPath, this.store.root, runId, this.companion.store.root], {
        detached: true, stdio: "ignore", windowsHide: true, env: mergeProcessEnv(),
      });
      child.on("error", (error) => {
        process.stderr.write(`harnest: detached dynamic worker failed for ${runId}: ${error?.message || error}\n`);
        void this.#launch(runId).promise.catch(() => undefined);
      });
      child.unref();
      return true;
    } catch (error) {
      process.stderr.write(`harnest: could not spawn a detached dynamic worker for ${runId}: ${error?.message || error}\n`);
      return false;
    }
  }

  #launch(runId) {
    const existing = this.running.get(runId);
    if (existing) return existing;
    const active = {
      controller: new AbortController(), promise: null, fence: null, attempt: null, record: null, spec: null,
      callOrdinal: 0, delivery: [], pumping: false, resolvedDeliverySeq: null, idleSignaled: false,
      inflightPreflights: 0, preflightGate: new Gate(), restartPass: false, passRunning: false, replayAfterSettle: false, replayFailure: null,
      callsInitiated: 0, idleAtCalls: 0, reuseExpected: 0, reuseDelivered: 0,
      semaphore: null, warming: new Map(),
      writerGate: new Gate(), writers: [], paused: false, stopRequested: false, stopRequestedAt: 0, settleDone: false,
      timeoutRequested: false, controlApplications: new Map(), stopCalls: new Set(), restart: new Set(),
      childCancelRequested: new Set(), acknowledged: new Set(), lastHeartbeat: 0, polling: false, poller: null,
    };
    active.semaphore = new Semaphore(DEFAULT_CONCURRENCY);
    const promise = this.#execute(runId, active)
      .catch(async (error) => { await this.#settleCrash(runId, active, error); })
      .finally(() => {
        clearInterval(active.poller);
        if (this.running.get(runId) === active) this.running.delete(runId);
      });
    active.promise = promise;
    this.running.set(runId, active);
    return active;
  }

  async status({
    runId, afterRevision, waitMs = 0, invocationLimit = 200, invocationCursor = null,
    phaseLimit = DEFAULT_PHASE_LIMIT, phaseCursor = null,
  } = {}) {
    if (typeof runId !== "string" || !runId.trim()) throw dynamicError("validation", "runId is required");
    if (afterRevision !== undefined && (!Number.isSafeInteger(afterRevision) || afterRevision < 0)) throw dynamicError("validation", "afterRevision must be a nonnegative safe integer");
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 25_000) throw dynamicError("validation", "waitMs must be between 0 and 25000");
    if (!Number.isInteger(invocationLimit) || invocationLimit < 1 || invocationLimit > 1_000) throw dynamicError("validation", "invocationLimit must be an integer between 1 and 1000");
    if (invocationCursor !== null && (!Number.isInteger(invocationCursor) || invocationCursor < 0)) throw dynamicError("validation", "invocationCursor must be a nonnegative ordinal");
    if (!Number.isInteger(phaseLimit) || phaseLimit < 1 || phaseLimit > MAX_PHASE_LIMIT) throw dynamicError("validation", `phaseLimit must be an integer between 1 and ${MAX_PHASE_LIMIT}`);
    if (phaseCursor !== null && (!Number.isSafeInteger(phaseCursor) || phaseCursor < 0)) throw dynamicError("validation", "phaseCursor must be a nonnegative ordinal");
    const deadline = this.clock() + waitMs;
    for (;;) {
      let record = await this.store.readRun(runId);
      if (!record) throw dynamicError("not-found", "dynamic run not found");
      if (LEASE_STATES.has(record.state) && !this.running.has(runId) && (!record.lease || this.clock() - record.lease.heartbeatAt > record.lease.timeoutMs)) {
        record = await this.#reconcileStale(runId) ?? record;
      } else if (record.state === "queued" && !record.lease && !this.running.has(runId)) {
        record = await this.#reapQueued(runId, record);
      }
      if (afterRevision !== record.revision) return projectStatus(record, { invocationLimit, invocationCursor, phaseLimit, phaseCursor });
      if (this.clock() >= deadline || RUN_TERMINAL.has(record.state)) return { runId, requestId: record.requestId, state: record.state, revision: record.revision, unchanged: true };
      await wait(Math.min(250, Math.max(10, this.pollIntervalMs), deadline - this.clock()));
    }
  }

  // Bounded queued redispatch: a run whose worker died before the fenced claim
  // must not sit queued forever. After the claim window the control plane
  // re-dispatches up to maxDispatchAttempts, then settles an explicit
  // unclaimed partial for the caller to resume.
  async #reapQueued(runId, record) {
    const claimedAt = Date.parse(record.dispatch?.lastAttemptAt || record.createdAt);
    const ageMs = this.clock() - claimedAt;
    if (!Number.isFinite(ageMs) || ageMs <= this.queuedClaimTimeoutMs) return record;
    const outcome = await this.store.transact(runId, (current) => {
      if (!current || current.state !== "queued" || current.lease) return null;
      const age = this.clock() - Date.parse(current.dispatch?.lastAttemptAt || current.createdAt);
      if (!Number.isFinite(age) || age <= this.queuedClaimTimeoutMs) return null;
      const attempts = Number.isInteger(current.dispatch?.attempts) ? current.dispatch.attempts : 0;
      const maxAttempts = current.dispatch?.maxAttempts ?? this.maxDispatchAttempts;
      if (attempts >= maxAttempts) {
        current.state = "partial";
        current.recoveryRequired = true;
        current.completedAt = now();
        current.error = compactError(dynamicError("unclaimed", `queued run was never claimed after ${attempts} dispatch attempt(s)`, { attempts, maxAttempts }));
        return { record: current, journal: [
          ...this.#reconcilePendingControls(current),
          { type: "recovery", at: current.updatedAt, state: "partial", reason: "unclaimed" },
        ] };
      }
      current.dispatch = { attempts: attempts + 1, maxAttempts, lastAttemptAt: now() };
      return { record: current, journal: [{ type: "dispatch", at: current.updatedAt, attempts: attempts + 1, reason: "unclaimed-timeout" }] };
    }).catch(() => null);
    if (!outcome?.record) return (await this.store.readRun(runId)) ?? record;
    if (outcome.record.state === "queued" && this.detachBackground) this.#spawnWorker(runId);
    return outcome.record;
  }

  async #reconcileStale(runId) {
    return this.store.transact(runId, (record) => {
      if (!LEASE_STATES.has(record.state)) return null;
      if (record.lease && this.clock() - record.lease.heartbeatAt <= record.lease.timeoutMs) return null;
      record.state = "partial";
      record.recoveryRequired = true;
      record.lease = null;
      record.deadlineAt = null;
      record.completedAt = now();
      record.error = compactError(dynamicError("interrupted", "dynamic run owner lease expired; explicit resume required"));
      for (const call of record.calls) {
        if (INVOCATION_TERMINAL.has(call.state) || call.state === "invalidated") continue;
        call.state = "partial";
        setCallUncertainty(call, true);
        call.error ??= compactError(dynamicError("interrupted", "call was in flight when the owner was lost"));
      }
      record.updatedAt = now();
      return { record, journal: [
        ...this.#reconcilePendingControls(record),
        { type: "recovery", at: record.updatedAt, state: "partial", reason: "lease-expired" },
      ] };
    }).then((result) => result?.record ?? null);
  }

  async result({
    runId, invocationLimit = 200, invocationCursor = null,
    phaseLimit = DEFAULT_PHASE_LIMIT, phaseCursor = null,
  } = {}) {
    const page = { invocationLimit, invocationCursor, phaseLimit, phaseCursor };
    const status = await this.status({ runId, ...page });
    if (!RUN_TERMINAL.has(status.state)) throw dynamicError("not-terminal", `dynamic run is ${status.state}; poll status before result`);
    const record = await this.store.readRun(runId);
    if (!RUN_TERMINAL.has(record.state)) throw dynamicError("not-terminal", "dynamic run resumed before result was read");
    return projectStatus(record, { includeOutput: true, ...page });
  }

  async history({ limit = 20, cursor = null, state = null } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw dynamicError("validation", "history limit must be an integer between 1 and 100");
    if (state !== null && !RUN_ACTIVE.has(state) && !RUN_TERMINAL.has(state)) throw dynamicError("validation", "unknown history state filter");
    let after = null;
    if (cursor) {
      try { after = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); } catch { throw dynamicError("validation", "invalid history cursor"); }
      if (!after || typeof after.updatedAt !== "string" || typeof after.runId !== "string") throw dynamicError("validation", "invalid history cursor");
    }
    const runs = [];
    for (const runId of await this.store.listRunIds()) {
      const record = await this.store.readRun(runId);
      if (!record) continue;
      if (state && record.state !== state) continue;
      runs.push(projectHistoryRun(record));
    }
    const key = (run) => `${run.updatedAt}\u0000${run.runId}`;
    // Newest first; cursors page strictly older so repeated calls are stable.
    runs.sort((left, right) => (left.updatedAt === right.updatedAt ? right.runId.localeCompare(left.runId) : right.updatedAt.localeCompare(left.updatedAt)));
    const filtered = after ? runs.filter((run) => key(run) < key(after)) : runs;
    const page = filtered.slice(0, limit);
    const nextCursor = filtered.length > limit && page.length ? Buffer.from(JSON.stringify({ updatedAt: page.at(-1).updatedAt, runId: page.at(-1).runId })).toString("base64url") : null;
    return { runs: page, nextCursor };
  }

  #readControl(record, commandId) {
    const command = (record?.controls ?? []).find((item) => item.commandId === commandId);
    return command ? controlSummary(command) : null;
  }

  async control({ runId, commandId, action, invocationId, message, route, approveWrites = false } = {}) {
    if (typeof runId !== "string" || !runId.trim()) throw dynamicError("validation", "runId is required");
    if (typeof commandId !== "string" || !commandId.trim() || commandId.length > 200) throw dynamicError("validation", "commandId is required and at most 200 characters");
    if (typeof action !== "string" || !CONTROL_ACTIONS.has(action)) throw dynamicError("validation", `action must be one of ${[...CONTROL_ACTIONS].join(", ")}`);
    if (typeof approveWrites !== "boolean") throw dynamicError("validation", "approveWrites must be boolean");
    if (approveWrites && action !== "restart-agent") throw dynamicError("validation", "approveWrites is only supported for restart-agent");
    if (invocationId !== undefined && typeof invocationId !== "string") throw dynamicError("validation", "invocationId must be a string");
    if (message !== undefined && (typeof message !== "string" || !message.trim())) throw dynamicError("validation", "message must be a nonempty string");
    if (typeof message === "string" && Buffer.byteLength(message, "utf8") > MAX_MESSAGE_BYTES) throw dynamicError("validation", "message exceeds the message byte limit");
    if (action === "reroute") {
      const normalizedRoute = normalizeRoute(route ?? {}, "route");
      if (!normalizedRoute.provider || !normalizedRoute.model) throw dynamicError("validation", "reroute requires route.provider and route.model");
      route = normalizedRoute;
    } else if (route !== undefined) {
      throw dynamicError("validation", "route is only supported for reroute");
    }
    const identity = controlIdentity({ action, invocationId, message, route, approveWrites });
    const active = this.running.get(runId);
    const outcome = await this.store.transact(runId, (record) => {
      if (!record) throw dynamicError("not-found", "dynamic run not found");
      const existing = (record.controls ?? []).find((item) => item.commandId === commandId);
      if (existing) {
        if (existing.identity !== identity) throw dynamicError("control-conflict", "commandId already belongs to a different control");
        return null;
      }
      const command = {
        commandId, identity, action, invocationId: invocationId ?? null, message: message ?? null, route: route ?? null,
        approveWrites: action === "restart-agent" ? Boolean(approveWrites) : false,
        attempt: record.attempt ?? 1,
        state: "accepted", requestedAt: now(), updatedAt: now(), appliedAt: null, effect: null, acknowledgement: null, error: null,
      };
      if (RUN_TERMINAL.has(record.state)) {
        // No live owner remains to apply a control: resolve it truthfully
        // instead of leaving it accepted forever.
        command.state = "rejected";
        command.error = compactError(dynamicError("not-active", "run is terminal"));
      }
      record.controls.push(command);
      if (command.state === "accepted") {
        if (action === "stop") record.cancellation ??= { state: "requested", requestedAt: now(), reason: "stop" };
        if (action === "pause") record.pause.requested = true;
        if (action === "continue") record.pause.requested = false;
      }
      record.updatedAt = now();
      return { record, journal: [{ type: "control", at: command.requestedAt, commandId, action, state: command.state, invocationId: command.invocationId }] };
    });
    const command = outcome?.record
      ? outcome.record.controls.find((item) => item.commandId === commandId)
      : null;
    if (command?.state === "accepted" && active?.attempt === command.attempt) {
      await this.#handleCommand(runId, active, command);
    }
    const finalRecord = await this.store.readRun(runId);
    return this.#readControl(finalRecord, commandId);
  }

  async resume({ runId, commandId, source, approveWrites = false } = {}) {
    if (typeof runId !== "string" || !runId.trim()) throw dynamicError("validation", "runId is required");
    if (typeof commandId !== "string" || !commandId.trim() || commandId.length > 200) throw dynamicError("validation", "commandId is required and at most 200 characters");
    if (typeof approveWrites !== "boolean") throw dynamicError("validation", "approveWrites must be boolean");
    if (source !== undefined && (typeof source !== "string" || !source.trim())) throw dynamicError("validation", "source must be a nonempty string");
    const identity = resumeIdentity({ source, approveWrites });
    const alreadyAccepted = (record) => {
      const prior = (record.resumes ?? []).find((item) => item.commandId === commandId);
      if (prior && prior.identity !== identity) throw dynamicError("resume-conflict", "commandId already belongs to another resume request");
      return Boolean(prior);
    };
    const initial = await this.store.readRun(runId);
    if (!initial) throw dynamicError("not-found", "dynamic run not found");
    if (alreadyAccepted(initial)) return this.status({ runId });
    let replacement = null;
    if (source !== undefined) {
      if (bytes(source) > MAX_SOURCE_BYTES) throw dynamicError("validation", `source must be at most ${MAX_SOURCE_BYTES} bytes`);
      const engine = await this.#engine();
      const meta = await engine.validateScript(source);
      if (!meta || typeof meta !== "object" || (meta.meta != null && typeof meta.meta !== "object")) throw dynamicError("validation", "engine.validateScript must return {meta, body}");
      replacement = { source, scriptDigest: digestContext(source), meta: meta.meta };
    }
    // A status read can redispatch an old queued revision. Resume owns that decision.
    if (LEASE_STATES.has(initial.state) && !this.running.has(runId)) await this.#reconcileStale(runId);
    const outcome = await this.store.transact(runId, async (record) => {
      if (!record) throw dynamicError("not-found", "dynamic run not found");
      if (alreadyAccepted(record)) return null;
      // A queued run with no lease lost its worker before the fenced claim;
      // that is recoverable. Any other active state already owns an attempt.
      const queuedSince = Date.parse(record.dispatch?.lastAttemptAt ?? record.createdAt);
      const orphanedQueued = record.state === "queued" && !record.lease && this.clock() - queuedSince > this.queuedClaimTimeoutMs;
      if (RUN_ACTIVE.has(record.state) && !orphanedQueued) throw dynamicError("resume-conflict", "dynamic run already has an active attempt");
      if (record.state === "completed") throw dynamicError("resume-conflict", "completed dynamic run cannot be resumed; start a follow-up");
      // Fail closed on any call whose true state is unknown.
      const unknown = record.calls.find((call) => call.uncertain);
      if (unknown) throw dynamicError("unsafe-resume", `call ${unknown.id} may still be executing; reconcile its native stop before retrying`);
      // Suffix invalidation survives only while invalidated calls still exist;
      // per-call flags remain the source of truth for reuse.
      if (!record.calls.some((call) => call.invalidated)) record.invalidatedFrom = null;
      // Replaying a write call needs explicit approval.
      const writers = record.calls.filter((call) => call.writer && INVOCATION_TERMINAL.has(call.state) && call.attempts.some((a) => a.startedAt));
      if (writers.length && !approveWrites) {
        throw dynamicError("policy", `retrying write call(s) ${writers.map((c) => c.id).join(", ")} requires approveWrites`);
      }
      if (replacement) {
        const specs = await this.store.readSpecs(runId);
        const original = findSpecRevision(specs, record)?.spec;
        if (!original) throw dynamicError("persistence", "dynamic run specification is missing");
        const { source, scriptDigest, meta } = replacement;
        const revision = specs.revisions.at(-1).revision + 1;
        await this.store.appendSpecRevision(runId, {
          revision, scriptDigest, argsDigest: original.argsDigest, createdAt: now(),
          spec: { ...original, source, scriptDigest }, meta,
        });
        record.scriptRevision = revision;
        record.scriptDigest = scriptDigest;
      }
      // Close out pending controls in the same transaction that queues the next attempt.
      const attempt = record.attempt ?? 1;
      const journal = this.#reconcilePendingControls(record);
      record.attempt = attempt + 1;
      record.state = "queued";
      record.dispatch = { attempts: 0, maxAttempts: this.maxDispatchAttempts, lastAttemptAt: now() };
      record.completedAt = null;
      record.deadlineAt = null;
      record.lease = null;
      record.output = null;
      record.error = null;
      record.recoveryRequired = false;
      record.pause = { requested: false, appliedAt: null };
      record.cancellation = null;
      record.warming = [];
      record.waitingFor = null;
      if (approveWrites) record.approvedWrites = true;
      // Clear per-attempt delivery order so the new attempt records its own;
      // call values/fingerprints stay for prefix reuse.
      record.deliverySeq = 0;
      for (const call of record.calls) if (call.state !== "completed") call.deliverySeq = null;
      record.resumes.push({ commandId, identity, approveWrites, sourceChanged: source !== undefined, at: now() });
      record.updatedAt = now();
      journal.push({ type: "resume", at: record.updatedAt, commandId, attempt: record.attempt, scriptRevision: record.scriptRevision, sourceChanged: source !== undefined });
      return { record, journal };
    });
    if (!outcome?.record) return this.status({ runId });
    return this.#dispatch(runId, outcome.record.background !== false);
  }

  // ---- execution -----------------------------------------------------------

  async execute(runId) {
    const active = this.#launch(runId);
    await active.promise.catch(() => undefined);
    return this.status({ runId });
  }

  async #claim(runId, active) {
    const outcome = await this.store.transact(runId, (record) => {
      if (!record) throw dynamicError("not-found", "dynamic run not found");
      if (RUN_TERMINAL.has(record.state)) return null;
      if (record.lease && record.lease.ownerId !== this.ownerId && this.clock() - record.lease.heartbeatAt <= record.lease.timeoutMs) {
        throw dynamicError("claim-conflict", "dynamic run is owned by another live worker");
      }
      const fence = (record.lease?.fence ?? 0) + 1;
      record.lease = { ownerId: this.ownerId, fence, heartbeatAt: this.clock(), timeoutMs: this.leaseTimeoutMs };
      record.state = "running";
      if (!record.startedAt) record.startedAt = now();
      const attempt = record.attempt ?? 1;
      if (!record.attemptWindows.some((window) => window.attempt === attempt)) {
        record.attemptWindows.push({ attempt, startedAt: now(), deadlineAt: this.clock() + (record.timeoutMs ?? 0), resumed: attempt > 1 });
      }
      record.deadlineAt = record.attemptWindows.at(-1).deadlineAt;
      record.pause = { requested: Boolean(record.pause?.requested), appliedAt: record.pause?.appliedAt ?? null };
      record.completedAt = null;
      record.recoveryRequired = false;
      record.updatedAt = now();
      return { record, journal: [
        ...this.#reconcilePendingControls(record, { claiming: true }),
        { type: "claimed", at: record.updatedAt, attempt, fence },
      ] };
    });
    if (!outcome?.record) return null;
    active.fence = outcome.record.lease.fence;
    active.attempt = outcome.record.attempt ?? 1;
    active.record = outcome.record;
    return outcome.record;
  }

  async #execute(runId, active) {
    const claimed = await this.#claim(runId, active);
    if (!claimed) return;
    const specs = await this.store.readSpecs(runId);
    const revision = findSpecRevision(specs, claimed);
    if (!revision?.spec) throw dynamicError("persistence", "dynamic run specification is missing");
    const spec = revision.spec;
    active.spec = spec;
    active.semaphore = new Semaphore(spec.execution.maxConcurrency ?? DEFAULT_CONCURRENCY);
    active.callOrdinal = 0;
    active.journalSequence = claimed.journalSequence ?? 0;
    active.deliverySeq = claimed.deliverySeq ?? 0;
    active.paused = Boolean(claimed.pause?.requested);
    active.lastHeartbeat = this.clock();
    this.#startPoller(runId, active);

    let output = null;
    let failure = null;
    try {
      for (;;) {
        active.delivery = [];
        active.resolvedDeliverySeq = null;
        active.idleSignaled = false;
        active.callOrdinal = 0;
        active.phase = null;
        active.replayFailure = null;
        active.callsInitiated = 0;
        active.idleAtCalls = 0;
        active.reuseExpected = 0;
        active.reuseDelivered = 0;
        // Fresh controller per pass so a restart can unwind the old attempt
        // without wedging the replay on an already-aborted signal.
        active.controller = new AbortController();
        active.callbacks = new Set();
        active.preflightTail = Promise.resolve();
        active.passEnded = false;
        active.passRunning = true;
        active.settleDone = false;
        const pending = await this.#reconcile(runId, active, active.record ?? claimed);
        if (pending.length) {
          failure = dynamicError("unsafe-resume", `call(s) ${pending.map((call) => call.id).join(", ")} may still be executing; reconcile before retry`);
          output = null;
        } else {
          const engine = await this.#engine();
          const remaining = Math.max(1, (active.record?.deadlineAt ?? claimed.deadlineAt ?? 0) - this.clock());
          try {
            output = await engine.runScript({
              source: spec.source,
              args: spec.args,
              onAgent: (prompt, options) => this.#agent(runId, active, prompt, options),
              onPhase: (title) => this.#phase(runId, active, title),
              onLog: (message) => this.#log(runId, active, message),
              onIdle: () => {
                active.idleAtCalls = active.callsInitiated;
                active.idleSignaled = true;
                this.#maybeFlushDeliveries(active);
              },
              signal: active.controller.signal,
              // Correct engine limit keys: unknown fields are ignored by the
              // engine, so stale names would silently fall back to defaults.
              limits: {
                maxAgents: claimed.maxAgents ?? MAX_AGENT_CALLS,
                maxHelperItems: 4096,
                maxResultBytes: MAX_ENGINE_RESULT_BYTES,
                maxCpuSliceMs: 250,
                timeoutMs: remaining,
                maxConcurrency: spec.execution.maxConcurrency ?? DEFAULT_CONCURRENCY,
              },
            });
            output = boundOutput(output);
            failure = null;
          } catch (error) {
            failure = error;
          }
        }
        active.passRunning = false;
        // Resolve cached deliveries the guest abandoned (fire-and-forget) in
        // recorded order; out-of-order arrivals set replayFailure below.
        this.#drainDeliveries(active);
        active.passEnded = true;
        active.controller.abort();
        let drainTimer;
        // Native stop acknowledgement has its own bound in #awaitChild.
        // Callback completion also includes durable journal writes.
        const drainMs = Math.max(1, Math.min(this.leaseTimeoutMs, (active.record?.deadlineAt ?? Infinity) - this.clock()));
        const drained = await Promise.race([
          Promise.allSettled([...active.callbacks]).then(() => true),
          new Promise((resolve) => { drainTimer = setTimeout(() => resolve(false), drainMs); }),
        ]).finally(() => clearTimeout(drainTimer));
        if (!drained) throw failure ?? dynamicError("unsafe-resume", "previous script callbacks did not acknowledge stopping");
        // A late cached delivery that could not be ordered deterministically
        // fails the run even if the guest's Promise.race already resolved.
        if (active.replayFailure) {
          failure = active.replayFailure;
          output = null;
        }
        // Run-level restart: the suffix was stopped and invalidated while the
        // original attempt window stays in force; replay immediately.
        if (active.restartPass && !active.stopRequested) {
          await this.#prepareRestartReplay(runId, active);
          output = null;
          failure = null;
          continue;
        }
        // A restart can also arrive while settle reconciles; defer terminalizing
        // and replay instead of losing the request.
        const replay = await this.#settle(runId, active, { output, failure });
        if (replay && !active.stopRequested) {
          await this.#prepareRestartReplay(runId, active);
          output = null;
          failure = null;
          continue;
        }
        break;
      }
    } catch (error) {
      failure = error;
      await this.#settle(runId, active, { output: null, failure });
    }
  }

  // Wait for the aborted pass's in-flight callbacks to finish reconciling,
  // then stop any suffix child that is still live. The next pass replays the
  // completed prefix and re-dispatches the invalidated suffix.
  async #prepareRestartReplay(runId, active) {
    // Replay intent precedes the async mutation; wait for its durable boundary
    // and old-pass markers before clearing them for the next pass.
    await active.restartPreparation;
    active.restartPass = false;
    active.replayAfterSettle = false;
    await this.#drainPreflights(active);
    active.restart = new Set();
    active.stopCalls = new Set();
    active.childCancelRequested = new Set();
    active.writers = [];
    // Settle may have stopped the poller while deferring the replay; the
    // replayed pass still needs its heartbeat and control observation.
    if (active.poller) clearInterval(active.poller);
    this.#startPoller(runId, active);
    active.lastHeartbeat = this.clock();
    this.#resetWarming(runId, active);
    for (const call of [...(active.record?.calls ?? [])]) {
      if (!call.invalidated && call.state !== "partial") continue;
      if (!call.jobId) continue;
      const receipt = await this.#lookup(call).catch(() => null);
      if (receipt && !INVOCATION_TERMINAL.has(receipt.state)) await this.#cancelChild(runId, active, call).catch(() => undefined);
    }
  }

  async #drainPreflights(active) {
    const deadline = this.clock() + this.cancelAckTimeoutMs + this.leaseTimeoutMs;
    while (active.inflightPreflights > 0 && this.clock() < deadline) {
      await Promise.race([active.preflightGate.wait(), wait(this.pollIntervalMs)]);
    }
  }

  #startPoller(runId, active) {
    const tick = async () => {
      if (active.polling || active.stopped) return;
      active.polling = true;
      try {
        const record = await this.store.readControlState(runId);
        if (!this.#owned(record, active) || active.stopped) return;
        if (this.clock() - active.lastHeartbeat >= this.heartbeatIntervalMs) {
          active.lastHeartbeat = this.clock();
          await this.#heartbeat(runId, active).catch(() => undefined);
          if (active.stopped) return;
        }
        if (!active.paused && record.pause?.requested) active.paused = true;
        if (active.paused && !record.pause?.requested) active.paused = false;
        if (!active.stopRequested && record.cancellation) {
          active.stopRequested = true;
          active.stopRequestedAt ||= this.clock();
          active.controller.abort();
        }
        if (!active.timeoutRequested && record.deadlineAt && this.clock() >= record.deadlineAt && !record.cancellation) {
          active.timeoutRequested = true;
          active.controller.abort();
          await this.#requestCancellation(runId, active, "timeout").catch(() => undefined);
        }
        for (const command of record.controls ?? []) {
          // A legacy command has no reliable attempt identity once the run has resumed.
          if (active.stopped || (command.attempt ?? 1) !== active.attempt
            || command.state !== "accepted" || active.controlApplications.has(command.commandId)) continue;
          await this.#handleCommand(runId, active, command);
        }
      } finally { active.polling = false; }
    };
    active.poller = setInterval(() => { void tick(); }, this.pollIntervalMs);
    active.stopped = false;
  }

  #handleCommand(runId, active, command) {
    const pending = active.controlApplications.get(command.commandId);
    if (pending) return pending;
    const application = this.#applyCommand(runId, active, command).catch(() => undefined);
    active.controlApplications.set(command.commandId, application);
    return application;
  }

  async #updateControl(runId, active, commandId, fields, mutate) {
    const apply = (record, owned) => {
      const command = (record?.controls ?? []).find((item) => item.commandId === commandId);
      if (!command) return null;
      const application = command.application;
      const ownsApplication = application?.ownerId === this.ownerId && application.fence === active.fence
        && application.attempt === active.attempt;
      if (application && !ownsApplication) return null;
      if (command.state !== "accepted" && !(command.state === "uncertain" && ownsApplication)) return null;
      if (!owned && !ownsApplication && (record.lease || !RUN_TERMINAL.has(record.state)
        || (record.attempt ?? 1) !== active.attempt || (command.attempt ?? 1) !== active.attempt)) return null;
      delete command.application;
      const event = finishControl(command, fields);
      if (owned) mutate?.(record, command);
      record.updatedAt = command.updatedAt;
      return { record, journal: [event] };
    };
    try {
      await this.#transact(runId, active, (record) => apply(record, true));
    } catch (error) {
      if (error?.details?.kind !== "lease-lost") throw error;
      // A late outcome may update its fenced command, even after resume.
      await this.store.transact(runId, (record) => apply(record, false)).catch(() => undefined);
    }
  }

  async #cancelChild(runId, active, call) {
    active.childCancelRequested.add(call.ordinal);
    if (!call.jobId) return null;
    try {
      const receipt = await this.companion.cancel(call.jobId);
      // A terminal receipt returned to the local owner is cancellation
      // evidence: the owner aborted the adapter's controller and the job
      // settled. Cross-process/unknown stops never reach this branch.
      if (receipt && INVOCATION_TERMINAL.has(receipt.state)) active.acknowledged.add(call.ordinal);
      return receipt;
    }
    catch (error) { if (error?.details?.kind === "not-active" || error?.code === "ENOENT") return null; throw error; }
  }

  async #applyCommand(runId, active, command) {
    try {
      if (active.stopped || RUN_TERMINAL.has(active.record?.state)) {
        await this.#updateControl(runId, active, command.commandId, undeliveredControl());
        return;
      }
      // Commit the delivery fence before invoking a side effect that can outlive the run.
      const started = await this.#transact(runId, active, (record) => {
        const pending = record.controls.find((item) => item.commandId === command.commandId);
        if (pending?.state !== "accepted" || pending.application || (pending.attempt ?? 1) !== active.attempt) return null;
        pending.application = { ownerId: this.ownerId, fence: active.fence, attempt: active.attempt };
        return { record };
      });
      if (!started) return;
      if (active.stopped || RUN_TERMINAL.has(active.record?.state)) {
        await this.#updateControl(runId, active, command.commandId, undeliveredControl());
        return;
      }
      if (command.action === "pause") {
        active.paused = true;
        await this.#updateControl(runId, active, command.commandId, { state: "applied", effect: "dispatch-gate-closed" }, (record) => {
          if (RUN_TERMINAL.has(record.state)) return;
          record.pause = { requested: true, appliedAt: now() };
          record.state = record.calls.some((call) => call.state === "running" || call.state === "prepared") ? "pausing" : "paused";
        });
      } else if (command.action === "continue") {
        active.paused = false;
        await this.#updateControl(runId, active, command.commandId, { state: "applied", effect: "dispatch-gate-open" }, (record) => {
          if (RUN_TERMINAL.has(record.state)) return;
          record.pause = { requested: false, appliedAt: now() };
          if (!record.cancellation) record.state = "running";
        });
      } else if (command.action === "stop") {
        active.stopRequested = true;
        active.stopRequestedAt ||= this.clock();
        active.controller.abort();
        await this.#updateControl(runId, active, command.commandId, { state: "applied", effect: "cancellation-requested" }, (record) => {
          // A settle may win the race while this command is in flight; never
          // resurrect `requested` over an already-acknowledged cancellation.
          if (RUN_TERMINAL.has(record.state)) return;
          if (!record.cancellation) record.cancellation = { state: "requested", requestedAt: now(), reason: "stop" };
          record.state = "stopping";
        });
      } else if (command.action === "stop-agent" || command.action === "restart-agent") {
        const call = (active.record?.calls ?? []).find((item) => item.id === command.invocationId);
        if (!call) {
          await this.#updateControl(runId, active, command.commandId, { state: "rejected", error: compactError(dynamicError("not-found", "unknown invocation")) });
          return;
        }
        if (command.action === "stop-agent" && INVOCATION_TERMINAL.has(call.state)) {
          await this.#updateControl(runId, active, command.commandId, { state: "rejected", error: compactError(dynamicError("not-active", "invocation is terminal")) });
          return;
        }
        if (command.action === "restart-agent") {
          const suffixWriters = (active.record?.calls ?? []).filter((item) => item.ordinal >= call.ordinal && item.writer && item.attempts.some((attempt) => attempt.startedAt));
          if (suffixWriters.length && command.approveWrites !== true) {
            await this.#updateControl(runId, active, command.commandId, {
              state: "rejected",
              error: compactError(dynamicError("policy", `restarting write invocation(s) ${suffixWriters.map((item) => item.id).join(", ")} requires approveWrites`)),
            });
            return;
          }
          // Record the replay intent BEFORE invalidating the suffix so a settle
          // that races this command observes it and defers terminalizing.
          if (active.settleDone) {
            await this.#updateControl(runId, active, command.commandId, {
              state: "rejected",
              error: compactError(dynamicError("not-active", "run settled before the restart could be applied")),
            });
            return;
          }
          const passLive = active.passRunning;
          const passController = active.controller;
          if (passLive) active.restartPass = true;
          else active.replayAfterSettle = true;
          active.restartPreparation = this.#invalidateFrom(runId, active, call.ordinal).then((invalidated) => {
            if (invalidated) {
              for (const item of active.record?.calls ?? []) if (item.ordinal >= call.ordinal) active.restart.add(item.ordinal);
            }
            return invalidated;
          }, (error) => {
            active.restartPass = false;
            active.replayAfterSettle = false;
            throw error;
          });
          const invalidated = await active.restartPreparation;
          if (!invalidated) {
            active.restartPass = false;
            active.replayAfterSettle = false;
            await this.#updateControl(runId, active, command.commandId, {
              state: "rejected",
              error: compactError(dynamicError("not-active", "run settled before the restart could be applied")),
            });
            return;
          }
          await this.hooks?.afterRestartInvalidate?.();
          if (call.jobId) await this.#cancelChild(runId, active, call).catch(() => undefined);
          // Abort the controller captured at decision time: a replay pass may
          // already have replaced active.controller while we awaited.
          if (passLive) passController.abort();
        } else {
          if (call.jobId) await this.#cancelChild(runId, active, call).catch(() => undefined);
          active.stopCalls.add(call.ordinal);
        }
        await this.#updateControl(runId, active, command.commandId, {
          state: "applied",
          effect: command.action === "restart-agent" ? "suffix-restarted" : "child-cancellation-requested",
        });
      } else if (command.action === "steer" || command.action === "reroute") {
        const call = (active.record?.calls ?? []).find((item) => item.id === command.invocationId);
        if (!call?.jobId) {
          await this.#updateControl(runId, active, command.commandId, { state: "rejected", error: compactError(dynamicError("unsupported-control", "no live child to control")) });
          return;
        }
        try {
          const ack = command.action === "steer"
            ? await this.companion.message(call.jobId, { commandId: command.commandId, message: command.message })
            : await this.companion.reroute(call.jobId, { commandId: command.commandId, route: command.route });
          const state = ack?.state === "applied" ? "applied" : ack?.state === "uncertain" ? "uncertain" : "rejected";
          await this.#updateControl(runId, active, command.commandId, {
            state, effect: command.action === "reroute" ? "next-model-request" : "next-agent-step",
            acknowledgement: ack ?? null,
            error: state === "rejected" ? compactError(dynamicError("unsupported-control", "control was not applied")) : null,
          });
        } catch (error) {
          await this.#updateControl(runId, active, command.commandId, { state: error?.details?.uncertain ? "uncertain" : "rejected", error: compactError(error) });
        }
      }
    } catch (error) {
      if (error?.details?.kind === "lease-lost") {
        await this.#updateControl(runId, active, command.commandId, undeliveredControl());
        return;
      }
      await this.#updateControl(runId, active, command.commandId, { state: "rejected", error: compactError(error) }).catch(() => undefined);
    }
  }

  async #settleCrash(runId, active, error) {
    try {
      await this.#transact(runId, active, (record) => {
        record.state = "partial";
        record.recoveryRequired = true;
        record.lease = null;
        record.deadlineAt = null;
        record.completedAt = now();
        record.error = compactError(error);
        for (const call of record.calls) {
          if (INVOCATION_TERMINAL.has(call.state) || call.state === "invalidated") continue;
          call.state = "partial";
          setCallUncertainty(call, true);
          call.error ??= compactError(error);
        }
        return { record, journal: [
          ...this.#reconcilePendingControls(record),
          { type: "recovery", at: record.updatedAt, state: "partial", error: record.error },
        ] };
      });
    } catch { /* owner may already have settled */ }
  }

  async #settle(runId, active, { output, failure }) {
    // Truthful reconciliation before terminalizing: observe every in-flight
    // child's receipt, requesting cancellation once when it has not settled.
    // A child that acknowledges cancellation is cancelled, not "unknown".
    const observed = new Map();
    const snapshot = await this.store.readRun(runId).catch(() => null) ?? active.record;
    for (const call of [...(snapshot?.calls ?? [])]) {
      if (INVOCATION_TERMINAL.has(call.state) || call.state === "invalidated") continue;
      let receipt = await this.#lookup(call).catch(() => null);
      if (!receipt || !INVOCATION_TERMINAL.has(receipt.state)) {
        await this.#cancelChild(runId, active, call).catch(() => undefined);
        receipt = await this.#lookup(call).catch(() => null);
      }
      if (receipt && INVOCATION_TERMINAL.has(receipt.state)) {
        this.#observe(call, receipt, active.acknowledged.has(call.ordinal));
        observed.set(call.ordinal, call);
      }
    }
    let deferred = false;
    await this.#transact(runId, active, (record) => {
      // A restart may have been accepted while this settle was reconciling:
      // keep the run active and let the owner replay the suffix. `restartPass`
      // covers a restart whose abort landed after the pass-end check.
      if ((active.replayAfterSettle || active.restartPass) && !active.stopRequested && !RUN_TERMINAL.has(record.state)) {
        deferred = true;
        return null;
      }
      for (const [ordinal, call] of observed) {
        const live = this.#ensureCall(record, call);
        const wasInvalidated = Boolean(live.invalidated);
        // A reconciliation observation can be older than the live record for
        // progress-only fields; never erase a recorded delivery order.
        if (live.deliverySeq != null && call.deliverySeq == null && call.state === "completed") call.deliverySeq = live.deliverySeq;
        Object.assign(live, call);
        if (wasInvalidated) {
          live.invalidated = true;
          live.state = "invalidated";
          live.uncertain = false;
          live.deliverySeq = null;
        }
      }
      const cancelled = Boolean(record.cancellation);
      const reason = record.cancellation?.reason ?? null;
      const unhealthy = record.calls.some((call) => call.state !== "completed");
      let state;
      if (cancelled && reason !== "timeout") state = "cancelled";
      else if (failure) state = "partial";
      else if (unhealthy) state = "partial";
      else state = "completed";
      record.waitingFor = null;
      record.state = state;
      record.completedAt = now();
      record.deadlineAt = null;
      record.lease = null;
      record.error = failure ? compactError(failure) : null;
      // Script output and execution health are separate: a partial run still
      // exposes the value the script produced.
      record.output = output ?? null;
      if (record.cancellation) record.cancellation.state = record.calls.some((call) => call.uncertain) ? "unacknowledged" : "acknowledged";
      for (const call of record.calls) {
        if (INVOCATION_TERMINAL.has(call.state) || call.state === "invalidated") continue;
        call.state = "partial";
        setCallUncertainty(call, true);
        call.error ??= compactError(failure ?? dynamicError("interrupted", "run settled before the call reported"));
      }
      record.progress = null;
      return { record, journal: [
        ...this.#reconcilePendingControls(record),
        { type: "settled", at: record.updatedAt, state, error: record.error },
      ] };
    }).catch(async (error) => { if (error?.details?.kind !== "lease-lost") throw error; });
    if (deferred) return true;
    active.settleDone = true;
    clearInterval(active.poller);
    active.stopped = true;
    return false;
  }

  // ---- reconciliation and replay -------------------------------------------

  async #lookup(call) {
    try {
      if (call.jobId) return await this.companion.status(call.jobId);
      if (call.requestId) return await this.companion.statusByRequestId(call.requestId);
      return null;
    } catch (error) {
      if (error.code === "ENOENT" || error.details?.kind === "not-found") return null;
      throw error;
    }
  }

  #observe(call, receipt, cancellationAcknowledged = false) {
    call.jobId = receipt.jobId ?? call.jobId;
    call.sessionId = receipt.sessionId ?? call.sessionId;
    if (receipt.trace?.progress && bytes(receipt.trace.progress) <= 8_000) call.progress = receipt.trace.progress;
    const attempt = call.attempts.at(-1);
    if (attempt) { attempt.jobId = call.jobId; attempt.sessionId = call.sessionId; attempt.state = receipt.state; }
    if (!INVOCATION_TERMINAL.has(receipt.state)) return;
    call.state = receipt.state;
    setCallUncertainty(call, !(cancellationAcknowledged && receipt.state === "cancelled") && uncertainReceipt(receipt));
    call.error = receipt.error ? compactError(receipt.error) : null;
    call.value = receipt.state === "completed" ? (receipt.result ?? null) : null;
    const target = receipt.target ?? call.target;
    call.usageSummary = receipt.usageSummary === undefined && target !== "opencode"
      ? summarizeUsage(target, receipt.usage ?? null)
      : receipt.usageSummary ?? null;
    call.completedAt = receipt.completedAt ?? now();
    if (attempt) {
      attempt.completedAt = call.completedAt;
      attempt.usageSummary = call.usageSummary;
    }
    enforceOutputSchema(call);
  }

  async #reconcile(runId, active, record) {
    const uncertain = [];
    const normalized = [];
    for (const call of record.calls) {
      if (call.state === "completed" || call.state === "invalidated") continue;
      if (!call.requestId) {
        if (call.state === "running") uncertain.push(call);
        continue;
      }
      const receipt = await this.#lookup(call);
      if (receipt) {
        this.#observe(call, receipt);
        if (!INVOCATION_TERMINAL.has(receipt.state)) { call.state = "running"; call.adopted = true; }
        else if (call.state === "completed" && call.deliverySeq == null) call.deliverySeq = ++active.deliverySeq;
        continue;
      }
      // No receipt for a deterministic request id means the intent provably
      // never reached dispatch (the job store registers the id before any
      // child can exist). Relaunching the same id is deduplicated, so this is
      // safe and keeps committed work moving; the never-started attempt is
      // resumed rather than counted twice.
      call.state = "pending";
      call.jobId = null;
      setCallUncertainty(call, false);
      const lastAttempt = call.attempts.at(-1);
      if (lastAttempt && !lastAttempt.jobId) {
        lastAttempt.startedAt = null;
        lastAttempt.state = "prepared";
        lastAttempt.completedAt = null;
      }
      normalized.push(call);
    }
    if (normalized.length) {
      // Persist the normalization: later reuse transactions re-read the record
      // from disk and would otherwise see the stale pre-reconcile intents.
      await this.#transact(runId, active, (current) => {
        for (const call of normalized) Object.assign(this.#ensureCall(current, call), call);
        return { record: current, journal: [{ type: "reconcile", at: current.updatedAt, calls: normalized.map((call) => call.id) }] };
      }).catch(() => undefined);
    }
    return uncertain;
  }

  async #invalidateFrom(runId, active, ordinal) {
    let terminal = false;
    await this.#transact(runId, active, (record) => {
      if (RUN_TERMINAL.has(record.state)) { terminal = true; return null; }
      let touched = false;
      for (const call of record.calls) {
        if (call.ordinal < ordinal || call.invalidated) continue;
        call.invalidated = true;
        call.deliverySeq = null;
        call.state = "invalidated";
        touched = true;
      }
      // Durable suffix checkpoint: a crash before every per-call flag lands
      // still knows the replay boundary, while calls before this ordinal (the
      // concurrent prefix) remain reusable. Set even when no call exists yet
      // at this ordinal so the replay boundary survives the crash.
      record.invalidatedFrom = Math.min(record.invalidatedFrom ?? ordinal, ordinal);
      return touched ? { record, journal: [{ type: "invalidate", at: record.updatedAt, from: ordinal }] } : null;
    });
    return !terminal;
  }

  async #phase(runId, active, title) {
    if (typeof title !== "string" || !title.trim() || title.length > 120) throw dynamicError("validation", "phase title must be a nonempty string of at most 120 characters");
    const trimmed = title.trim();
    await this.#transact(runId, active, (record) => {
      const known = record.phases.some((phase) => (phase.title ?? phase) === trimmed);
      if (known && record.progress?.phase === trimmed) return null;
      if (!known) record.phases.push({ title: trimmed, ordinal: record.phases.length, firstAt: now() });
      record.progress = this.#progress(record, trimmed);
      return { record, journal: known ? [] : [{ type: "phase", at: record.updatedAt, title: trimmed }] };
    });
    active.phase = trimmed;
  }

  async #log(runId, active, message) {
    if (typeof message !== "string") throw dynamicError("validation", "log message must be a string");
    await this.#transact(runId, active, (record) => {
      record.logCount = (record.logCount ?? 0) + 1;
      record.lastLogAt = now();
      return { record, journal: [{ type: "log", at: record.updatedAt, message: compactText(message, 500) }] };
    });
  }

  #progress(record, phase = null) {
    const counts = invocationCounts(record);
    return {
      phase: phase ?? record.progress?.phase ?? null,
      calls: counts,
      active: counts.running,
      dispatchCount: record.dispatchCount ?? 0,
    };
  }

  #newCall(ordinal, effective, phase) {
    return {
      id: invocationIdFor(ordinal),
      ordinal,
      label: effective.label,
      phase: phase ?? null,
      state: "pending",
      fingerprint: null,
      target: null,
      route: {},
      routingDecision: null,
      cwd: effective.cwd,
      writer: effective.policy.write,
      requestId: null,
      jobId: null,
      sessionId: null,
      attempts: [],
      usageSummary: null,
      progress: null,
      error: null,
      value: null,
      deliverySeq: null,
      reused: false,
      invalidated: false,
      adopted: false,
      uncertain: false,
      startedAt: null,
      completedAt: null,
    };
  }

  // Replay delivery must preserve the recorded settle order for concurrent
  // callbacks (Promise.race and friends) without any timing guess. The engine
  // reports quiescence via onIdle only after every host microtask turn has
  // dispatched its onAgent callbacks, so by then all cached deliveries the
  // script will request for this turn are queued. A cached call that arrives
  // after a higher sequence already resolved cannot be ordered
  // deterministically: fail closed instead of guessing.
  async #deliver(active, seq, value) {
    if (seq === null || seq === undefined) throw dynamicError("non-replayable", "a reused call is missing its recorded delivery order; refusing to guess");
    active.reuseDelivered += 1;
    return new Promise((resolve, reject) => {
      active.delivery.push({ seq, value, resolve, reject });
      this.#maybeFlushDeliveries(active);
    });
  }

  #maybeFlushDeliveries(active) {
    // Flush only a complete turn batch: the guest has quiesced, every reuse
    // decision of this pass has enqueued its delivery, and no preflight is
    // still running. This makes the ascending resolve order deterministic.
    if (active.pumping || !active.idleSignaled || active.inflightPreflights > 0
      || active.reuseDelivered !== active.reuseExpected || !active.delivery.length) return;
    active.idleSignaled = false;
    this.#pumpDelivery(active);
  }

  // Pass-end drain: cached deliveries the guest never awaited are resolved in
  // recorded order; an undelivered reuse decision or out-of-order arrival
  // fails closed instead of guessing.
  #drainDeliveries(active) {
    if (active.reuseDelivered !== active.reuseExpected) {
      active.replayFailure = active.replayFailure ?? dynamicError("non-replayable", "a reused call never produced its cached delivery; refusing to guess");
      return;
    }
    if (!active.delivery.length) return;
    this.#pumpDelivery(active);
  }

  #pumpDelivery(active) {
    active.pumping = true;
    const step = () => {
      if (!active.delivery.length) { active.pumping = false; return; }
      active.delivery.sort((left, right) => left.seq - right.seq);
      const next = active.delivery.shift();
      if (active.resolvedDeliverySeq !== null && active.resolvedDeliverySeq !== undefined && next.seq < active.resolvedDeliverySeq) {
        const error = dynamicError("non-replayable", "replay callbacks settled in an order that cannot be reproduced deterministically");
        active.replayFailure = error;
        next.reject(error);
      } else {
        active.resolvedDeliverySeq = next.seq;
        next.resolve(next.value);
      }
      // Resolve the next cached delivery on a later macrotask so no racing
      // callback can observe a higher delivery sequence first.
      setImmediate(step);
    };
    step();
  }

  // Prefix-warming: hold matching siblings behind the first member of the
  // group until it emits its first meaningful response, settles, or the
  // prefix stagger budget elapses. Mismatched routes/context never share a
  // gate because the gate key is the invocation fingerprint minus
  // prompt/label. Gate creation and opening are recorded durably so a crash
  // cannot claim a warming delay it never held.
  async #awaitWarming(runId, active, call, key) {
    const staggerMs = active.spec?.execution?.prefixStaggerMs ?? 0;
    if (!(staggerMs > 0)) return;
    const existing = active.warming.get(key);
    if (existing) {
      if (!existing.opened) await Promise.race([existing.gate.wait(), wait(staggerMs)]);
      return;
    }
    const entry = { opened: false, gate: new Gate(), timer: null, key, leaderOrdinal: call.ordinal };
    if (active.warming.size >= MAX_WARMING_KEYS) active.warming.clear();
    active.warming.set(key, entry);
    await this.#recordWarming(runId, active, {
      key, leaderOrdinal: call.ordinal, startedAt: now(), openedAt: null, openedBy: null,
    });
    entry.timer = setTimeout(() => { void this.#openWarming(runId, active, key, "cap"); }, staggerMs);
    if (entry.timer.unref) entry.timer.unref();
  }

  async #recordWarming(runId, active, entry) {
    await this.#transact(runId, active, (record) => {
      record.warming ??= [];
      const prior = record.warming.findIndex((item) => item.key === entry.key);
      if (prior >= 0) {
        if (!record.warming[prior].openedAt && entry.openedAt) record.warming[prior] = { ...record.warming[prior], ...entry };
        else return null;
      } else {
        if (record.warming.length >= MAX_WARMING_KEYS) record.warming.shift();
        record.warming.push(entry);
      }
      return { record, journal: [{ type: "warming", at: record.updatedAt, key: entry.key, openedBy: entry.openedBy ?? null }] };
    }).catch(() => undefined);
  }

  async #resetWarming(runId, active) {
    active.warming.clear();
    await this.#transact(runId, active, (record) => {
      if (!(record.warming ?? []).length) return null;
      record.warming = [];
      return { record };
    }).catch(() => undefined);
  }

  async #openWarming(runId, active, key, reason) {
    const entry = key ? active.warming.get(key) : null;
    if (!entry || entry.opened) return;
    entry.opened = true;
    if (entry.timer) clearTimeout(entry.timer);
    entry.gate.open();
    await this.#recordWarming(runId, active, {
      key, leaderOrdinal: entry.leaderOrdinal, startedAt: entry.startedAt ?? null, openedAt: now(), openedBy: reason,
    });
  }

  // First meaningful response: a real adapter progress event on the child's
  // trace. Lifecycle/state/heartbeat events do not count.
  async #meaningfulProgress(receipt) {
    const store = this.companion?.store;
    if (!receipt?.jobId || typeof store?.readTrace !== "function") return false;
    const page = await store.readTrace(receipt.jobId, { limit: 10 }).catch(() => null);
    return Boolean(page?.events?.some((entry) => entry?.event?.type === "progress"));
  }

  #agent(runId, active, prompt, options) {
    active.callsInitiated += 1;
    active.inflightPreflights += 1;
    const previous = active.preflightTail ?? Promise.resolve();
    let release;
    active.preflightTail = new Promise((resolve) => { release = resolve; });
    let finished = false;
    const onPreflightDone = () => {
      if (finished) return;
      finished = true;
      active.inflightPreflights -= 1;
      release();
      active.preflightGate.open();
      this.#maybeFlushDeliveries(active);
    };
    let promise;
    try {
      promise = this.#agentInner(runId, active, prompt, options, onPreflightDone, previous);
    } catch (error) {
      onPreflightDone();
      throw error;
    }
    // The preflight boundary is reported from inside (before awaiting a
    // cached delivery); this backstop covers error paths that never reach it.
    promise.then(onPreflightDone, onPreflightDone);
    active.callbacks?.add(promise);
    promise.then(() => active.callbacks?.delete(promise), () => active.callbacks?.delete(promise));
    return promise;
  }

  async #agentInner(runId, active, prompt, options, onPreflightDone, previous) {
    const ordinal = active.callOrdinal++;
    if (active.passEnded) { onPreflightDone(); return null; }
    const spec = active.spec;
    const root = this.#rootOptions(spec);
    const phase = active.phase;
    let effective;
    try {
      effective = await normalizeAgentOptions(prompt, options, { ordinal, root });
    } catch (error) {
      await previous;
      await this.#recordRejected(runId, active, ordinal, error, phase);
      throw error;
    }
    let resolved;
    let resolutionError;
    try { resolved = await this.#resolveCall(runId, active, effective, ordinal, phase); }
    catch (error) { resolutionError = error; }
    // Only replay decisions require ordinal serialization. Filesystem and
    // route validation can finish concurrently without changing call identity.
    await previous;
    if (active.passEnded) { onPreflightDone(); return null; }
    const record = active.record;
    const call = record.calls.find((item) => item.ordinal === ordinal)
      ?? (() => { const created = this.#newCall(ordinal, effective, phase); record.calls.push(created); return created; })();
    call.label = effective.label;
    call.cwd = effective.cwd;
    call.writer = effective.policy.write;

    if (resolutionError) {
      call.target = effective.target;
      call.state = "failed";
      call.error = compactError(resolutionError);
      await this.#persistCall(runId, active, call);
      return null;
    }

    const fingerprintInput = { ...effective, target: resolved.target, route: resolved.route, phase };
    const fingerprint = invocationFingerprint(fingerprintInput);
    const prior = record.calls.find((item) => item.ordinal === ordinal);
    const suffixInvalidated = Number.isInteger(active.record.invalidatedFrom) && ordinal >= active.record.invalidatedFrom;
    // Older records stored the phase separately from the fingerprint.
    const reusable = prior && prior.state === "completed" && !prior.invalidated && !prior.uncertain && !suffixInvalidated
      && (prior.phase ?? null) === phase
      && (prior.fingerprint === fingerprint
        || (phase !== null && prior.fingerprint === invocationFingerprint({ ...fingerprintInput, phase: null })));
    if (reusable) {
      if (enforceOutputSchema(prior, effective.schema)) {
        prior.schema = effective.schema;
        await this.#persistCall(runId, active, prior);
        await this.#invalidateFrom(runId, active, ordinal + 1);
        return null;
      }
      active.reuseExpected += 1;
      await this.#transact(runId, active, (current) => {
        const target = current.calls.find((item) => item.ordinal === ordinal);
        if (!target) return null;
        target.reused = true;
        return { record: current, journal: [{ type: "reuse", at: current.updatedAt, ordinal, requestId: target.requestId }] };
      }).catch(() => undefined);
      // Enqueue the cached delivery BEFORE reporting the preflight complete so
      // a sibling's completion cannot flush a partial batch and resolve a
      // higher delivery sequence first.
      const delivery = this.#deliver(active, prior.deliverySeq, prior.value ?? null);
      onPreflightDone();
      return delivery;
    }
    // The ordered prefix ends here: a failed/partial/changed call invalidates
    // reuse of every later call while the concurrent prefix (lower ordinals)
    // stays cached. A never-dispatched intent (prepared/pending) is the same
    // attempt resumed and must not invalidate anything.
    const resumeIntent = prior && !prior.invalidated && (prior.state === "prepared" || prior.state === "pending");
    if (prior && !prior.invalidated && !resumeIntent) {
      await this.#invalidateFrom(runId, active, ordinal);
    } else if (suffixInvalidated && prior && !prior.invalidated) {
      await this.#invalidateFrom(runId, active, ordinal);
    }

    // Live child adopted during reconciliation: await it instead of dispatching.
    if (prior?.adopted && prior.state === "running") {
      onPreflightDone();
      const outcome = await this.#awaitChild(runId, active, prior);
      return await this.#finalizeCall(runId, active, prior, outcome, effective.schema);
    }

    onPreflightDone();
    return this.#dispatchCall(runId, active, effective, { ordinal, phase, resolved, fingerprint });
  }

  async #recordRejected(runId, active, ordinal, error, phase) {
    const record = active.record;
    if (!record) return;
    if (!record.calls.some((call) => call.ordinal === ordinal)) {
      record.calls.push({ ...this.#newCall(ordinal, { label: `call ${ordinal}`, cwd: active.spec.cwd, policy: active.spec.policy }, phase), state: "failed", error: compactError(error) });
    }
    await this.#transact(runId, active, (current) => {
      const call = current.calls.find((item) => item.ordinal === ordinal);
      if (!call) return null;
      call.state = "failed";
      call.error = compactError(error);
      return { record: current, journal: [{ type: "call", at: current.updatedAt, ordinal, state: "failed" }] };
    }).catch(() => undefined);
  }

  async #persistCall(runId, active, call) {
    await this.#transact(runId, active, (record) => {
      const target = this.#ensureCall(record, call);
      Object.assign(target, call);
      record.progress = this.#progress(record);
      return { record, journal: [{ type: "call", at: record.updatedAt, ordinal: call.ordinal, state: call.state }] };
    }).catch(() => undefined);
  }

  async #resolveCall(runId, active, effective, ordinal, phase) {
    const spec = active.spec;
    const requested = effective.target ?? spec.target;
    const automatic = requested === null || requested === "auto";
    const baseTarget = automatic ? "pi" : requested;
    const remaining = Math.max(1, (active.record.deadlineAt ?? this.clock() + 60_000) - this.clock());
    const timeoutMs = Math.max(1, Math.min(effective.execution.timeoutMs ?? remaining, remaining));
    const context = { ...effective.context, dynamic: {
      runId, ordinal, label: effective.label, phase,
      ...(effective.schema == null ? {} : { outputSchema: effective.schema }),
    } };
    const base = normalizeRequest({
      requestId: childRequestIdFor(runId, ordinal, 1),
      target: baseTarget,
      task: effective.prompt,
      cwd: effective.cwd,
      context,
      metadata: effective.metadata,
      policy: effective.policy,
      route: effective.route,
      execution: { background: true, timeoutMs, ...(effective.execution?.transport ? { transport: effective.execution.transport } : {}) },
    });
    if (automatic) base.metadata = { ...base.metadata, routing: { ...base.metadata.routing, mode: "auto" } };
    const resolved = normalizeRequest(await this.companion.routeResolver(base));
    if (resolved.requestId !== base.requestId || resolved.contextDigest !== base.contextDigest || resolved.task !== base.task) throw dynamicError("identity", "route resolver changed request identity");
    if (resolved.cwd !== base.cwd) throw dynamicError("validation", "route resolver changed the prevalidated cwd");
    if (resolved.execution.timeoutMs !== base.execution.timeoutMs) throw dynamicError("validation", "route resolver changed the requested timeout");
    if (!automatic && resolved.target !== base.target) throw dynamicError("routing", "route resolver changed an explicit target");
    for (const [key, value] of Object.entries(base.route)) if (resolved.route[key] !== value) throw dynamicError("routing", `route resolver changed an explicit route.${key}`);
    if (automatic && resolved.target === "acp" && !resolved.route.agent) throw dynamicError("routing", "automatic call has no usable agent route");
    if (automatic && !["acp", "amp"].includes(resolved.target) && !resolved.route.model) throw dynamicError("routing", "automatic call has no usable model route");
    assertDynamicLeaf(resolved);
    if (resolved.workflow != null) throw dynamicError("policy", "route resolver added a workflow");
    if (stablePolicy(resolved.policy) !== stablePolicy(base.policy)) throw dynamicError("policy", "route resolver changed the call policy");
    // Session transport: dynamic children targeting an interactive-capable
    // harness request the session mode unless the call pinned one-shot. The
    // core selects/pools the native session; the runner only carries the flag.
    const requestedTransport = effective.execution?.transport;
    const transport = requestedTransport ?? (SESSION_TARGETS.has(resolved.target) ? "session" : null);
    if (transport) {
      base.execution = { ...base.execution, transport };
      resolved.execution = { ...resolved.execution, transport };
    }
    return { base: resolved, target: resolved.target, route: resolved.route };
  }

  async #gate(runId, active) {
    for (;;) {
      if (active.stopRequested || active.passEnded) return false;
      if (this.clock() >= (active.record?.deadlineAt ?? Infinity)) return false;
      if (!active.paused) return true;
      await wait(this.pollIntervalMs);
    }
  }

  async #acquireWriter(active, call) {
    while (active.writers.some((entry) => cwdOverlaps(entry.cwd, call.cwd))) {
      await Promise.race([active.writerGate.wait(), wait(this.pollIntervalMs)]);
    }
    active.writers.push({ cwd: call.cwd, ordinal: call.ordinal });
  }

  #releaseWriter(active, call) {
    active.writers = active.writers.filter((entry) => entry.ordinal !== call.ordinal);
    active.writerGate.open();
  }

  async #dispatchCall(runId, active, effective, { ordinal, phase, resolved, fingerprint }) {
    const record = active.record;
    let call = record.calls.find((item) => item.ordinal === ordinal);
    if (!call) {
      call = this.#newCall(ordinal, effective, phase);
      record.calls.push(call);
    }
    // Attempt bookkeeping: a persisted intent that provably never started is
    // the same attempt resumed (deterministic requestId reuse); anything that
    // actually ran or was invalidated gets a fresh attempt and requestId.
    const last = call.attempts.at(-1);
    const resumeIntent = Boolean(last) && !last.startedAt && (call.state === "prepared" || call.state === "pending");
    // Legacy snapshots kept only the latest usage and assigned the phase on
    // the invocation. Preserve that evidence before replacing the intent.
    if (last && last.usageSummary === undefined) {
      last.usageSummary = call.target === "opencode" ? null : call.usageSummary ?? null;
    }
    if (last && call.uncertain) last.uncertain = true;
    for (const attempt of call.attempts) {
      if (attempt.phase === undefined) attempt.phase = call.phase ?? null;
    }
    const attemptNumber = resumeIntent ? last.attempt : (last?.attempt ?? 0) + 1;
    const requestId = resumeIntent ? last.requestId : childRequestIdFor(runId, ordinal, attemptNumber);
    call.fingerprint = fingerprint;
    call.phase = phase;
    call.target = resolved.target;
    call.route = resolved.route;
    call.routingDecision = resolved.metadata?.harnest?.routingDecision ?? null;
    call.requestId = requestId;
    call.invalidated = false;
    call.adopted = false;
    call.error = null;
    call.value = null;
    call.schema = effective.schema;
    call.deliverySeq = null;
    call.usageSummary = null;
    call.state = "prepared";
    call.startedAt = null;
    call.completedAt = null;
    if (resumeIntent) {
      last.state = "prepared";
      last.startedAt = call.startedAt;
      last.jobId = null;
      last.sessionId = null;
      last.completedAt = null;
      last.phase = phase;
      last.usageSummary = null;
    } else {
      call.attempts.push({ attempt: attemptNumber, requestId, phase, jobId: null, sessionId: null, state: "prepared", startedAt: call.startedAt, completedAt: null });
    }
    setCallUncertainty(call, false);
    if (!(await this.#commitIntent(runId, active, call))) return null;

    const allowed = await this.#gate(runId, active);
    if (!allowed) {
      call.state = active.stopRequested && active.record.cancellation?.reason === "timeout" ? "partial" : "cancelled";
      call.error = active.record.cancellation?.reason === "timeout" ? compactError(dynamicError("timeout", "run deadline exceeded before dispatch")) : null;
      call.completedAt = now();
      await this.#persistCall(runId, active, call);
      return null;
    }
    if (call.writer) await this.#acquireWriter(active, call);
    let retryAfterWait = false;
    try {
      await active.semaphore.acquire();
      try {
        // A last check under the semaphore so pause/stop that arrived while
        // queued does not dispatch anyway.
        if (active.stopRequested) throw dynamicError("cancelled", "run stopping before dispatch");
        const warming = (active.spec?.execution?.prefixStaggerMs ?? 0) > 0
          ? warmingKey({ ...effective, target: resolved.target, route: resolved.route })
          : null;
        await this.#awaitWarming(runId, active, call, warming);
        if (!(await this.#gate(runId, active))) throw dynamicError("cancelled", "script pass ended before dispatch");
        await this.#reserveDispatch(runId, active, call);
        // The attempt-scoped deterministic requestId is the dedup key; the
        // resolver ran against a probe id, so bind the real one here.
        const started = this.clock();
        const receipt = await this.companion.start({ ...resolved.base, requestId }, { routeResolved: true });
        const completion = this.companion.ownedCompletion?.(receipt.jobId) ?? null;
        this.#observe(call, receipt);
        if (!INVOCATION_TERMINAL.has(receipt.state)) call.state = "running";
        call.attempts.at(-1).jobId = call.jobId;
        call.attempts.at(-1).sessionId = call.sessionId;
        await this.#commitDispatch(runId, active, call, started);
        const outcome = await this.#awaitChild(runId, active, call, warming, completion);
        const wait = this.#usageLimitWait(active, call, outcome);
        if (wait) {
          await this.#finalizeCall(runId, active, call, outcome);
          retryAfterWait = await this.#waitForProvider(runId, active, call, wait);
          if (!retryAfterWait) return null;
        } else {
          return await this.#finalizeCall(runId, active, call, outcome);
        }
      } finally { active.semaphore.release(); }
    } catch (error) {
      const kind = error?.details?.kind;
      if (kind === "control-conflict" || kind === "request-conflict") {
        // The deterministic request already exists with different content.
        call.state = "partial";
        setCallUncertainty(call, true);
      } else if (kind === "cancelled" || active.stopRequested) {
        call.state = "cancelled";
      } else {
        // companion.start failed before any child existed, or persistence broke.
        call.state = kind === "persistence" || kind === "lease-lost" ? "partial" : "failed";
        setCallUncertainty(call, kind === "persistence");
      }
      call.error = compactError(error);
      call.completedAt = now();
      await this.#persistCall(runId, active, call).catch(() => undefined);
      if (kind === "limit") throw error;
      return null;
    } finally {
      if (call.writer) this.#releaseWriter(active, call);
    }
    if (retryAfterWait) return this.#dispatchCall(runId, active, effective, { ordinal, phase, resolved, fingerprint });
  }

  async #commitIntent(runId, active, call) {
    try {
      await this.#transact(runId, active, (record) => {
        Object.assign(this.#ensureCall(record, call), call);
        record.progress = this.#progress(record);
        return { record, journal: [{ type: "call", at: record.updatedAt, ordinal: call.ordinal, state: "prepared", requestId: call.requestId, fingerprint: call.fingerprint }] };
      });
      return true;
    } catch (error) {
      if (error?.details?.kind === "lease-lost") return false;
      throw error;
    }
  }

  #ensureCall(record, call) {
    let target = record.calls.find((item) => item.ordinal === call.ordinal);
    if (!target) { target = call; record.calls.push(target); }
    return target;
  }

  async #reserveDispatch(runId, active, call) {
    await this.#transact(runId, active, (record) => {
      if (active.stopRequested || active.passEnded || record.cancellation) throw dynamicError("cancelled", "run stopping before dispatch");
      const target = record.calls.find((item) => item.ordinal === call.ordinal);
      const attempt = target?.attempts.at(-1);
      if (attempt?.requestId !== call.requestId || target.invalidated) throw dynamicError("control-conflict", "child dispatch intent changed before launch");
      if (attempt.dispatchReserved) return null;
      const maxAgents = record.maxAgents ?? MAX_AGENT_CALLS;
      const dispatchCount = record.dispatchCount ?? 0;
      if (dispatchCount >= maxAgents) throw dynamicError("limit", `dynamic run exceeded ${maxAgents} child launches`);
      attempt.dispatchReserved = true;
      record.dispatchCount = dispatchCount + 1;
      record.progress = this.#progress(record);
      return { record, journal: [{ type: "dispatch-reserved", at: now(), ordinal: call.ordinal, requestId: call.requestId }] };
    });
    call.attempts.at(-1).dispatchReserved = true;
  }

  async #commitDispatch(runId, active, call, startedAt) {
    await this.#transact(runId, active, (record) => {
      const target = this.#ensureCall(record, call);
      Object.assign(target, call);
      target.attempts.at(-1).jobId = call.jobId;
      target.attempts.at(-1).sessionId = call.sessionId;
      target.attempts.at(-1).state = "running";
      target.startedAt = new Date(startedAt).toISOString();
      target.attempts.at(-1).startedAt = new Date(startedAt).toISOString();
      record.progress = this.#progress(record);
      return { record, journal: [{ type: "dispatch", at: record.updatedAt, ordinal: call.ordinal, requestId: call.requestId, jobId: call.jobId }] };
    });
  }

  async #awaitChild(runId, active, call, warmingKeyValue = null, completion = null) {
    // One completion subscriber for the whole wait; each tick replaces a
    // single cancellable waiter instead of adding another reaction.
    const childWait = completionWait(completion);
    for (;;) {
      const nativeId = this.companion.ownedSessionId?.(call.jobId);
      if (nativeId && nativeId !== call.sessionId) {
        await this.#transact(runId, active, (record) => {
          const current = record.calls.find((item) => item.ordinal === call.ordinal);
          if (!current || current.jobId !== call.jobId || current.state !== "running") return null;
          current.sessionId = nativeId;
          if (current.attempts.at(-1)) current.attempts.at(-1).sessionId = nativeId;
          return { record, journal: [{ type: "session", at: now(), ordinal: call.ordinal, jobId: call.jobId, sessionId: nativeId }] };
        });
        call.sessionId = nativeId;
      }
      if (active.restart.has(call.ordinal)) return { state: "invalidated", reason: "restart-agent" };
      if (active.stopCalls.has(call.ordinal)) {
        await this.#cancelChild(runId, active, call).catch(() => undefined);
        active.stopCalls.delete(call.ordinal);
      }
      if ((active.stopRequested || active.passEnded) && !active.childCancelRequested.has(call.ordinal)) await this.#cancelChild(runId, active, call).catch(() => undefined);
      if (completion && !childWait.settled) {
        if (warmingKeyValue && await this.#meaningfulProgress({ jobId: call.jobId })) await this.#openWarming(runId, active, warmingKeyValue, "progress");
        if (this.clock() >= (active.record?.deadlineAt ?? Infinity)) return { state: "partial", uncertain: true, error: dynamicError("timeout", "run deadline exceeded") };
        if (active.stopRequested && this.clock() - active.stopRequestedAt > this.cancelAckTimeoutMs + this.leaseTimeoutMs) return { state: "partial", uncertain: true, error: dynamicError("cancel-unacknowledged", "child stop has not been acknowledged") };
        // The single completion subscriber clears this tick's timer, so a
        // settled child is observed immediately; every guard above still runs
        // each iteration.
        await childWait.waitTick(this.pollIntervalMs);
        continue;
      }
      const receipt = completion ? childWait.receipt : await this.#lookup(call).catch(() => null);
      if (completion && receipt && !INVOCATION_TERMINAL.has(receipt.state)) completion = null;
      if (!receipt) return { state: "partial", uncertain: true, error: dynamicError("unknown", "child receipt could not be read") };
      if (warmingKeyValue && await this.#meaningfulProgress(receipt)) await this.#openWarming(runId, active, warmingKeyValue, "progress");
      if (INVOCATION_TERMINAL.has(receipt.state)) {
        if (warmingKeyValue) await this.#openWarming(runId, active, warmingKeyValue, "settled");
        return { state: receipt.state, receipt };
      }
      if (active.stopRequested && this.clock() - active.stopRequestedAt > this.cancelAckTimeoutMs + this.leaseTimeoutMs) {
        return { state: "partial", uncertain: true, receipt, error: dynamicError("cancel-unacknowledged", "child stop has not been acknowledged") };
      }
      if (this.clock() >= (active.record?.deadlineAt ?? Infinity)) return { state: "partial", uncertain: true, receipt, error: dynamicError("timeout", "run deadline exceeded") };
      await wait(this.pollIntervalMs);
    }
  }

  // Opt-in provider-limit waiting. Only a classified usage-limit with an
  // explicit reset time inside the original attempt deadline is waitable;
  // writes require recorded approval, and retries are bounded. Auth failures,
  // unknown resets and exhausted budgets fail as before.
  #usageLimitWait(active, call, outcome) {
    const policy = active.spec.execution.providerWait ?? this.providerWait;
    if (!policy || !outcome?.receipt || outcome.uncertain) return null;
    if (outcome.state === "completed") return null;
    const resetAt = usageLimitResetAt(outcome.receipt);
    if (resetAt === null || resetAt <= this.clock()) return null;
    const deadlineAt = active.record?.deadlineAt ?? 0;
    if (!(resetAt < deadlineAt)) return null;
    if (call.writer && !active.record?.approvedWrites) return null;
    const current = active.record?.calls.find((item) => item.ordinal === call.ordinal) ?? call;
    if ((current.waitWaits ?? 0) >= policy.maxRetries) return null;
    return { resetAt, provider: outcome.receipt.target ?? call.target ?? null };
  }

  async #waitForProvider(runId, active, call, limit) {
    const until = Math.min(limit.resetAt, active.record?.deadlineAt ?? limit.resetAt);
    await this.#transact(runId, active, (record) => {
      const live = this.#ensureCall(record, call);
      live.waitWaits = (live.waitWaits ?? 0) + 1;
      live.state = "running";
      live.jobId = null;
      const attempt = live.attempts.at(-1);
      if (attempt) { attempt.state = "failed"; attempt.completedAt = now(); }
      live.error = compactError(dynamicError("provider-limit", `provider usage limit reported; waiting until ${new Date(limit.resetAt).toISOString()}`, { resetAt: limit.resetAt, provider: limit.provider }));
      record.waitingFor = {
        callId: live.id, provider: limit.provider, reason: "provider-limit",
        resetAt: new Date(limit.resetAt).toISOString(), until: new Date(until).toISOString(), startedAt: now(),
      };
      record.state = "waiting";
      record.progress = { ...this.#progress(record), waitingFor: record.waitingFor };
      return { record, journal: [{ type: "waiting", at: record.updatedAt, callId: live.id, resetAt: record.waitingFor.resetAt }] };
    });
    while (this.clock() < until) {
      if (active.stopRequested || active.passEnded) break;
      await wait(Math.min(this.pollIntervalMs, Math.max(1, until - this.clock())));
    }
    const retry = !active.stopRequested && !active.passEnded;
    await this.#transact(runId, active, (record) => {
      record.waitingFor = null;
      if (!record.cancellation) record.state = "running";
      const live = this.#ensureCall(record, call);
      live.jobId = null;
      live.state = "running";
      record.progress = this.#progress(record);
      return { record, journal: [{ type: "resumed", at: record.updatedAt, callId: live.id, retry }] };
    }).catch(() => undefined);
    return retry;
  }

  async #finalizeCall(runId, active, call, outcome, schema = call.schema) {
    const record = active.record;
    const prior = record.calls.find((item) => item.ordinal === call.ordinal);
    const target = prior ?? call;
    if (schema != null) target.schema = schema;
    if (outcome.state === "invalidated") {
      target.state = "invalidated";
      target.invalidated = true;
      target.deliverySeq = null;
      target.completedAt = now();
      target.attempts.at(-1).state = "invalidated";
      target.attempts.at(-1).completedAt = target.completedAt;
    } else if (outcome.receipt && !outcome.uncertain) {
      this.#observe(target, outcome.receipt, active.acknowledged.has(target.ordinal));
    } else {
      target.state = outcome.uncertain ? "partial" : (outcome.state === "cancelled" ? "cancelled" : "failed");
      setCallUncertainty(target, outcome.uncertain);
      target.error = outcome.error ? compactError(outcome.error) : (target.error ?? null);
      target.value = null;
      target.completedAt = now();
      if (target.attempts.at(-1)) { target.attempts.at(-1).state = target.state; target.attempts.at(-1).completedAt = target.completedAt; }
    }
    if (target.state === "completed") target.deliverySeq = ++active.deliverySeq;
    target.progress = null;
    await this.#transact(runId, active, (current) => {
      const live = this.#ensureCall(current, target);
      // A restart-agent may have invalidated this call while its receipt was
      // being finalized; the invalidation must survive the late completion.
      const wasInvalidated = Boolean(live.invalidated);
      if (live.deliverySeq != null && target.deliverySeq == null && target.state === "completed") target.deliverySeq = live.deliverySeq;
      Object.assign(live, target);
      if (wasInvalidated) {
        live.invalidated = true;
        live.state = "invalidated";
        live.uncertain = false;
        live.deliverySeq = null;
      }
      addUsageToTotals(current.usageTotals, live.usageSummary);
      // Pause drains in-flight work: once the last running call settles with a
      // pause intent outstanding, the run is truthfully paused (not pausing).
      if (current.pause?.requested && !current.cancellation && current.state !== "stopping"
        && !current.calls.some((call) => call.state === "running")) current.state = "paused";
      current.progress = this.#progress(current);
      return {
        record: current,
        journal: [{ type: "call", at: current.updatedAt, ordinal: live.ordinal, state: live.state, jobId: live.jobId, deliverySeq: live.deliverySeq }],
      };
    }).catch(() => undefined);
    return target.value ?? null;
  }
}

function stablePolicy(policy) {
  return stableJson(policy);
}
