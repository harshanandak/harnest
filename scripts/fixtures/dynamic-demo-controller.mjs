#!/usr/bin/env node
// Fresh-process controller for the dynamic workflow demo.
//
// Run as a separate OS process so the demo proves that resume/reopen works from
// a brand-new controller: it imports the runner modules from --root, calls
// resume on the stopped run, waits for the terminal state, and writes its
// evidence next to the rest of the fixture artifacts.
//
// Usage:
//   node scripts/fixtures/dynamic-demo-controller.mjs \
//     --root <repo> --fixture <dir> --harnest-state-dir <dir> \
//     --dynamic-state-dir <dir> --run <runId> --command-id <id> \
//     [--engine <module path>] [--timeout-ms <ms>]
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const TERMINAL = new Set(["completed", "failed", "cancelled", "partial"]);

function parseArgs(argv) {
  const result = { timeoutMs: 90_000 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const take = () => {
      const value = argv[++index];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      return value;
    };
    if (arg === "--root") result.root = resolve(take());
    else if (arg === "--fixture") result.fixture = resolve(take());
    else if (arg === "--harnest-state-dir") result.companionStateDir = resolve(take());
    else if (arg === "--dynamic-state-dir") result.dynamicStateDir = resolve(take());
    else if (arg === "--run") result.runId = take();
    else if (arg === "--command-id") result.commandId = take();
    else if (arg === "--engine") result.engine = resolve(take());
    else if (arg === "--adapter") result.adapter = resolve(take());
    else if (arg === "--timeout-ms") result.timeoutMs = Number(take());
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!result.root || !result.fixture || !result.companionStateDir || !result.dynamicStateDir || !result.runId || !result.commandId) {
    throw new Error("--root, --fixture, --harnest-state-dir, --dynamic-state-dir, --run and --command-id are required");
  }
  return result;
}

const args = parseArgs(process.argv.slice(2));
mkdirSync(args.fixture, { recursive: true });

const importRoot = (relative) => import(pathToFileURL(join(args.root, relative)).href);
const { Companion } = await importRoot("src/companion.mjs");
const { DynamicWorkflowRunner } = await importRoot("src/dynamic-runner.mjs");

// Resume executes the new attempt in this process, so this controller must
// inject the same fake adapter the detached initial worker used. Real harness
// processes are never launched.
const companionOptions = { stateDir: args.companionStateDir, detachBackground: false };
const adapterPath = args.adapter ?? process.env.HARNEST_WORKER_ADAPTER;
if (adapterPath) {
  const adapterModule = await import(pathToFileURL(adapterPath).href);
  const factory = adapterModule?.adapterFactory ?? adapterModule?.default?.adapterFactory;
  const run = adapterModule?.run ?? adapterModule?.default?.run;
  if (typeof factory === "function") companionOptions.adapterFactory = factory;
  else if (typeof run === "function") companionOptions.adapterFactory = () => ({ run });
  else throw new Error("adapter module must export adapterFactory or run");
}
const companion = new Companion(companionOptions);
const runnerOptions = {
  companion,
  stateDir: args.dynamicStateDir,
  detachBackground: true,
  pollIntervalMs: 25,
  heartbeatIntervalMs: 250,
  leaseTimeoutMs: 20_000,
};
if (args.engine) {
  const engineModule = await import(pathToFileURL(args.engine).href);
  const engine = engineModule?.default?.runScript ? engineModule.default : engineModule;
  if (typeof engine?.runScript !== "function" || typeof engine?.validateScript !== "function") {
    throw new Error("--engine module must export validateScript and runScript");
  }
  runnerOptions.engine = engine;
}
const runner = new DynamicWorkflowRunner(runnerOptions);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitTerminal(runId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let status = await runner.status({ runId });
  while (!TERMINAL.has(status.state)) {
    if (Date.now() >= deadline) throw new Error(`run ${runId} stayed ${status.state} past ${timeoutMs}ms`);
    await sleep(100);
    status = await runner.status({ runId });
  }
  return status;
}

const evidencePath = join(args.fixture, "controller-resume.json");
let exitCode = 0;
try {
  const resumed = await runner.resume({ runId: args.runId, commandId: args.commandId, approveWrites: true });
  const status = await waitTerminal(args.runId, args.timeoutMs);
  const result = await runner.result({ runId: args.runId });
  const history = await runner.history({ limit: 50 });
  const record = {
    pid: process.pid,
    controller: "fresh-process",
    runId: args.runId,
    commandId: args.commandId,
    resumedState: resumed?.state ?? null,
    attempt: status.attempt,
    state: status.state,
    output: result.output ?? null,
    invocationIds: status.invocations.map((call) => call.id),
    invocationLabels: status.invocations.map((call) => call.label),
    controls: status.controls,
    historyCount: history.runs.length,
    at: new Date().toISOString(),
  };
  writeFileSync(evidencePath, JSON.stringify(record, null, 2), "utf8");
  process.stdout.write(`DEMO_CONTROLLER_OK ${JSON.stringify({ pid: process.pid, runId: args.runId, state: status.state, attempt: status.attempt })}\n`);
} catch (error) {
  exitCode = 1;
  writeFileSync(
    join(args.fixture, "controller-resume.error.json"),
    JSON.stringify({ pid: process.pid, runId: args.runId, commandId: args.commandId, message: error?.message ?? String(error), kind: error?.details?.kind ?? null }, null, 2),
    "utf8",
  );
  process.stdout.write(`DEMO_CONTROLLER_FAILED ${error?.message ?? String(error)}\n`);
  // Always try to stop the run this process may have resumed.
  try {
    const status = await runner.status({ runId: args.runId }).catch(() => null);
    if (status && !TERMINAL.has(status.state)) {
      await runner.control({ runId: args.runId, commandId: `${args.commandId}-cleanup`, action: "stop" }).catch(() => undefined);
      await waitTerminal(args.runId, 20_000).catch(() => undefined);
    }
  } catch {
    /* cleanup is best effort; the parent performs its own stop pass */
  }
} finally {
  process.exitCode = exitCode;
}
