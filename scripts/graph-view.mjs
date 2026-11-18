#!/usr/bin/env node
/**
 * graph-view - the canonical terminal view over Harnest graph runs.
 *
 * The workflow switcher and the left-justified waterfall come straight from
 * opencode-plugin/graph-render.mjs, the same pure renderer the OpenCode sidebar
 * widget uses, so every harness (Claude Code, Codex, Cursor, Pi) shows one
 * consistent workflow view. This file is only the terminal adapter: it loads
 * the durable record plus job receipts, paints the shared rows with ANSI color,
 * and offers keyboard drill-in (prompt, attempts, response, trace) that a
 * sidebar row cannot show.
 *
 * Reads the durable store the same way the MCP server does: graph snapshot,
 * immutable spec (the prompts), per-child job snapshots (route, usage,
 * session) and event traces (activity counts). It never mutates state and
 * never dispatches work.
 *
 * Usage:
 *   node scripts/graph-view.mjs [graphId|requestId] [--workflow <id|requestId>]
 *                               [--state <dir>] [--list] [--watch] [--once|--plain]
 *                               [--interval <ms> (min 200)] [--width <n>] [--ascii]
 *
 * Keys: up/down (or j/k) select, enter opens a node, esc goes back,
 * j/k scroll the node view, r refreshes, q quits.
 * Without a TTY (or with --once) it prints one frame and exits. --watch always
 * wins over --once/--plain.
 */
import { open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Companion } from "../src/companion.mjs";
import { GraphStore } from "../src/graph-store.mjs";
import {
  COLOR,
  GLYPH,
  MUTED,
  graphListRows,
  graphTitle,
  graphWaterfallRows,
  latestGraph,
  levelsOf,
  listGraphs,
  shortModel,
  shortThinking,
  truncate,
} from "../opencode-plugin/graph-render.mjs";

// Node/list colors arrive as hex from the shared renderer; terminal state text
// uses the same palette through paint().
const HEX = /^#?([a-f0-9]{2})([a-f0-9]{2})([a-f0-9]{2})$/i;

// The shared renderer emits its own glyph set for the sidebar; the terminal
// keeps an ascii fallback for hosts that cannot draw it.
const ASCII_GLYPH = new Map([
  [GLYPH.completed, "+"], [GLYPH.running, "*"], [GLYPH.pending, "."],
  [GLYPH.failed, "x"], [GLYPH.partial, "~"], [GLYPH.blocked, "!"], [GLYPH.cancelled, "-"],
  ["├", "+"], ["╰", "+"], ["└", "+"], ["┌", "+"], ["┐", "+"], ["┴", "+"], ["┬", "+"], ["┼", "+"],
  ["│", "|"], ["─", "-"], ["⟵", "<-"], ["▸", ">"], ["…", "..."], ["●", "*"], ["·", "-"],
]);

export function createStyle(enabled) {
  const wrap = (code, text) => (enabled ? `\u001b[${code}m${text}\u001b[0m` : text);
  return {
    bold: (text) => wrap("1", text),
    dim: (text) => wrap("2", text),
    cyan: (text) => wrap("36", text),
    green: (text) => wrap("32", text),
    red: (text) => wrap("31", text),
    yellow: (text) => wrap("33", text),
    magenta: (text) => wrap("35", text),
    status: (state, text) => paint(text, COLOR[state] ?? MUTED, enabled),
  };
}

/** Paint a shared-renderer cell color (hex) as an ANSI truecolor span; unknown values pass through. */
export function paint(text, color, enabled) {
  if (!enabled) return text;
  const match = HEX.exec(String(color ?? ""));
  if (!match) return text;
  const [r, g, b] = match.slice(1).map((value) => parseInt(value, 16));
  return `\u001b[38;2;${r};${g};${b}m${text}\u001b[0m`;
}

