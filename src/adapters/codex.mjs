import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { harnessLaunch } from "../config.mjs";
import { NativeLaunchError, spawnNativeCommand } from "../launch-command.mjs";
import { CODEX_QUOTA_SOURCE, probeCodexQuota } from "../codex-quota.mjs";
import { assertNoClaudeRoute } from "../model-policy.mjs";
import { assertPromptOnlyWorkflow } from "../one-shot-policy.mjs";
import { digestContext, routeControlError } from "../protocol.mjs";
import {
  boundedProviderText,
  classifyProviderFailure,
  mergeProcessEnv,
  parseJsonLine,
  providerErrorFromEvent,
  runProcess,
} from "../process.mjs";
import { structuredResult } from "../result.mjs";
import { summarizeUsage } from "../usage.mjs";
import { requireRouteVersion } from "./route-version.mjs";

export const CODEX_SUPPORTED_POLICY_HELP = "codex exec maps read-only policy to --sandbox read-only and write policy to --sandbox workspace-write. Danger-full-access and --dangerously-bypass-approvals are never used. Granular policy.tools and policy.maxCostUsd have no CLI equivalent and are rejected rather than silently weakened.";

function adapterError(message, kind, details = {}) {
  const error = new Error(message);
  error.name = "CodexAdapterError";
  error.details = { kind, ...details };
  return error;
}

function reportProgress(onProgress, event) {
  if (!onProgress) return;
  const failed = (cause) => {
    throw adapterError(`Codex progress callback failed: ${boundedProviderText(cause?.message || String(cause))}`, "transport", { phase: "progress", cause });
  };
  try {
    const pending = onProgress(event);
    return pending && typeof pending.then === "function" ? Promise.resolve(pending).catch(failed) : undefined;
  } catch (cause) {
    return failed(cause);
  }
}

function isPolicySupported(policy = {}) {
  const tools = Array.isArray(policy.tools) ? policy.tools : [];
  const maxCost = policy.maxCostUsd;
  if (tools.length > 0) return { supported: false, reason: "policy.tools granular filtering is not supported by codex exec; no per-tool CLI flag exists" };
  if (maxCost != null) return { supported: false, reason: "policy.maxCostUsd budget enforcement is not supported by codex exec" };
  return { supported: true };
}

// Field order is a prompt-cache contract: stable context first, then the
// variable task, requestId and route. A provider prefix cache can only match
// leading bytes, so identifiers that change per attempt must not lead.
function handoffEnvelope(request) {
  return {
    protocolVersion: request.protocolVersion || "1.0",
    contextDigest: request.contextDigest || digestContext(request.context),
    context: request.context ?? null,
    flowSpec: request.workflow?.spec || null,
    cwd: request.cwd,
    policy: request.policy || { write: false, tools: [], maxCostUsd: null },
    task: request.task,
    requestId: request.requestId,
    route: request.route || {},
  };
}

function promptFor(request) {
  const envelope = JSON.stringify(handoffEnvelope(request));
  const intro = "Execute the complete assigned workflow. Preserve the request and context identifiers exactly. Return the final answer for this phase.";
  return `${intro}\n\n${envelope}`;
}

function resolvedModel(route = {}) {
  const model = typeof route.model === "string" && route.model.trim() ? route.model.trim() : null;
  if (model && !/^[a-zA-Z0-9._/[\]=,+-]+$/.test(model)) {
    throw adapterError("Codex route model contains unsupported characters", "policy", { model });
  }
  return model;
}

// Codex matches ReasoningEffort case-sensitively (lowercase only), so
// normalize here and echo the same value in the receipt route.
function resolvedThinking(route = {}) {
  const thinking = typeof route?.thinking === "string" && route.thinking.trim()
    ? route.thinking.trim().toLowerCase()
    : null;
  return thinking;
}

function unknownQuota(reason = "probe-failed") {
  return { status: "unknown", source: CODEX_QUOTA_SOURCE, observedAt: Date.now(), reason };
}

