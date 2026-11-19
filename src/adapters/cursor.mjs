import { harnessLaunch } from "../config.mjs";
import { NativeLaunchError, spawnNativeCommand } from "../launch-command.mjs";
import { assertNoClaudeRoute } from "../model-policy.mjs";
import { assertPromptOnlyWorkflow } from "../one-shot-policy.mjs";
import { digestContext, hasToolPolicy, normalizePolicyControls } from "../protocol.mjs";
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

export const CURSOR_SUPPORTED_POLICY_HELP = "Cursor print mode supports policy.mode=plan and policy.sandbox=true. Read-only defaults to --mode ask. Approved write work uses --force only in agent mode. Granular tools, budgets, and disabling the sandbox are unsupported.";

function adapterError(message, kind, details = {}) {
  const error = new Error(message);
  error.name = "CursorAdapterError";
  error.details = { kind, ...details };
  return error;
}

function reportProgress(onProgress, event) {
  if (!onProgress) return;
  const failed = (cause) => {
    throw adapterError(`Cursor progress callback failed: ${boundedProviderText(cause?.message || String(cause))}`, "transport", { phase: "progress", cause });
  };
  try {
    const pending = onProgress(event);
    return pending && typeof pending.then === "function" ? Promise.resolve(pending).catch(failed) : undefined;
  } catch (cause) {
    return failed(cause);
  }
}

function isPolicySupported(policy = {}) {
  const { tools, sandbox } = normalizePolicyControls(policy);
  const maxCost = policy.maxCostUsd;
  if (hasToolPolicy(tools)) return { supported: false, reason: "policy.tools granular filtering is not supported by cursor-agent print mode; no per-tool CLI flag exists" };
  if (sandbox === false) return { supported: false, reason: "policy.sandbox=false could disable isolation required by Cursor configuration; omit the field to inherit it" };
  if (maxCost != null) return { supported: false, reason: "policy.maxCostUsd budget enforcement is not supported by cursor-agent CLI" };
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
  const provider = typeof route.provider === "string" && route.provider.trim() ? route.provider.trim() : null;
  const safe = /^[a-zA-Z0-9._/[\]=,+-]+$/;
  if (model && !safe.test(model)) throw adapterError("Cursor route model contains unsupported characters", "policy", { model });
  if (provider && !/^[a-zA-Z0-9._/-]+$/.test(provider)) throw adapterError("Cursor route provider contains unsupported characters", "policy", { provider });
  return { provider, model };
}

// cursor-agent has no reasoning-effort flag; thinking must ride in the model
// ID. Silently dropping route.thinking would run a route the caller did not ask
// for, so reject it like the unsupported policy controls.
function assertThinkingEncodedInModel(route = {}) {
  const thinking = route?.thinking;
  if (thinking == null || (typeof thinking === "string" && !thinking.trim())) return;
  throw adapterError(
    "Cursor route.thinking is not supported: encode thinking in route.model (for example claude-opus-5-thinking-high) — cursor-agent print mode has no reasoning-effort flag",
    "policy",
    { thinking, hint: "set route.model to a thinking-capable model ID instead of route.thinking" },
  );
}

function buildArgs(request, launchArgs) {
  const args = [...launchArgs];
  const policy = request.policy || {};
  const { model } = resolvedModel(request.route || {});
  const sessionId = request.execution?.sessionId;
  if (sessionId) args.push("--resume", String(sessionId));
  args.push("--trust", "-p", "--output-format", "stream-json", "--stream-partial-output");
  args.push(...cursorPolicyFlags(policy));
  if (model) args.push("--model", model);
  args.push("--workspace", request.cwd);
  args.push(promptFor(request));
  return args;
}

function cursorPolicyFlags(policy) {
  const mode = policy.mode ?? (policy.write ? "agent" : "ask");
  const flags = mode === "agent" ? [] : ["--mode", mode];
  // Force can approve commands that Cursor would otherwise reject outside its sandbox.
  if (policy.sandbox === true) flags.push("--sandbox", "enabled");
  else if (mode === "agent") flags.push("--force");
  return flags;
}

