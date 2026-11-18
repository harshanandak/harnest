// Zero-paid fake child adapter for the dynamic workflow demo.
//
// The adapter runs inside the detached dynamic worker (selected through
// HARNEST_WORKER_ADAPTER) and never launches a native harness, touches
// the network, or spends money. It reads a JSON instruction from request.task:
//
//   {
//     "kind": "plan" | "work" | "checkpoint" | "after-pause",
//     "label": "work-pi",
//     "items": [1, 2, 3],
//     "failFirst": true,            // fail only the first launch for this label
//     "holdUntilFile": "C:\\...",   // checkpoint handshake file (optional)
//     "maxHoldMs": 30000,           // bounded wait for that file
//     "postFileHoldMs": 300         // settle window after the file appears
//   }
//
// Every launch is appended to `$HARNEST_DEMO_DIR/launches.jsonl` so the
// demo can prove exactly how many child launches happened in each process.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_MAX_HOLD_MS = 30_000;
const DEFAULT_POST_FILE_HOLD_MS = 300;
const PLAN_DELAY_MS = 80;
const WORK_DELAY_MS = 120;
const AFTER_PAUSE_DELAY_MS = 80;
const POLL_MS = 50;

function demoDir() {
  const dir = process.env.HARNEST_DEMO_DIR;
  if (!dir) {
    throw Object.assign(new Error("HARNEST_DEMO_DIR is required for the demo adapter"), {
      details: { kind: "validation" },
    });
  }
  return dir;
}

export function launchesPath(dir = demoDir()) {
  return join(dir, "launches.jsonl");
}

/** Read every launch record; a torn final line is ignored, never fatal. */
export function readLaunches(dir = demoDir()) {
  let text;
  try {
    text = readFileSync(launchesPath(dir), "utf8");
  } catch {
    return [];
  }
  const records = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      /* torn tail from a concurrent append; the next run rewrites cleanly */
    }
  }
  return records;
}

export function launchCounts(records) {
  const counts = {};
  for (const record of records) counts[record.label] = (counts[record.label] ?? 0) + 1;
  return counts;
}

function recordLaunch(entry) {
  const dir = demoDir();
  mkdirSync(dir, { recursive: true });
  appendFileSync(launchesPath(dir), `${JSON.stringify(entry)}\n`, "utf8");
}

function parseTask(task) {
  try {
    return JSON.parse(task);
  } catch {
    return {};
  }
}

function abortError() {
  return Object.assign(new Error("demo adapter aborted"), {
    details: { kind: "aborted", aborted: true },
  });
}

function sleep(ms, signal) {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      if (signal?.aborted) reject(abortError());
      else resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
    };
    if (signal?.aborted) {
      cleanup();
      reject(abortError());
      return;
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

async function waitForFile(path, timeoutMs, signal) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (!existsSync(path)) {
    if (signal?.aborted) throw abortError();
    if (Date.now() >= deadline) return false;
    await sleep(POLL_MS, signal);
  }
  return true;
}

export function adapterFactory(target) {
  return {
    async run(request, { signal, onProgress } = {}) {
      const instruction = parseTask(request.task);
      const kind = typeof instruction.kind === "string" ? instruction.kind : "work";
      const label = typeof instruction.label === "string" && instruction.label ? instruction.label : `call-${request.requestId}`;
      const priorForLabel = readLaunches().filter((entry) => entry.label === label).length;
      const attempt = priorForLabel + 1;
      recordLaunch({
        at: new Date().toISOString(),
        pid: process.pid,
        target,
        kind,
        label,
        requestId: request.requestId ?? null,
        attempt,
      });
      if (typeof onProgress === "function") {
        await onProgress({ phase: "demo-launch", label, target, attempt });
      }
      if (signal?.aborted) throw abortError();

      if (kind === "plan") {
        await sleep(PLAN_DELAY_MS, signal);
      } else if (kind === "work") {
        await sleep(WORK_DELAY_MS, signal);
        if (instruction.failFirst === true && attempt === 1) {
          throw Object.assign(new Error(`synthetic ${label} failure`), {
            details: { kind: "downstream", demoFailure: true },
          });
        }
      } else if (kind === "checkpoint") {
        if (instruction.holdUntilFile) {
          await waitForFile(instruction.holdUntilFile, instruction.maxHoldMs ?? DEFAULT_MAX_HOLD_MS, signal);
        }
        await sleep(instruction.postFileHoldMs ?? DEFAULT_POST_FILE_HOLD_MS, signal);
      } else if (kind === "after-pause") {
        await sleep(AFTER_PAUSE_DELAY_MS, signal);
      }
      if (signal?.aborted) throw abortError();

      return {
        sessionId: `demo-${target}-${label}-${attempt}`,
        result: {
          finalText: JSON.stringify({
            label,
            target,
            kind,
            items: instruction.items ?? null,
            attempt,
          }),
        },
        usage: { input_tokens: 7 * attempt, output_tokens: 3 * attempt },
      };
    },
  };
}

export default adapterFactory;
