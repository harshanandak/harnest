/**
 * Pure graph rendering and store discovery for the OpenCode sidebar widget.
 * Kept free of TUI imports so it can be unit tested with plain Node.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const GLYPH = { completed: "✔", running: "●", pending: "○", failed: "✖", partial: "◌", blocked: "⛔", cancelled: "⊘" };
export const COLOR = {
  completed: "#22c55e",
  running: "#eab308",
  pending: "#6b7280",
  failed: "#ef4444",
  blocked: "#ef4444",
  partial: "#d946ef",
  cancelled: "#6b7280",
};
export const DIM = "#6b7280";
export const MUTED = "#9ca3af";

export function stateDir(env = process.env) {
  if (env.HARNEST_STATE_DIR) return env.HARNEST_STATE_DIR;
  if (process.platform === "win32") return join(env.LOCALAPPDATA || homedir(), "harnest", "jobs");
  return join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "harnest", "jobs");
}

export async function latestGraph(directory = join(stateDir(), "graphs")) {
  const graphs = await listGraphs(directory, 1);
  return graphs[0] ?? null;
}

/**
 * Recent graphs, active first (running/queued by newest), then settled by
 * newest. The human title comes from the spec sidecar the store writes next
 * to each record, so only the selected window is read.
 */
export async function listGraphs(directory = join(stateDir(), "graphs"), limit = 6) {
  const entries = await readdir(directory).catch(() => []);
  const candidates = [];
  for (const name of entries) {
    if (!/^graph-[a-f0-9]{64}\.json$/.test(name)) continue;
    const info = await stat(join(directory, name)).catch(() => null);
    if (!info) continue;
    candidates.push({ id: name.slice(0, -5), mtimeMs: info.mtimeMs });
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const graphs = [];
  for (const candidate of candidates.slice(0, Math.max(1, limit * 2))) {
    let record;
    try { record = JSON.parse(await readFile(join(directory, `${candidate.id}.json`), "utf8")); } catch { continue; }
    let spec = null;
    try { spec = JSON.parse(await readFile(join(directory, `${candidate.id}.json.spec`), "utf8"))?.spec ?? null; } catch { spec = null; }
    graphs.push({ id: candidate.id, mtimeMs: candidate.mtimeMs, record, spec });
    if (graphs.length >= limit * 2) break;
  }
  const active = (graph) => graph.record?.state === "running" || graph.record?.state === "queued";
  graphs.sort((a, b) => (active(b) - active(a)) || (b.mtimeMs - a.mtimeMs));
  return graphs.slice(0, limit);
}

export function truncate(text, width) {
  const value = String(text ?? "");
  const points = [...value];
  return points.length <= width ? value : `${points.slice(0, Math.max(1, width - 1)).join("")}…`;
}

export function shorten(text, width) {
  return truncate(text, width);
}

export function shortModel(node) {
  const model = node?.route?.model ? String(node.route.model).split("/").pop() : "";
  const target = node?.target ?? "?";
  if (!model) return target;
  return model
    .replace(/^deepseek-v4\.1-/, "")
    .replace(/^deepseek-v4-/, "")
    .replace(/^gpt-[\d.]+-/, "")
    .replace(/-\d{4}$/, "")
    .replace(/^muse-spark-[\d.]+-contributor$/, "muse")
    .replace(/^claude-/, "")
    .slice(0, 10);
}

export function levelsOf(nodes) {
  // Records travel through user-reachable files; a torn record can carry
  // null entries or non-array fields, so normalize before dereferencing.
  const list = Array.isArray(nodes) ? nodes.filter((node) => node && typeof node === "object") : [];
  const byId = new Map(list.map((node) => [node.id, node]));
  const memo = new Map();
  const level = (node, seen) => {
    if (memo.has(node.id)) return memo.get(node.id);
    if (seen.has(node.id)) return 0;
    seen.add(node.id);
    const dependsOn = Array.isArray(node.dependsOn) ? node.dependsOn : [];
    const value = dependsOn.length
      ? 1 + Math.max(...dependsOn.map((id) => (byId.has(id) ? level(byId.get(id), seen) : 0)))
      : 0;
    seen.delete(node.id);
    memo.set(node.id, value);
    return value;
  };
  const groups = [];
  for (const node of list) {
    const value = level(node, new Set());
    (groups[value] ??= []).push(node);
  }
  return groups;
}

/** "multi-cluster-a-20260913" -> "Multi Cluster A"; identifiers stay identifiable but readable. */
export function prettyName(value) {
  return String(value ?? "")
    .replace(/[-_]+/g, " ")
    .replace(/\b20\d{6}\b/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b[a-z]/g, (char) => char.toUpperCase());
}

export function shortThinking(node) {
  const level = node?.routingDecision?.thinking ?? node?.route?.thinking;
  return level ? String(level) : "";
}

/** Human title: the graph's task if the caller set one, else a prettified requestId. */
export function graphTitle(graph) {
  const record = graph?.record ?? graph ?? {};
  const spec = graph?.spec ?? record.spec ?? {};
  const task = String(spec.task ?? "").replace(/\s+/g, " ").trim();
  return task || prettyName(record.requestId) || "graph";
}

/**
 * Left-justified waterfall: one node per line, indented by dependency depth,
 * so waves of 20-30 lanes stay readable in a narrow sidebar. Rows are cells
 * for a flex row (name left, model right) with a `{ spacer: true }` gap; no
 * column widths are pre-computed, so the host renders at any width without
 * wrapping. Merges stay unambiguous because a node with several parents
 * names them.
 */
export function graphWaterfallRows(graph) {
  const record = graph?.record ?? graph;
  const nodes = Array.isArray(record?.nodes) ? record.nodes.filter((node) => node && typeof node === "object") : [];
  const completed = nodes.filter((node) => node.state === "completed").length;
  const running = nodes.filter((node) => node.state === "running").length;
  const stats = `${completed}/${nodes.length}${running ? `  ●${running}` : ""}  ${record?.state ?? "unknown"}`;
  const rows = [[
    { text: graphTitle(graph), color: MUTED },
    { spacer: true },
    { text: stats, color: MUTED },
  ]];
  if (!nodes.length) return rows;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const levels = levelsOf(nodes);
  const levelOf = new Map();
  levels.forEach((column, index) => column.forEach((node) => levelOf.set(node.id, index)));
  const lastOfLevel = new Set(levels.map((column) => column[column.length - 1].id));
  for (const node of levels.flat()) {
    const level = levelOf.get(node.id) ?? 0;
    const indent = Math.min(level, 3) * 2;
    const branch = level ? (lastOfLevel.has(node.id) ? "╰─ " : "├─ ") : "  ";
    const glyph = GLYPH[node.state] ?? "?";
    const parents = (Array.isArray(node.dependsOn) ? node.dependsOn : []).map((id) => byId.get(id)).filter(Boolean);
    let annotation = "";
    if (parents.length > 1) annotation = parents.length > 3 ? `⟵ ${parents.length} deps` : `⟵ ${parents.map((parent) => prettyName(parent.id)).join(", ")}`;
    else if (parents.length === 1 && (levels[levelOf.get(parents[0].id)] ?? []).length > 1) annotation = `⟵ ${prettyName(parents[0].id)}`;
    const thinking = shortThinking(node);
    const color = COLOR[node.state] ?? MUTED;
    const cells = [
      { text: `${" ".repeat(indent)}${branch}`, color: DIM },
      { text: `${glyph} `, color },
      { text: prettyName(node.id), color },
    ];
    if (annotation) cells.push({ text: `  ${annotation}`, color: DIM });
    cells.push({ spacer: true });
    cells.push({ text: `${shortModel(node)}${thinking ? ` · ${thinking}` : ""}`, color: MUTED });
    rows.push(cells);
  }
  return rows;
}

/** The workflow whose node ran in this OpenCode session, if any (receipts carry sessionId). */
export function graphForSession(graphs, sessionID) {
  if (!sessionID) return null;
  return graphs.find((graph) => {
    const nodes = Array.isArray(graph.record?.nodes) ? graph.record.nodes : [];
    return nodes.some((node) => node && typeof node === "object" && node.receipt?.sessionId === sessionID);
  }) ?? null;
}

/** One line per graph with the selected graph marked; the switcher above the waterfall. */
export function graphListRows(graphs, { selectedId } = {}) {
  const rows = [];
  const active = graphs.filter((graph) => graph.record?.state === "running" || graph.record?.state === "queued").length;
  rows.push([{ text: `workflows  ${graphs.length}${active ? `  ●${active} active` : ""}`, color: MUTED }]);
  for (const graph of graphs.slice(0, 6)) {
    const record = graph.record ?? graph;
    const nodes = Array.isArray(record?.nodes) ? record.nodes.filter((node) => node && typeof node === "object") : [];
    const completed = nodes.filter((node) => node.state === "completed").length;
    const running = nodes.filter((node) => node.state === "running").length;
    const state = record?.state ?? "unknown";
    const marker = graph.id === selectedId ? "▸" : " ";
    const color = COLOR[state] ?? MUTED;
    rows.push([
      { text: `${marker} ${GLYPH[state] ?? "?"} ${graphTitle(graph)}`, color },
      { spacer: true },
      { text: `${completed}/${nodes.length}${running ? ` ●${running}` : ""}`, color },
    ]);
  }
  return rows;
}
