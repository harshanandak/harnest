import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { SessionAdapterPool } from "./session-pool.mjs";
import { hostname } from "node:os";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAdapter } from "./adapters/index.mjs";
import { createRouteResolver } from "./routing.mjs";
import { createModelCatalog } from "./model-catalog.mjs";
import { JobStore } from "./job-store.mjs";
import { EXECUTION_CONTROLS } from "./execution-controls.mjs";
import {
  MAX_MESSAGE_BYTES,
  TERMINAL_STATES,
  assertReceipt,
  createReceipt,
  normalizeRequest,
  stableJson,
  terminalReceipt,
} from "./protocol.mjs";
import {
  REVIEW_DEFAULT_THRESHOLD,
  REVIEW_MAX_LANES,
  REVIEW_MAX_ROUNDS,
  REVIEW_MIN_LANES,
  REVIEW_MIN_ROUNDS,
  boardView,
  consolidateFindings,
  newReviewNonce,
  normalizeReviewers,
  normalizeRubric,
  parseLaneResult,
  reviewId,
  reviewPrompt,
  tallyRound,
} from "./review.mjs";
import { BoardStore } from "./board.mjs";
import { mergeProcessEnv, redactSecrets } from "./process.mjs";
import { addUsageToTotals, emptyUsageTotals, summarizeUsage, usageSummaryHasValues } from "./usage.mjs";

// Bounded per-receipt attempt ledger: older entries collapse into
// `usageTotals`/`usageAttemptsDropped` so an unbounded resume/failover chain
// cannot grow the receipt without limit.
const MAX_USAGE_ATTEMPTS = 20;
const MAX_NATIVE_SESSION_ID_LENGTH = 1_000;

// Canonical usage evidence. OpenCode progress carries a zero-initialized
// accumulator, so only its explicit `usageReported` map confirms keys; hosts
// that null absent fields can be summarized directly. A summary with no
// reported metric is null, never an invented zero.
function confirmedUsageSummary(target, event) {
  if (!event || typeof event !== "object") return null;
  const reported = event.usageReported;
  if (reported && typeof reported === "object" && !Array.isArray(reported)) {
    const summary = summarizeUsage(target, event.usage, { reported });
    return usageSummaryHasValues(summary) ? summary : null;
  }
  if (usageSummaryHasValues(event.usageSummary)) return event.usageSummary;
  if (target === "opencode") return null;
  const summary = summarizeUsage(target, event.usage, { reported: null });
  return usageSummaryHasValues(summary) ? summary : null;
}

function safeNativeSessionId(value) {
  if (typeof value !== "string") return null;
  if (!value.trim() || value.length > MAX_NATIVE_SESSION_ID_LENGTH) return null;
  return redactSecrets(value) === value ? value : null;
}

function hasUnsafeCleanup(error) {
  const details = error?.details;
  return Boolean(details?.unsafeResume || (Array.isArray(details?.cleanupError) && details.cleanupError.length));
}

function safeError(error) {
  const redact = (value) => redactSecrets(String(value || "")).slice(0, 4_000);
  const sessionId = safeNativeSessionId(error?.details?.sessionId);
  const cleanupError = Array.isArray(error?.details?.cleanupError)
    ? error.details.cleanupError.slice(0, 10).map((item) => ({
      component: redact(item?.component).slice(0, 100),
      message: redact(item?.message ?? item).slice(0, 500),
    }))
    : null;
  return {
    name: error?.name || "Error",
    message: redact(error?.message || error),
    details: error?.details
        ? {
          kind: error.details.kind ?? null,
          aborted: Boolean(error.details.aborted),
          timedOut: Boolean(error.details.timedOut),
          code: error.details.code ?? null,
          signal: error.details.signal ?? null,
          stderr: redact(error.details.stderr),
          stdout: redact(error.details.stdout),
          stdoutBytes: error.details.stdoutBytes ?? null,
          stderrBytes: error.details.stderrBytes ?? null,
          stdoutTruncated: Boolean(error.details.stdoutTruncated),
          stderrTruncated: Boolean(error.details.stderrTruncated),
          uncertain: Boolean(error.details.uncertain),
          unsafeResume: Boolean(error.details.unsafeResume || cleanupError?.length),
          cleanupError,
          ...(sessionId ? { sessionId } : {}),
          ...(typeof error.details.resetAt === "string" && /^\d{4}-\d{2}-\d{2}T/.test(error.details.resetAt) && Number.isFinite(Date.parse(error.details.resetAt)) ? { resetAt: new Date(error.details.resetAt).toISOString() } : {}),
          warnings: Array.isArray(error.details.warnings) ? error.details.warnings.slice(0, 10).map((warning) => redact(warning).slice(0, 500)) : [],
          execution: error.details.execution ? {
            effectivePolicy: {
              write: typeof error.details.execution.effectivePolicy?.write === "boolean" ? error.details.execution.effectivePolicy.write : null,
              mode: redact(error.details.execution.effectivePolicy?.mode).slice(0, 100),
            },
            launchFlags: Array.isArray(error.details.execution.launchFlags) ? error.details.execution.launchFlags.slice(0, 30).map((flag) => redact(flag).slice(0, 100)) : [],
          } : null,
          hint: typeof error.details.hint === "string" ? redact(error.details.hint).slice(0, 500) : null,
        }
      : null,
  };
}

const HEARTBEAT_INTERVAL_MS = 10_000;
const STALE_HEARTBEAT_MS = 60_000;
const STALL_WARNING_MS = 300_000;
// A queued detached job whose worker died before the fenced claim has no lease
// to expire. After this claim window, status() re-dispatches it a bounded
// number of times, then settles it as unclaimed instead of leaving it queued
// forever.
const QUEUED_CLAIM_TIMEOUT_MS = 60_000;
const MAX_DISPATCH_ATTEMPTS = 3;

function activityFrom(event) {
  const value = event?.text ?? event?.phase ?? event?.state ?? event?.type ?? "progress";
  return String(value).replace(/\s+/g, " ").trim().slice(0, 500) || "progress";
}

function traceView(job) {
  return {
    ref: job.receipt.trace?.ref || `job:${job.receipt.jobId}:events`,
    eventCount: job.trace?.eventCount || 0,
    lastEventAt: job.trace?.lastEventAt || null,
    lastActivity: job.trace?.lastActivity || null,
    progress: job.trace?.progress || job.receipt.trace?.progress || null,
  };
}

function recoveryView(job, overrides = {}) {
  return {
    lookupKey: job.request.requestId,
    canResume: false,
    heartbeatAt: job.lease?.heartbeatAt || null,
    ...(job.receipt.recovery || {}),
    ...overrides,
  };
}

// A canary counts as emitted only when a result line is exactly the value or
// "RESULT: <value>". Text that merely quotes the token — for example a refusal
// that names it — must not satisfy the contract.
function collectResultLines(value, lines = []) {
  if (typeof value === "string") lines.push(...value.split(/\r?\n/).map((line) => line.trim()));
  else if (Array.isArray(value)) for (const item of value) collectResultLines(item, lines);
  else if (value && typeof value === "object") for (const item of Object.values(value)) collectResultLines(item, lines);
  return lines;
}

function lineMatchesCanary(line, value) {
  if (line === value) return true;
  const prefixed = line.replace(/^RESULT\s*:/i, "").trim();
  return prefixed !== line && prefixed === value;
}

function assertCompletionContract(request, output) {
  const result = output?.result;
  const requiredFields = Array.isArray(request.context?.requiredResultFields)
    ? request.context.requiredResultFields.filter((field) => typeof field === "string")
    : [];
  const missing = requiredFields.filter((field) => {
    const value = result?.[field];
    if (Array.isArray(value)) return value.length === 0;
    if (typeof value === "string") return !value.trim();
    return value == null;
  });
  const requiredText = Array.isArray(request.context?.requiredText)
    ? request.context.requiredText
      .filter((value) => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean)
    : [];
  const lines = collectResultLines(result);
  const absentText = requiredText.filter((value) => !lines.some((line) => lineMatchesCanary(line, value)));
  if (missing.length || absentText.length) {
    throw Object.assign(new Error([
      missing.length ? `missing non-empty result fields: ${missing.join(", ")}` : "",
      absentText.length ? `missing required result text: ${absentText.join(", ")}` : "",
    ].filter(Boolean).join("; ")), {
      name: "CompletionContractError",
      details: { kind: "completion-contract", missingFields: missing, missingText: absentText },
    });
  }
}

function requestIdentity(value) {
  return stableJson({
    target: value.target,
    task: value.task,
    cwd: value.cwd,
    contextDigest: value.contextDigest,
    workflow: value.workflow,
    route: value.route,
    policy: value.policy,
  });
}

function comparisonRouteIdentity(request) {
  const route = { ...request.route };
  if (request.target === "opencode" && typeof route.model === "string") {
    if (route.provider && route.model.startsWith(`${route.provider}/`)) {
      route.model = route.model.slice(route.provider.length + 1);
    } else if (!route.provider && route.model.includes("/")) {
      const separator = route.model.indexOf("/");
      route.provider = route.model.slice(0, separator);
      route.model = route.model.slice(separator + 1);
    }
  }
  return stableJson({ target: request.target, route });
}

