/**
 * harnest - Pi extension bridging this session to durable OpenCode/Pi/Cursor/Claude/Codex/Gemini/Amp/ACP handoffs.
 *
 * Registers:
 *   - tools handoff_*          : same surface as the Claude/Codex/OpenCode MCP server
 *   - tool handoff_host_info   : how to launch handoffs correctly from THIS host
 *   - tool handoff_view        : Pi-only live waterfall frame from the shared graph-view renderer
 *   - commands /harnest_info|status|trace|result|sessions|cancel
 *   - commands /harnest_view|harnest_watch : live waterfall widget, plus the interactive viewer in a side terminal
 *
 * Pi has no native child-agent surface, so the lead calls these tools directly and
 * reads bounded status/trace pages; there is no subagent transcript to delegate to.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createDaemonClient, ensureDaemon } from "__HARNEST_DAEMON_CLIENT_URL__";
import { jobStateDirectory } from "__HARNEST_DAEMON_SETTINGS_URL__";
import { renderDynamicView, watchDynamicView } from "__HARNEST_DYNAMIC_VIEW_URL__";
import { resolveTrustedCommand, windowsSystemCommand } from "__HARNEST_LAUNCH_COMMAND_URL__";

const client = createDaemonClient();
let readiness;
const connect = () => readiness ??= ensureDaemon().catch((error) => { readiness = null; throw error; });
const callDaemon = async (name, args, key) => {
  await connect();
  try { return (await client.call(name, args))[key]; }
  catch (error) { readiness = null; throw error; }
};

const READ_ONLY_TARGETS = ["opencode", "pi", "cursor", "claude", "codex", "gemini"];

// Bounded local truncation (no new runtime imports): tool outputs must stay
// small; the full trace always remains pageable via handoff_trace.
function clip(text, maxBytes = 20000) {
  const raw = typeof text === "string" ? text : JSON.stringify(text, null, 2);
  if (Buffer.byteLength(raw, "utf8") <= maxBytes) return { text: raw, truncated: false };
  const buf = Buffer.from(raw, "utf8").subarray(0, maxBytes).toString("utf8");
  return {
    text: `${buf}\n\n[Output truncated to ${maxBytes} bytes. Re-poll handoff_trace with afterSequence for the next page.]`,
    truncated: true,
  };
}

const text = (value, isError = false) => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  details: value && typeof value === "object" ? value : {},
  isError,
});
const ok = (value) => {
  const rendered = clip(value);
  return {
    content: [{ type: "text", text: rendered.text }],
    details: value && typeof value === "object" ? value : {},
  };
};
// Operational tool-call failures throw so Pi marks the execution failed;
// successful reads (even of failed jobs) return normally.
const guard = async (fn) => {
  try {
    return ok(await fn());
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error), { cause: error?.details ?? undefined });
  }
};
const checkAborted = (signal) => {
  if (signal?.aborted) throw new Error("Cancelled", { cause: signal.reason ?? undefined });
};

// ---------------------------------------------------------------------------
// Live workflow view
//
// Pi has no sidebar surface, so the shared terminal renderer
// (scripts/graph-view.mjs - the same waterfall the OpenCode widget draws) is
// shown either as a widget above the editor, re-rendered on a timer, or by
// handing the interactive viewer to a separate terminal window. Both paths run
// the canonical renderer so the hosts cannot drift apart.
// ---------------------------------------------------------------------------
const GRAPH_VIEW_URL = "__HARNEST_GRAPH_VIEW_URL__";
const VIEW_WIDGET_KEY = "harnest-view";
const VIEW_STATUS_KEY = "harnest-view";
const VIEW_DEFAULT_INTERVAL_MS = 2000;
const VIEW_MAX_ROWS = 16;
const VIEW_SETTLED_STATES = ["completed", "failed", "cancelled", "partial", "blocked"];
const VIEW_HINT = "Harnest view: /harnest_view off  ·  /harnest_view <graphId> switches  ·  /harnest_watch opens the interactive tree";
const shortId = (id) => String(id ?? "").slice(0, 16);

/** graph-view.mjs argv; `--plain` emits one ANSI-free static frame, `watch: true` opens the interactive tree instead. */
export function graphViewArgs({ graphId = null, list = false, ascii = false, watch = false } = {}) {
  const mode = watch ? ["--watch"] : ["--plain"];
  return [...mode, ...(list ? ["--list"] : []), ...(ascii ? ["--ascii"] : []), ...(graphId ? [graphId] : [])];
}

/** Clip one row to the widget width without splitting a surrogate pair. */
export function clipRow(line, width) {
  const text = String(line ?? "").trimEnd();
  const chars = [...text];
  return chars.length <= width ? text : `${chars.slice(0, Math.max(0, width - 1)).join("")}…`;
}

/**
 * Widget rows from a plain frame. Column padding collapses (leading tree
 * indentation does not), so per-node model and thinking level survive terminals
 * narrower than the 120 columns a piped graph-view render assumes, and the
 * terminal-only key hint is dropped.
 */
export function widgetRows(frame, { width = 120, maxRows = VIEW_MAX_ROWS } = {}) {
  const rows = String(frame ?? "").replace(/\r/g, "").split("\n");
  while (rows.length && rows[rows.length - 1].trim() === "") rows.pop();
  const fitted = rows
    .filter((line) => !/^\s*enter open node\b/.test(line))
    .map((line) => clipRow(line.replace(/(\S) {4,}(?=\S)/g, "$1  "), width));
  if (fitted.length <= maxRows) return fitted;
  const shown = fitted.slice(0, Math.max(1, maxRows - 1));
  shown.push(clipRow(`… ${fitted.length - shown.length} more rows`, width));
  return shown;
}

/** Header facts of a shared frame: `<title>  <state>  <completed>/<total> nodes  <elapsed>`. */
const KNOWN_STATES = new Set(["queued", "running", "completed", "failed", "partial", "cancelled", "blocked", "pending"]);
export function frameSummary(frame) {
  const line = String(frame ?? "").split("\n")[0] ?? "";
  const match = /^(.*?)\s+([A-Za-z][A-Za-z-]*)\s+(\d+)\/(\d+) nodes\b/.exec(line);
  if (!match) return null;
  const state = match[2].toLowerCase();
  if (!KNOWN_STATES.has(state)) return null;
  return { title: match[1].trim(), state, completed: Number(match[3]), total: Number(match[4]) };
}