function quotaWarning(quota) {
  if (quota?.status !== "available") return null;
  const highUsage = Number.isFinite(quota.usedPercent) && quota.usedPercent >= 95;
  if (!highUsage && quota.ordinaryUsageAllowed !== false) return null;
  const reset = Number.isFinite(quota.resetsAt) ? `; resets at ${quota.resetsAt}` : "";
  const permission = quota.ordinaryUsageAllowed === false ? "ordinaryUsageAllowed=false" : `${quota.usedPercent}% used`;
  return {
    type: "codex_quota",
    status: "warning",
    text: `Codex native quota warning: ${permission}${reset}`.slice(0, 240),
    quota,
  };
}

function buildArgs(request, launchArgs, outFile) {
  const args = [...launchArgs, "exec"];
  const policy = request.policy || {};
  const sessionId = request.execution?.sessionId;
  args.push("-C", request.cwd);
  args.push("-s", policy.write ? "workspace-write" : "read-only");
  const model = resolvedModel(request.route || {});
  if (model) args.push("-m", model);
  // Preserve the caller's effort as a native Codex config override.
  const thinking = resolvedThinking(request.route || {});
  if (thinking) args.push("-c", `model_reasoning_effort="${thinking}"`);
  const { profile, serviceTier } = request.route || {};
  if (profile) args.push("--profile", profile);
  if (serviceTier) args.push("--strict-config", "-c", `service_tier="${serviceTier}"`);
  if (serviceTier === "fast" || serviceTier === "priority") args.push("--enable", "fast_mode");
  args.push("--json", "-o", outFile);
  if (sessionId) args.push("resume", String(sessionId));
  args.push("-");
  return args;
}

async function verifyRouteControls(command, launchArgs, route, options) {
  const { profile, serviceTier } = route;
  if (!profile && !serviceTier) return;
  const field = profile ? "route.profile" : "route.serviceTier";
  // Codex 0.170.0 defines the profile overlay and the documented service tier IDs.
  await requireRouteVersion(command, launchArgs, options, "codex-cli ", [0, 170, 0], field);
  if (profile) {
    const configuredHome = options.env.CODEX_HOME;
    const userHome = options.env[process.platform === "win32" ? "USERPROFILE" : "HOME"] || homedir();
    const codexHome = configuredHome ? resolve(options.cwd, configuredHome) : join(userHome, ".codex");
    const profileFile = await stat(join(codexHome, `${profile}.config.toml`)).catch(() => null);
    if (!profileFile?.isFile()) throw adapterError(`Codex route.profile "${profile}" has no native config file`, "policy", { field });
  }
  if (serviceTier === "fast" || serviceTier === "priority") {
    // Codex drops priority when fast_mode is disabled. Use the same run-level
    // feature override in the probe and exec so profile defaults cannot mask it.
    const { stdout } = await runProcess(command, [
      ...launchArgs, "features", "--enable", "fast_mode", "list",
    ], { ...options, timeoutMs: 5_000 });
    if (!/^fast_mode\s+\S+\s+true\s*$/m.test(stdout)) {
      throw adapterError("Codex route.serviceTier requires the native fast_mode feature", "policy", { field: "route.serviceTier" });
    }
  }
}