function normalizeControl(input, kind) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw Object.assign(new TypeError("control must be an object"), { details: { kind: "validation" } });
  if (typeof input.commandId !== "string" || !input.commandId.trim()) throw Object.assign(new TypeError("commandId is required"), { details: { kind: "validation" } });
  const delivery = input.delivery || "steer";
  if (!["steer", "follow_up"].includes(delivery)) throw Object.assign(new TypeError("delivery must be steer or follow_up"), { details: { kind: "validation" } });
  if (kind === "message" && (typeof input.message !== "string" || !input.message.trim())) {
    throw Object.assign(new TypeError("message is required"), { details: { kind: "validation" } });
  }
  if (typeof input.message === "string" && Buffer.byteLength(input.message, "utf8") > MAX_MESSAGE_BYTES) {
    throw Object.assign(new TypeError(`message exceeds ${MAX_MESSAGE_BYTES} bytes; send guidance in smaller steering steps`), { details: { kind: "validation" } });
  }
  if (kind === "reroute") {
    if (!input.route || typeof input.route !== "object") throw Object.assign(new TypeError("route is required"), { details: { kind: "validation" } });
    if (typeof input.route.provider !== "string" || !input.route.provider.trim()) {
      throw Object.assign(new TypeError("route.provider is required"), { details: { kind: "validation" } });
    }
    if (typeof input.route.model !== "string" || !input.route.model.trim()) {
      throw Object.assign(new TypeError("route.model is required"), { details: { kind: "validation" } });
    }
  }
  return {
    commandId: input.commandId.trim(),
    kind,
    delivery,
    message: typeof input.message === "string" && input.message.trim() ? input.message.trim() : null,
    route: kind === "reroute" ? { ...input.route } : null,
  };
}

function controlIdentity(control) {
  return stableJson({
    kind: control.kind,
    delivery: control.delivery,
    message: control.message,
    route: control.route,
  });
}

// Ordered failover for read-only runs only. A write-capable retry on another
// harness could duplicate side effects, so write requests never fall back.
// Eligible failures are transport (harness missing/unreachable), wall-clock
// timeout, explicit provider failures (provider-auth: rejected/missing
// authorization or region opt-in; unavailable: missing catalog/private-server
// model), and — read-only only — task failure itself ("stuck here, try the
// next harness"): a read-only retry cannot mutate anything, it only spends
// tokens, and it is capped at one. Never: cancellation, policy/validation
// rejections, budget exhaustion, or persistence/lease loss.
function nextFallbackRoute(job, error, state = {}) {
  if (job.request.policy.write) return null;
  if (job.request.metadata?.routing?.fallbacks === false) return null;
  if (state.persistenceFailure || state.cancelled) return null;
  if ((job.receipt.routingFallbacks || []).length > 0) return null;
  const kind = error?.details?.kind;
  const timedOut = Boolean(state.attemptTimedOut) || error?.details?.timedOut || kind === "timeout";
  const transport = kind === "transport";
  const stuck = kind === "downstream" || kind === "completion-contract";
  const providerFailure = kind === "provider-auth" || kind === "unavailable";
  if (!timedOut && !transport && !stuck && !providerFailure) return null;
  const ranked = job.request.metadata?.harnest?.routingDecision?.rankedRoutes;
  if (!Array.isArray(ranked) || ranked.length < 2) return null;
  const selected = job.request.metadata?.harnest?.routingDecision?.selected;
  // Prefer candidate-id position: the request route may carry post-policy
  // resolver fields, so route-JSON equality can misidentify the current lane.
  // Fall back to route equality only when the selected id is absent (e.g. a
  // resolver overrode the route after the policy decision).
  const selectedIndex = ranked.findIndex((entry) => entry?.id === selected);
  const ordered = selectedIndex >= 0 ? ranked.slice(selectedIndex + 1) : ranked;
  const current = { target: job.request.target, route: job.request.route };
  const sameRoute = (entry) => entry.target === current.target
    && stableJson(entry.route) === stableJson(current.route);
  return ordered.find((entry) => entry
    && typeof entry.target === "string"
    && entry.route
    && typeof entry.route === "object"
    && (entry.target === current.target || !EXECUTION_CONTROLS.some((field) => job.request.execution[field] !== undefined))
    && !sameRoute(entry)) || null;
}

// How to steer this job right now: live controls only exist on RUNNING
// Pi / OpenCode-V2 runs (a queued job has no adapter/RPC channel yet, so it
// reports pending, not live). One-shot targets (cursor/claude/codex) and
// OpenCode V1 fail closed — steer them by resuming once settled. Terminal
// jobs always steer via resume (write-capable retries need lead approval).
export function steerFor(receipt, ownership) {
  const interactive = receipt.execution?.transport === "session" && ["claude", "codex", "cursor"].includes(receipt.target);
  if (TERMINAL_STATES.has(receipt.state)) {
    return {
      mode: "resume",
      hint: receipt.state === "completed"
        ? "completed; start an explicit follow-up with a fresh requestId and execution.sessionId from the receipt; a bare handoff_resume does not replay completed work"
        : "terminal; handoff_resume claims one retry per parent (write-capable retries need lead approval after trace review)",
    };
  }
  if (receipt.state === "queued") {
    return {
      mode: "pending",
      hint: "job has not started; poll handoff_status, then steer once running (live) or settled (resume)",
    };
  }
  if (receipt.cancellation?.state === "requested") {
    return { mode: "pending", hint: "cancellation requested; poll handoff_status for owner acknowledgement before resuming" };
  }
  if (ownership && !ownership.local && (interactive || receipt.target === "pi" || (receipt.target === "opencode" && receipt.route?.harnessVersion === "v2"))) {
    return {
      mode: "owner-required",
      hint: "send handoff_message/reroute through the originating Harnest process (see ownership); this process can inspect or request cancellation, but cannot forward live controls",
    };
  }
  if (interactive) {
    if (receipt.target === "cursor") return { mode: "live", hint: "Cursor ACP supports cancellation and negotiated model reroute; mid-turn messages are unsupported. Inspect native acknowledgements." };
    return { mode: "live", hint: "protocol session controls are available; inspect acknowledgement evidence, since queued or SDK-delivered messages do not prove consumption" };
  }
  if (receipt.target === "pi") {
    return {
      mode: "live",
      hint: "handoff_message with a fresh commandId; only applied counts as acknowledged",
    };
  }
  if (receipt.target === "opencode") {
    if (receipt.route?.harnessVersion === "v2") {
      return {
        mode: "live",
        hint: "handoff_message with a fresh commandId; only applied counts as acknowledged",
      };
    }
    return {
      mode: "resume",
      hint: "V1 controls fail closed; resume continues the OpenCode session with a follow-up run",
    };
  }
  return {
    mode: "resume",
    hint: `${receipt.target} is one-shot and rejects live controls; resume with execution.sessionId once settled`,
  };
}

function controlSummary(control) {
  return {
    commandId: control.commandId,
    kind: control.kind,
    delivery: control.delivery,
    state: control.state,
    requestedAt: control.requestedAt,
    updatedAt: control.updatedAt,
    effect: control.effect ?? null,
    route: control.route,
    acknowledgement: control.acknowledgement ?? null,
    error: control.error ?? null,
  };
}

function capabilitySummary(value) {
  if (!value || typeof value !== "object") return undefined;
  return Object.fromEntries(Object.entries(value).slice(0, 32).filter(([key, item]) => /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(key) && (typeof item === "boolean" || typeof item === "number" || typeof item === "string" && item.length <= 200)));
}

export class Companion {
  constructor(options = {}) {
    this.store = options.store || new JobStore(options.stateDir);
    this.boards = options.boards || new BoardStore(options.boardDir ?? ((options.store || options.stateDir) ? join(this.store.root, "boards") : undefined));
    this.adapterFactory = options.adapterFactory || createAdapter;
    this.adapterOptions = options.adapterOptions || {};
    // A custom adapter may not use the native account/catalog at all.
    this.modelCatalog = options.routing?.modelCatalog ?? (options.adapterFactory
      ? async () => ({ status: "unavailable", models: [], reason: "custom adapter has no model catalog" })
      : createModelCatalog({ config: options.routing?.config, env: options.routing?.env }));
    this.routeResolver = options.routeResolver || createRouteResolver({ ...options.routing, modelCatalog: this.modelCatalog });
    this.running = new Map();
    this.sessionPool = new SessionAdapterPool({ ...options.sessionPool, lockDir: join(this.store.root, "native-sessions") });
    this.ownerId = options.ownerId || randomUUID();
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
    this.cancelAckTimeoutMs = options.cancelAckTimeoutMs ?? 5_000;
    // Detached background execution: when true, a background start persists
    // the queued job and hands it to a detached worker process instead of
    // running the adapter here. Off by default so in-process consumers
    // (tests, embeddings, the graph runner) keep today's semantics.
    this.detachBackground = options.detachBackground === true;
    this.workerPath = options.workerPath || fileURLToPath(new URL("./job-worker.mjs", import.meta.url));
    // Queued-claim reconciliation for detached jobs: a worker that dies before
    // its fenced claim leaves no lease to expire, so status() re-dispatches it
    // after queuedClaimTimeoutMs (default 60s) and gives up after
    // maxDispatchAttempts (default 3).
    const queuedClaimTimeoutMs = Number(options.queuedClaimTimeoutMs);
    this.queuedClaimTimeoutMs = Number.isFinite(queuedClaimTimeoutMs) && queuedClaimTimeoutMs > 0
      ? queuedClaimTimeoutMs
      : QUEUED_CLAIM_TIMEOUT_MS;
    this.maxDispatchAttempts = Number.isInteger(options.maxDispatchAttempts) && options.maxDispatchAttempts > 0
      ? options.maxDispatchAttempts
      : MAX_DISPATCH_ATTEMPTS;
  }