export function parseArgs(argv) {
  const options = { graphId: null, stateDir: null, once: false, list: false, watch: false, intervalMs: 1000, intervalSet: false, width: null, ascii: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    // A flag consumes the next token only when it is a value, not another
    // flag: `--state --watch` must not swallow --watch.
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("-")) return null;
      index += 1;
      return next;
    };
    if (arg === "--state") options.stateDir = value();
    else if (arg === "--workflow") options.graphId = value();
    else if (arg === "--once" || arg === "--plain") options.once = true;
    else if (arg === "--watch") { options.watch = true; options.once = false; }
    else if (arg === "--list" || arg === "-l") options.list = true;
    else if (arg === "--interval") {
      const raw = value();
      if (raw !== null) {
        // Always leave setTimeout a finite, sane delay; Infinity would hot-loop.
        const ms = Number(raw);
        options.intervalMs = Number.isFinite(ms) ? Math.min(60_000, Math.max(200, Math.floor(ms))) : 1000;
        options.intervalSet = true;
      }
    } else if (arg === "--width") {
      const raw = value();
      const pixels = raw === null ? NaN : Number(raw);
      if (Number.isFinite(pixels) && pixels >= 20) options.width = Math.min(4096, Math.floor(pixels));
    } else if (arg === "--ascii") options.ascii = true;
    else if (!arg.startsWith("-")) {
      if (!arg) throw new Error("no selector provided");
      options.graphId = arg;
    }
  }
  // /workflow-view documents --watch as a 2s live loop unless --interval overrides it.
  if (options.watch && !options.intervalSet) options.intervalMs = 2000;
  // --watch always wins over --once/--plain, so mixed flags are not order-dependent.
  if (options.watch) options.once = false;
  return options;
}

const GRAPH_ID = /^graph-[a-f0-9]{64}$/;

/**
 * Accept either a full graph id or a human requestId (what graph titles and
 * receipts expose). Unknown selectors pass through so the store read fails with
 * a precise "graph not found" instead of a silently different run.
 */
export async function resolveSelector(root, selector) {
  if (GRAPH_ID.test(selector)) return selector;
  const candidates = await listGraphs(root, 100);
  const match = candidates.find((graph) => graph.record?.requestId === selector)
    ?? candidates.find((graph) => String(graph.record?.requestId ?? "").startsWith(selector));
  return match?.id ?? selector;
}

/** Replace C0 controls (newlines survive) and DEL with "?", so untrusted record text cannot emit terminal commands. */
export function controlsSafe(text) {
  return String(text ?? "").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "?");
}

/** Map every non-ASCII code point to an ASCII fallback and strip controls, so --ascii frames stay renderable. */
export function asciiSafe(text) {
  let out = "";
  for (const char of String(text ?? "")) {
    const mapped = ASCII_GLYPH.get(char);
    if (mapped !== undefined) { out += mapped; continue; }
    const code = char.codePointAt(0);
    if (code > 0x7f || (code <= 0x1f && char !== "\n") || code === 0x7f) { out += "?"; continue; }
    out += char;
  }
  return out;
}

function plain(text, ascii) {
  return ascii ? asciiSafe(text) : controlsSafe(text);
}

/**
 * Paint one shared row of cells to a terminal line. Text cells keep their hex
 * colors; spacer cells absorb the remaining width, so the same rows the widget
 * draws reflow to the terminal exactly as they do in a sidebar.
 */
export function renderRow(cells, width = 110, { color = false, ascii = false } = {}) {
  const texts = cells.map((cell) => (cell.spacer ? null : plain(cell.text, ascii)));
  const fixed = texts.reduce((total, text) => total + (text?.length ?? 0), 0);
  const spacers = texts.filter((text) => text === null).length;
  let slack = spacers ? Math.max(spacers, width - fixed) : 0;
  let remaining = spacers;
  return cells.map((cell, index) => {
    if (cell.spacer) {
      const each = Math.max(1, Math.ceil(slack / remaining));
      slack -= each;
      remaining -= 1;
      return " ".repeat(each);
    }
    return paint(texts[index], cell.color, color);
  }).join("");
}

/** The shared workflow switcher as terminal lines (same rows the sidebar widget draws). */
export function renderList(graphs, { width = 110, color = false, ascii = false, selectedId } = {}) {
  return graphListRows(graphs, { selectedId }).map((cells) => renderRow(cells, width, { color, ascii }));
}