function executionSignal(parentSignal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  if (parentSignal) {
    if (parentSignal.aborted) controller.abort();
    else parentSignal.addEventListener("abort", abort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs || 3_600_000);
  timer.unref?.();
  return {
    signal: controller.signal,
    state: { get timedOut() { return timedOut; }, get aborted() { return controller.signal.aborted; } },
    dispose() {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", abort);
    },
  };
}

function processFailure(error, state) {
  const details = error?.details || {};
  if (details.cause?.name === "CodexAdapterError" && details.cause.details?.phase === "progress") return details.cause;
  if (error?.details?.kind === "policy") return error;
  if (details.timedOut || state?.timedOut) {
    return adapterError("Codex execution timed out", "timeout", { ...details, kind: "timeout", timedOut: true, aborted: false });
  }
  if (details.aborted || state?.aborted) {
    return adapterError("Codex execution aborted", "abort", { ...details, kind: "abort", aborted: true });
  }
  if (details.kind === "transport" || /ENOENT|EACCES|spawn .* ENOENT/i.test(error?.message || "")) {
    return adapterError(`Codex harness unavailable: ${error?.message || "spawn failed"}`, "transport", {
      ...details,
      kind: "transport",
      hint: "install codex CLI and ensure it is on PATH, or set HARNEST_CODEX",
    });
  }
  const kind = ["transport", "downstream", "policy", "unsupported-control"].includes(details.kind) ? details.kind : "downstream";
  return adapterError(error?.message || "Codex process failed", kind, details);
}

// Best-effort scan of --json JSONL for a thread/session id and assistant text.
// The -o file is authoritative for finalText; this only feeds live deltas.
function scanEvent(line, found) {
  const event = parseJsonLine(line);
  if (!event || typeof event !== "object") return;
  const record = event.data && typeof event.data === "object" ? { ...event, ...event.data } : event;
  for (const key of ["session_id", "sessionId", "thread_id", "threadId", "conversation_id"]) {
    if (typeof record[key] === "string" && record[key] && !found.sessionId) found.sessionId = record[key];
  }
  const item = record.item;
  const text = (item?.type === "agent_message" ? item.text : "") || event.text || record.text || record.message || record.content || record.delta || "";
  const delta = typeof text === "string" && text.trim() ? text.slice(0, 2000) : "";
  if (delta) found.deltaCount += 1;
  if (event.type === "turn.completed" && record.usage && typeof record.usage === "object") {
    found.usage ??= {};
    for (const key of ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens"]) {
      const value = record.usage[key];
      if (Number.isFinite(value) && value >= 0) found.usage[key] = (found.usage[key] || 0) + value;
    }
  }
  return { event: record, text: delta };
}

const CODEX_PROVIDER = "openai/codex";
const MAX_CODEX_WARNINGS = 20;

const KNOWN_CODEX_WARNING_PATTERNS = [
  /\bfeatures\.rmcp_client is ignored\b/i,
  /\bOAuth tokens for server openrouter cannot be refreshed\b/i,
];

function codexStderrDiagnostics(stderr) {
  const warnings = [];
  const remaining = [];
  for (const line of String(stderr || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed && KNOWN_CODEX_WARNING_PATTERNS.some((pattern) => pattern.test(trimmed))) {
      const warning = boundedProviderText(trimmed);
      if (warning && warnings.length < MAX_CODEX_WARNINGS && !warnings.includes(warning)) warnings.push(warning);
    } else {
      remaining.push(line);
    }
  }
  return { stderr: remaining.join("\n").trim(), warnings };
}

function warningDetails(warnings) {
  return warnings.length ? { warnings } : {};
}

function withWarnings(error, warnings) {
  if (error?.details && warnings.length) error.details = { ...error.details, warnings };
  return error;
}

function boundedToolField(value, maxChars) {
  return typeof value === "string" && value.trim() ? boundedProviderText(value, maxChars) : null;
}

function codexToolEvent(event, item) {
  const phase = event?.type === "item.started" ? "started" : event?.type === "item.completed" ? "completed" : null;
  if (!phase || !item || typeof item !== "object") return null;
  let tool = null;
  if (item.type === "command_execution") {
    tool = "command_execution";
  } else if (item.type === "mcp_tool_call") {
    const server = boundedToolField(item.server ?? item.server_name ?? item.serverName, 80);
    const name = boundedToolField(item.tool ?? item.tool_name ?? item.toolName ?? item.name, 80);
    tool = server && name ? `${server}/${name}` : name || server || "mcp_tool_call";
  }
  if (!tool) return null;
  return {
    type: "codex_tool",
    phase,
    tool: tool.slice(0, 160),
    callId: boundedToolField(item.id, 160),
    status: boundedToolField(item.status, 80),
    text: `${phase} ${tool}`.slice(0, 240),
  };
}

async function defaultGitCheck(cwd, { signal, timeoutMs, spawnFn } = {}) {
  const requestedTimeout = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10_000;
  const result = await runProcess("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"], {
    cwd,
    signal,
    spawnFn: spawnFn || spawnNativeCommand,
    timeoutMs: Math.min(requestedTimeout, 10_000),
  });
  return result.stdout.trim() === "true";
}