function launchDiagnostics(request) {
  const policy = request.policy || {};
  const { model } = resolvedModel(request.route || {});
  const flags = [];
  if (request.execution?.sessionId) flags.push("--resume");
  flags.push("--trust", "-p", "--output-format", "stream-json", "--stream-partial-output");
  flags.push(...cursorPolicyFlags(policy));
  if (model) flags.push("--model");
  flags.push("--workspace");
  return {
    effectivePolicy: {
      write: Boolean(policy.write) && policy.mode !== "plan",
      mode: policy.mode ?? (policy.write ? "agent" : "ask"),
      ...(policy.sandbox === true ? { sandbox: true } : {}),
    },
    launchFlags: flags,
  };
}

function attachExecution(error, execution) {
  if (!error || typeof error !== "object") return error;
  error.details = { ...(error.details || {}), execution };
  return error;
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
  if (details.cause?.name === "CursorAdapterError" && details.cause.details?.phase === "progress") return details.cause;
  if (error?.details?.kind === "policy") return error;
  if (details.timedOut || state?.timedOut) {
    return adapterError("Cursor execution timed out", "timeout", { ...details, kind: "timeout", timedOut: true, aborted: false });
  }
  if (details.aborted || state?.aborted) {
    return adapterError("Cursor execution aborted", "abort", { ...details, kind: "abort", aborted: true });
  }
  if (details.kind === "transport" || /ENOENT|EACCES|spawn .* ENOENT/i.test(error?.message || "")) {
    return adapterError(`Cursor harness unavailable: ${error?.message || "spawn failed"}`, "transport", {
      ...details,
      kind: "transport",
      hint: "install cursor-agent and ensure it is on PATH, or set HARNEST_CURSOR",
    });
  }
  const kind = ["transport", "downstream", "policy", "unsupported-control"].includes(details.kind) ? details.kind : "downstream";
  return adapterError(error?.message || "Cursor process failed", kind, details);
}

const CURSOR_PROVIDER = "cursor";

function cursorProviderHint(classification) {
  if (classification.category === "region") {
    return "the provider rejected this run for a regional or opt-in restriction; enable the provider for this region or reroute";
  }
  if (classification.category === "billing") {
    return "the provider reported an exhausted or unpaid balance; top up the account or reroute";
  }
  if (classification.kind === "unavailable") {
    return "cursor-agent reported the requested model as unavailable; verify route.model with `cursor-agent --list-models`";
  }
  return "cursor-agent has no usable credential; run `cursor-agent login` — Harnest never reads, stores, or forwards provider secrets";
}

// cursor-agent print-mode failures arrive as text; recover an inline HTTP
// status so the shared classifier can treat 401/402/403 as authorization
// evidence.
function statusFromErrorText(text) {
  const match = /\b(?:http(?:\s+status)?|status(?:\s+code)?)[\s:=]*(401|402|403|404|429)\b/i.exec(String(text || ""))
    || /\b(401|402|403)\b/.exec(String(text || ""));
  return match ? Number(match[1]) : null;
}

function lastNonEmptyLine(text) {
  const lines = String(text || "").split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (line) return line;
  }
  return "";
}

/**
 * cursor-agent print mode reports provider failures as text (`Error:
 * Authentication required…` on stderr, or a plain stdout line) and can emit a
 * JSON `error` event. Build bounded candidates from each surface and let the
 * shared classifier decide; null keeps the existing downstream mapping.
 */