/** One static frame: terminal header, shared switcher (when several workflows exist) and shared waterfall. */
export function renderView(view, { width = 110, height = 40, ascii = false, color = false, selected = 0 } = {}) {
  const style = createStyle(color);
  const record = view.record;
  const spec = record?.spec ?? null;
  const header = [
    style.bold(`${graphTitle({ record, spec })}  ${style.status(view.state, view.state)}  ${view.counts.completed}/${view.counts.total} nodes  ${formatMs(view.elapsedMs)}`),
    style.dim(`${view.requestId}  ${String(view.graphId ?? "").slice(0, 30)}...`),
  ];
  if (view.recoveryRequired) header.push(style.red("recovery required: resume this graph explicitly"));
  if (view.cancellation) header.push(style.yellow(`cancellation: ${view.cancellation.state}${view.cancellation.reason ? ` (${view.cancellation.reason})` : ""}`));
  header.push(style.dim(`completed ${view.counts.completed}  running ${view.counts.running}  pending ${view.counts.pending}  blocked ${view.counts.blocked}  failed ${view.counts.failed}  partial ${view.counts.partial}  cancelled ${view.counts.cancelled}`));
  header.push("");

  const graphs = view.graphs ?? [];
  const order = view.order ?? [];
  const body = [];
  if (graphs.length > 1) {
    for (const line of renderList(graphs, { width, color, ascii, selectedId: view.graphId })) body.push(line);
    body.push("");
  }

  const index = order.length ? Math.max(0, Math.min(order.length - 1, selected)) : 0;
  const selectedId = order[index] ?? null;
  let selectedRow = body.length;
  const waterfall = graphWaterfallRows({ record, spec });
  waterfall.forEach((cells, row) => {
    const id = row === 0 ? null : order[row - 1];
    const cursor = id !== null && id === selectedId ? "> " : "  ";
    if (id !== null && id === selectedId) selectedRow = body.length;
    body.push(style.bold(cursor) + renderRow(cells, Math.max(20, width - 2), { color, ascii }));
  });

  const footer = ["", style.dim("enter open node   up/down select   r refresh   q quit")];
  const maxBody = Math.max(3, height - header.length - footer.length);
  let start = 0;
  if (body.length > maxBody) start = Math.min(Math.max(0, selectedRow - Math.floor(maxBody / 2)), body.length - maxBody);
  const visible = body.slice(start, start + maxBody);
  const lines = [...header];
  if (start > 0) lines.push(style.dim(`  ... ${start} earlier rows`));
  lines.push(...visible);
  const remaining = body.length - start - visible.length;
  if (remaining > 0) lines.push(style.dim(`  ... ${remaining} later rows`));
  lines.push(...footer);
  return lines.slice(0, height).join("\n");
}

function number(usage, keys) {
  if (!usage || typeof usage !== "object") return null;
  for (const key of keys) if (Number.isFinite(usage[key])) return usage[key];
  return null;
}

export function formatTokens(usage) {
  if (!usage || typeof usage !== "object") return null;
  const input = number(usage, ["input", "input_tokens", "prompt_tokens", "promptTokens"]);
  const output = number(usage, ["output", "output_tokens", "completion_tokens", "completionTokens"]);
  const parts = [];
  if (input != null) parts.push(`${compact(input)} in`);
  if (output != null) parts.push(`${compact(output)} out`);
  const cost = number(usage, ["cost", "total_cost_usd", "costUsd"]);
  if (cost != null && cost > 0) parts.push(`$${cost.toFixed(4)}`);
  return parts.length ? parts.join(" / ") : null;
}

function compact(value) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

export function formatMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

// Incremental per-trace tool-call counter. Raw trace text is only scanned for
// occurrences, never rendered; drill-in uses the redacting trace reader.
const traceCursors = new Map();
async function countToolCalls(path) {
  const cursor = traceCursors.get(path) ?? { offset: 0, carry: "", tools: 0 };
  try {
    const handle = await open(path, "r");
    try {
      const info = await handle.stat();
      if (info.size > cursor.offset) {
        const buffer = Buffer.alloc(info.size - cursor.offset);
        await handle.read(buffer, 0, buffer.length, cursor.offset);
        cursor.offset = info.size;
        const text = cursor.carry + buffer.toString("utf8");
        const lines = text.split("\n");
        cursor.carry = lines.pop() ?? "";
        for (const line of lines) {
          const marker = line.indexOf('"tool_use"');
          if (marker !== -1 && marker === line.lastIndexOf('"tool_use"')) cursor.tools += 1;
        }
      }
    } finally {
      await handle.close();
    }
  } catch {
    // A missing or mid-rotation trace contributes no counts; the view stays useful.
  }
  traceCursors.set(path, cursor);
  return cursor.tools;
}

/** Newest (active-first) graph id from the shared store reader; kept for callers that pass a GraphStore. */
export async function latestGraphId(graphs) {
  const root = typeof graphs === "string" ? graphs : graphs.root;
  const picked = await latestGraph(root);
  if (!picked) throw new Error(`no graph records found in ${root}`);
  return picked.id;
}