// cmd.exe treats `& % ^ < > | !` specially, POSIX sh expands `$` and backticks,
// and the side terminal re-parses the line in a fresh shell, so a value carrying
// any of them cannot be made safe by double-quoting around spaces.
const UNSAFE_SHELL_VALUE = /[&%^|<>!$`"';()\[\]{}*?~\r\n\t]/;
// Flags and graph ids the extension generates: --watch, --ascii, graph-<64hex>.
const SHELL_SAFE_ARG = /^[A-Za-z0-9._-]+$/;

/**
 * One shell command line, quoted for paths with spaces (both cmd.exe and POSIX
 * shells). Returns null when a path cannot be quoted safely (a checkout at
 * `C:\R&D\...`) or an argument is not a plain flag/id, so callers report the
 * refusal instead of opening a terminal on a corrupted line.
 */
export function graphViewCommandLine(nodePath, scriptPath, args = []) {
  const paths = [nodePath, scriptPath].map(String);
  const safeArgs = args.map(String);
  if (paths.some((value) => UNSAFE_SHELL_VALUE.test(value))) return null;
  if (!safeArgs.every((value) => SHELL_SAFE_ARG.test(value))) return null;
  const quote = (value) => (value.includes(" ") ? `"${value.replaceAll('"', '\\"')}"` : value);
  return [...paths, ...safeArgs].map(quote).join(" ");
}

/**
 * Best-effort terminal launcher for the interactive viewer. A missing launcher
 * returns null so the caller prints the exact command instead of failing
 * silently; Windows uses cmd's own `start`, Windows Terminal is not required.
 */
export function terminalLaunchPlan({ commandLine, platform = process.platform, env = process.env } = {}) {
  if (typeof commandLine !== "string" || !commandLine) return null;
  if (platform === "win32") {
    try {
      const command = windowsSystemCommand("cmd.exe", env);
      return { via: "a new console window", command, args: ["/d", "/c", "start", "", command, "/d", "/k", commandLine] };
    } catch { return null; }
  }
  if (platform === "darwin") {
    const command = resolveTrustedCommand("osascript", env);
    if (!command) return null;
    return { via: "Terminal.app", command, args: ["-e", `tell application "Terminal" to do script "${commandLine.replaceAll('"', '\\"')}"`, "-e", 'tell application "Terminal" to activate'] };
  }
  const shell = resolveTrustedCommand("sh", env);
  if (!shell) return null;
  for (const via of ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"]) {
    const command = resolveTrustedCommand(via, env);
    if (command) return { via, command, args: [via === "gnome-terminal" ? "--" : "-e", shell, "-lc", commandLine] };
  }
  return null;
}

/** Injectable launcher: tests drive this so no window opens during a test run. */
export const terminalLauncher = {
  async spawn(command, args, options) {
    const child = spawn(command, args, options);
    await once(child, "spawn");
    child.unref();
  },
};

async function openViewerTerminal(commandLine, cwd) {
  const plan = terminalLaunchPlan({ commandLine });
  if (!plan) return null;
  try {
    await terminalLauncher.spawn(plan.command, plan.args, { detached: true, stdio: "ignore", cwd });
    return plan;
  } catch { return null; }
}

const HandoffRouteSchema = Type.Object({
  provider: Type.Optional(Type.String({ minLength: 1 })),
  model: Type.Optional(Type.String({ minLength: 1, description: "For ACP, an advertised session model ID." })),
  agent: Type.Optional(Type.String({ minLength: 1, description: "Claude named agent, OpenCode agent, or trusted ACP registration ID." })),
  variant: Type.Optional(Type.String({ minLength: 1, description: "For ACP, an advertised session mode ID." })),
  thinking: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Boolean()])),
  harnessVersion: Type.Optional(StringEnum(["v1", "v2"], { description: "OpenCode only: v1 or v2." })),
  serverUrl: Type.Optional(Type.String({ minLength: 1, description: "OpenCode private server URL." })),
  serviceTier: Type.Optional(StringEnum(["default", "fast", "priority", "flex"], { description: "Native one-shot tier. Claude accepts only fast." })),
  profile: Type.Optional(Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$", description: "Codex one-shot native config profile name." })),
  options: Type.Optional(Type.Record(Type.String({ pattern: "^(?!(?:__proto__|prototype|constructor)$)(?=[\\s\\S]{1,128}$)[\\s\\S]*\\S" }),
    Type.Union([Type.String({ maxLength: 256 }), Type.Boolean()]),
    { maxProperties: 16, additionalProperties: false, description: "ACP session option IDs mapped to advertised values." })),
}, { additionalProperties: false, description: "Explicit route; omit for policy selection via metadata.routing mode auto." });

const HandoffPolicySchema = Type.Object({
  write: Type.Optional(Type.Boolean({ description: "Write-capable request. On guarded hosts, confirm scope and set metadata.harnest.writeApproved=true." })),
  readOnly: Type.Optional(Type.Boolean({ description: "Legacy alias for !write; must not contradict write or allowWrites." })),
  allowWrites: Type.Optional(Type.Boolean({ description: "Legacy alias for write; must not contradict write or readOnly." })),
  tools: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  maxCostUsd: Type.Optional(Type.Number({ minimum: 0 })),
}, { additionalProperties: false });

const HandoffMetadataSchema = Type.Object({
  harnest: Type.Optional(Type.Object({
    writeApproved: Type.Optional(Type.Boolean({ description: "Exact guarded-host approval marker. Set true only after the lead confirms the intended write scope; there is no separate writeScope protocol field." })),
  }, { additionalProperties: true })),
  routing: Type.Optional(Type.Record(Type.String(), Type.Any())),
}, { additionalProperties: true });

const NativeExecutionFields = {
  sessionId: Type.Optional(Type.String({ description: "Resume token from a prior receipt." })),
  addDirs: Type.Optional(Type.Array(Type.String({ maxLength: 1024 }), { maxItems: 8, description: "Existing absolute directories for Claude, Codex, Cursor, or Gemini. Codex requires write policy. External write roots require confirmed write approval." })),
  attachments: Type.Optional(Type.Array(Type.Object({
    type: StringEnum(["image", "file"]),
    path: Type.String({ maxLength: 1024 }),
  }, { additionalProperties: false }), { maxItems: 4, description: "Absolute local paths, up to 256 KiB each. Codex and Pi accept images. OpenCode and capable ACP agents accept images and files." })),
  instructions: Type.Optional(Type.String({ minLength: 1, maxLength: 8000, description: "Append up to 8000 UTF-8 bytes to the Claude or Pi system prompt." })),
  sessionAction: Type.Optional(StringEnum(["resume", "fork"], { description: "Requires sessionId. Resume is the default. Fork uses native support on Claude, Codex, OpenCode, or Pi." })),
  maxTurns: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description: "Maximum Claude print-mode agentic turns." })),
};

const RequestSchema = Type.Object({
  protocolVersion: Type.Optional(Type.Literal("1.0")),
  requestId: Type.String({ minLength: 1, description: "Stable caller-generated recovery key; required before any downstream work starts." }),
  target: StringEnum(["opencode", "pi", "cursor", "claude", "codex", "gemini", "amp", "acp"], { description: "Downstream harness that owns the whole run. Generic ACP requires route.agent and approved write policy." }),
  task: Type.String({ minLength: 1, description: "Exact task text for the downstream workflow." }),
  cwd: Type.String({ minLength: 1, description: "Absolute working directory for the run." }),
  context: Type.Optional(Type.Any({ description: "Context capsule; digest is computed and round-tripped." })),
  contextDigest: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
  workflow: Type.Optional(Type.Any({ description: "Taskflow graph (null for a single leaf)." })),
  route: Type.Optional(HandoffRouteSchema),
  execution: Type.Optional(Type.Object({
    background: Type.Optional(Type.Boolean({ description: "Default true for long runs; poll status/trace then." })),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1, description: "Absolute wall-clock budget in ms." })),
    ...NativeExecutionFields,
    transport: Type.Optional(StringEnum(["oneshot", "session"], { description: "Session transport uses the native interactive protocol; unsupported controls never silently fall back to one-shot execution." })),
  }, { additionalProperties: false })),
  policy: Type.Optional(HandoffPolicySchema),
  metadata: Type.Optional(HandoffMetadataSchema),
}, { additionalProperties: false, description: "Complete Harnest request containing target, task, absolute cwd, context, workflow, route, execution, and policy." });

const ReadOnlyRequestSchema = Type.Object({
  ...RequestSchema.properties,
  target: StringEnum(READ_ONLY_TARGETS, { description: "Read-only-capable downstream harness; Amp and generic ACP are write-only." }),
}, { additionalProperties: false, description: "Read-only comparison or review request." });

const ReferenceSchema = Type.Object({
  jobId: Type.Optional(Type.String({ minLength: 1 })),
  requestId: Type.Optional(Type.String({ minLength: 1 })),
});

const NODE_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$";

const GraphSchema = Type.Object({
  requestId: Type.String({ minLength: 1, maxLength: 200 }),
  cwd: Type.String({ minLength: 1 }),
  task: Type.Optional(Type.String()),
  context: Type.Optional(Type.Any()),
  policy: Type.Optional(HandoffPolicySchema),
  metadata: Type.Optional(HandoffMetadataSchema),
  execution: Type.Optional(Type.Object({
    background: Type.Optional(Type.Boolean()),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 86400000 })),
    maxConcurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 6 })),
  }, { additionalProperties: false })),
  nodes: Type.Array(Type.Object({
    id: Type.String({ minLength: 1, maxLength: 64, pattern: NODE_ID_PATTERN }),
    target: StringEnum(["auto", "pi", "claude", "codex", "opencode", "cursor", "gemini", "amp", "acp"]),
    task: Type.String({ minLength: 1 }),
    dependsOn: Type.Optional(Type.Array(Type.String({ pattern: NODE_ID_PATTERN }), { maxItems: 256 })),
    route: Type.Optional(HandoffRouteSchema),
    cwd: Type.Optional(Type.String()),
    context: Type.Optional(Type.Any()),
    policy: Type.Optional(HandoffPolicySchema),
    metadata: Type.Optional(HandoffMetadataSchema),
    execution: Type.Optional(Type.Object({
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 86400000 })),
      ...NativeExecutionFields,
    }, { additionalProperties: false })),
  }), { minItems: 1, maxItems: 256 }),
  outputs: Type.Optional(Type.Array(Type.String({ pattern: NODE_ID_PATTERN }), { minItems: 1, maxItems: 256 })),
});

function referenceOf(params) {
  const { jobId, requestId } = params || {};
  if (!jobId && !requestId) throw new Error("jobId or requestId is required");
  return jobId ? { jobId } : { requestId };
}

const RouteSchema = Type.Object({
  provider: Type.Optional(Type.String()),
  model: Type.String(),
  agent: Type.Optional(Type.String()),
  variant: Type.Optional(Type.String()),
  thinking: Type.Optional(Type.Union([Type.String(), Type.Boolean()])),
  harnessVersion: Type.Optional(StringEnum(["v1", "v2"])),
  serverUrl: Type.Optional(Type.String()),
}, { additionalProperties: false });

const NamedHandoffRouteSchema = Type.Object({
  ...HandoffRouteSchema.properties,
  model: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

// The skill says "default to background execution"; nudge it at the boundary
// for callers that omit execution entirely.
function prepareArguments(args) {
  const next = args && typeof args === "object" ? { ...args } : args;
  const req = next?.request && typeof next.request === "object" ? { ...next.request } : undefined;
  if (req && req.execution === undefined) req.execution = { background: true };
  if (req) next.request = req;
  return next;
}

async function streamBackgroundTrace(call, jobId, requestId, signal, onUpdate) {
  if (!onUpdate) return;
  let afterSequence = 0;
  for (let i = 0; i < 40; i += 1) {
    checkAborted(signal);
    const page = await call("handoff_trace", { ...(jobId ? { jobId } : { requestId }), afterSequence, limit: 50 }, "trace");
    afterSequence = page.nextSequence ?? afterSequence;
    const progress = page.receipt?.trace?.progress;
    const summary = progress
      ? `${progress.phase || "?"} — ${(progress.current || "").slice(0, 160)}`
      : (page.receipt?.state || "?");
    onUpdate({
      content: [{ type: "text", text: `handoff ${jobId || requestId}: [${page.receipt?.state}] ${summary}` }],
      details: { jobId: page.jobId, state: page.receipt?.state, progress },
    });
    if (["completed", "failed", "cancelled", "partial"].includes(page.receipt?.state)) break;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 1500);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("Cancelled"));
      }, { once: true });
    });
  }
}

export default function harnestExtension(pi) {
  const call = async (name, args, key) => {
    const result = await callDaemon(name, args, key);
    await registerRemoteTools().catch(() => {});
    return result;
  };
  const sessionList = (args) => call("handoff_sessions", args, "sessions");
  const workflowView = {
    history: (args) => call("handoff_dynamic_history", args, "workflow"),
    status: (args) => call("handoff_dynamic_status", args, "workflow"),
  };
  // Live-view state. Everything starts on an explicit command (or a graph start)
  // and is torn down in session_shutdown, so no timer outlives its session.
  let sessionCtx = null;
  let viewTarget = null;
  let viewAscii = false;
  let viewIntervalMs = VIEW_DEFAULT_INTERVAL_MS;
  let viewTimer = null;
  let viewToken = 0;
  let viewRefreshing = false;
  let viewFailures = 0;
  let stopDynamicView = null;

  const graphViewPaths = () => {
    const script = fileURLToPath(GRAPH_VIEW_URL);
    return { script, cwd: dirname(dirname(script)) };
  };

  const runGraphView = async (args, signal) => {
    const { script, cwd } = graphViewPaths();
    const result = await pi.exec(process.execPath, [script, ...args], { cwd, timeout: 15_000, signal });
    if (result.killed) throw new Error("graph-view timed out");
    if (result.code !== 0) throw new Error((result.stderr || `graph-view exited ${result.code}`).trim().slice(0, 300) || "graph-view failed");
    return result.stdout;
  };

  const clearViewTimer = () => {
    if (viewTimer) {
      clearInterval(viewTimer);
      viewTimer = null;
    }
  };

  const stopView = () => {
    viewToken += 1;
    viewFailures = 0;
    viewRefreshing = false;
    clearViewTimer();
    try {
      if (sessionCtx?.hasUI) {
        sessionCtx.ui.setWidget(VIEW_WIDGET_KEY, undefined);
        sessionCtx.ui.setStatus(VIEW_STATUS_KEY, undefined);
      }
    } catch { /* the widget is decorative */ }
  };

  const renderView = async () => {
    if (viewRefreshing || !sessionCtx?.hasUI) return;
    viewRefreshing = true;
    const token = viewToken;
    try {
      const frame = await runGraphView(graphViewArgs({ graphId: viewTarget, ascii: viewAscii }));
      if (token !== viewToken) return;
      viewFailures = 0;
      const summary = frameSummary(frame);
      const width = Math.max(48, (process.stdout.columns || 120) - 1);
      sessionCtx.ui.setWidget(VIEW_WIDGET_KEY, [...widgetRows(frame, { width }), VIEW_HINT], { placement: "aboveEditor" });
      sessionCtx.ui.setStatus(VIEW_STATUS_KEY, summary ? `Harnest view: ${summary.completed}/${summary.total} ${summary.state}` : "Harnest view: live");
      // A settled workflow keeps its final tree on screen but stops spawning a
      // renderer every interval; /harnest_view restarts the loop after a resume.
      if (summary && VIEW_SETTLED_STATES.includes(summary.state)) clearViewTimer();
    } catch (error) {
      if (token !== viewToken) return;
      viewFailures += 1;
      const message = String(error?.message || error).replace(/\s+/g, " ").slice(0, 160);
      if (viewFailures >= 3) clearViewTimer();
      try {
        sessionCtx.ui.setWidget(VIEW_WIDGET_KEY, [
          `Harnest view: ${message}`,
          viewFailures >= 3 ? "stopped after repeated failures · /harnest_view retries" : "retrying…",
          VIEW_HINT,
        ], { placement: "aboveEditor" });
        sessionCtx.ui.setStatus(VIEW_STATUS_KEY, "Harnest view: error");
      } catch { /* the widget is decorative */ }
    } finally {
      viewRefreshing = false;
    }
  };

  const startView = async (ctx, { graphId = null } = {}) => {
    if (!ctx?.hasUI) return false;
    sessionCtx = ctx;
    viewToken += 1;
    viewTarget = graphId;
    viewFailures = 0;
    clearViewTimer();
    // The token check makes an in-flight refresh drop its stale frame, so the
    // render below is never blocked by a previous run.
    viewRefreshing = false;
    const timer = setInterval(() => { void renderView(); }, viewIntervalMs);
    timer.unref?.();
    viewTimer = timer;
    await renderView();
    return true;
  };

  const recentGraphIds = async (limit = 6) => {
    const root = join(jobStateDirectory(), "graphs");
    const names = await readdir(root).catch(() => []);
    const found = [];
    for (const name of names) {
      const match = /^(graph-[a-f0-9]{64})\.json$/.exec(name);
      if (!match) continue;
      const info = await stat(join(root, name)).catch(() => null);
      if (info) found.push({ id: match[1], mtimeMs: info.mtimeMs });
    }
    found.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return found.slice(0, limit).map((entry) => entry.id);
  };

  const graphReference = Type.Object({ graphId: Type.String({ minLength: 1 }) });
  const graphTools = [
    { name: "handoff_graph_validate", description: "Validate an agent DAG and every route before dispatch; no model calls. On guarded hosts, validation does not grant write authority; start still requires metadata.harnest.writeApproved=true after the lead confirms scope.", parameters: Type.Object({ graph: GraphSchema }), run: (args) => call("handoff_graph_validate", args, "graph") },
    { name: "handoff_graph_start", description: "Run a durable mixed-harness DAG. Dependencies pass results, independent nodes run concurrently. Defaults to background; retain graphId. On guarded hosts, write-capable graphs require metadata.harnest.writeApproved=true after the lead confirms scope.", parameters: Type.Object({ graph: GraphSchema }), run: (args) => call("handoff_graph_start", args, "graph") },
    { name: "handoff_graph_status", description: "Read compact node states. Pass afterRevision and waitMs (up to 25000) to wait for changes with fewer agent calls. Use handoff_trace on individual children.", parameters: Type.Object({
      graphId: Type.String({ minLength: 1 }), afterRevision: Type.Optional(Type.Integer({ minimum: 0 })), waitMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 25000 })),
    }), run: (args) => call("handoff_graph_status", args, "graph") },
    { name: "handoff_graph_result", description: "Read a settled graph with its output nodes and unsuccessful/blocked steps.", parameters: graphReference, run: (args) => call("handoff_graph_result", args, "graph") },
    { name: "handoff_graph_cancel", description: "Request graph cancellation. Stop future dispatch and cancel active children; poll for settlement.", parameters: graphReference, run: (args) => call("handoff_graph_cancel", args, "graph") },
    { name: "handoff_graph_resume", description: "Resume unsuccessful steps without rerunning completed nodes. Repeated commandId is idempotent. Write retries need explicit approveWrites.", parameters: Type.Object({
      graphId: Type.String({ minLength: 1 }), commandId: Type.String({ minLength: 1, maxLength: 200 }),
      nodeIds: Type.Optional(Type.Array(Type.String({ pattern: NODE_ID_PATTERN }), { minItems: 1, maxItems: 256 })),
      approveWrites: Type.Optional(Type.Boolean()), background: Type.Optional(Type.Boolean()),
    }), run: (args) => call("handoff_graph_resume", args, "graph") },
  ];
  for (const tool of graphTools) {
    pi.registerTool({
      name: tool.name, label: tool.name.replaceAll("_", " "), description: tool.description,
      promptSnippet: tool.description, parameters: tool.parameters,
      promptGuidelines: ["Use graph tools for dependencies across different harnesses; each node is a prompt-only handoff.", "Retain graphId and all node job IDs. Resume only explicitly chosen unsuccessful work; completed steps stay completed."],
      async execute(_id, params, signal, _onUpdate, ctx) {
        checkAborted(signal);
        return guard(async () => {
          const result = await tool.run(params);
          if (result.graphId) pi.appendEntry("harnest-graph", { graphId: result.graphId, requestId: result.requestId, state: result.state, at: Date.now() });
          // Starting a workflow is the moment a user wants to watch it: show the
          // live tree unless a view is already running on an explicit target.
          if (result.graphId && !viewTimer) {
            try { void startView(ctx, { graphId: result.graphId }); } catch { /* the widget is decorative */ }
          }
          return result;
        });
      },
    });
  }

  const remoteToolNames = new Set();
  let discovery;
  let discovered = false;
  const discoverRemoteTools = async () => {
    await connect();
    const tools = await client.listTools().catch((error) => { readiness = null; throw error; });
    for (const tool of tools) {
      if (!/^handoff_(dynamic|routing)_/.test(tool.name) || remoteToolNames.has(tool.name)) continue;
      const key = tool.name.startsWith("handoff_dynamic_") ? "workflow" : "routing";
      pi.registerTool({
        name: tool.name, label: tool.name.replaceAll("_", " "), description: tool.description,
        parameters: tool.inputSchema,
        async execute(_id, params, signal, _onUpdate, ctx) {
          checkAborted(signal);
          return guard(async () => {
            const result = await call(tool.name, params, key);
            if (result.runId) pi.appendEntry("harnest-dynamic", { runId: result.runId, requestId: result.requestId, state: result.state, at: Date.now() });
            if (result.invocations && ctx?.hasUI) ctx.ui.setWidget("harnest-dynamic", renderDynamicView({ run: result, readOnly: true }, { width: 90, height: 15 }).split("\n"));
            return result;
          });
        },
      });
      remoteToolNames.add(tool.name);
    }
    discovered = true;
  };
  const registerRemoteTools = async () => {
    if (!discovered) await (discovery ??= discoverRemoteTools().finally(() => { discovery = undefined; }));
  };

  pi.on("session_start", async (_event, ctx) => {
    sessionCtx = ctx;
    try {
      if (ctx?.hasUI) ctx.ui.setStatus("harnest", ctx.ui.theme.fg("dim", "harnest: idle"));
    } catch { /* status line is decorative */ }
    try { await registerRemoteTools(); }
    catch { ctx?.ui?.notify?.("Harnest daemon unavailable", "warning"); }
  });
  pi.on("session_shutdown", () => {
    stopDynamicView?.();
    stopDynamicView = null;
    // /new, /resume, /reload and exit must not leave a widget or timer behind.
    stopView();
  });
  pi.on("agent_settled", (_event, ctx) => {
    try {
      if (ctx?.hasUI) {
        ctx.ui.setStatus("harnest", undefined);
        ctx.ui.setWidget("harnest-handoff", undefined);
      }
    } catch { /* status line is decorative */ }
  });

  const command = (name, spec, handler) => pi.registerCommand(name, { ...spec, handler });

  command("harnest_dynamic", { description: "Watch a JavaScript workflow by runId, follow this session, or stop with off" }, async (args, ctx) => {
    const runId = String(args || "").trim();
    stopDynamicView?.();
    if (runId === "off") { stopDynamicView = null; if (ctx?.hasUI) ctx.ui.setWidget("harnest-dynamic", undefined); return; }
    if (!ctx?.hasUI) throw new Error("dynamic workflow watch requires an interactive Pi session");
    stopDynamicView = watchDynamicView({ runner: workflowView, runId: runId && runId !== "follow" ? runId : undefined,
      sessionId: ctx.sessionManager?.getSessionId?.(),
      render: (data) => ctx.ui.setWidget("harnest-dynamic", renderDynamicView(data, { width: 90, height: 20 }).split("\n")),
      onError: (error) => ctx.ui.notify(String(error.message).slice(0, 200), "error"),
    });
    pi.appendEntry("harnest-dynamic-view", { runId: runId || null, at: Date.now() });
  });

  command("harnest_dynamic_watch", { description: "Open the interactive multi-agent workflow viewer in a separate terminal" }, async (args, ctx) => {
    const target = String(args || "").trim();
    const script = join(dirname(fileURLToPath(GRAPH_VIEW_URL)), "dynamic-view.mjs");
    const commandLine = graphViewCommandLine(process.execPath, script, target ? [target] : []);
    if (!commandLine) throw new Error("Viewer path or run ID contains shell metacharacters");
    const plan = await openViewerTerminal(commandLine, dirname(dirname(script)));
    if (ctx?.hasUI) ctx.ui.notify(plan ? "Multi-agent workflow viewer opened" : `Open a terminal and run:\n${commandLine}`, "info");
  });

  command("harnest_info", {
    description: "Show Harnest handoff launch info for this host",
  }, async (_args, ctx) => {
    const { sessions } = await sessionList({ limit: 5 }).catch(() => ({ sessions: [] }));
    const lines = [
      "Harnest active (Pi). Call handoff_workflow directly; status/trace pages are the operator view.",
      `Recent: ${sessions.map((s) => `${String(s.jobId).slice(0, 8)}[${s.state}]`).join(", ") || "none"}`,
      "Next: /harnest_status <jobId>, /harnest_trace <jobId>, /harnest_result <jobId>. Full detail: handoff_host_info tool.",
    ];
    if (ctx?.hasUI) ctx.ui.notify(lines.join("\n"), "info");
    pi.appendEntry("harnest-info", { at: Date.now(), recent: sessions.map((s) => s.jobId) });
  });

  const idFromArgs = (args) => String(args || "").trim().split(/\s+/)[0] || "";
  const refFromId = (id) => {
    if (!id) throw new Error("Usage: /harnest_status <jobId|requestId>");
    return id.includes("-") && id.length >= 8 && /^[a-zA-Z0-9-]+$/.test(id) ? { jobId: id } : { requestId: id };
  };

  command("harnest_status", {
    description: "Show handoff status for a jobId or requestId",
    getArgumentCompletions: async (prefix) => {
      const { sessions } = await sessionList({ limit: 20 }).catch(() => ({ sessions: [] }));
      const items = sessions.map((s) => ({ value: s.jobId, label: String(s.jobId).slice(0, 13), description: `${s.state} ${s.target}` }));
      const matches = items.filter((i) => i.value.startsWith(prefix || ""));
      return matches.length ? matches : null;
    },
  }, async (args, ctx) => {
    const receipt = await call("handoff_status", refFromId(idFromArgs(args)), "receipt");
    if (ctx?.hasUI) ctx.ui.notify(`${receipt.jobId} [${receipt.state}] ${receipt.target}`, "info");
    pi.appendEntry("harnest-status", { jobId: receipt.jobId, state: receipt.state, at: Date.now() });
  });

  command("harnest_trace", {
    description: "Show the latest handoff trace page for a jobId or requestId",
    getArgumentCompletions: async (prefix) => {
      const { sessions } = await sessionList({ limit: 20 }).catch(() => ({ sessions: [] }));
      const items = sessions.map((s) => ({ value: s.jobId, label: String(s.jobId).slice(0, 13), description: `${s.state} ${s.target}` }));
      const matches = items.filter((i) => i.value.startsWith(prefix || ""));
      return matches.length ? matches : null;
    },
  }, async (args, ctx) => {
    const page = await call("handoff_trace", { ...refFromId(idFromArgs(args)), limit: 20 }, "trace");
    const progress = page.receipt?.trace?.progress;
    const line = progress ? `${progress.phase} — ${progress.current}` : page.receipt?.state;
    if (ctx?.hasUI) ctx.ui.notify(`${page.jobId}: ${line}`, "info");
    pi.appendEntry("harnest-trace", { jobId: page.jobId, at: Date.now() });
  });

  command("harnest_result", {
    description: "Show the terminal receipt for a settled handoff",
  }, async (args, ctx) => {
    const receipt = await call("handoff_result", refFromId(idFromArgs(args)), "receipt");
    const finalText = String(receipt.result?.finalText || receipt.error?.message || "").slice(0, 2000);
    if (ctx?.hasUI) ctx.ui.notify(`${receipt.jobId} [${receipt.state}]\n${finalText}`, receipt.state === "completed" ? "info" : "error");
    pi.appendEntry("harnest-result", { jobId: receipt.jobId, state: receipt.state, at: Date.now() });
  });

  command("harnest_sessions", {
    description: "List recent handoff sessions",
  }, async (_args, ctx) => {
    const { sessions } = await sessionList({ limit: 20 });
    const lines = sessions.map((s) => `${String(s.jobId).slice(0, 13)} [${s.state}] ${s.target} ${s.trace?.lastActivity || ""}`);
    if (ctx?.hasUI) ctx.ui.notify(lines.join("\n") || "no handoff sessions", "info");
  });

  command("harnest_cancel", {
    description: "Confirm then cancel a running handoff",
  }, async (args, ctx) => {
    const jobId = idFromArgs(args);
    if (!jobId) throw new Error("Usage: /harnest_cancel <jobId>");
    if (ctx?.hasUI) {
      const confirmed = await ctx.ui.confirm("Cancel handoff?", `Cancel ${jobId}?`);
      if (!confirmed) return;
    }
    await call("handoff_cancel", { jobId }, "receipt");
    if (ctx?.hasUI) ctx.ui.notify(`Cancelled ${jobId}`, "info");
    pi.appendEntry("harnest-cancel", { jobId, at: Date.now() });
  });

  const viewCompletions = async (prefix) => {
    const items = [
      { value: "off", label: "off", description: "Stop the live workflow view" },
      { value: "list", label: "list", description: "List recent workflows" },
      { value: "ascii", label: "ascii", description: "Toggle ASCII glyphs" },
      { value: "interval", label: "interval", description: "Refresh interval in ms" },
      ...(await recentGraphIds()).map((id) => ({ value: id, label: shortId(id), description: "Pin this workflow" })),
    ];
    const matches = items.filter((item) => item.value.startsWith(prefix || ""));
    return matches.length ? matches : null;
  };

  command("harnest_view", {
    description: "Live workflow view: show the graph waterfall above the editor and keep it fresh",
    getArgumentCompletions: viewCompletions,
  }, async (args, ctx) => {
    const [head = "", second = ""] = String(args || "").trim().split(/\s+/).filter(Boolean);
    if (["off", "stop", "hide"].includes(head)) {
      stopView();
      if (ctx?.hasUI) ctx.ui.notify("workflow view off", "info");
      pi.appendEntry("harnest-view", { on: false, at: Date.now() });
      return;
    }
    if (head === "list") {
      const frame = await runGraphView(graphViewArgs({ list: true, ascii: viewAscii }));
      if (ctx?.hasUI) ctx.ui.notify(clip(frame, 3000).text, "info");
      pi.appendEntry("harnest-view", { list: true, at: Date.now() });
      return;
    }
    let requested = null;
    if (head === "ascii") viewAscii = !viewAscii;
    else if (head === "interval") {
      const value = Number(second);
      if (!Number.isFinite(value) || value < 250 || value > 60000) throw new Error("Usage: /harnest_view interval <250-60000>");
      viewIntervalMs = Math.round(value);
    } else if (head) requested = head;
    // A modifier keeps the current pin; a bare /harnest_view follows the newest active workflow.
    const target = requested ?? (head ? viewTarget : null);
    if (!(await startView(ctx, { graphId: target }))) throw new Error("workflow view needs an interactive Pi session");
    ctx.ui.notify(`workflow view on: ${target ? shortId(target) : "newest active workflow"} · every ${viewIntervalMs}ms · /harnest_view off stops`, "info");
    pi.appendEntry("harnest-view", { on: true, graphId: target, intervalMs: viewIntervalMs, at: Date.now() });
  });

  command("harnest_watch", {
    description: "Open the interactive workflow tree in a separate terminal window",
    getArgumentCompletions: viewCompletions,
  }, async (args, ctx) => {
    const target = idFromArgs(args) || viewTarget || null;
    const { script, cwd } = graphViewPaths();
    const commandLine = graphViewCommandLine(process.execPath, script, graphViewArgs({ graphId: target, ascii: viewAscii, watch: true }));
    if (!commandLine) {
      const message = "cannot open the workflow viewer: the extension path or graph id contains shell metacharacters";
      if (ctx?.hasUI) ctx.ui.notify(message, "warning");
      pi.appendEntry("harnest-view", { watch: true, graphId: target, opened: false, at: Date.now() });
      return;
    }
    const plan = await openViewerTerminal(commandLine, cwd);
    const opened = Boolean(plan);
    const message = opened
      ? `workflow viewer opened in ${plan.via}\n${commandLine}`
      : `open a terminal in ${cwd} and run:\n${commandLine}`;
    if (ctx?.hasUI) ctx.ui.notify(message, opened ? "info" : "warning");
    pi.appendEntry("harnest-view", { watch: true, graphId: target, opened, at: Date.now() });
  });

  pi.registerTool({
    name: "handoff_view",
    label: "Live workflow view",
    description:
      "Render the shared workflow waterfall the way the terminal viewer draws it: per-node state, target, model, thinking level, tokens, and tool calls. Read-only; omit graphId for the newest active workflow, or pass list=true for the workflow switcher.",
    promptSnippet: "Show live workflow progress via handoff_view",
    promptGuidelines: [
      "Use handoff_view when the user asks to see workflow progress, the node tree, or which model each step runs on.",
      "Render once with the graphId from handoff_graph_start; re-render only when the user asks again or the run has advanced.",
    ],
    parameters: Type.Object({
      graphId: Type.Optional(Type.String({ minLength: 1, description: "Workflow to render; omit for the newest active one." })),
      list: Type.Optional(Type.Boolean({ description: "Render the workflow switcher (recent runs) instead of one waterfall." })),
      ascii: Type.Optional(Type.Boolean({ description: "ASCII glyphs for terminals without Unicode support." })),
    }),
    async execute(_id, params, signal) {
      checkAborted(signal);
      return guard(async () => {
        const frame = await runGraphView(graphViewArgs({ graphId: params.graphId ?? null, list: params.list === true, ascii: params.ascii === true }), signal);
        return widgetRows(frame, { width: 200, maxRows: 200 }).join("\n");
      });
    },
  });

  pi.registerTool({
    name: "handoff_workflow",
    label: "Hand off workflow",
    description:
      "Run one complete workflow in OpenCode, Pi, Cursor, Claude, Codex, Gemini, Amp, or a trusted locally registered ACP agent and return a parent-visible receipt. Codex one-shot accepts route.profile and route.serviceTier. Claude one-shot accepts route.agent and route.serviceTier fast. Generic ACP is write-only and accepts advertised model, variant, and options controls after route.agent selects a trusted registration. ACP rejects provider pins, granular tools, cost budgets, persistent session transport, and live controls. Use execution.background=true for durable status/result retrieval. On guarded hosts, any write-capable policy requires metadata.harnest.writeApproved=true after the lead confirms scope.",
    promptSnippet: "Delegate a whole workflow to a downstream harness via handoff_workflow",
    promptGuidelines: [
      "Use handoff_workflow with execution.background=true when the task runs longer than one turn; then poll handoff_status and handoff_trace, and finish with handoff_result.",
      "Use handoff_trace with afterSequence set to the previous nextSequence every 1-2s for live progress; heartbeat-only activity is stalled, not progress.",
      "Accept the handoff only when the receipt requestId and context digest match and final text is present.",
      "A nested handoff remains subject to the child host's approval and sandbox restrictions and cannot widen them.",
    ],
    parameters: Type.Object({ request: RequestSchema }),
    prepareArguments,
    async execute(_id, params, signal, onUpdate, ctx) {
      checkAborted(signal);
      const receipt = await call("handoff_workflow", { request: params.request }, "receipt");
      if (ctx?.hasUI && receipt?.jobId) {
        try {
          ctx.ui.setStatus("harnest", ctx.ui.theme.fg("accent", `handoff ${String(receipt.jobId).slice(0, 8)} [${receipt.state}]`));
          ctx.ui.setWidget("harnest-handoff", [`handoff ${String(receipt.jobId).slice(0, 8)}: ${receipt.target} [${receipt.state}]`]);
        } catch { /* decorative */ }
      }
      pi.appendEntry("harnest-handoff", { jobId: receipt.jobId, requestId: receipt.requestId, at: Date.now() });
      if (params.request?.execution?.background) {
        await streamBackgroundTrace(call, receipt.jobId, null, signal, onUpdate).catch((error) => {
          if (!String(error?.message || "").includes("Cancelled")) throw error;
        });
        // The stream window (60s) may end before a long handoff settles;
        // return the terminal receipt when ready, else the live status.
        const live = await call("handoff_status", { jobId: receipt.jobId }, "receipt");
        if (["completed", "failed", "cancelled", "partial"].includes(live.state)) {
          return guard(() => call("handoff_result", { jobId: receipt.jobId }, "receipt"));
        }
        return guard(async () => ({
          ...live,
          note: "handoff still running after the progress stream window; keep polling handoff_status/handoff_trace",
        }));
      }
      return guard(async () => receipt);
    },
  });

  pi.registerTool({
    name: "handoff_compare",
    label: "Compare model routes",
    description:
      "Send one identical read-only task to 2-16 independently resolved routes; returns one durable receipt per lane.",
    promptSnippet: "Compare independent model routes on one read-only task via handoff_compare",
    promptGuidelines: [
      "Use handoff_compare only for read-only multi-model comparison with 2-16 named candidates; shared-checkout writes are rejected.",
      "Keep every lane receipt attributable; consensus counts only where receipts independently agree.",
    ],
    parameters: Type.Object({
      request: ReadOnlyRequestSchema,
      candidates: Type.Array(Type.Object({
        name: Type.String(),
        target: Type.Optional(StringEnum(READ_ONLY_TARGETS)),
        route: NamedHandoffRouteSchema,
      }), { minItems: 2, maxItems: 16 }),
    }),
    async execute(_id, params, signal) {
      checkAborted(signal);
      return guard(() => call("handoff_compare", params, "comparison"));
    },
  });

  pi.registerTool({
    name: "handoff_status",
    label: "Handoff status",
    description: "Poll compact state for a handoff job by jobId or requestId; terminal states precede handoff_result.",
    promptSnippet: "Check a handoff job state via handoff_status",
    promptGuidelines: [
      "Use handoff_status for compact state; use handoff_trace for event detail.",
    ],
    parameters: ReferenceSchema,
    async execute(_id, params, signal) {
      checkAborted(signal);
      return guard(() => call("handoff_status", referenceOf(params), "receipt"));
    },
  });

  pi.registerTool({
    name: "handoff_result",
    label: "Handoff result",
    description: "Terminal receipt for a completed job; requires terminal state. Verify requestId, context digest, route, session identity, and final text.",
    promptSnippet: "Fetch the terminal receipt via handoff_result",
    promptGuidelines: [
      "Use handoff_result only after handoff_status shows a terminal state.",
    ],
    parameters: ReferenceSchema,
    async execute(_id, params, signal) {
      checkAborted(signal);
      return guard(() => call("handoff_result", referenceOf(params), "receipt"));
    },
  });

  pi.registerTool({
    name: "handoff_trace",
    label: "Handoff trace",
    description:
      "Bounded redacted event page (truncated at ~20KB); pass afterSequence=previous nextSequence to poll only new events. Full trace stays pageable by sequence.",
    promptSnippet: "Read new handoff events via handoff_trace",
    promptGuidelines: [
      "Use handoff_trace with afterSequence for live progress; never paste the unbounded trace into context.",
    ],
    parameters: Type.Object({
      jobId: Type.Optional(Type.String({ minLength: 1 })),
      requestId: Type.Optional(Type.String({ minLength: 1 })),
      afterSequence: Type.Optional(Type.Number({ minimum: 0 })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
    }),
    async execute(_id, params, signal) {
      checkAborted(signal);
      const { afterSequence, limit, ...reference } = params;
      return guard(() => call("handoff_trace", { ...referenceOf(reference), afterSequence, limit }, "trace"));
    },
  });

  pi.registerTool({
    name: "handoff_sessions",
    label: "List handoff sessions",
    description: "Recent durable receipts with downstream identity and progress.",
    promptSnippet: "Rediscover durable handoffs via handoff_sessions",
    promptGuidelines: [
      "Use handoff_sessions to recover jobs after context loss, then handoff_status by requestId.",
    ],
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
      state: Type.Optional(StringEnum(["queued", "running", "completed", "failed", "cancelled", "partial"])),
      target: Type.Optional(StringEnum(["opencode", "pi", "cursor", "claude", "codex", "gemini", "amp", "acp"])),
    }),
    async execute(_id, params, signal) {
      checkAborted(signal);
      return guard(async () => ({ sessions: (await sessionList(params)).sessions }));
    },
  });

  pi.registerTool({
    name: "handoff_message",
    label: "Steer handoff",
    description:
      "Durably steer the next agent step (delivery=steer) or queue a follow-up (delivery=follow_up). Only applied counts as acknowledged. One-shot targets (Cursor, Claude print mode, Codex exec, Gemini, Amp, generic ACP) reject this as unsupported-control.",
    promptSnippet: "Steer a running handoff via handoff_message",
    promptGuidelines: [
      "Use handoff_message with a fresh commandId per guidance; treat only applied as acknowledged and never reuse a commandId.",
    ],
    parameters: Type.Object({
      jobId: Type.String({ minLength: 1 }),
      commandId: Type.String({ minLength: 1 }),
      message: Type.String({ minLength: 1 }),
      delivery: Type.Optional(StringEnum(["steer", "follow_up"])),
    }),
    async execute(_id, params, signal) {
      checkAborted(signal);
      const { jobId, ...rest } = params;
      return guard(() => call("handoff_message", { jobId, ...rest }, "control"));
    },
  });

  pi.registerTool({
    name: "handoff_reroute",
    label: "Reroute handoff",
    description: "Change provider/model for the next model request, optionally with guidance. Applies to current OpenCode and Pi live runs.",
    promptSnippet: "Change a running handoff route via handoff_reroute",
    promptGuidelines: [
      "Use handoff_reroute for next-model-request route changes; mid-inference swaps never happen.",
    ],
    parameters: Type.Object({
      jobId: Type.String({ minLength: 1 }),
      commandId: Type.String({ minLength: 1 }),
      route: RouteSchema,
      message: Type.Optional(Type.String()),
      delivery: Type.Optional(StringEnum(["steer", "follow_up"])),
    }),
    async execute(_id, params, signal) {
      checkAborted(signal);
      const { jobId, ...rest } = params;
      return guard(() => call("handoff_reroute", { jobId, ...rest }, "control"));
    },
  });

  pi.registerTool({
    name: "handoff_cancel",
    label: "Cancel handoff",
    description: "Cancel a queued or running handoff; terminal state becomes cancelled.",
    promptSnippet: "Cancel a handoff via handoff_cancel",
    promptGuidelines: [
      "Use handoff_cancel only for the identified job; terminal jobs need handoff_resume instead.",
    ],
    parameters: Type.Object({ jobId: Type.String({ minLength: 1 }) }),
    async execute(_id, params, signal) {
      checkAborted(signal);
      return guard(() => call("handoff_cancel", { jobId: params.jobId }, "receipt"));
    },
  });

  pi.registerTool({
    name: "handoff_resume",
    label: "Resume handoff",
    description: "Resume a partial or failed read-only handoff once, after reviewing its trace; write-capable retries need lead approval.",
    promptSnippet: "Resume a settled handoff via handoff_resume",
    promptGuidelines: [
      "Use handoff_resume at most once and only for read-only jobs.",
    ],
    parameters: Type.Object({
      jobId: Type.String({ minLength: 1 }),
      background: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params, signal) {
      checkAborted(signal);
      return guard(() => call("handoff_resume", params, "receipt"));
    },
  });

  pi.registerTool({
    name: "handoff_review",
    label: "Review with models",
    description: "2-8 read-only reviewer lanes score one rubric with a shared board and lane messages; tallies scores, never implements.",
    promptSnippet: "Run a multi-model review via handoff_review",
    promptGuidelines: [
      "Use handoff_review for plan/code review by several models; implement the returned findings yourself, then re-invoke with previous.",
      "Reviewers must end with the fenced JSON score block or their lane abstains.",
    ],
    parameters: Type.Object({
      request: ReadOnlyRequestSchema,
      reviewers: Type.Array(Type.Object({
        name: Type.String(),
        target: Type.Optional(StringEnum(READ_ONLY_TARGETS)),
        route: NamedHandoffRouteSchema,
      }), { minItems: 2, maxItems: 8 }),
      rubric: Type.Optional(Type.Array(Type.Union([Type.String(), Type.Object({
        factor: Type.String(),
        weight: Type.Optional(Type.Number({ minimum: 0, exclusiveMinimum: true })),
      })]), { minItems: 1 })),
      threshold: Type.Optional(Type.Number({ minimum: 0, maximum: 10 })),
      rounds: Type.Optional(Type.Integer({ minimum: 1, maximum: 3 })),
      previous: Type.Optional(Type.Object({
        summary: Type.Optional(Type.String()),
        scores: Type.Optional(Type.Record(Type.String(), Type.Number())),
      }, { additionalProperties: true })),
    }),
    async execute(_id, params, signal) {
      checkAborted(signal);
      return guard(() => call("handoff_review", params, "review"));
    },
  });

  pi.registerTool({
    name: "handoff_post",
    label: "Post to board",
    description: "Send a message to other subagents on a shared topic agreed out of band.",
    promptSnippet: "Talk to peer subagents via handoff_post",
    promptGuidelines: [
      "Use handoff_post with a topic every collaborating worker knows; read replies with handoff_read.",
    ],
    parameters: Type.Object({
      topic: Type.String({ minLength: 1, maxLength: 64 }),
      from: Type.String({ minLength: 1 }),
      message: Type.String({ minLength: 1 }),
    }),
    async execute(_id, params, signal) {
      checkAborted(signal);
      return guard(() => call("handoff_post", params, "post"));
    },
  });

  pi.registerTool({
    name: "handoff_read",
    label: "Read board",
    description: "Read new messages from a shared topic; poll with afterSequence for only new entries.",
    promptSnippet: "Read peer messages via handoff_read",
    promptGuidelines: [
      "Use handoff_read with afterSequence set to the previous nextSequence.",
    ],
    parameters: Type.Object({
      topic: Type.String({ minLength: 1, maxLength: 64 }),
      afterSequence: Type.Optional(Type.Number({ minimum: 0 })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
    }),
    async execute(_id, params, signal) {
      checkAborted(signal);
      const { afterSequence, limit, ...reference } = params;
      return guard(() => call("handoff_read", { ...reference, afterSequence, limit }, "board"));
    },
  });

  pi.registerTool({
    name: "handoff_fleet",
    label: "View agent fleet",
    description: "How many handoff agents are active, what each is doing, and how to steer it right now (live, pending, or resume).",
    promptSnippet: "Watch every subagent at once via handoff_fleet",
    promptGuidelines: [
      "Use handoff_fleet to see running agents, recent messages, and per-agent steer mode (live vs resume).",
    ],
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
      state: Type.Optional(StringEnum(["queued", "running", "completed", "failed", "cancelled", "partial"])),
      target: Type.Optional(StringEnum(["opencode", "pi", "cursor", "claude", "codex", "gemini", "amp", "acp"])),
      recent: Type.Optional(Type.Number({ minimum: 0, maximum: 10 })),
    }),
    async execute(_id, params, signal) {
      checkAborted(signal);
      return guard(async () => ({ fleet: await call("handoff_fleet", params, "fleet") }));
    },
  });

  pi.registerTool({
    name: "handoff_host_info",
    label: "Host launch info",
    description:
      "Report how Harnest handoffs must be launched in THIS host: tool names, visibility model, and live-control semantics. Call first when unsure.",
    promptSnippet: "Learn the Pi launch path via handoff_host_info",
    promptGuidelines: [
      "Call handoff_host_info first when unsure which launch path the current host expects.",
    ],
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      checkAborted(signal);
      const host = await call("handoff_host_info", {}, "host");
      return ok(JSON.stringify({
        leadHost: "pi",
        visibilityModel:
          "Pi has no native child-agent surface. Call handoff_* tools directly in this session; bounded status/trace pages ARE the operator view. Progress streams via tool updates on background runs; /harnest_status, /harnest_trace, /harnest_result, /harnest_sessions, /harnest_cancel commands available. The live waterfall renders as the /harnest_view widget above the editor (timer-refreshed from scripts/graph-view.mjs), /harnest_watch opens the interactive tree in a separate terminal, and handoff_view returns one frame.",
        workers: "none - direct tool calls only",
        routingPreferences: {
          tools: ["handoff_routing_get", "handoff_routing_configure", "handoff_routing_preview"],
          usage: "Read settings and revision, edit a preset, then preview the resolved route. metadata.routing.preset selects a preset for one request; null selects base.",
        },
        graphWorkflows: {
          tools: graphTools.map(tool => tool.name),
          routing: "target:auto chooses per-node routes from policy; explicit routes remain available",
          visibility: "compact node status with revision-based long polling; child job IDs use handoff_trace; /harnest_view renders the same waterfall live in the TUI",
          recovery: "selective resume preserves completed nodes; cancellation waits for child settlement",
        },
        dynamicWorkflows: {
          coordinator: "harnest",
          tools: [...remoteToolNames].filter((name) => name.startsWith("handoff_dynamic_")),
          recovery: "ordered-prefix replay; failed/changed invocation invalidates subsequent reuse",
          viewer: "/harnest_dynamic <runId|follow|off>; /harnest_dynamic_watch <runId>",
        },
        writeApproval: {
          marker: "metadata.harnest.writeApproved=true",
          appliesTo: "write-capable handoff_workflow and handoff_graph_start calls on guarded hosts, including policy.write=true, policy.readOnly=false, and policy.allowWrites=true",
          scope: "The lead confirms the intended write scope before setting the marker; there is no separate writeScope protocol field.",
        },
        nestedHandoffs: "A nested handoff remains subject to the child host's approval and sandbox restrictions and cannot widen them.",
        controlSemantics: {
          acknowledged: "applied",
          v1Opencode: "live message/reroute fail closed by design; use Pi downstream targets or V2 for live control",
          cursor: "oneshot rejects live controls; session uses ACP cancel/model negotiation, not mid-turn messaging",
          claude: "oneshot rejects live controls; session uses SDK streaming guidance with consumption evidence",
          codex: "oneshot rejects live controls; session uses app-server turn/steer and owned queued follow-ups",
          gemini: "oneshot rejects live controls; session transport is unsupported",
          amp: "oneshot rejects live controls; session transport is unsupported",
          acp: "generic attached ACP supports cancellation only; message and reroute controls are unsupported",
        },
        routingResolverConfigured: host.routingResolverConfigured,
        routingResolver: host.routingResolver,
      }, null, 2));
    },
  });
}