function providerFailureFromCursorOutput({ event = null, terminal = null, text = "", stderr = "" } = {}) {
  const candidates = [];
  for (const record of [terminal, event]) {
    const extracted = providerErrorFromEvent(record);
    if (extracted) candidates.push(extracted);
  }
  if (terminal) {
    const message = [typeof terminal.result === "string" ? terminal.result : "",
      ...(Array.isArray(terminal.errors) ? terminal.errors.filter((value) => typeof value === "string").slice(0, 10) : [])].join("; ");
    if (message) candidates.push({ message, status: terminal.status ?? statusFromErrorText(message) });
  }
  for (const value of [stderr, text]) {
    const line = lastNonEmptyLine(value);
    if (line && !parseJsonLine(line)) candidates.push({ type: null, message: line, status: statusFromErrorText(line) });
  }
  for (const candidate of candidates) {
    const classification = classifyProviderFailure(candidate);
    if (!classification) continue;
    const status = candidate.status ?? null;
    const reason = boundedProviderText(candidate.message || "Cursor provider request failed");
    const label = classification.kind === "provider-auth" ? "provider authorization" : "model availability";
    return adapterError(
      `Cursor ${label} failure for ${CURSOR_PROVIDER}${status !== null ? ` (HTTP ${status})` : ""}: ${reason}`,
      classification.kind,
      {
        category: classification.category,
        provider: CURSOR_PROVIDER,
        status,
        providerError: { type: candidate.type || null, message: reason, status },
        hint: cursorProviderHint(classification),
      },
    );
  }
  return null;
}

