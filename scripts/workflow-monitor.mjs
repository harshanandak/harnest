#!/usr/bin/env node
/**
 * Line-oriented observer for native host tasks and Claude plugin monitors.
 * Works with piped stdout; never owns, dispatches or cancels workflow work.
 */
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";
import { once } from "node:events";
import { setTimeout as wait } from "node:timers/promises";
import { GLYPH, graphTitle, listGraphs, prettyName, shortModel, shortThinking, stateDir } from "../opencode-plugin/graph-render.mjs";
import { redactSecrets } from "../src/process.mjs";

const TERMINAL = new Set(["completed", "failed", "partial", "cancelled"]);
const MAX_NODE_LINES = 5;
const INTERVAL_MIN_MS = 200;
const INTERVAL_MAX_MS = 60_000;
const ACTIVE = new Set(["running", "queued", "pausing", "paused", "waiting", "stopping"]);
const RUN_ID = /^(?:dyn|graph)-[a-f0-9]{64}$/;
const clean = (value) => redactSecrets(String(value ?? "")).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 240);

function takeValue(argv, index) {
  const value = argv[index + 1];
  if (typeof value !== "string") return null;
  if (value.startsWith("-") && !Number.isFinite(Number(value))) return null;
  return value;
}

function clampInterval(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(INTERVAL_MAX_MS, Math.max(INTERVAL_MIN_MS, parsed)) : fallback;
}

export function parseArgs(argv) {
  const options = { once: false, intervalMs: 2000 };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--once") options.once = true;
    else if (["--workflow", "--state", "--dynamic-state"].includes(arg)) {
      const value = takeValue(argv, index);
      if (!value || value.startsWith("-")) throw new Error(`${arg} requires a value`);
      options[{ "--workflow": "workflow", "--state": "stateDir", "--dynamic-state": "dynamicStateDir" }[arg]] = value;
      index++;
    }
    else if (arg === "--interval") {
      const value = takeValue(argv, index);
      if (value !== null) {
        options.intervalMs = clampInterval(value, options.intervalMs);
        index += 1;
      }
    } else throw new Error(`Unknown monitor argument: ${arg}`);
  }
  if (options.workflow && !RUN_ID.test(options.workflow)) throw new Error("--workflow requires a dyn- or graph- run ID");
  return options;
}

const nodesOf = (record) => [record?.calls, record?.invocations, record?.nodes].find(Array.isArray)?.filter((node) => node && typeof node === "object") ?? [];
const phaseOf = (record) => clean(Array.isArray(record?.phases) ? record.phases.at(-1)?.title : "");
const activityOf = (node) => clean(node.progress?.current ?? node.progress?.phase ?? "");
const titleOf = (graph) => clean(graph.record?.name || graphTitle(graph));
const signatureOf = (record) => JSON.stringify({
  state: record.state, attempt: record.attempt, phase: phaseOf(record),
  controls: (Array.isArray(record.controls) ? record.controls : []).filter((item) => item && typeof item === "object").slice(-5).map(({ commandId, action, state }) => [commandId, action, state]),
  nodes: nodesOf(record).map((node) => [node.id, JSON.stringify([node.state, node.attempts?.length ?? 0, node.route, node.phase, activityOf(node)])]),
});

function nodeLabel(node) {
  const model = shortModel(node);
  const thinking = shortThinking(node);
  const label = clean(node.label || prettyName(node.id));
  const attempt = node.attempts?.length > 1 ? ` attempt ${node.attempts.length}` : "";
  if (!model || model === "?") return label + attempt;
  return `${label} (${clean(model)}${thinking ? ` · ${clean(thinking)}` : ""})${attempt}`;
}

/**
 * Pure diff: given the previous signature map and the current graph list,
 * return the lines to emit and the next signature map. Already-settled graphs
 * establish a silent baseline; only active graphs announce themselves.
 */
