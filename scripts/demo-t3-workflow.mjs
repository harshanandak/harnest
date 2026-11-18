#!/usr/bin/env node
// Harnest T3 proof demo: starts one named three-invocation dynamic workflow
// with the zero-paid fake adapter and prints {runId, stateDir} so the T3-side
// adapter (or the parent session) can drive observation and controls through
// src/t3-bridge.mjs. The script itself never steps the run unless an
// explicitly documented flag says so:
//
//   node scripts/demo-t3-workflow.mjs [--root <repo>] [--fixture <dir>]
//       [--state <dir>] [--timeout-ms <ms>] [--wait-ready]
//
//       Starts "Harnest T3 proof" (phases plan/review/finish; three fake
//       adapter agents; the review agent fails its first launch via the
//       adapter's failFirst seam, then the finish agent parks on the gate
//       file). Prints exactly one JSON object {runId, stateDir} and exits,
//       leaving the detached dynamic worker parked on the finish hold.
//
//   node scripts/demo-t3-workflow.mjs --release --state <dir>
//       Writes the finish gate file so the held finish agent drains. No
//       control is issued; prints {runId, stateDir}.
//
//   node scripts/demo-t3-workflow.mjs --resume <runId> --state <dir>
//       Performs the durable same-source resume exactly as a bridge `resume`
//       dispatch does: through createT3Bridge, which injects the trusted
//       adapter seam from HARNEST_WORKER_ADAPTER (defaulting to this
//       repo's zero-paid fake adapter, so the proof never launches a harness).
//       Prints {runId, stateDir, resumed, state} after the attempt settles.
//
// Modes are mutually exclusive. No paid model calls: the adapter fixture
// never launches a harness or touches the network.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Companion } from "../src/companion.mjs";
import { DynamicWorkflowRunner } from "../src/dynamic-runner.mjs";
import { createT3Bridge } from "../src/t3-bridge.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const ADAPTER_PATH = resolve(HERE, "fixtures", "dynamic-demo-adapter.mjs");
const NAME = "harnest-t3-proof";

export const WORKFLOW_SOURCE = [
  "export const meta = {",
  `  name: "${NAME}",`,
  '  description: "Zero-paid three-agent T3 proof: plan, review with one failed attempt, finish",',
  '  phases: ["plan", "review", "finish"],',
  "};",
  "",
  'await phase("plan");',
  'const plan = await agent(',
  '  JSON.stringify({ kind: "plan", label: "plan", items: args.items }),',
  '  { label: "plan", target: "pi" },',
  ");",
  'if (!plan) return { branch: "plan-failed" };',
  "",
  'await phase("review");',
  'const review = await agent(',
  "  JSON.stringify({",
  '    kind: "work",',
  '    label: "review",',
  "    items: args.items,",
  "    failFirst: args.failReview !== false,",
  "  }),",
  '  { label: "review", target: "opencode", route: { model: "demo/opencode" } },',
  ");",
  "",
  'await phase("finish");',
  '// The finish agent parks on a gate file so the run stays observable while',
  "// a T3 panel (or the parent session) drives controls through the bridge.",
  "const finish = await agent(",
  "  JSON.stringify({",
  '    kind: "checkpoint",',
  '    label: "finish",',
  "    holdUntilFile: args.finishGate || null,",
  "    maxHoldMs: args.maxHoldMs || 0,",
  "    postFileHoldMs: 150,",
  "  }),",
  '  { label: "finish", target: "pi" },',
  ");",
  "",
  "return {",
  '  branch: plan ? "proceed" : "no-plan",',
  "  itemCount: args.items.length,",
  "  plan: plan ? JSON.parse(plan.finalText).label : null,",
  "  review: review ? JSON.parse(review.finalText).label : null,",
  "  finish: finish ? JSON.parse(finish.finalText).label : null,",
  "};",
].join("\n");

const sleep = (ms) => new Promise((resolve_) => setTimeout(resolve_, ms));