function terminalFailure(terminal) {
  const permissionDenials = Array.isArray(terminal.permission_denials)
    ? terminal.permission_denials.slice(0, 10).map((denial) => {
      if (!denial || typeof denial !== "object") return { reason: boundedProviderText(denial) };
      return {
        toolName: typeof denial.tool_name === "string" ? boundedProviderText(denial.tool_name) : null,
        toolUseId: typeof denial.tool_use_id === "string" ? boundedProviderText(denial.tool_use_id) : null,
      };
    })
    : [];
  if (permissionDenials.length) {
    return adapterError("Cursor reported permission denials; the requested work was not completed", "downstream", {
      permissionDenials,
    });
  }
  const finalText = typeof terminal.result === "string" ? terminal.result.trim() : "";
  const outcomeText = finalText.replace(/^Blocked[.!:]\s*/i, "");
  const allToolsDenied = /^(?:every|all) tool calls? (?:was|were|is|are|has been|have been) (?:blocked|rejected|denied)\b/i.test(outcomeText);
  const preventedExecution = /\bbefore (?:it|they|any of them) (?:ran|could run)\b/i.test(finalText)
    || /\b(?:could not|couldn't|cannot|can't|unable to)\b/i.test(finalText)
    || /\bno\b.{0,80}\b(?:was|were|could be)?\s*(?:created|written|changed|read)\b/is.test(finalText);
  const explicitBlockage = (allToolsDenied && preventedExecution)
    || /^I(?:'m| am) blocked\b.{0,240}\b(?:every|all) tool calls? (?:was|were|is|are|has been|have been) (?:blocked|rejected|denied)\b/is.test(finalText);
  if (explicitBlockage) {
    return adapterError("Cursor explicitly reported that every tool call was blocked; the requested work was not completed", "downstream", {
      completionBlocked: true,
      finalText: boundedProviderText(finalText),
    });
  }
  if (!terminal.is_error && (!terminal.subtype || terminal.subtype === "success")) return null;
  const failure = providerFailureFromCursorOutput({ terminal })
    || adapterError(`Cursor run ended unsuccessfully (subtype=${terminal.subtype || "unknown"})`, "downstream");
  failure.details = { ...failure.details, subtype: terminal.subtype || null, isError: Boolean(terminal.is_error),
    errors: Array.isArray(terminal.errors) ? terminal.errors.slice(0, 10) : [] };
  return failure;
}

function observedUsage(event) {
  if (!event.usage || typeof event.usage !== "object") return null;
  return {
    inputTokens: event.usage.inputTokens ?? event.usage.input_tokens ?? null,
    outputTokens: event.usage.outputTokens ?? event.usage.output_tokens ?? null,
    cacheReadTokens: event.usage.cacheReadTokens ?? event.usage.cache_read_input_tokens ?? null,
    cacheWriteTokens: event.usage.cacheWriteTokens ?? event.usage.cache_creation_input_tokens ?? null,
  };
}

function startsJsonObject(text) {
  // Object-leading lines are reserved for JSON, even if cut off inside a key.
  // Plain-text fallback permits braces embedded in prose, not JSON fragments.
  return text.trimStart().startsWith("{");
}

export class CursorAdapter {
  constructor(options = {}) {
    const injected = options.launch || options.command || options.executable || options.bin;
    this.launch = harnessLaunch("cursor", injected);
    this.spawnFn = options.spawnFn;
    this.env = options.env || {};
  }

  async run(request, { signal, onProgress } = {}) {
    assertPromptOnlyWorkflow("cursor", request?.workflow);
    assertNoClaudeRoute("cursor", request?.route);
    if (!request || typeof request !== "object") throw new TypeError("request must be an object");
    const policyCheck = isPolicySupported(request.policy || {});
    if (!policyCheck.supported) {
      throw adapterError(`Cursor policy not supported: ${policyCheck.reason} — ${CURSOR_SUPPORTED_POLICY_HELP}`, "policy", { reason: policyCheck.reason });
    }
    assertThinkingEncodedInModel(request.route);
    const executionDetails = launchDiagnostics(request);
    const execution = executionSignal(signal, request.execution?.timeoutMs);
    let terminal = null;
    let terminalError = null;
    let streamError = null;
    let structured = false;
    let sessionId = request.execution?.sessionId || null;
    let usage = null;
    let deltaCount = 0;
    const observe = (event) => {
      if (!event || typeof event !== "object") return;
      structured = true;
      const priorSession = sessionId;
      if (typeof event.session_id === "string" && event.session_id) sessionId = event.session_id;
      const nextUsage = observedUsage(event);
      if (nextUsage) usage = nextUsage;
      if (event.type === "result") {
        terminal = event;
        terminalError ||= terminalFailure(event);
      } else if (event.type === "error" || event.error || event.is_error) {
        const failure = providerFailureFromCursorOutput({ event, terminal: event.is_error ? event : null });
        if (!streamError || failure) streamError = failure || adapterError("Cursor stream reported an error", "downstream", {
          providerError: providerErrorFromEvent(event),
        });
      }
      const content = event.message?.content;
      const text = event.type === "result" ? "" : event.delta || event.text
        || (Array.isArray(content) ? content.map((part) => part?.text).filter(Boolean).join("\n") : "");
      if (typeof text === "string" && text) deltaCount += 1;
      if (onProgress && (text || sessionId !== priorSession || nextUsage)) {
        return reportProgress(onProgress, { type: text ? "cursor_delta" : "cursor_progress", text: String(text).slice(0, 2000),
          sessionId, workflowRunId: `cursor:${request.requestId}`, usage });
      }
    };
    const observeSingle = (output) => {
      // Only a complete retained document can use the legacy single-JSON path.
      if (terminal || output.stdoutTruncated) return;
      const text = String(output.stdout || "");
      const single = parseJsonLine(text);
      if (!single || typeof single !== "object") {
        if (startsJsonObject(text)) structured = true;
        return;
      }
      if (!single.type && typeof single.result === "string") return observe({ ...single, type: "result" });
      return observe(single);
    };
    try {
      if (execution.signal.aborted) {
        throw adapterError(execution.state.timedOut ? "Cursor execution timed out" : "Cursor execution aborted", execution.state.timedOut ? "timeout" : "abort", {
          aborted: !execution.state.timedOut,
          timedOut: execution.state.timedOut,
        });
      }
      const launchArgs = Array.isArray(this.launch.args) ? this.launch.args : [];
      const args = buildArgs(request, launchArgs);
      // Explicit merge, not replacement: a read-only policy changes what the run
      // may write, never whether cursor-agent can authenticate. Credential and
      // profile values are inherited and never logged.
      const env = mergeProcessEnv({ ...(this.launch.env || {}), ...this.env });
      const result = await runProcess(this.launch.command, args, {
        cwd: request.cwd,
        env,
        spawnFn: this.spawnFn || spawnNativeCommand,
        signal: execution.signal,
        timeoutMs: request.execution?.timeoutMs,
        onStdoutLine: (line) => {
          const event = parseJsonLine(line);
          if (event && typeof event === "object") return observe(event);
          else if (startsJsonObject(line)) structured = true;
          else if (/^\s*(?:error\s*:|(?:http|status(?:\s+code)?)\s*[:=]?\s*[45]\d\d\b)/i.test(line)) {
            streamError ||= providerFailureFromCursorOutput({ text: line })
              || adapterError(`Cursor print-mode error: ${boundedProviderText(line)}`, "downstream");
          }
        },
      });
      const stdoutText = String(result.stdout || "");
      await observeSingle(result);
      if (terminalError || streamError) throw terminalError || streamError;
      let finalText = typeof terminal?.result === "string" ? terminal.result.trim() : "";
      if (!terminal && !structured) {
        const providerFailure = providerFailureFromCursorOutput({ stderr: result.stderr });
        if (providerFailure) throw providerFailure;
        if (result.stdoutTruncated) {
          throw adapterError("Cursor plain-text output was truncated before a final result could be recovered", "output-limit", {
            stdoutTruncated: true, stdoutBytes: result.stdoutBytes,
          });
        }
        finalText = stdoutText.trim();
      }
      if (!finalText) {
        const providerFailure = providerFailureFromCursorOutput({ stderr: result.stderr });
        if (providerFailure) throw providerFailure;
        throw adapterError("Cursor completed without final output (missing or empty result envelope)", "downstream", {
          code: result.code,
          stderr: String(result.stderr || "").slice(0, 4000),
          stdout: stdoutText.slice(0, 4000),
        });
      }
      if (onProgress) {
        await reportProgress(onProgress, { type: "cursor_stdout", text: finalText.slice(0, 2000) });
      }
      const { provider, model } = resolvedModel(request.route || {});
      return {
        sessionId,
        workflowRunId: `cursor:${request.requestId}`,
        route: {
          harness: "cursor",
          provider: provider || "cursor",
          model: model || "default",
          variant: null,
          thinking: null,
          requested: request.route || {},
        },
        execution: executionDetails,
        result: structuredResult(finalText, {
          eventSummary: { count: deltaCount + 1, types: deltaCount ? ["cursor_stdout", "cursor_delta"] : ["cursor_stdout"] },
        }),
        usage,
        usageSummary: summarizeUsage("cursor", usage),
      };
    } catch (error) {
      if (error instanceof NativeLaunchError || error?.name === "CursorAdapterError") throw attachExecution(error, executionDetails);
      const aborted = Boolean(error?.details?.aborted || execution.state.aborted);
      const timedOut = Boolean(error?.details?.timedOut || execution.state.timedOut);
      if (!aborted && !timedOut && !["transport", "output-limit"].includes(error?.details?.kind)) {
        await observeSingle(error?.details || {});
        if (terminalError || streamError) throw attachExecution(terminalError || streamError, executionDetails);
        const providerFailure = providerFailureFromCursorOutput({
          text: error?.details?.stdout,
          stderr: error?.details?.stderr,
        });
        if (providerFailure) throw attachExecution(providerFailure, executionDetails);
      }
      throw attachExecution(processFailure(error, execution.state), executionDetails);
    } finally {
      execution.dispose();
    }
  }

  async control(_command, _signal) {
    throw Object.assign(new Error("cursor-agent print mode is one-shot and does not support live message/reroute controls; resume with execution.sessionId instead"), {
      name: "CursorAdapterError",
      details: { kind: "unsupported-control" },
    });
  }
}

export default CursorAdapter;