export async function loadView({ stateDir: dir = null, graphId = null, graphsLimit = 6 } = {}) {
  if (graphId === "") throw new Error("no selector provided");
  const companion = dir ? new Companion({ stateDir: dir }) : new Companion();
  const root = join(companion.store.root, "graphs");
  const graphs = await listGraphs(root, graphsLimit);
  const id = graphId ? await resolveSelector(root, graphId) : graphs[0]?.id;
  if (!id) throw new Error(`no graph records found in ${root}`);
  let record = null;
  try {
    record = await new GraphStore(root).read(id);
  } catch (error) {
    const missing = error?.code === "ENOENT" || error?.code === "not-found" || /invalid graphId/i.test(String(error?.message));
    if (missing) {
      // Leave record null; the caller gets a precise "graph not found" below.
    } else if (/specification/i.test(String(error?.message)) || error instanceof SyntaxError) {
      // The snapshot is fine but its immutable spec sidecar is missing or torn
      // (a SyntaxError comes from a truncated sidecar). --list still shows the
      // graph, so render the snapshot with spec:null rather than failing.
      record = await readFile(join(root, `${id}.json`), "utf8")
        .then((text) => ({ ...JSON.parse(text), spec: null }))
        .catch(() => { throw error; });
    } else {
      throw error;
    }
  }
  if (!record) throw new Error(`graph not found: ${graphId ?? id}`);
  const specList = Array.isArray(record.spec?.nodes) ? record.spec.nodes : [];
  const specNodes = new Map(specList.filter((entry) => entry && typeof entry === "object").map((node) => [node.id, node]));
  const nodes = [];
  for (const node of (Array.isArray(record.nodes) ? record.nodes : []).filter((entry) => entry && typeof entry === "object")) {
    const spec = specNodes.get(node.id);
    const job = node.jobId ? await companion.store.get(node.jobId).catch(() => null) : null;
    nodes.push({
      id: node.id,
      target: node.target,
      route: node.route,
      routingDecision: node.routingDecision ?? null,
      state: node.state,
      dependsOn: Array.isArray(node.dependsOn) ? node.dependsOn : [],
      attempts: Array.isArray(node.attempts) ? node.attempts : [],
      jobId: node.jobId,
      requestId: node.requestId,
      progress: node.progress ?? job?.receipt?.trace?.progress ?? null,
      error: node.error ?? null,
      sessionId: node.receipt?.sessionId ?? job?.receipt?.sessionId ?? null,
      usage: job?.receipt?.usage ?? null,
      outcome: node.receipt?.result ?? job?.receipt?.result ?? null,
      task: spec?.request?.task ?? null,
      context: spec?.request?.context ?? null,
      policy: spec?.request?.policy ?? null,
      cwd: spec?.request?.cwd ?? null,
      execution: spec?.request?.execution ?? null,
      requestedTarget: spec?.requestedTarget ?? node.target,
      tools: node.jobId ? await countToolCalls(companion.store.tracePath(node.jobId)) : 0,
    });
  }
  const counts = { total: nodes.length, completed: 0, running: 0, pending: 0, failed: 0, partial: 0, blocked: 0, cancelled: 0 };
  for (const node of nodes) counts[node.state] = (counts[node.state] ?? 0) + 1;
  return {
    graphId: record.graphId,
    requestId: record.requestId,
    state: record.state,
    revision: record.revision,
    recoveryRequired: Boolean(record.recoveryRequired),
    cancellation: record.cancellation ?? null,
    errors: record.errors ?? [],
    createdAt: record.createdAt,
    completedAt: record.completedAt ?? null,
    updatedAt: record.updatedAt,
    elapsedMs: Math.max(0, Date.parse(record.completedAt ?? record.updatedAt) - Date.parse(record.createdAt)),
    counts,
    // Waterfall order is the renderer's dependency-depth order, so terminal
    // selection and the shared rows stay aligned even when nodes were declared
    // out of order.
    order: levelsOf(nodes).flat().map((node) => node.id),
    nodes,
    graphs,
    outputs: record.spec?.outputs ?? [],
    companion,
    record,
  };
}

function wrap(text, width) {
  const lines = [];
  for (const paragraph of String(text).split(/\r?\n/)) {
    if (!paragraph) { lines.push(""); continue; }
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      if (!line.length) line = word;
      else if (line.length + 1 + word.length <= width) line += ` ${word}`;
      else { lines.push(line); line = word; }
    }
    lines.push(line);
  }
  return lines;
}