  async start(input, options = {}) {
    if (this.closed) throw Object.assign(new Error("Harnest is shutting down"), { details: { kind: "not-active" } });
    const normalized = normalizeRequest(input);
    const request = options.routeResolved ? normalized : await this.routeResolver(normalized);
    const cwd = await stat(request.cwd).catch(() => null);
    if (!cwd?.isDirectory()) throw Object.assign(new TypeError(`cwd is not a directory: ${request.cwd}`), { details: { kind: "validation", hint: "cwd must be an existing absolute directory" } });

    const receipt = createReceipt(request);
    if (options.resumeOf) {
      // Resume lineage: the new job starts a fresh execution identity but
      // carries the parent's immutable attempt ledger and running totals so
      // burn from the earlier job is visible. Entries keep their own jobId,
      // target, route, state and numbers; only the oldest entries beyond the
      // cap collapse into usageAttemptsDropped/usageTotals.
      receipt.resumeOf = options.resumeOf;
      const parent = await this.store.get(options.resumeOf).catch(() => null);
      const parentReceipt = parent?.receipt;
      if (parentReceipt) {
        const prior = Array.isArray(parentReceipt.usageAttempts) ? parentReceipt.usageAttempts : [];
        const carried = prior.slice(-MAX_USAGE_ATTEMPTS);
        if (carried.length) receipt.usageAttempts = structuredClone(carried);
        receipt.usageAttemptsDropped = Math.max(0, (Number(parentReceipt.usageAttemptsDropped) || 0) + (prior.length - carried.length));
        if (parentReceipt.usageTotals && typeof parentReceipt.usageTotals === "object") {
          // Parent totals already include every closed entry. A crashed run can
          // leave a running entry that was never folded, so fold those exactly
          // once and record the truthful interrupted state on the copy.
          receipt.usageTotals = structuredClone(parentReceipt.usageTotals);
          for (const entry of receipt.usageAttempts ?? []) {
            if (entry.state !== "running") continue;
            addUsageToTotals(receipt.usageTotals, entry.usageSummary);
            receipt.usageTotals.partial = true;
            entry.state = "partial";
          }
        } else {
          // No parent totals: derive from every prior entry (dropped entries
          // included) so running entries are counted once, then mark them
          // interrupted without folding again.
          receipt.usageTotals = prior.reduce((totals, entry) => addUsageToTotals(totals, entry?.usageSummary), emptyUsageTotals());
          for (const entry of receipt.usageAttempts ?? []) {
            if (entry.state === "running") {
              receipt.usageTotals.partial = true;
              entry.state = "partial";
            }
          }
        }
      }
    }
    // The MCP boundary converts an over-budget foreground request into a
    // durable background job and records why in request metadata; carry the
    // bounded explanation into the durable receipt so every poller sees it.
    const executionNote = request.metadata?.harnest?.execution;
    if (executionNote?.foregroundConverted === true) {
      receipt.execution = {
        ...receipt.execution,
        background: request.execution.background,
        timeoutMs: request.execution.timeoutMs,
        foregroundConverted: true,
        convertedAt: typeof executionNote.convertedAt === "string" ? executionNote.convertedAt : null,
        requestedTimeoutMs: Number.isInteger(executionNote.requestedTimeoutMs) ? executionNote.requestedTimeoutMs : null,
        safeForegroundWaitMs: Number.isInteger(executionNote.safeForegroundWaitMs) ? executionNote.safeForegroundWaitMs : null,
        hint: typeof executionNote.hint === "string" ? executionNote.hint.slice(0, 500) : null,
      };
    }
    const job = {
      request,
      receipt,
      trace: { eventCount: 0, lastEventAt: null, lastActivity: null, progress: receipt.trace.progress },
      lease: null,
      controls: [],
    };
    {
      const claim = options.resumeOf
        ? await this.store.putIfResumeAbsent(job, options.resumeOf)
        : await this.store.putIfRequestAbsent(job);
      if (!claim.created) {
        if (requestIdentity(claim.job.request) !== requestIdentity(request)) {
          throw Object.assign(new Error(`requestId already belongs to a different handoff: ${request.requestId}`), {
            details: { kind: "request-conflict", hint: "mint a new caller-owned requestId for different work; reuse the same requestId only to recover this job" },
          });
        }
        return this.status(claim.job.receipt.jobId);
      }
    }

    // Detached background execution: hand the queued job to a worker process
    // that keeps its own heartbeat, so caller/server exit cannot strand it.
    // Graph children stay in-process: the graph runner owns and observes
    // their lease, and detaching them would outlive the scheduler.
    const detach = request.execution.background && this.detachBackground && !request.context?.graph;
    if (detach && this.#spawnWorker(job.receipt.jobId)) return receipt;

    const promise = this.#track(job);

    if (request.execution.background) return receipt;
    const settled = assertReceipt(await promise);
    if (!TERMINAL_STATES.has(settled.state)) {
      throw Object.assign(new Error(
        `handoff ${settled.jobId} did not reach a durable terminal state; recover with requestId ${settled.requestId}`,
      ), {
        name: "StatePersistenceError",
        details: { kind: "persistence", jobId: settled.jobId, requestId: settled.requestId, state: settled.state },
      });
    }
    return settled;
  }

  // Claim and execute a queued job from any process (the detached job worker).
  // The claim is fenced by the store: if another worker already claimed the
  // job, #run returns the stored receipt instead of executing it.
  async runQueued(jobId) {
    const job = await this.store.get(jobId);
    if (TERMINAL_STATES.has(job.receipt.state)) return job.receipt;
    if (job.receipt.state !== "queued" || job.lease) {
      throw Object.assign(new Error(`job ${jobId} is not claimable (${job.receipt.state}${job.lease ? ", lease held" : ""})`), {
        details: { kind: "claim-conflict", hint: "the job is already owned by another worker; poll handoff_status for its receipt" },
      });
    }
    return assertReceipt(await this.#track(job));
  }

  ownedCompletion(jobId) {
    return this.running.get(jobId)?.promise ?? null;
  }

  ownedSessionId(jobId) {
    return this.running.get(jobId)?.persistedSessionId ?? null;
  }

  // Worker failure backstop: a detached worker that throws outside #run's own
  // terminalization (bad environment, store failure, anything runQueued
  // rethrows) calls this before exiting 1 so the job never sits running until
  // its lease goes stale. Durable under the job lock and fenced to this
  // process's lease when it holds one. Terminal jobs, and jobs leased by
  // another process, are left untouched: their owner is the only writer.
  async failQueued(jobId, error) {
    const failure = safeError(error);
    const failed = await this.store.transition(jobId, (current) => {
      if (TERMINAL_STATES.has(current.receipt.state)) return null;
      if (current.lease && current.lease.ownerId !== this.ownerId) return null;
      current.lease = null;
      current.receipt = terminalReceipt(current.receipt, "failed", { error: failure, result: null });
      return current;
    }, () => ({
      at: new Date().toISOString(),
      activity: "failed",
      event: { type: "state", state: "failed", error: failure },
    }));
    return failed?.receipt ?? (await this.store.get(jobId)).receipt;
  }

  // Whether this process may auto-re-dispatch a queued job: only detached
  // background jobs it owns. Graph children stay scheduler-owned, in-process
  // runs settle through this process's own backstop, cancellation is the
  // caller's intent, and a receipt with execution evidence is no longer an
  // unclaimed handoff.
  #canRedispatch(job) {
    if (!this.detachBackground) return false;
    if (job.request.context?.graph) return false;
    if (job.receipt.cancellation) return false;
    if (this.#executionStarted(job.receipt)) return false;
    return true;
  }

  #executionStarted(receipt) {
    return receipt.startedAt != null
      || receipt.sessionId != null
      || receipt.workflowRunId != null
      || receipt.usage != null
      || receipt.result != null
      || receipt.recovery?.heartbeatAt != null;
  }

  // One bounded re-dispatch for a queued job whose worker died before the
  // fenced claim. The attempt record is committed atomically with the
  // decision and the cap is enforced against the latest stored snapshot, so
  // concurrent status pollers cannot exceed maxDispatchAttempts. At the cap
  // the job settles as an explicit unclaimed partial for the caller to resume
  // or inspect; the worker is spawned only after the attempt is durable.
  async #redispatchQueued(jobId) {
    const at = new Date().toISOString();
    const transitioned = await this.store.transition(jobId, (current) => {
      if (current.receipt.state !== "queued" || current.lease) return null;
      if (current.receipt.cancellation) return null;
      if (this.#executionStarted(current.receipt)) return null;
      const attempts = Number.isInteger(current.receipt.dispatch?.attempts) ? current.receipt.dispatch.attempts : 0;
      if (attempts >= this.maxDispatchAttempts) {
        current.receipt = terminalReceipt(current.receipt, "partial", {
          error: {
            name: "UnclaimedJobError",
            message: `job ${jobId} stayed queued through ${attempts} dispatch attempt(s); no worker claimed it`,
            details: {
              kind: "unclaimed",
              attempts,
              maxAttempts: this.maxDispatchAttempts,
              hint: "resume this handoff to retry, or inspect the worker environment (state directory, node path, worker adapter); the job never started",
            },
          },
          result: null,
          recoveryRequired: true,
        });
        return current;
      }
      current.receipt = {
        ...current.receipt,
        dispatch: {
          attempts: attempts + 1,
          maxAttempts: this.maxDispatchAttempts,
          lastAttemptAt: at,
          reason: "unclaimed-timeout",
        },
      };
      return current;
    }, (current) => ({
      at,
      activity: current.receipt.state === "partial" ? "unclaimed" : "dispatch retry",
      event: current.receipt.state === "partial"
        ? { type: "recovery", state: "partial", error: current.receipt.error }
        : { type: "dispatch", attempts: current.receipt.dispatch?.attempts ?? null, reason: current.receipt.dispatch?.reason ?? null },
    }));
    if (!transitioned) return this.store.get(jobId).catch(() => null);
    if (transitioned.receipt.state === "queued") this.#spawnWorker(jobId);
    return transitioned;
  }

  async compare(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw Object.assign(new TypeError("comparison must be an object"), { details: { kind: "validation" } });
    }
    const base = normalizeRequest(input.request);
    if (base.policy.write) {
      throw Object.assign(new TypeError("multi-model comparison must be read-only; use isolated worktrees for implementation bake-offs"), { details: { kind: "policy" } });
    }
    const candidates = input.candidates;
    if (!Array.isArray(candidates) || candidates.length < 2 || candidates.length > 16) {
      throw Object.assign(new TypeError("comparison requires 2 to 16 candidates"), { details: { kind: "validation" } });
    }
    const names = new Set();
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        throw Object.assign(new TypeError("each comparison candidate must be an object"), { details: { kind: "validation" } });
      }
      if (typeof candidate.name !== "string" || !/^[A-Za-z0-9._-]+$/.test(candidate.name)) {
        throw Object.assign(new TypeError("candidate.name must use letters, numbers, dot, underscore, or hyphen"), { details: { kind: "validation" } });
      }
      if (names.has(candidate.name)) throw Object.assign(new TypeError(`duplicate comparison candidate: ${candidate.name}`), { details: { kind: "validation" } });
      names.add(candidate.name);
      if (!candidate.route || typeof candidate.route !== "object" || Array.isArray(candidate.route)) {
        throw Object.assign(new TypeError(`candidate ${candidate.name} requires a route object`), { details: { kind: "validation" } });
      }
      if (typeof candidate.route.model !== "string" || !candidate.route.model.trim()) {
        throw Object.assign(new TypeError(`candidate ${candidate.name} requires route.model`), { details: { kind: "validation" } });
      }
    }

    const prepared = await Promise.all(candidates.map(async (candidate) => {
      const requested = normalizeRequest({
        ...base,
        requestId: `${base.requestId}:${candidate.name}`,
        target: candidate.target ?? base.target,
        route: { ...base.route, ...candidate.route },
      });
      const resolved = await this.routeResolver(requested);
      if (resolved.policy.write) throw Object.assign(new TypeError(`candidate ${candidate.name} resolved to a write-capable request`), { details: { kind: "policy" } });
      return { candidate, request: resolved };
    }));
    const routeOwners = new Map();
    for (const lane of prepared) {
      const identity = comparisonRouteIdentity(lane.request);
      const duplicate = routeOwners.get(identity);
      if (duplicate) {
        throw Object.assign(new TypeError(`comparison candidates ${duplicate} and ${lane.candidate.name} resolve to the same route`), { details: { kind: "validation" } });
      }
      routeOwners.set(identity, lane.candidate.name);
    }

    const settled = [];
    // Bounded fan-out: at most 4 lanes run concurrently so a 16-lane compare
    // cannot exhaust processes/handles; lane order in the receipt is stable.
    for (let offset = 0; offset < prepared.length; offset += 4) {
      const chunk = prepared.slice(offset, offset + 4);
      settled.push(...await Promise.allSettled(chunk.map(({ request }) => this.start(request, { routeResolved: true }))));
    }
    const lanes = settled.map((result, index) => {
      const { candidate, request } = prepared[index];
      return {
        name: candidate.name,
        requestId: request.requestId,
        resolved: { target: request.target, route: request.route },
        receipt: result.status === "fulfilled" ? result.value : null,
        error: result.status === "rejected" ? safeError(result.reason) : null,
      };
    });
    const receipts = lanes.map((lane) => lane.receipt).filter(Boolean);
    const state = lanes.some((lane) => lane.error || ["failed", "cancelled", "partial"].includes(lane.receipt?.state))
      ? "partial"
      : receipts.every((receipt) => receipt.state === "completed")
        ? "completed"
        : "active";
    return {
      protocolVersion: "1.0",
      comparisonId: base.requestId,
      contextDigest: base.contextDigest,
      state,
      createdAt: new Date().toISOString(),
      lanes,
    };
  }

  // Multi-model review loop. Each call runs up to `rounds` of opinion
  // convergence across 2-8 read-only lanes sharing one rubric: round 1 is
  // independent scoring, later rounds share the full board (every lane's
  // findings and scores) plus directed lane-to-lane messages, then re-score.
  // The loop NEVER implements: it returns consolidated findings for the
  // caller to apply, then re-invoke with `previous` for the next
  // implement→review loop. State is completed (threshold met), partial
  // (rounds exhausted below threshold — findings attached to implement), or
  // failed (quorum never reached: fewer than 2 voting lanes).
  async review(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw Object.assign(new TypeError("review must be an object"), { details: { kind: "validation" } });
    }
    const base = normalizeRequest(input.request);
    if (base.policy.write) {
      throw Object.assign(new TypeError("multi-model review must be read-only; reviewers never receive write policy"), { details: { kind: "policy" } });
    }
    const reviewers = normalizeReviewers(input.reviewers);
    const rubric = normalizeRubric(input.rubric ?? ["correctness", "security", "simplicity"]);
    const threshold = input.threshold ?? REVIEW_DEFAULT_THRESHOLD;
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 10) {
      throw Object.assign(new TypeError("review threshold must be a number between 0 and 10"), { details: { kind: "validation" } });
    }
    const rounds = input.rounds ?? 2;
    if (!Number.isInteger(rounds) || rounds < REVIEW_MIN_ROUNDS || rounds > REVIEW_MAX_ROUNDS) {
      throw Object.assign(new TypeError(`review rounds must be an integer between ${REVIEW_MIN_ROUNDS} and ${REVIEW_MAX_ROUNDS}`), { details: { kind: "validation" } });
    }
    const previous = input.previous ?? null;
    if (previous !== null) {
      if (typeof previous !== "object" || Array.isArray(previous)) throw Object.assign(new TypeError("review previous must be an object"), { details: { kind: "validation" } });
      if (previous.summary !== undefined && typeof previous.summary !== "string") {
        throw Object.assign(new TypeError("review previous.summary must be a string"), { details: { kind: "validation" } });
      }
      if (previous.scores !== undefined && (typeof previous.scores !== "object" || previous.scores === null || Array.isArray(previous.scores))) {
        throw Object.assign(new TypeError("review previous.scores must be an object"), { details: { kind: "validation" } });
      }
    }

    const prepared = await Promise.all(reviewers.map(async (reviewer) => {
      const requested = normalizeRequest({
        ...base,
        requestId: `${base.requestId}:review:${reviewer.name}:init`,
        target: reviewer.target ?? base.target,
        route: { ...base.route, ...reviewer.route },
      });
      const resolved = await this.routeResolver(requested);
      if (resolved.policy.write) throw Object.assign(new TypeError(`reviewer ${reviewer.name} resolved to a write-capable request`), { details: { kind: "policy" } });
      return { reviewer, request: resolved };
    }));
    const routeOwners = new Map();
    for (const lane of prepared) {
      const identity = comparisonRouteIdentity(lane.request);
      const duplicate = routeOwners.get(identity);
      if (duplicate) {
        throw Object.assign(new TypeError(`reviewers ${duplicate} and ${lane.reviewer.name} resolve to the same route; review needs independent models`), { details: { kind: "validation" } });
      }
      routeOwners.set(identity, lane.reviewer.name);
    }

    const nonce = newReviewNonce();
    let board = null;
    const roundsOut = [];
    for (let round = 1; round <= rounds; round += 1) {
      const settled = [];
      for (let offset = 0; offset < prepared.length; offset += 4) {
        const chunk = prepared.slice(offset, offset + 4);
        settled.push(...await Promise.allSettled(chunk.map(({ reviewer, request }) => {
          const task = reviewPrompt({
            task: base.task,
            context: base.context,
            rubric,
            round,
            board,
            lane: reviewer.name,
            previous: round === 1 ? previous : null,
          });
          return this.start({
            ...request,
            requestId: reviewId(base.requestId, nonce, reviewer.name, round),
            task,
            execution: { ...request.execution, background: false },
          }, { routeResolved: true });
        })));
      }
      const parsed = settled.map((result, index) => {
        const lane = prepared[index].reviewer.name;
        if (result.status === "rejected") {
          const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
          return { name: lane, valid: false, error: `lane failed: ${message.slice(0, 500)}` };
        }
        const receipt = result.value;
        if (!receipt || receipt.state !== "completed") {
          return { name: lane, valid: false, error: `lane ended ${receipt?.state || "unknown"}` };
        }
        return parseLaneResult(lane, receipt.result?.finalText || "", rubric);
      });
      const tally = tallyRound(parsed, rubric);
      roundsOut.push({
        round,
        tally,
        findings: consolidateFindings(parsed),
        lanes: settled.map((result, index) => {
          const receipt = result.status === "fulfilled" ? result.value : null;
          return {
            name: prepared[index].reviewer.name,
            requestId: reviewId(base.requestId, nonce, prepared[index].reviewer.name, round),
            jobId: receipt?.jobId || null,
            state: receipt?.state || "failed",
            error: result.status === "rejected"
              ? safeError(result.reason)
              : (receipt?.state !== "completed" ? receipt?.error || { message: `lane ended ${receipt?.state}` } : null),
            result: receipt?.result
              ? { ...receipt.result, finalText: String(receipt.result.finalText || "").slice(0, 4000) }
              : null,
          };
        }),
      });
      if (tally.voting.length < REVIEW_MIN_LANES) break;
      board = boardView(parsed, tally);
      if (tally.overall != null && tally.overall >= threshold) break;
    }

    const final = roundsOut.at(-1);
    const met = final && final.tally.voting.length >= REVIEW_MIN_LANES
      && final.tally.overall != null && final.tally.overall >= threshold;
    const failed = !final || final.tally.voting.length < REVIEW_MIN_LANES;
    return {
      protocolVersion: "1.0",
      reviewId: base.requestId,
      contextDigest: base.contextDigest,
      threshold,
      state: failed ? "failed" : (met ? "completed" : "partial"),
      createdAt: new Date().toISOString(),
      rounds: roundsOut,
      final: final ? {
        round: final.round,
        overall: final.tally.overall,
        laneScores: final.tally.laneScores,
        factorMeans: final.tally.factorMeans,
        voting: final.tally.voting,
        abstained: final.tally.abstained,
        findings: final.findings,
      } : null,
    };
  }

  // Register and run one job in this process, with the shared failure
  // backstop: #run terminalizes adapter failures itself, so reaching the
  // backstop means persistence broke mid-flight. Commit atomically under the
  // job lock so two crashed workers cannot last-writer-wins each other.
  async close() {
    this.closed = true;
    const active = [...this.running.values()];
    for (const owner of active) owner.controller.abort(new Error("Harnest shutdown"));
    const cleanup = await this.sessionPool.close();
    await Promise.allSettled(active.map((owner) => owner.promise));
    return { cleanupFailures: cleanup.filter((item) => item.status === "rejected").map((item) => safeError(item.reason)) };
  }

  #track(job) {
    const controller = new AbortController();
    const active = {
      controller,
      promise: null,
      job,
      adapter: null,
      controlQueue: Promise.resolve(),
      controlPromises: new Map(),
    };
    const jobId = job.receipt.jobId;
    this.running.set(jobId, active);
    const promise = this.#run(job, controller, active)
      .catch(async (error) => {
        const failed = safeError(error);
        const next = await this.store.transition(jobId, (current) => {
          const owned = current?.lease?.ownerId === this.ownerId;
          const unclaimed = current?.receipt?.state === "queued" && !current?.lease;
          if (!owned && !unclaimed) return null;
          current.lease = null;
          current.receipt = terminalReceipt(current.receipt, "failed", { error: failed, result: null });
          return current;
        }, () => ({
          at: new Date().toISOString(),
          activity: "failed",
          event: { type: "state", state: "failed", error: failed },
        })).catch(() => null);
        job.lease = null;
        if (next) return next.receipt;
        return (await this.store.get(jobId).catch(() => null))?.receipt || job.receipt;
      })
      .finally(() => this.running.delete(jobId));
    active.promise = promise;
    return promise;
  }

  // Detached execution: one worker process per job, same semantics as an
  // in-process run (fenced claim, heartbeat, attempts, fallback, terminal
  // receipt). The child is detached, unref'd, and without stdio pipes, so
  // caller/server death cannot withdraw its heartbeat. Spawn failure is
  // non-fatal: the caller falls back to an in-process run.
  #spawnWorker(jobId) {
    try {
      const child = spawn(process.execPath, [this.workerPath, this.store.root, jobId], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: mergeProcessEnv(),
      });
      child.on("error", (error) => {
        process.stderr.write(`harnest: detached worker failed for job ${jobId}: ${error?.message || error}\n`);
        void this.runQueued(jobId).catch(() => undefined);
      });
      child.unref();
      return true;
    } catch (error) {
      process.stderr.write(`harnest: could not spawn a detached worker for job ${jobId}: ${error?.message || error}\n`);
      return false;
    }
  }

  async #run(job, controller, active) {
    let persisted = Promise.resolve();
    let persistenceFailure = null;
    let eventFlushTimer = null;
    const pendingEvents = [];
    const queuePersistence = (work) => {
      const current = persisted.catch(() => undefined).then(work);
      persisted = current;
      return current;
    };
    const leaseLost = () => Object.assign(new Error(`job ${job.receipt.jobId} lease is no longer owned by this worker`), {
      name: "LeaseLostError",
      details: { kind: "lease-lost" },
    });
    const flushEvents = () => {
      clearTimeout(eventFlushTimer);
      eventFlushTimer = null;
      if (!pendingEvents.length) return persisted;
      const batch = pendingEvents.splice(0);
      const records = batch.map((entry) => entry.record);
      const storeOptions = batch.some((entry) => entry.options.claim)
        ? { claim: true }
        : { expectedLeaseOwner: this.ownerId };
      const current = queuePersistence(async () => {
        const written = await this.store.commitBatch(job, records, storeOptions);
        if (!written) throw leaseLost();
        return written;
      });
      current.then(
        (value) => batch.forEach((entry) => entry.resolve(value)),
        (error) => batch.forEach((entry) => entry.reject(error)),
      );
      current.catch((error) => {
        persistenceFailure ||= error;
        if (!batch.some((entry) => entry.options.claim)) controller.abort();
      });
      return current;
    };
    const persist = () => {
      flushEvents();
      return queuePersistence(async () => {
      const written = await this.store.put(job, { expectedLeaseOwner: this.ownerId });
      if (!written) throw leaseLost();
      return written;
      });
    };
    const recordEvent = (event, options = {}) => {
      if (event.type === "progress" && !TERMINAL_STATES.has(job.receipt.state)) {
        const observed = event.data;
        for (const field of ["sessionId", "workflowRunId"]) {
          if (typeof observed?.[field] === "string" && observed[field].trim()) job.receipt[field] = observed[field];
        }
        // Adapter progress carries cumulative snapshots, not usage deltas.
        if (observed?.usage && typeof observed.usage === "object" && !Array.isArray(observed.usage)) {
          job.receipt.usage = structuredClone(observed.usage);
        }
      }
      const at = new Date().toISOString();
      const record = {
        at,
        activity: activityFrom(event),
        event,
      };
      let resolveEvent;
      let rejectEvent;
      const completion = new Promise((resolve, reject) => {
        resolveEvent = resolve;
        rejectEvent = reject;
      });
      completion.catch(() => {});
      pendingEvents.push({ record, options, resolve: resolveEvent, reject: rejectEvent });
      if (options.claim || pendingEvents.length >= 100) flushEvents();
      else if (!eventFlushTimer) {
        eventFlushTimer = setTimeout(flushEvents, 25);
        // A pending durable write is real work: hold the loop while events
        // are unflushed so a bare process cannot drain out from under an
        // awaited progress completion. The timer is cleared on flush, so
        // idle jobs still exit.
        eventFlushTimer.ref?.();
      }
      return completion;
    };

    const heartbeatAt = new Date().toISOString();
    job.lease = { ownerId: this.ownerId, pid: process.pid, host: hostname(), heartbeatAt };
    job.receipt = {
      ...job.receipt,
      state: "running",
      startedAt: heartbeatAt,
      recovery: recoveryView(job, { heartbeatAt }),
    };
    await recordEvent({ type: "state", state: "running" }, { claim: true });
    const durableRunningReceipt = structuredClone(job.receipt);

    const reconcileCancellation = () => {
      if (job.receipt.cancellation?.state === "requested") controller.abort();
    };
    // A cross-process cancellation can be recorded between the claim and this
    // loop start; adopt it now so the run does not wait for the next heartbeat.
    try {
      const stored = await this.store.get(job.receipt.jobId);
      if (stored?.receipt?.cancellation?.state === "requested" && !job.receipt.cancellation) {
        job.receipt.cancellation = stored.receipt.cancellation;
      }
    } catch { /* best-effort; the heartbeat persist re-adopts stored intents */ }
    reconcileCancellation();

    const timeoutMs = job.request.execution.timeoutMs;
    const deadlineAt = performance.now() + timeoutMs;
    const timeoutError = () => Object.assign(new Error(`handoff exceeded ${timeoutMs}ms wall-clock timeout`), {
      details: { kind: "timeout", timedOut: true },
    });
    // Per-attempt provider usage ledger. Each attempt gets its own immutable
    // record and generation; a closed attempt's late callbacks are dropped so
    // they can never write another provider's ledger or receipt identity.
    const usageAttempts = Array.isArray(job.receipt.usageAttempts) ? job.receipt.usageAttempts : [];
    job.receipt.usageAttempts = usageAttempts;
    job.receipt.usageTotals = job.receipt.usageTotals && typeof job.receipt.usageTotals === "object"
      ? job.receipt.usageTotals
      : emptyUsageTotals();
    let attemptSeq = usageAttempts.reduce((max, entry) => Math.max(max, Number(entry?.attempt) || 0), 0);
    let currentAttempt = null;
    const openAttemptUsage = () => {
      // Hard cap: the ledger never exceeds MAX_USAGE_ATTEMPTS. Each evicted
      // entry is the oldest and therefore closed; a running entry can only
      // reach the front through a stale resume, and seeding already folded
      // those exactly once, so fold here only if it was never folded.
      while (usageAttempts.length >= MAX_USAGE_ATTEMPTS) {
        const evicted = usageAttempts.shift();
        if (evicted?.state === "running") {
          addUsageToTotals(job.receipt.usageTotals, evicted.usageSummary);
          job.receipt.usageTotals.partial = true;
        }
        job.receipt.usageAttemptsDropped = (Number(job.receipt.usageAttemptsDropped) || 0) + 1;
      }
      attemptSeq += 1;
      const entry = {
        attempt: attemptSeq,
        jobId: job.receipt.jobId,
        target: job.request.target,
        route: job.request.route ?? {},
        state: "running",
        usageReported: false,
        usage: null,
        usageSummary: null,
      };
      usageAttempts.push(entry);
      currentAttempt = { entry, closed: false };
      return currentAttempt;
    };
    const closeAttemptUsage = (state) => {
      if (!currentAttempt || currentAttempt.closed) return;
      currentAttempt.closed = true;
      currentAttempt.entry.state = state;
      addUsageToTotals(job.receipt.usageTotals, currentAttempt.entry.usageSummary);
      if (state === "cancelled" || state === "timeout") job.receipt.usageTotals.partial = true;
      job.receipt.usageSummary = currentAttempt.entry.usageSummary ?? null;
    };
    openAttemptUsage();
    let sessionLease = null;
    // Keep the heartbeat referenced so a pending run can still adopt a durable
    // cancellation. Serialize its writes so a slow store cannot build a backlog
    // ahead of cancellation or terminal persistence.
    let heartbeatBusy = false;
    const heartbeat = setInterval(() => {
      if (!job.lease) return;
      const at = new Date().toISOString();
      job.lease.heartbeatAt = at;
      job.receipt = { ...job.receipt, recovery: recoveryView(job, { heartbeatAt: at }) };
      if (heartbeatBusy) return;
      heartbeatBusy = true;
      void persist().then(reconcileCancellation).catch((error) => {
        persistenceFailure ||= error;
        controller.abort();
      }).finally(() => { heartbeatBusy = false; });
    }, this.heartbeatIntervalMs);
    try {
      let output = null;
      for (;;) {
        const remainingMs = Math.ceil(deadlineAt - performance.now());
        if (remainingMs <= 0) throw timeoutError();
        if (currentAttempt?.closed) {
          // Retry: drop the failed attempt's counters and summary so a silent
          // next attempt cannot inherit them.
          job.receipt.usage = null;
          job.receipt.usageSummary = null;
          openAttemptUsage();
        }
        const attempt = currentAttempt;
        const create = () => this.adapterFactory(job.request.target, this.adapterOptions, job.request);
        if (job.request.execution.transport === "session" && ["claude", "codex", "cursor"].includes(job.request.target)) {
          sessionLease = await this.sessionPool.acquire(job.request, create);
        }
        const adapter = sessionLease?.adapter ?? create();
        active.adapter = adapter;
        // Attempts have separate cancellation signals but share one deadline.
        // The durable request retains its original budget for recovery.
        const attemptController = new AbortController();
        const propagateAbort = () => attemptController.abort();
        if (controller.signal.aborted) attemptController.abort();
        else controller.signal.addEventListener("abort", propagateAbort, { once: true });
        let removeAbortListener = () => {};
        const aborted = new Promise((_, reject) => {
          const rejectAborted = () => reject(Object.assign(new Error("handoff cancelled"), {
            details: { aborted: true },
          }));
          if (attemptController.signal.aborted) {
            rejectAborted();
            return;
          }
          attemptController.signal.addEventListener("abort", rejectAborted, { once: true });
          removeAbortListener = () => attemptController.signal.removeEventListener("abort", rejectAborted);
        });
        const adapterRun = adapter.run({
          ...job.request,
          execution: { ...job.request.execution, timeoutMs: remainingMs },
        }, {
          signal: attemptController.signal,
          onProgress: (event) => {
            const progress = (async () => {
              // Closed attempts cannot publish late usage or session identity.
              if (!attempt || attempt.closed) return undefined;
              if (sessionLease && typeof event?.sessionId === "string" && event.sessionId) {
                try { await sessionLease.bind(event.sessionId); }
                catch (error) { persistenceFailure ??= error; attemptController.abort(); throw error; }
                if (!attempt || attempt.closed) return undefined;
                job.receipt.sessionId = event.sessionId;
                attempt.entry.sessionId = event.sessionId;
              }
              if (adapter.capabilities) job.receipt.capabilities = capabilitySummary(adapter.capabilities);
              if (event && typeof event === "object" && event.usage && typeof event.usage === "object" && !Array.isArray(event.usage)) {
                const summary = confirmedUsageSummary(job.request.target, event);
                attempt.entry.usage = structuredClone(event.usage);
                attempt.entry.usageSummary = summary;
                attempt.entry.usageReported = summary != null;
                job.receipt.usageSummary = summary;
              }
              const recorded = await recordEvent({ type: "progress", data: event });
              if (attempt && !attempt.closed && sessionLease) active.persistedSessionId = job.receipt.sessionId ?? null;
              return recorded;
            })();
            progress.catch(() => {});
            return progress;
          },
        });
        let adapterFailure = null;
        let adapterExit = null;
        const adapterSettled = Promise.resolve(adapterRun).then(() => true, (error) => {
          adapterFailure = error;
          if (error?.details && (error.details.code != null || error.details.signal != null)) {
            adapterExit = { code: error.details.code ?? null, signal: error.details.signal ?? null };
          }
          return true;
        });
        let deadlineTimer;
        let attemptTimedOut = false;
        const deadline = new Promise((_, reject) => {
          deadlineTimer = setTimeout(() => {
            attemptTimedOut = true;
            const error = timeoutError();
            reject(error);
            attemptController.abort(error);
          }, remainingMs);
        });
        const cleanupAttempt = () => {
          clearTimeout(deadlineTimer);
          removeAbortListener();
          controller.signal.removeEventListener("abort", propagateAbort);
        };
        try {
          output = await Promise.race([adapterRun, aborted, deadline]).finally(cleanupAttempt);
          if (performance.now() >= deadlineAt) throw timeoutError();
          break;
        } catch (error) {
          cleanupAttempt();
          if (sessionLease) {
            try { await sessionLease.release(); }
            catch (cleanup) { job.receipt.cleanupError = safeError(cleanup); }
            sessionLease = null;
          }
          if (job.receipt.cancellation?.state === "requested" && controller.signal.aborted) {
            let ackTimer;
            const settled = await Promise.race([
              adapterSettled,
              new Promise((resolve) => { ackTimer = setTimeout(() => resolve(false), this.cancelAckTimeoutMs); }),
            ]).finally(() => clearTimeout(ackTimer));
            const acknowledged = settled && !hasUnsafeCleanup(adapterFailure);
            job.receipt.cancellation = {
              ...job.receipt.cancellation,
              state: acknowledged ? "acknowledged" : "unacknowledged",
              acknowledgedAt: acknowledged ? new Date().toISOString() : null,
              downstreamExit: acknowledged ? adapterExit : null,
            };
            if (!settled) throw Object.assign(new Error("cancellation requested but adapter did not acknowledge stopping"), {
              details: { kind: "cancel-unacknowledged", hint: "inspect the originating harness before retrying; downstream execution may still be active" },
            });
          }
          const usageFailure = adapterFailure ?? error;
          if (usageFailure?.details?.usage && attempt && !attempt.closed) {
            attempt.entry.usage = structuredClone(usageFailure.details.usage);
            attempt.entry.usageSummary = confirmedUsageSummary(job.request.target, usageFailure.details);
            attempt.entry.usageReported = attempt.entry.usageSummary != null;
          }
          if (job.receipt.cancellation?.state === "unacknowledged" && hasUnsafeCleanup(adapterFailure)) throw adapterFailure;
          if (!controller.signal.aborted && (attemptTimedOut || performance.now() >= deadlineAt)) throw timeoutError();
          const next = job.receipt.cleanupError || hasUnsafeCleanup(error) ? null : nextFallbackRoute(job, error, { attemptTimedOut, persistenceFailure, cancelled: controller.signal.aborted });
          if (!next) throw error;
          // Resume tokens belong to the harness that issued them: keep the
          // session only when the fallback stays on the same target.
          const keptSession = next.target === job.request.target;
          const record = {
            from: { target: job.request.target, route: job.request.route },
            to: { target: next.target, route: next.route },
            errorKind: attemptTimedOut ? "timeout" : (error?.details?.kind || "unknown"),
            keptSession,
            at: new Date().toISOString(),
          };
          // A cross-target fallback must not inherit the failed run's session:
          // resume tokens belong to the harness that issued them.
          closeAttemptUsage(attemptTimedOut ? "timeout" : "failed");
          job.request = normalizeRequest({
            ...job.request,
            target: next.target,
            route: { ...next.route },
            execution: { ...job.request.execution, sessionId: keptSession ? job.request.execution.sessionId : null },
          });
          job.receipt = {
            ...job.receipt,
            target: job.request.target,
            route: job.request.route,
            routingFallbacks: [...(job.receipt.routingFallbacks || []), record],
          };
          await recordEvent({ type: "fallback", ...record });
          await persist();
          continue;
        }
      }
      clearInterval(heartbeat);
      flushEvents();
      await persisted;
      if (persistenceFailure) throw persistenceFailure;
      if (currentAttempt && !currentAttempt.closed) {
        const terminalSummary = confirmedUsageSummary(job.request.target, output)
          ?? (currentAttempt.entry.usageReported ? currentAttempt.entry.usageSummary : null);
        if (output?.usage && typeof output.usage === "object" && !Array.isArray(output.usage)) {
          currentAttempt.entry.usage = structuredClone(output.usage);
        }
        currentAttempt.entry.usageSummary = terminalSummary;
        currentAttempt.entry.usageReported = terminalSummary != null;
      }
      if (!output?.result?.finalText) {
        throw Object.assign(new Error("downstream workflow completed without finalText"), {
          details: { kind: "downstream" },
        });
      }
      assertCompletionContract(job.request, output);
      closeAttemptUsage("completed");
      // The terminal output may carry a null or valueless usageSummary; the
      // canonical summary already observed from progress must survive the
      // terminal merge. The legacy raw usage field keeps its own contract.
      const knownSummary = job.receipt.usageSummary;
      job.lease = null;
      const receiptOutput = { ...output };
      if (receiptOutput.capabilities) receiptOutput.capabilities = capabilitySummary(receiptOutput.capabilities);
      delete receiptOutput.usageReported;
      if (receiptOutput.execution) receiptOutput.execution = { ...job.receipt.execution, ...receiptOutput.execution };
      job.receipt = terminalReceipt(job.receipt, "completed", receiptOutput);
      if (!usageSummaryHasValues(job.receipt.usageSummary)) {
        job.receipt.usageSummary = usageSummaryHasValues(knownSummary) ? knownSummary : null;
      }
    } catch (error) {
      clearInterval(heartbeat);
      flushEvents();
      await persisted.catch(() => undefined);
      if (error?.details?.kind === "lease-lost") {
        return (await this.store.get(job.receipt.jobId)).receipt;
      }
      const failure = hasUnsafeCleanup(error) ? error : (persistenceFailure || error);
      const timedOut = error?.details?.timedOut || error?.details?.kind === "timeout";
      const unacknowledged = error?.details?.kind === "cancel-unacknowledged" || job.receipt.cancellation?.state === "unacknowledged";
      const aborted = !persistenceFailure && !timedOut && !unacknowledged && (controller.signal.aborted || error?.details?.aborted);
      closeAttemptUsage(aborted ? "cancelled" : timedOut ? "timeout" : "failed");
      job.lease = null;
      const failureSessionId = safeNativeSessionId(failure?.details?.sessionId);
      const safeFailure = aborted ? null : safeError(failure);
      job.receipt = terminalReceipt(job.receipt, unacknowledged ? "partial" : (aborted ? "cancelled" : "failed"), {
        error: safeFailure,
        ...(job.receipt.sessionId == null && failureSessionId ? { sessionId: failureSessionId } : {}),
      });
    } finally {
      try { await sessionLease?.release(job.receipt.state === "completed" ? job.receipt : undefined); }
      catch (cleanup) { job.receipt.cleanupError = safeError(cleanup); }
      if (job.receipt.cleanupError && job.receipt.state !== "completed") {
        const cleanup = job.receipt.cleanupError;
        job.receipt = terminalReceipt(job.receipt, "partial", {
          completedAt: job.receipt.completedAt,
          error: job.receipt.error ?? { ...cleanup, details: { ...cleanup.details, kind: "cleanup", unsafeResume: true } },
          ...(job.receipt.cancellation ? {
            cancellation: { ...job.receipt.cancellation, state: "unacknowledged", acknowledgedAt: null },
          } : {}),
        });
        if (job.receipt.usageTotals) job.receipt.usageTotals.partial = true;
      }
      if (job.receipt.cleanupError || hasUnsafeCleanup(job.receipt.error)) job.receipt.recovery.canResume = false;
    }
    clearTimeout(eventFlushTimer);
    try {
      // Start the terminal commit immediately rather than waiting for batching.
      const terminalCompletion = recordEvent({
        type: "state",
        state: job.receipt.state,
        sessionId: job.receipt.sessionId,
        workflowRunId: job.receipt.workflowRunId,
        error: job.receipt.error,
      });
      flushEvents();
      await terminalCompletion;
    } catch (error) {
      if (error?.details?.kind === "lease-lost") {
        return (await this.store.get(job.receipt.jobId)).receipt;
      }
      job.receipt = terminalReceipt(job.receipt, "failed", {
        error: safeError(Object.assign(new Error(`state persistence failed: ${error.message}`), {
          name: "StatePersistenceError",
          details: { ...error.details, kind: "persistence" },
        })),
        result: null,
      });
      const written = await this.store.put(job, { expectedLeaseOwner: this.ownerId }).catch(() => null);
      if (!written) {
        return (await this.store.get(job.receipt.jobId).catch(() => null))?.receipt || durableRunningReceipt;
      }
    }
    return job.receipt;
  }

  async status(jobId) {
    let job = await this.store.get(jobId);
    // Queued detached handoffs have no lease and no heartbeat, so the
    // stale-running rule cannot see them: a worker that dies before its fenced
    // claim would strand the job in `queued` forever. The claim window governs
    // instead — re-dispatch up to the cap, then settle explicitly. Queued jobs
    // this process must not re-dispatch (in-process runs, graph children,
    // cancellations, or receipts with execution evidence) keep the existing
    // heartbeat reconciliation below.
    const claimWindowGoverns = job.receipt.state === "queued" && !job.lease && this.#canRedispatch(job);
    if (claimWindowGoverns) {
      const claimedAt = Date.parse(job.receipt.dispatch?.lastAttemptAt || job.receipt.createdAt);
      const claimAgeMs = Date.now() - claimedAt;
      if (!Number.isFinite(claimAgeMs) || claimAgeMs > this.queuedClaimTimeoutMs) {
        job = (await this.#redispatchQueued(jobId)) ?? job;
      }
    }
    if (!claimWindowGoverns && ["queued", "running"].includes(job.receipt.state)) {
      const heartbeat = job.lease?.heartbeatAt || job.receipt.recovery?.heartbeatAt ||
        job.receipt.startedAt || job.receipt.createdAt;
      const ageMs = Date.now() - Date.parse(heartbeat);
      if (!Number.isFinite(ageMs) || ageMs > STALE_HEARTBEAT_MS) {
        const recovered = await this.store.transition(jobId, (current) => {
          if (!["queued", "running"].includes(current.receipt.state)) return null;
          const currentHeartbeat = current.lease?.heartbeatAt || current.receipt.recovery?.heartbeatAt ||
            current.receipt.startedAt || current.receipt.createdAt;
          const currentAgeMs = Date.now() - Date.parse(currentHeartbeat);
          if (Number.isFinite(currentAgeMs) && currentAgeMs <= STALE_HEARTBEAT_MS) return null;
          const error = {
            name: "InterruptedExecution",
            message: `job ${jobId} lost its active worker heartbeat`,
            details: { kind: "interrupted", staleForMs: Number.isFinite(currentAgeMs) ? currentAgeMs : null },
          };
          current.lease = null;
          current.receipt = terminalReceipt(current.receipt, "partial", { error, result: null });
          return current;
        }, (current) => ({
          at: new Date().toISOString(),
          activity: "recovery",
          event: { type: "recovery", state: "partial", error: current.receipt.error },
        }));
        if (recovered) {
          const active = this.running.get(jobId);
          this.running.delete(jobId);
          active?.controller.abort();
          job = recovered;
        } else {
          job = await this.store.get(jobId);
        }
      }
    }
    // Reuse the snapshot read above so one poll does not read the job twice.
    const summary = await this.store.traceSummary(jobId, { snapshot: job }).catch((error) => {
      if (error.details?.lastSafeSequence === undefined) return null;
      return { recovery: {
        malformedRecords: error.details.malformedRecords ?? 0,
        lastSafeSequence: error.details.lastSafeSequence,
        error: error.message,
      } };
    });
    if (summary) {
      job.receipt = { ...job.receipt, trace: { ...job.receipt.trace, ...summary } };
    }
    if (job.receipt.state === "running") {
      const progress = job.receipt.trace.progress ?? {};
      const since = progress.lastMeaningfulAt || job.receipt.startedAt || job.receipt.createdAt;
      const inactiveMs = Math.max(0, Date.now() - Date.parse(since));
      const stalled = Number.isFinite(inactiveMs) && inactiveMs >= STALL_WARNING_MS;
      job.receipt.trace.progress = {
        ...progress, stalled,
        stall: stalled ? { since, thresholdMs: STALL_WARNING_MS, reason: "no meaningful downstream activity; worker heartbeat is not progress" } : null,
        activeTool: progress.activeTool ? { ...progress.activeTool, elapsedMs: Math.max(0, Date.now() - Date.parse(progress.activeTool.startedAt)) } : null,
      };
    }
    return assertReceipt(job.receipt);
  }

  async statusByRequestId(requestId) {
    return this.status(await this.store.jobIdForRequest(requestId));
  }

  async statusReference(reference = {}) {
    if (reference.jobId) return this.status(reference.jobId);
    if (reference.requestId) return this.statusByRequestId(reference.requestId);
    throw Object.assign(new TypeError("jobId or requestId is required"), { details: { kind: "validation" } });
  }

  async result(jobId) {
    const receipt = await this.status(jobId);
    if (!TERMINAL_STATES.has(receipt.state)) {
      throw Object.assign(new Error(`job ${jobId} is ${receipt.state}; retrieve status before result`), { details: { kind: "not-terminal", hint: "poll handoff_status until terminal, then call handoff_result" } });
    }
    return receipt;
  }

  async resultReference(reference = {}) {
    const receipt = await this.statusReference(reference);
    if (!TERMINAL_STATES.has(receipt.state)) {
      throw Object.assign(new Error(`job ${receipt.jobId} is ${receipt.state}; retrieve status before result`), { details: { kind: "not-terminal", hint: "poll handoff_status until terminal, then call handoff_result" } });
    }
    return receipt;
  }

  async traceReference(reference = {}, options = {}) {
    const receipt = await this.statusReference(reference);
    const trace = await this.store.readTrace(receipt.jobId, options);
    return { receipt, ...trace };
  }

  async sessions(options = {}) {
    return { sessions: await this.store.listReceipts(options) };
  }

  // Fleet view: how many agents are running, what each is doing right now
  // (progress, last activity, recent messages), and how to steer it at this
  // moment (live message vs resume). Active jobs read through status() so
  // the view is canonical (stale-worker recovery included); terminal jobs
  // use the durable receipt as-is.
  async fleet(options = {}) {
    const recent = options.recent ?? 3;
    if (!Number.isInteger(recent) || recent < 0 || recent > 10) {
      throw Object.assign(new TypeError("fleet recent must be an integer between 0 and 10"), { details: { kind: "validation" } });
    }
    const limit = Math.max(1, Math.min(100, Number(options.limit) || 20));
    const candidates = await this.store.listAllReceipts({ target: options.target });
    const receipts = [];
    for (const receipt of candidates) {
      const full = ["queued", "running"].includes(receipt.state) ? await this.status(receipt.jobId) : receipt;
      if (!options.state || full.state === options.state) receipts.push(full);
    }
    receipts.sort((left, right) => String(right.updatedAt || right.createdAt).localeCompare(String(left.updatedAt || left.createdAt)));
    const byState = {};
    for (const receipt of receipts) byState[receipt.state] = (byState[receipt.state] || 0) + 1;
    const agents = [];
    for (const full of receipts.slice(0, limit)) {
      const receipt = full;
      const job = await this.store.get(full.jobId);
      const ownership = {
        ownerId: job.lease?.ownerId ?? null,
        pid: job.lease?.pid ?? null,
        host: job.lease?.host ?? null,
        local: Boolean(this.running.has(full.jobId) && job.lease?.ownerId === this.ownerId),
      };
      const summary = full.trace?.eventCount != null
        ? { eventCount: full.trace.eventCount, lastActivity: full.trace.lastActivity ?? null, progress: full.trace.progress ?? null }
        : await this.store.traceSummary(receipt.jobId, { snapshot: job }).catch(() => ({ eventCount: 0, lastActivity: null, progress: null }));
      // Progress and recentMessages come from separate store reads, so on a
      // fast-moving job the progress snapshot can be newer than the message
      // window. That is inherent to polling; consumers must treat the view
      // as eventually consistent, never as an atomic snapshot.
      let recentMessages = [];
      if (recent > 0) {
        const tail = await this.store.readTrace(receipt.jobId, { limit: 50 }).catch(() => null);
        recentMessages = (tail?.events || []).slice(-recent).map((entry) => ({
          sequence: entry.sequence,
          at: entry.at,
          activity: entry.activity,
        }));
      }
      agents.push({
        jobId: full.jobId,
        requestId: full.requestId,
        target: full.target,
        route: full.route ? {
          provider: full.route.provider ?? null,
          model: full.route.model ?? null,
        } : null,
        state: full.state,
        progress: summary.progress,
        lastActivity: summary.lastActivity,
        eventCount: summary.eventCount,
        // Uncertain controls are unresolved by definition (reconcile from the
        // trace), so they count as pending alongside accepted ones.
        controlsPending: (full.controls || []).filter((control) => control.state === "accepted" || control.state === "uncertain").length,
        ownership,
        cancellation: full.cancellation ?? null,
        steer: steerFor(full, ownership),
        recentMessages,
      });
    }
    return {
      agents,
      active: (byState.queued || 0) + (byState.running || 0),
      byState,
      total: receipts.length,
      displayed: agents.length,
      limit,
      hasMore: receipts.length > agents.length,
      countsScope: "all-matching-jobs",
    };
  }

  // Peer board: post a message for other workers, or read new ones.
  // No job binding — workers agree a topic out of band (usually handed down
  // by the spawning parent) and talk through it.
  async postToBoard(input = {}) {
    return this.boards.post(input);
  }

  async readBoard(input = {}, options = {}) {
    const { afterSequence, limit, ...reference } = input;
    return this.boards.read({ ...reference, afterSequence, limit, ...options });
  }

  async cancel(jobId) {
    const active = this.running.get(jobId);
    const cancelled = await this.store.transition(jobId, (current) => {
      if (!["queued", "running"].includes(current.receipt.state)) return null;
      if (current.receipt.cancellation) return null;
      current.receipt.cancellation = {
        state: "requested", requestedAt: new Date().toISOString(), requestedBy: this.ownerId,
        acknowledgedAt: null,
      };
      if (current.receipt.state === "queued" && !current.lease) {
        current.receipt.cancellation.state = "acknowledged";
        current.receipt.cancellation.acknowledgedAt = new Date().toISOString();
        current.receipt = terminalReceipt(current.receipt, "cancelled", { error: null, result: null });
      }
      return current;
    }, (current) => ({
      at: new Date().toISOString(),
      activity: current.receipt.cancellation?.state === "requested" ? "cancellation requested" : "cancelled",
      event: { type: "state", state: current.receipt.state, cancellation: current.receipt.cancellation ?? null, error: null },
    }));
    if (cancelled) {
      if (active && (!cancelled.lease || cancelled.lease.ownerId === this.ownerId)) {
        active.job.receipt.cancellation = cancelled.receipt.cancellation;
        active.controller.abort();
      }
      return assertReceipt(cancelled.receipt);
    }
    // Another process may have recorded the cancellation intent first (the
    // graph runner's #stop does exactly that). The owner still owns the live
    // controller, so adopt the intent here and abort: without this, one-shot
    // children keep running until the graph's force-settle window.
    const stored = await this.store.get(jobId).catch(() => null);
    if (active && stored?.receipt?.cancellation?.state === "requested") {
      if (!active.job.receipt.cancellation) active.job.receipt.cancellation = stored.receipt.cancellation;
      active.controller.abort();
    }
    return this.status(jobId);
  }

  async #control(jobId, input, kind) {
    const command = normalizeControl(input, kind);
    const active = this.running.get(jobId);
    if (!active) {
      const current = await this.store.get(jobId);
      if (["queued", "running"].includes(current.receipt.state)) {
        throw Object.assign(new Error(`job ${jobId} is owned by another Harnest process`), {
          details: {
            kind: "control-owner", ownerId: current.lease?.ownerId ?? null,
            pid: current.lease?.pid ?? null, host: current.lease?.host ?? null,
            hint: "send controls through the originating Harnest process; this process supports status/trace and cancellation requests only",
          },
        });
      }
      throw Object.assign(new Error(`job ${jobId} is not active`), {
        details: { kind: "not-active", hint: "controls require a running job; check handoff_status and retry after resume" },
      });
    }

    const existing = active.job.controls?.find((item) => item.commandId === command.commandId);
    if (existing) {
      if (existing.identity !== controlIdentity(command)) {
        throw Object.assign(new Error(`commandId ${command.commandId} already belongs to a different control`), {
          details: { kind: "control-conflict", hint: "mint a fresh commandId for different content; retries must repeat the identical payload" },
        });
      }
      const pending = active.controlPromises.get(command.commandId);
      return pending ? pending : controlSummary(existing);
    }

    const operation = active.controlQueue.catch(() => undefined).then(async () => {
      if (active.job.receipt.state !== "running") {
        throw Object.assign(new Error(`job ${jobId} is ${active.job.receipt.state}; controls require running`), {
          details: { kind: "not-active", hint: "the job already settled; use handoff_resume for a follow-up run" },
        });
      }
      const now = new Date().toISOString();
      const record = {
        ...command,
        identity: controlIdentity(command),
        state: "accepted",
        requestedAt: now,
        updatedAt: now,
        effect: kind === "reroute" ? "next_model_request" : (command.delivery === "steer" ? "next_agent_step" : "next_turn"),
        acknowledgement: null,
        error: null,
      };
      active.job.controls ||= [];
      active.job.controls.push(record);
      active.job.receipt = {
        ...active.job.receipt,
        controls: active.job.controls.map(controlSummary),
      };
      const accepted = await this.store.commit(active.job, {
        at: now,
        activity: `control ${command.commandId} accepted`,
        event: { type: "control", commandId: command.commandId, kind, state: "accepted" },
      }, { expectedLeaseOwner: this.ownerId });
      if (!accepted) {
        throw Object.assign(new Error(`job ${jobId} lease was lost before control delivery`), {
          details: { kind: "lease-lost", hint: "re-read handoff_status; the worker may have crashed and the job may be resumable" },
        });
      }

      try {
        const deadline = Date.now() + 10_000;
        while (!active.adapter?.control && Date.now() < deadline && active.job.receipt.state === "running") {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        if (!active.adapter?.control) throw Object.assign(new Error(`${active.job.request.target} adapter does not support live controls`), {
          details: { kind: "unsupported-control" },
        });
        record.acknowledgement = await active.adapter.control(command, active.controller.signal);
        const acknowledgement = record.acknowledgement;
        record.state = acknowledgement?.rejected === true ? "rejected"
          : acknowledgement?.acknowledged === false || acknowledgement?.queued === true || acknowledgement?.applied === false ? "uncertain" : "applied";
        if (record.state === "uncertain") record.effect = "delivery_unconfirmed";
      } catch (error) {
        record.state = error?.details?.uncertain ? "uncertain" : "rejected";
        record.error = safeError(error);
      }
      record.updatedAt = new Date().toISOString();
      active.job.receipt = {
        ...active.job.receipt,
        controls: active.job.controls.map(controlSummary),
      };
      const written = await this.store.commit(active.job, {
        at: record.updatedAt,
        activity: `control ${command.commandId} ${record.state}`,
        event: {
          type: "control",
          commandId: command.commandId,
          kind,
          state: record.state,
          acknowledgement: record.acknowledgement,
          error: record.error,
        },
      }, { expectedLeaseOwner: this.ownerId });
      if (!written) {
        const current = await this.store.get(jobId).catch(() => null);
        const durable = current?.receipt?.controls?.find((item) => item.commandId === command.commandId);
        if (durable) return durable;
        throw Object.assign(new Error(`job ${jobId} lease was lost while persisting control acknowledgement`), {
          details: { kind: "lease-lost", hint: "re-read handoff_status and handoff_trace to reconcile whether the control applied" },
        });
      }
      return controlSummary(record);
    });
    active.controlQueue = operation;
    active.controlPromises.set(command.commandId, operation);
    operation.finally(() => active.controlPromises.delete(command.commandId)).catch(() => {});
    return operation;
  }

  async message(jobId, input = {}) {
    return this.#control(jobId, input, "message");
  }

  async reroute(jobId, input = {}) {
    return this.#control(jobId, input, "reroute");
  }

  async resume(jobId, overrides = {}) {
    await this.status(jobId);
    const previous = await this.store.get(jobId);
    if (previous.receipt.cleanupError || previous.receipt.error?.details?.unsafeResume || previous.receipt.error?.details?.cleanupError?.length) {
      throw Object.assign(new Error("native session cleanup is uncertain; reconcile its owner before retrying"), { details: { kind: "unsafe-resume" } });
    }
    if (!TERMINAL_STATES.has(previous.receipt.state)) {
      throw Object.assign(new Error(`job ${jobId} is not terminal`), { details: { kind: "not-terminal", hint: "resume requires a settled job; poll handoff_status first" } });
    }
    if (previous.receipt.state === "completed" && (typeof overrides.task !== "string" || !overrides.task.trim())) {
      throw Object.assign(new Error(`job ${jobId} completed; an explicit follow-up task is required`), {
        details: { kind: "follow-up-required", hint: "start a new handoff with a fresh requestId and execution.sessionId from this receipt, or supply task when resuming the handoff" },
      });
    }
    const request = {
      ...previous.request,
      ...overrides,
      requestId: previous.request.requestId,
      context: previous.request.context,
      contextDigest: previous.request.contextDigest,
      execution: {
        ...previous.request.execution,
        ...overrides.execution,
        sessionId: previous.receipt.sessionId || previous.request.execution.sessionId,
        ...(previous.request.execution.sessionAction === "fork" && previous.receipt.sessionId
          ? { sessionAction: overrides.execution?.sessionAction ?? "resume" } : {}),
      },
      metadata: {
        ...previous.request.metadata,
        ...overrides.metadata,
        resumeOf: jobId,
      },
    };
    return this.start(request, { resumeOf: jobId });
  }
}