async function waitFor(description, predicate, timeoutMs, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${description}`);
    await sleep(intervalMs);
  }
}

export function parseArgs(argv = process.argv.slice(2)) {
  const result = { mode: "start", timeoutMs: 120_000 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const take = () => {
      const value = argv[++index];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      return value;
    };
    if (arg === "--root") result.root = resolve(take());
    else if (arg === "--fixture") result.fixture = resolve(take());
    else if (arg === "--state") result.state = resolve(take());
    else if (arg === "--timeout-ms") result.timeoutMs = Number(take());
    else if (arg === "--release") result.mode = "release";
    else if (arg === "--resume") result.mode = "resume", result.runId = take();
    else if (arg === "--help" || arg === "-h") result.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (result.mode === "resume" && !/^dyn-[a-f0-9]{64}$/.test(result.runId ?? "")) {
    throw new Error("--resume requires a dyn-<64 hex> runId");
  }
  if (result.mode !== "start" && !result.state) throw new Error(`--${result.mode} requires --state <dir>`);
  if (result.state && (!isAbsolute(result.state) || result.state.includes(".."))) {
    throw new Error("--state must be an absolute path without traversal");
  }
  return result;
}

export async function main(argv = process.argv.slice(2), out = process.stdout) {
  const args = parseArgs(argv);
  if (args.help) {
    out.write("Usage: see scripts/demo-t3-workflow.mjs header comment\n");
    return 0;
  }

  const fixture = args.fixture ?? join(tmpdir(), "harnest-t3-demo", new Date().toISOString().replace(/[:.]/g, "-"));
  const stateDir = args.state ?? join(fixture, "state");
  mkdirSync(stateDir, { recursive: true });
  const gatePath = join(stateDir, "finish-gate");
  mkdirSync(dirname(gatePath), { recursive: true });

  const print = (value) => out.write(`${JSON.stringify(value)}\n`);

  if (args.mode === "release") {
    writeFileSync(gatePath, "release\n", "utf8");
    print({ runId: null, stateDir, released: gatePath });
    return 0;
  }

  process.env.HARNEST_WORKER_ADAPTER = ADAPTER_PATH;
  process.env.HARNEST_DEMO_DIR = stateDir;

  if (args.mode === "resume") {
    // Route through createT3Bridge so this is byte-for-byte the same code
    // path an HTTP resume dispatch takes: same restricted schema (no source
    // replacement), same trusted adapter seam (env or explicit adapterPath).
    // The zero-paid proof always injects the fake adapter; a production T3
    // server must leave HARNEST_WORKER_ADAPTER unset and use its own
    // real adapters. The process waits for a terminal state before printing
    // so the run never loses its lease on exit.
    if (!process.env.HARNEST_WORKER_ADAPTER) {
      process.env.HARNEST_WORKER_ADAPTER = ADAPTER_PATH;
    }
    const bridge = await createT3Bridge({ stateDir, adapterPath: process.env.HARNEST_WORKER_ADAPTER });
    await bridge.dispatch({ operation: "resume", input: { runId: args.runId, commandId: `t3-proof-resume-${Date.now().toString(36)}` } });
    const settled = await waitFor("resumed run to settle", async () => {
      const status = await bridge.dispatch({ operation: "status", input: { runId: args.runId } });
      return ["completed", "failed", "cancelled", "partial"].includes(status.state) ? status : null;
    }, args.timeoutMs);
    print({ runId: settled.runId, stateDir, resumed: true, state: settled.state });
    return 0;
  }

  const spec = {
    requestId: `t3-proof-${Date.now().toString(36)}`,
    name: NAME,
    source: WORKFLOW_SOURCE,
    args: {
      items: [1, 2, 3],
      finishGate: gatePath,
      maxHoldMs: Math.max(30_000, args.timeoutMs),
      failReview: true,
    },
    cwd: stateDir,
    target: "auto",
    route: {},
    policy: { write: false, tools: [], maxCostUsd: null },
    context: { demo: "harnest-t3-proof" },
    metadata: { demo: "harnest-t3-proof", routing: { fallbacks: false } },
    execution: { background: true, timeoutMs: Math.max(90_000, args.timeoutMs), maxConcurrency: 3, maxAgents: 10, prefixStaggerMs: 0 },
  };

  const companion = new Companion({ stateDir });
  const runner = new DynamicWorkflowRunner({
    companion,
    stateDir: join(stateDir, "dynamic"),
    detachBackground: true,
    pollIntervalMs: 25,
    heartbeatIntervalMs: 250,
    leaseTimeoutMs: 20_000,
  });

  const validation = await runner.validate(spec);
  if (validation?.valid !== true || validation?.meta?.name !== NAME) {
    throw new Error(`demo workflow failed validation: ${JSON.stringify(validation?.meta ?? validation)}`);
  }
  const started = await runner.start(spec);
  const runId = started.runId;
  if (!["queued", "running"].includes(started.state)) {
    throw new Error(`demo run did not start: ${started.state}`);
  }

  // Park deterministically on the finish hold before printing, so the parent
  // always observes a running workflow rather than racing a fast completion.
  const bridge = await createT3Bridge({ stateDir });
  await waitFor("finish agent parked on the gate", async () => {
    const status = await bridge.dispatch({ operation: "status", input: { runId, invocationLimit: 10 } });
    if (["failed", "cancelled", "partial"].includes(status.state)) {
      throw new Error(`demo run reached ${status.state} before parking: ${JSON.stringify(status.error)}`);
    }
    const finishRow = (status.invocations ?? []).find((call) => call.label === "finish");
    return finishRow?.state === "running" && existsSync(gatePath) === false;
  }, args.timeoutMs).catch((error) => {
    // The hold timeout in the adapter is bounded; surface the failure plainly.
    throw error;
  });

  print({ runId, stateDir });
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`harnest-t3-demo failed: ${error?.message ?? error}\n`);
    process.exit(1);
  });
}