export function summarizeEvent(record) {
  const event = record?.event ?? {};
  if (event.type === "state") return `state -> ${event.state}`;
  if (event.type === "recovery") return `recovery -> ${event.state}`;
  if (event.type === "progress") {
    const data = event.data ?? {};
    if (data.type === "text") return `text: ${data.finalText || data.text || ""}`;
    if (data.type === "tool_use" || data.type === "tool") return `tool: ${data.tool || data.event?.part?.tool || data.event?.part?.state?.title || "call"}`;
    const part = data.event?.part;
    if (part?.text) return `text: ${part.text}`;
    if (part?.state?.output) return `tool: ${part.state.title ?? "call"}`;
    return data.type ?? record.activity ?? "progress";
  }
  return record.activity ?? event.type ?? "event";
}

/** Drill-in for one node; terminal-only detail the shared waterfall deliberately omits. */
export async function nodeDetail(node, { width = 110, color = false, events = [] } = {}) {
  const style = createStyle(color);
  const thinking = shortThinking(node);
  const lines = [];
  lines.push(style.bold(`${node.id}  ${style.status(node.state, node.state)}`) + `  ${node.target} · ${shortModel(node)}${thinking ? ` · ${thinking}` : ""}`);
  lines.push(style.dim(`cwd: ${node.cwd ?? "-"}   policy: write=${node.policy?.write ?? false} tools=${(node.policy?.tools ?? []).length > 0 ? node.policy.tools.join(",") : "all"}`));
  if (node.routingDecision?.selected) lines.push(style.dim(`routing: ${JSON.stringify(node.routingDecision.selected)}`));
  const dependsOn = Array.isArray(node.dependsOn) ? node.dependsOn : [];
  if (dependsOn.length) lines.push(style.dim(`depends on: ${dependsOn.join(", ")}`));
  lines.push("");
  lines.push(style.cyan(style.bold("Prompt")));
  for (const line of wrap(node.task ?? "(no task recorded)", width - 2)) lines.push(`  ${line}`);
  if (node.context && Object.keys(node.context).length) {
    lines.push("");
    lines.push(style.cyan(style.bold("Context")));
    for (const line of wrap(JSON.stringify(node.context), width - 2).slice(0, 12)) lines.push(`  ${line}`);
  }
  lines.push("");
  lines.push(style.cyan(style.bold("Attempts")));
  const attempts = Array.isArray(node.attempts) ? node.attempts.filter((attempt) => attempt && typeof attempt === "object") : [];
  if (!attempts.length) lines.push("  (none yet)");
  for (const attempt of attempts) {
    const parts = [`#${attempt.attempt}`, attempt.state, attempt.requestId ?? "", attempt.jobId ? `job ${attempt.jobId.slice(0, 8)}` : "", attempt.sessionId ? `session ${String(attempt.sessionId).slice(0, 18)}` : "", attempt.startedAt ? `started ${attempt.startedAt}` : ""];
    lines.push(`  ${truncate(parts.filter(Boolean).join("  "), width - 2)}`);
  }
  if (node.usage || node.error || node.sessionId) {
    lines.push("");
    lines.push(style.cyan(style.bold("Outcome")));
    if (node.sessionId) lines.push(`  session ${node.sessionId}`);
    if (node.usage) lines.push(`  tokens ${formatTokens(node.usage) ?? JSON.stringify(node.usage)}`);
    if (node.error) lines.push(`  ${style.red(`error: ${node.error.message}`)}`);
  }
  if (node.outcome?.finalText) {
    lines.push("");
    lines.push(style.cyan(style.bold("Response")));
    for (const line of wrap(node.outcome.finalText, width - 2).slice(0, 14)) lines.push(`  ${line}`);
  }
  lines.push("");
  lines.push(style.cyan(style.bold("Recent activity")));
  if (!events.length) lines.push("  (no trace events yet)");
  for (const record of events.slice(-12)) {
    if (!record || typeof record !== "object") continue;
    const time = record.at ? new Date(record.at) : null;
    const at = time && Number.isFinite(time.getTime()) ? time.toISOString().slice(11, 19) : "--:--:--";
    lines.push(style.dim(`  ${String(record.sequence ?? "").padStart(5)} ${at} `) + truncate(summarizeEvent(record), width - 22));
  }
  lines.push("");
  lines.push(style.dim("esc back   j/k scroll   r refresh   q quit"));
  return lines;
}

export async function detailEvents(view, node) {
  if (!node.jobId) return [];
  try {
    // No afterSequence means the store returns the newest events (the tail),
    // not the first page; bad job ids fail here and degrade to no activity.
    const page = await view.companion.store.readTrace(node.jobId, { limit: 200 });
    return page.events ?? [];
  } catch {
    return [];
  }
}

