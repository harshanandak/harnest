#!/usr/bin/env node
/**
 * handoff-view - live transcript for a single Harnest job.
 *
 * The companion folds every harness's deltas (claude_delta, codex_delta,
 * cursor_delta, amp_delta, OpenCode/Pi progress) into the durable trace. This is the
 * operator's read-only screen over that trace: one line per meaningful event,
 * `--watch` tails it until the job reaches a terminal state, and noisy
 * activity records are skipped. No writes, no dispatch.
 *
 * Usage:
 *   node scripts/handoff-view.mjs <jobId|requestId> [--watch]
 *                                 [--interval <ms> (min 200)] [--once|--plain]
 *                                 [--state <dir>]
 */
import { pathToFileURL } from "node:url";
import { once } from "node:events";
import { JobObserver } from "../src/job-store.mjs";
import { redactSecrets } from "../src/process.mjs";

const TERMINAL = new Set(["completed", "failed", "partial", "cancelled"]);
const NOISE = new Set(["heartbeat", "usage", "tool_execution_update", "message_update", "turn_start", "turn_end", "step_start", "step_end"]);
const TRACE_PAGE = 200;
const INTERVAL_MIN_MS = 200;
const INTERVAL_MAX_MS = 60_000;

export function eventText(event) {
  const data = event?.event?.data ?? event?.data ?? null;
  if (!data || typeof data !== "object") return null;
  if (typeof data.text === "string" && data.text.trim()) return data.text;
  const part = data.part && typeof data.part === "object" ? data.part : null;
  if (part && typeof part.text === "string" && part.text.trim()) return part.text;
  return null;
}

export function isNoisy(event) {
  const activity = String(event?.activity ?? event?.event?.type ?? "");
  if (activity.startsWith("control")) return false;
  return NOISE.has(activity);
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const clean = (value, limit = 240) => redactSecrets(String(value ?? "")).replace(CONTROL, "?").slice(0, limit);

export function formatEventLine(event) {
  const stamp = String(event?.at ?? "").slice(11, 19).replace(CONTROL, "?");
  const text = eventText(event);
  if (text) {
    // Collapse whitespace, then neutralize control characters: raw ESC/BEL in
    // untrusted agent text can clear the screen or spoof the terminal title.
    const line = clean(text.replace(/\s+/g, " ").trim(), 4096);
    return `[${stamp}] ${line}`;
  }
  // The activity fallback is caller-supplied too (control commandIds), so it
  // gets the same neutralization as text payloads.
  const activity = clean(event?.activity ?? event?.event?.type ?? "update");
  return `[${stamp}] (${activity})`;
}

function statusLine(receipt) {
  const route = receipt.route ?? {};
  const progress = receipt.trace?.progress ?? {};
  const controls = Array.isArray(receipt.controls) ? receipt.controls.slice(-5) : [];
  return [
    `state ${clean(receipt.state)}`,
    `route ${clean(receipt.target)}/${clean(route.model || route.provider || "unknown")}`,
    `thinking ${clean(route.thinking ?? "unknown")}`,
    progress.phase && `phase ${clean(progress.phase)}`,
    progress.current && `activity ${clean(progress.current)}`,
    progress.lastMeaningfulAt && `last meaningful ${clean(progress.lastMeaningfulAt)}`,
    ...controls.map((control) => `control ${clean(control.commandId)} ${clean(control.state)}`),
    receipt.error && `error ${clean(receipt.error.details?.kind ?? receipt.error.kind ?? receipt.error.name)} ${clean(receipt.error.message)}`,
  ].filter(Boolean).join(" | ");
}

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
  const options = { selector: null, watch: false, once: false, intervalMs: 1000, stateDir: null };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--watch") options.watch = true;
    else if (arg === "--once" || arg === "--plain") options.once = true;
    else if (arg === "--state") {
      const value = takeValue(argv, index);
      if (value !== null) {
        options.stateDir = value;
        index += 1;
      }
    } else if (arg === "--interval") {
      const value = takeValue(argv, index);
      if (value !== null) {
        options.intervalMs = clampInterval(value, options.intervalMs);
        index += 1;
      }
    } else if (!arg.startsWith("-")) options.selector = arg;
  }
  if (options.watch) options.once = false;
  return options;
}

export async function followJob({ store, selector, watch = false, intervalMs = 1000, write = (line) => console.log(line) }) {
  let jobId = selector;
  try {
    jobId = await store.jobIdForRequest(selector);
  } catch (error) {
    if (error.details?.kind !== "not-found" && error.code !== "ENOENT") throw error;
    // A missing request index can still mean the selector is a jobId.
  }
  let headerShown = false;
  let lastSequence = null;
  let lastStatus = null;
  for (;;) {
    const receipt = (await store.get(jobId))?.receipt;
    if (!receipt) throw new Error(`job not found: ${selector}`);
    if (!headerShown) {
      const route = receipt.route ?? {};
      const model = route.model || route.provider || "-";
      await write(`handoff-view  ${clean(receipt.requestId ?? jobId)}  ${clean(receipt.target)}/${clean(model)}  ${clean(receipt.state)}  ev ${clean(receipt.trace?.eventCount ?? 0)}`);
      headerShown = true;
    }
    const currentStatus = statusLine(receipt);
    if (currentStatus !== lastStatus) {
      await write(currentStatus);
      lastStatus = currentStatus;
    }
    for (;;) {
      // The first read takes the newest page (no afterSequence); later reads
      // page forward. Drain every page, terminal or not, so the final answer
      // is never dropped behind the page size.
      const tailRead = lastSequence === null;
      const trace = await store.readTrace(jobId, tailRead ? { limit: TRACE_PAGE } : { afterSequence: lastSequence, limit: TRACE_PAGE });
      const before = lastSequence;
      for (const event of trace.events) {
        if (isNoisy(event)) { lastSequence = Number(event.sequence) || lastSequence; continue; }
        await write(formatEventLine(event));
        lastSequence = Number(event.sequence) || lastSequence;
      }
      // A tail read's hasMore means older events exist, not newer ones.
      if (!trace.hasMore || tailRead || lastSequence === before) break;
    }
    if (!watch || TERMINAL.has(receipt.state)) return;
    await new Promise((done) => setTimeout(done, intervalMs));
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.selector) throw new Error("usage: node scripts/handoff-view.mjs <jobId|requestId> [--watch]");
  const store = new JobObserver(options.stateDir || undefined);
  await followJob({ store, selector: options.selector, watch: options.watch, intervalMs: options.intervalMs, write: async (line) => {
    if (!process.stdout.write(`${line}\n`)) await once(process.stdout, "drain");
  } });
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`handoff-view: ${error.message}`);
    process.exit(1);
  });
}