export function monitorLines(previous, graphs, { announce = false } = {}) {
  const lines = [];
  const next = new Map();
  for (const graph of graphs) {
    const record = graph.record ?? {};
    const nodes = nodesOf(record);
    const signature = signatureOf(record);
    const before = previous.get(graph.id);
    next.set(graph.id, signature);
    if (before === undefined) {
      if (ACTIVE.has(record.state) || announce) {
        const state = ["running", "queued"].includes(record.state) ? "started" : clean(record.state);
        lines.push(`▶ ${titleOf(graph)} ${state} · ${nodes.length} node${nodes.length === 1 ? "" : "s"}${announce ? ` (${graph.id})` : ""}`);
      }
      if (!announce) continue;
    }
    if (before === signature) continue;
    const old = before ? JSON.parse(before) : {};
    const current = JSON.parse(signature);
    const beforeStates = new Map(old.nodes ?? []);
    const currentStates = new Map(current.nodes);
    const completed = nodes.filter((node) => node.state === "completed").length;
    if (current.phase && current.phase !== old.phase) lines.push(`  ${titleOf(graph)} · phase ${current.phase}`);
    if (current.attempt > 1 && current.attempt !== old.attempt) lines.push(`  ${titleOf(graph)} · workflow attempt ${current.attempt}`);
    for (const control of current.controls) {
      if (!(old.controls ?? []).some((entry) => JSON.stringify(entry) === JSON.stringify(control))) lines.push(`  ${titleOf(graph)} · ${clean(control[1])}: ${clean(control[2])}`);
    }
    let changes = 0;
    for (const node of nodes) {
      if (beforeStates.get(node.id) === currentStates.get(node.id)) continue;
      changes += 1;
      if (changes > MAX_NODE_LINES) continue;
      lines.push(`${GLYPH[node.state] ?? "?"} ${titleOf(graph)} · ${nodeLabel(node)} ${clean(node.state)}${activityOf(node) ? ` · ${activityOf(node)}` : ""}`);
    }
    if (changes > MAX_NODE_LINES) lines.push(`… ${changes - MAX_NODE_LINES} more changes in ${titleOf(graph)}`);
    if (TERMINAL.has(record.state) || old.state !== record.state && before !== undefined) {
      lines.push(`${GLYPH[record.state] ?? "?"} ${titleOf(graph)} ${clean(record.state)} · ${completed}/${nodes.length}${record.error?.message ? ` · ${clean(record.error.message)}` : ""}`);
    }
  }
  return { lines, next };
}

async function readRecord(path) {
  if ((await stat(path)).size > 16 * 1024 * 1024) throw new Error("Workflow snapshot exceeds the observer's 16 MiB limit");
  return JSON.parse(await readFile(path, "utf8"));
}

export async function observedWorkflows(options = {}) {
  const root = options.stateDir ?? stateDir();
  const dynamicRoot = options.dynamicStateDir ?? join(root, "dynamic");
  let workflows;
  if (options.workflow) {
    const path = join(options.workflow.startsWith("dyn-") ? dynamicRoot : join(root, "graphs"), `${options.workflow}.json`);
    const record = await readRecord(path);
    const spec = options.workflow.startsWith("graph-") ? await readRecord(`${path}.spec`).then((value) => value.spec).catch((error) => { if (error.code === "ENOENT" || error instanceof SyntaxError) return null; throw error; }) : null;
    workflows = [{ id: options.workflow, record, spec }];
  } else {
    const fixed = await listGraphs(join(root, "graphs"), 12);
    const names = await readdir(dynamicRoot).catch((error) => { if (error.code === "ENOENT") return []; throw error; });
    const candidates = await Promise.all(names.filter((name) => /^dyn-[a-f0-9]{64}\.json$/.test(name)).map(async (name) => ({ name, time: (await stat(join(dynamicRoot, name))).mtimeMs })));
    candidates.sort((a, b) => b.time - a.time);
    const dynamic = await Promise.all(candidates.slice(0, 12).map(async ({ name }) => ({ id: name.slice(0, -5), record: await readRecord(join(dynamicRoot, name)) })));
    workflows = [...fixed, ...dynamic];
  }
  for (const workflow of workflows) {
    for (const node of nodesOf(workflow.record).filter((item) => item.state === "running")) {
      if (!/^[a-f0-9-]{36}$/.test(node.jobId ?? "")) continue;
      const job = await readRecord(join(root, `${node.jobId}.json`)).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
      if (job?.trace?.progress) node.progress = job.trace.progress;
    }
  }
  return workflows;
}

export async function watchWorkflows(options, { load = observedWorkflows, write = (line) => process.stdout.write(line + "\n"), signal } = {}) {
  let previous = new Map();
  let lastError = null;
  while (!signal?.aborted) {
    let workflows;
    try { workflows = await load(options); lastError = null; }
    catch (error) {
      const message = `Workflow observer error: ${clean(error.message)}`;
      if (message !== lastError) await write(message);
      lastError = message;
      if (options.once || options.workflow) throw error;
    }
    if (workflows) {
      const { lines, next } = monitorLines(previous, workflows, { announce: Boolean(options.workflow) });
      previous = next;
      for (const line of lines) if (await write(line) === false) await once(process.stdout, "drain", { signal });
      if (options.workflow && workflows.some((workflow) => workflow.id === options.workflow && TERMINAL.has(workflow.record.state))) return;
    }
    if (options.once) return;
    await wait(options.intervalMs, undefined, { signal }).catch((error) => { if (!signal?.aborted) throw error; });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const outputError = (error) => { controller.abort(); if (error.code !== "EPIPE") process.exitCode = 1; };
  process.stdout.on("error", outputError);
  await watchWorkflows(parseArgs(process.argv.slice(2)), { signal: controller.signal }).catch((error) => {
    if (!controller.signal.aborted) { console.error(clean(error.message)); process.exitCode = 1; }
  });
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  process.stdout.removeListener("error", outputError);
}