export function viewport(lines, height, scroll) {
  if (lines.length <= height) return lines;
  // height - 1 real lines plus the status line, so the last real line is
  // reachable exactly at lines.length - height + 1.
  const start = Math.min(scroll, Math.max(0, lines.length - height + 1));
  const window = lines.slice(start, start + height - 1);
  window.push(createStyle(false).dim(`[${start + window.length}/${lines.length} lines - j/k scroll]`));
  return window;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const interactive = !options.once && Boolean(process.stdout.isTTY);
  const color = interactive && !process.env.NO_COLOR;
  const width = options.width || process.stdout.columns || 120;

  if (options.list) {
    const companion = options.stateDir ? new Companion({ stateDir: options.stateDir }) : new Companion();
    const root = join(companion.store.root, "graphs");
    const graphs = await listGraphs(root);
    const selectedId = options.graphId ? await resolveSelector(root, options.graphId) : graphs[0]?.id;
    process.stdout.write(renderList(graphs, { width, ascii: options.ascii, color, selectedId }).join("\n") + "\n");
    return;
  }

  let view = await loadView({ stateDir: options.stateDir, graphId: options.graphId });
  const write = (text) => process.stdout.write(text);

  if (!interactive) {
    const frame = renderView(view, { width, ascii: options.ascii, color: false });
    write((options.ascii ? asciiSafe(frame) : controlsSafe(frame)) + "\n");
    return;
  }

  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdout.write("\u001b[?25l");
  let selected = 0;
  let detail = null;
  let scroll = 0;
  let dirty = true;
  const nodeAt = (index) => view.nodes.find((node) => node.id === view.order[index]) ?? view.nodes[index] ?? null;
  const quit = () => {
    process.stdin.setRawMode?.(false);
    process.stdout.write("\u001b[?25h\n");
    process.exit(0);
  };
  process.stdin.on("data", (buffer) => {
    const key = buffer.toString("utf8");
    if (key === "q" || key === "\u0003") return quit();
    if (detail !== null) {
      if (key === "\u001b" || key === "\u001b[D") { detail = null; scroll = 0; dirty = true; }
      else if (key === "j" || key === "\u001b[B") { scroll += 1; dirty = true; }
      else if (key === "k" || key === "\u001b[A") { scroll = Math.max(0, scroll - 1); dirty = true; }
      else if (key === "r") dirty = true;
      return;
    }
    if (key === "\u001b[C" || key === "\r" || key === "\n") { detail = selected; scroll = 0; dirty = true; }
    else if (key === "j" || key === "\u001b[B") { selected = Math.min(view.order.length - 1, selected + 1); dirty = true; }
    else if (key === "k" || key === "\u001b[A") { selected = Math.max(0, selected - 1); dirty = true; }
    else if (key === "r") dirty = true;
  });
  process.on("SIGINT", quit);

  for (;;) {
    if (dirty) {
      dirty = false;
      const columns = options.width || process.stdout.columns || 120;
      const rows = process.stdout.rows || 40;
      let frame;
      if (detail === null) {
        frame = renderView(view, { width: columns, height: rows, ascii: options.ascii, color, selected });
      } else {
        const node = nodeAt(detail);
        frame = node ? viewport(await nodeDetail(node, { width: columns, color, events: await detailEvents(view, node) }), rows, scroll).join("\n") : "";
      }
      write(`\u001b[H\u001b[2J${options.ascii ? asciiSafe(frame) : controlsSafe(frame)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
    try {
      const next = await loadView({ stateDir: options.stateDir, graphId: view.graphId });
      const changed = next.revision !== view.revision || next.order.join(",") !== view.order.join(",") || next.nodes.some((node, index) => {
        const before = view.nodes[index];
        return !before || before.state !== node.state || before.tools !== node.tools || before.usage !== node.usage;
      });
      view = next;
      selected = Math.min(selected, Math.max(0, view.order.length - 1));
      if (changed) dirty = true;
    } catch (error) {
      const message = controlsSafe(String(error?.message ?? "unknown"));
      write(`\u001b[H\u001b[2J${createStyle(color).red(`view reload failed: ${message}`)}\n`);
    }
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    process.stdin.setRawMode?.(false);
    if (process.stdout.isTTY) process.stdout.write(`\u001b[?25h\n`);
    console.error(`graph-view: ${error.message}`);
    process.exit(1);
  });
}