async function requireGitWorktree(check, cwd, options) {
  try {
    if (await check(cwd, options)) return;
    throw adapterError("Codex requires cwd inside a Git worktree", "validation", { cwd });
  } catch (error) {
    if (error?.name === "CodexAdapterError" || error?.details?.aborted || error?.details?.timedOut) throw error;
    if (error instanceof NativeLaunchError || error?.details?.kind === "transport" || /ENOENT|EACCES|spawn git/i.test(error?.message || "")) {
      throw adapterError("Git executable is unavailable for the Codex cwd preflight", "transport", {
        kind: "transport",
        code: error?.details?.code ?? error?.code ?? null,
        hint: "install Git and ensure it is on PATH before launching Codex",
      });
    }
    const reason = boundedProviderText(error?.details?.stderr || error?.message || "Git did not recognize the directory as a worktree");
    throw adapterError("Codex requires cwd inside a Git worktree", "validation", { cwd, reason });
  }
}

function codexProviderHint(classification) {
  if (classification.category === "region") {
    return "the OpenAI provider rejected this run for a regional or opt-in restriction; enable the provider for this region or reroute";
  }
  if (classification.category === "billing") {
    return "the OpenAI account reported an exhausted or unpaid balance; top up the account or reroute";
  }
  if (classification.kind === "unavailable") {
    return "codex reported the requested model as unavailable; verify route.model against the models this account can access";
  }
  return "codex has no usable OpenAI credential; run `codex login` — Harnest never reads, stores, or forwards provider secrets";
}

// Codex failures arrive as text; recover an inline HTTP status so the shared
// classifier can treat 401/402/403 as authorization evidence.
function statusFromErrorText(text) {
  const match = /\b(?:http(?:\s+status)?|status(?:\s+code)?)[\s:=]*(401|402|403|404|429)\b/i.exec(String(text || ""))
    || /\b(401|402|403)\b/.exec(String(text || ""));
  return match ? Number(match[1]) : null;
}

/**
 * Codex reports provider failures through `--json` error events
 * (`{"type":"error"|"turn.failed",...}`) and, when it exits before emitting
 * one, as stderr text. Both are bounded and handed to the shared classifier;
 * null keeps the adapter's timeout/transport/downstream mapping.
 */
function providerFailureFromCodexOutput({ event = null, stderr = "" } = {}) {
  const candidates = [];
  if (event) {
    const extracted = providerErrorFromEvent(event);
    if (extracted) candidates.push(extracted);
  }
  const stderrLines = String(stderr || "").split(/\r?\n/);
  for (let index = stderrLines.length - 1; index >= 0; index -= 1) {
    const line = stderrLines[index].trim();
    if (line) candidates.push({ type: null, message: line, status: statusFromErrorText(line) });
  }
  for (const candidate of candidates) {
    const classification = classifyProviderFailure(candidate);
    if (!classification) continue;
    const status = candidate.status ?? null;
    const reason = boundedProviderText(candidate.message || "Codex provider request failed");
    const label = classification.kind === "provider-auth" ? "provider authorization" : "model availability";
    return adapterError(
      `Codex ${label} failure for ${CODEX_PROVIDER}${status !== null ? ` (HTTP ${status})` : ""}: ${reason}`,
      classification.kind,
      {
        category: classification.category,
        provider: CODEX_PROVIDER,
        status,
        providerError: { type: candidate.type || null, message: reason, status },
        hint: codexProviderHint(classification),
      },
    );
  }
  return null;
}

export class CodexAdapter {
  constructor(options = {}) {
    const injected = options.launch || options.command || options.executable || options.bin;
    this.launch = harnessLaunch("codex", injected);
    this.spawnFn = options.spawnFn;
    this.gitSpawnFn = options.gitSpawnFn;
    this.gitCheckFn = options.gitCheckFn || defaultGitCheck;
    this.quotaProbeFn = options.quotaProbeFn || probeCodexQuota;
    this.quotaSpawnFn = options.quotaSpawnFn;
    this.quotaTimeoutMs = Number.isSafeInteger(options.quotaTimeoutMs) && options.quotaTimeoutMs > 0
      ? options.quotaTimeoutMs
      : 5_000;
    this.env = options.env || {};
  }

  async run(request, { signal, onProgress } = {}) {
    assertPromptOnlyWorkflow("codex", request?.workflow);
    assertNoClaudeRoute("codex", request?.route);
    if (!request || typeof request !== "object") throw new TypeError("request must be an object");
    const controlError = routeControlError("codex", request.route, request.execution?.transport);
    if (controlError) throw adapterError(controlError, "policy");
    const policyCheck = isPolicySupported(request.policy || {});
    if (!policyCheck.supported) {
      throw adapterError(`Codex policy not supported: ${policyCheck.reason} — ${CODEX_SUPPORTED_POLICY_HELP}`, "policy", { reason: policyCheck.reason });
    }
    const execution = executionSignal(signal, request.execution?.timeoutMs);
    let scratch = null;
    let outFile = null;
    const found = { sessionId: request.execution?.sessionId || null, deltaCount: 0, toolCount: 0, usage: null, turnFailed: false };
    let quota = unknownQuota("not-probed");
    let quotaEventCount = 0;
    let streamError = null;
    try {
      if (execution.signal.aborted) {
        throw adapterError(execution.state.timedOut ? "Codex execution timed out" : "Codex execution aborted", execution.state.timedOut ? "timeout" : "abort", {
          aborted: !execution.state.timedOut,
          timedOut: execution.state.timedOut,
        });
      }
      await requireGitWorktree(this.gitCheckFn, request.cwd, {
        signal: execution.signal,
        timeoutMs: request.execution?.timeoutMs,
        spawnFn: this.gitSpawnFn,
      });
      const launchArgs = Array.isArray(this.launch.args) ? this.launch.args : [];
      const processOptions = {
        cwd: request.cwd,
        env: mergeProcessEnv({ ...(this.launch.env || {}), ...this.env }),
        spawnFn: this.spawnFn || spawnNativeCommand,
        signal: execution.signal,
      };
      await verifyRouteControls(this.launch.command, launchArgs, request.route || {}, processOptions);
      try {
        quota = await this.quotaProbeFn({
          launch: this.launch,
          spawnFn: this.quotaSpawnFn,
          cwd: request.cwd,
          env: this.env,
          signal: execution.signal,
          timeoutMs: Math.min(this.quotaTimeoutMs, request.execution?.timeoutMs || this.quotaTimeoutMs),
        });
      } catch {
        quota = unknownQuota();
      }
      if (execution.signal.aborted) {
        throw adapterError(execution.state.timedOut ? "Codex execution timed out" : "Codex execution aborted", execution.state.timedOut ? "timeout" : "abort", {
          aborted: !execution.state.timedOut,
          timedOut: execution.state.timedOut,
        });
      }
      const warning = quotaWarning(quota);
      if (warning) {
        quotaEventCount = 1;
        if (onProgress) await reportProgress(onProgress, warning);
      }
      scratch = await mkdtemp(join(tmpdir(), "harnest-codex-"));
      outFile = join(scratch, "final.txt");
      const args = buildArgs(request, launchArgs, outFile);
      const result = await runProcess(this.launch.command, args, {
        ...processOptions,
        timeoutMs: request.execution?.timeoutMs,
        stdinLines: [promptFor(request)],
        onStdoutLine: (line) => {
          const priorSession = found.sessionId;
          const scanned = scanEvent(line, found);
          if (!scanned) return;
          const { event, text } = scanned;
          const toolEvent = codexToolEvent(event, event.item);
          if (toolEvent) found.toolCount += 1;
          if (event.type === "error" || event.type === "turn.failed" || event.error) {
            if (event.type === "turn.failed") found.turnFailed = true;
            const failure = providerFailureFromCodexOutput({ event });
            if (!streamError || failure) streamError = failure || adapterError("Codex stream reported an error", "downstream", {
              providerError: providerErrorFromEvent(event),
            });
          }
          if (onProgress && toolEvent) return reportProgress(onProgress, toolEvent);
          if (onProgress && (text || found.sessionId !== priorSession || event.type === "turn.completed")) {
            return reportProgress(onProgress, { type: "codex_delta", text, sessionId: found.sessionId,
              workflowRunId: `codex:${request.requestId}`, usage: found.usage ? { ...found.usage } : null });
          }
        },
      });
      const diagnostics = codexStderrDiagnostics(result.stderr);
      const finalText = String(await readFile(outFile, "utf8").catch(() => "")).trim();
      if (request.route?.serviceTier && found.turnFailed) throw withWarnings(streamError, diagnostics.warnings);
      if (!finalText) {
        const providerFailure = (streamError?.details.kind !== "downstream" ? streamError : null)
          || providerFailureFromCodexOutput({ stderr: diagnostics.stderr });
        if (providerFailure) throw withWarnings(providerFailure, diagnostics.warnings);
        if (streamError) throw withWarnings(streamError, diagnostics.warnings);
        throw adapterError("Codex completed without final output (last-message file empty)", "downstream", {
          code: result.code,
          stderr: diagnostics.stderr.slice(0, 4000),
          stdout: String(result.stdout || "").slice(0, 4000),
          ...warningDetails(diagnostics.warnings),
        });
      }
      if (onProgress) {
        await reportProgress(onProgress, { type: "codex_stdout", text: finalText.slice(0, 2000) });
      }
      const route = request.route || {};
      return {
        sessionId: found.sessionId,
        workflowRunId: `codex:${request.requestId}`,
        route: {
          harness: "codex",
          provider: typeof route.provider === "string" && route.provider ? route.provider : "openai",
          model: typeof route.model === "string" && route.model ? route.model : "default",
          variant: null,
          thinking: resolvedThinking(route),
          ...(route.profile ? { profile: route.profile } : {}),
          ...(route.serviceTier ? { serviceTier: route.serviceTier } : {}),
          requested: route,
        },
        result: structuredResult(finalText, {
          eventSummary: {
            count: found.deltaCount + found.toolCount + quotaEventCount + 1,
            types: ["codex_stdout", ...(quotaEventCount ? ["codex_quota"] : []), ...(found.deltaCount ? ["codex_delta"] : []), ...(found.toolCount ? ["codex_tool"] : [])],
          },
          quota,
          ...warningDetails(diagnostics.warnings),
        }),
        usage: found.usage,
        usageSummary: summarizeUsage("codex", found.usage),
      };
    } catch (error) {
      if (error instanceof NativeLaunchError || error?.name === "CodexAdapterError") throw error;
      const aborted = Boolean(error?.details?.aborted || execution.state.aborted);
      const timedOut = Boolean(error?.details?.timedOut || execution.state.timedOut);
      const diagnostics = codexStderrDiagnostics(error?.details?.stderr);
      if (error?.details && Object.hasOwn(error.details, "stderr")) {
        error.details = { ...error.details, stderr: diagnostics.stderr, ...warningDetails(diagnostics.warnings) };
      }
      if (!aborted && !timedOut && !["transport", "output-limit"].includes(error?.details?.kind)) {
        if (streamError && streamError.details.kind !== "downstream") throw withWarnings(streamError, diagnostics.warnings);
        const providerFailure = providerFailureFromCodexOutput({
          stderr: diagnostics.stderr,
        });
        if (providerFailure) throw withWarnings(providerFailure, diagnostics.warnings);
        if (streamError) throw withWarnings(streamError, diagnostics.warnings);
      }
      throw processFailure(error, execution.state);
    } finally {
      execution.dispose();
      if (scratch) await rm(scratch, { recursive: true, force: true });
    }
  }

  async control(_command, _signal) {
    throw Object.assign(new Error("codex exec is one-shot and does not support live message/reroute controls; resume with execution.sessionId instead"), {
      name: "CodexAdapterError",
      details: { kind: "unsupported-control" },
    });
  }
}

export default CodexAdapter;
