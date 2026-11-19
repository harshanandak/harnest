#!/usr/bin/env node
// Zero-paid dynamic workflow demo (approved issue15 plan, acceptance 147).
//
// Runs the real QuickJS engine through the real detached DynamicWorkflowRunner
// with a real Companion, but every child handoff goes to the fake adapter in
// scripts/fixtures/dynamic-demo-adapter.mjs. No native harness process, no
// network or paid model calls. Write-capable routes still use the fake adapter.
//
// Flow: validate -> start -> branch -> mixed seven-target parallel fan-out ->
// one failed agent -> pause (in-flight checkpoint drains; the next dispatch
// parks) -> explicit stop -> fresh controller process resumes the ordered
// prefix -> final result -> per-invocation/history drill-in -> parameterized
// saved-workflow rerun. Canonical CLI frames are captured with
// `scripts/dynamic-view.mjs --once`.
//
// Artifacts stay in the fixture directory for human review and are printed as
// `DEMO_FIXTURE <path>`. Run the test for cleanup of its disposable fixture.
//
// Verification harness: --root points at another checkout (for example the
// lead's integrated tree); default is this repo. --engine is a verification
// override for the spawned workers only; the committed default is the tree's
// own src/dynamic-engine.mjs.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, "..");
const ADAPTER_PATH = join(HERE, "fixtures", "dynamic-demo-adapter.mjs");
const CONTROLLER_PATH = join(HERE, "fixtures", "dynamic-demo-controller.mjs");
const TERMINAL = new Set(["completed", "failed", "cancelled", "partial"]);
const PAUSE_COMMAND_ID = "demo-pause-1";
const STOP_COMMAND_ID = "demo-stop-1";
const RESUME_COMMAND_ID = "demo-resume-1";

const USAGE = `usage: node scripts/demo-dynamic-workflow.mjs [--root <dir>] [--fixture <dir>] [--engine <path>] [--timeout-ms <ms>]`;

export function parseArgs(argv) {
  const result = { timeoutMs: 120_000 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const take = () => {
      const value = argv[++index];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      return value;
    };
    if (arg === "--root") result.root = resolve(take());
    else if (arg === "--fixture") result.fixture = resolve(take());
    else if (arg === "--engine") result.engine = resolve(take());
    else if (arg === "--timeout-ms") result.timeoutMs = Number(take());
    else if (arg === "--help" || arg === "-h") result.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return result;
}

export const WORKFLOW_SOURCE = [
  'export const meta = {',
  '  name: "dynamic-demo",',
  '  description: "Zero-paid branch, seven-target fan-out, checkpoint and replay demo",',
  '  phases: ["plan", "fan-out", "checkpoint", "reduce"],',
  '};',
  '',
  'log("demo items=" + args.items.length);',
  'await phase("plan");',
  'const plan = await agent(',
  '  JSON.stringify({ kind: "plan", label: "plan", items: args.items }),',
  '  { label: "plan", target: "pi", policy: { write: false } },',
  ');',
  'if (!plan) {',
  '  return { branch: "plan-failed", itemCount: args.items.length };',
  '}',
  'const planned = JSON.parse(plan.finalText);',
  '',
  'await phase("fan-out");',
  'const lanes = [',
  '  ["work-pi", "pi"],',
  '  ["work-opencode", "opencode"],',
  '  ["work-claude", "claude"],',
  '  ["work-codex", "codex"],',
  '  ["work-cursor", "cursor"],',
  '  ["work-gemini", "gemini"],',
  '  ["work-amp", "amp"],',
  '];',
  'const laneResults = await parallel(lanes.map(function (lane) {',
  '  return async function () {',
  '    const response = await agent(',
  '      JSON.stringify({',
  '        kind: "work",',
  '        label: lane[0],',
  '        items: args.items,',
  '        failFirst: lane[0] === "work-cursor" && args.failCursor !== false,',
  '      }),',
  '      { label: lane[0], target: lane[1], policy: { write: ["opencode", "amp"].includes(lane[1]) },',
  '        ...(lane[1] === "opencode" ? { route: { model: "demo/opencode" } } : {}) },',
  '    );',
  '    return {',
  '      label: lane[0],',
  '      target: lane[1],',
  '      failed: response === null,',
  '      attempt: response ? JSON.parse(response.finalText).attempt : null,',
  '    };',
  '  };',
  '}));',
  '',
  'await phase("checkpoint");',
  'const checkpoint = await agent(',
  '  JSON.stringify({',
  '    kind: "checkpoint",',
  '    label: "checkpoint",',
  '    holdUntilFile: args.pauseGate ? args.pauseGate : null,',
  '    maxHoldMs: args.maxHoldMs ? args.maxHoldMs : 0,',
  '    postFileHoldMs: 200,',
  '  }),',
  '  { label: "checkpoint", target: "pi", policy: { write: false } },',
  ');',
  '',
  'const afterPause = await agent(',
  '  JSON.stringify({ kind: "after-pause", label: "after-pause", items: args.items }),',
  '  { label: "after-pause", target: "pi", policy: { write: false } },',
  ');',
  '',
  'await phase("reduce");',
  'const failedLabels = laneResults',
  '  .filter(function (lane) { return lane.failed; })',
  '  .map(function (lane) { return lane.label; });',
  'return {',
  '  branch: planned.target === "pi" ? "proceed" : "unexpected-plan-target",',
  '  itemCount: args.items.length,',
  '  checkpoint: checkpoint ? JSON.parse(checkpoint.finalText).label : null,',
  '  afterPause: afterPause ? JSON.parse(afterPause.finalText).label : null,',
  '  lanes: laneResults,',
  '  failedLabels: failedLabels,',
  '  completedCount: laneResults.length - failedLabels.length,',
  '  total: laneResults.reduce(function (sum, lane) {',
  '    return sum + (lane.failed ? 0 : args.items.length);',
  '  }, 0),',
  '};',
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

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function runProcess(command, argv, { timeoutMs, env, onSpawn } = {}) {
  return new Promise((settle) => {
    const child = spawn(command, argv, { env: env ?? process.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let done = false;
    onSpawn?.(child);
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish(-1, "timeout");
    }, timeoutMs);
    const finish = (code, reason) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      settle({ code, reason, stdout, stderr, child });
    };
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { stderr += `spawn error: ${error.message}`; finish(-1, "spawn-error"); });
    child.on("close", (code) => finish(code ?? -1, "exit"));
  });
}

async function captureView(root, runId, companionStateDir, dynamicStateDir, txtPath, jsonPath) {
  const script = join(root, "scripts", "dynamic-view.mjs");
  const base = ["--once", "--state-dir", companionStateDir, "--dynamic-state-dir", dynamicStateDir, runId];
  const frame = await runProcess(process.execPath, [script, ...base], { timeoutMs: 30_000 });
  if (frame.code !== 0) throw new Error(`dynamic-view --once failed for ${runId}: ${(frame.stderr || frame.stdout).slice(0, 500)}`);
  writeFileSync(txtPath, frame.stdout, "utf8");
  const json = await runProcess(process.execPath, [script, "--json", ...base], { timeoutMs: 30_000 });
  if (json.code === 0) {
    try {
      writeJson(jsonPath, JSON.parse(json.stdout));
    } catch {
      writeFileSync(jsonPath, json.stdout, "utf8");
    }
  }
  return frame.stdout;
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const out = io.stdout ?? process.stdout;
  const args = parseArgs(argv);
  if (args.help) {
    out.write(`${USAGE}\n`);
    return 0;
  }

  const root = args.root ?? DEFAULT_ROOT;
  const fixture = args.fixture ?? join(tmpdir(), "harnest-dynamic-demo", new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(fixture, { recursive: true });
  out.write(`DEMO_FIXTURE ${fixture}\n`);

  const companionStateDir = join(fixture, "companion");
  const dynamicStateDir = join(fixture, "dynamic");
  const workDir = join(fixture, "cwd");
  const viewDir = join(fixture, "view");
  const inspectDir = join(fixture, "inspect");
  const traceDir = join(fixture, "traces");
  for (const dir of [companionStateDir, dynamicStateDir, workDir, viewDir, inspectDir, traceDir]) mkdirSync(dir, { recursive: true });

  const gatePath = join(fixture, "pause-gate");
  const enginePath = args.engine ?? join(root, "src", "dynamic-engine.mjs");
  check(existsSync(enginePath), `engine module not found: ${enginePath}`);
  if (args.engine) process.env.HARNEST_DYNAMIC_ENGINE = enginePath;
  process.env.HARNEST_WORKER_ADAPTER = ADAPTER_PATH;
  process.env.HARNEST_DEMO_DIR = fixture;

  const importFromRoot = (relative) => import(pathToFileURL(join(root, relative)).href);
  const { Companion } = await importFromRoot("src/companion.mjs");
  const { DynamicWorkflowRunner } = await importFromRoot("src/dynamic-runner.mjs");
  const { WorkflowRegistry } = await importFromRoot("src/workflow-registry.mjs");
  const engineModule = await import(pathToFileURL(enginePath).href);
  const validateScript = engineModule.validateScript ?? engineModule.default?.validateScript;
  check(typeof validateScript === "function", `engine module must export validateScript: ${enginePath}`);
  const { readLaunches, launchCounts } = await import(pathToFileURL(ADAPTER_PATH).href);

  const companion = new Companion({ stateDir: companionStateDir, detachBackground: false });
  const runner = new DynamicWorkflowRunner({
    companion,
    stateDir: dynamicStateDir,
    detachBackground: true,
    pollIntervalMs: 25,
    heartbeatIntervalMs: 250,
    leaseTimeoutMs: 20_000,
  });
  const registry = new WorkflowRegistry({ userDir: join(fixture, "workflows"), validateScript });

  const manifest = {
    startedAt: new Date().toISOString(),
    pid: process.pid,
    root,
    fixture,
    enginePath,
    adapterPath: ADAPTER_PATH,
    controllerPath: CONTROLLER_PATH,
    companionStateDir,
    dynamicStateDir,
    runnerDependencies: [
      "ordered-prefix replay: a failed/cancelled call must invalidate reuse of the suffix (runner worker owns)",
      "reconcile: a persisted intent with no child job must be relaunchable after a parked pause (runner worker owns)",
      "replay delivery: concurrent cached callbacks must settle in the recorded order (runner worker owns)",
    ],
    runIds: {},
    launches: null,
    controls: {},
    status: {},
    results: {},
    history: null,
    historyPages: null,
    inspects: {},
    traces: {},
    frames: {},
    savedWorkflow: null,
    savedRerun: null,
    controllerResume: null,
    assertions: [],
    error: null,
    artifacts: {
      workflow: join(fixture, "workflow.js"),
      launches: join(fixture, "launches.jsonl"),
      stoppedStatus: join(fixture, "stopped.status.json"),
      stoppedResult: join(fixture, "stopped.result.json"),
      finalStatus: join(fixture, "final.status.json"),
      finalResult: join(fixture, "final.result.json"),
      history: join(fixture, "history.json"),
      inspectDir,
      traceDir,
      viewDir,
      controllerResume: join(fixture, "controller-resume.json"),
      manifest: join(fixture, "demo.json"),
    },
  };

  const assert = (name, condition, detail = null) => {
    const entry = { name, ok: Boolean(condition), detail };
    manifest.assertions.push(entry);
    if (!entry.ok) throw new Error(`assertion failed: ${name}${detail !== null ? ` (${JSON.stringify(detail)})` : ""}`);
  };

  const activeRunIds = new Set();
  const activeChildren = new Set();
  const stopAll = async () => {
    for (const runId of activeRunIds) {
      try {
        const status = await runner.status({ runId });
        if (!TERMINAL.has(status.state)) {
          await runner.control({ runId, commandId: `demo-cleanup-${runId}`, action: "stop" }).catch(() => undefined);
          await waitFor(`cleanup stop ${runId}`, async () => {
            const current = await runner.status({ runId }).catch(() => null);
            return !current || TERMINAL.has(current.state);
          }, 20_000).catch(() => undefined);
        }
      } catch {
        /* cleanup is best effort */
      }
    }
    for (const child of activeChildren) {
      try { child.kill(); } catch { /* already gone */ }
    }
  };

  let exitCode = 0;
  let outcome = "";
  try {
    writeFileSync(manifest.artifacts.workflow, WORKFLOW_SOURCE, "utf8");

    // --- initial run: branch -> seven-target fan-out -> one failed agent ----
    const requestId = `demo-${Date.now().toString(36)}`;
    const spec = {
      requestId,
      name: "dynamic-demo",
      source: WORKFLOW_SOURCE,
      args: { items: [1, 2, 3, 4, 5], pauseGate: gatePath, maxHoldMs: 30_000, failCursor: true },
      cwd: workDir,
      target: "auto",
      route: {},
      policy: { write: true, tools: [], maxCostUsd: null },
      context: { demo: "dynamic-workflow" },
      metadata: { demo: "dynamic-workflow", routing: { fallbacks: false } },
      execution: { background: true, timeoutMs: 90_000, maxConcurrency: 6, maxAgents: 40, prefixStaggerMs: 0 },
    };
    const validation = await runner.validate(spec);
    assert(
      "validate accepts the script and returns literal metadata",
      validation?.valid === true && validation?.meta?.name === "dynamic-demo",
      validation?.meta ?? validation,
    );
    const started = await runner.start(spec);
    const runId = started.runId;
    activeRunIds.add(runId);
    manifest.runIds.initial = runId;
    manifest.status.started = started;
    assert("start returns a queued or running run", ["queued", "running"].includes(started.state), started.state);

    await waitFor("checkpoint dispatch", async () => {
      const counts = launchCounts(readLaunches(fixture));
      if ((counts.checkpoint ?? 0) >= 1) return true;
      const status = await runner.status({ runId });
      if (TERMINAL.has(status.state)) {
        throw new Error(`initial run reached ${status.state} before checkpoint dispatch: ${JSON.stringify(status.error)}`);
      }
      return false;
    }, 45_000);
    const beforePause = launchCounts(readLaunches(fixture));
    assert(
      "branch and all seven targets dispatched before pause",
      beforePause.plan === 1
        && ["work-pi", "work-opencode", "work-claude", "work-codex", "work-cursor", "work-gemini", "work-amp"].every((label) => beforePause[label] === 1)
        && beforePause.checkpoint === 1,
      beforePause,
    );

    // --- pause: in-flight checkpoint drains, the next dispatch parks --------
    await runner.control({ runId, commandId: PAUSE_COMMAND_ID, action: "pause" });
    await waitFor("pause applied", async () => {
      const status = await runner.status({ runId });
      const command = (status.controls ?? []).find((item) => item.commandId === PAUSE_COMMAND_ID);
      return command?.state === "applied" || status.state === "pausing" || status.state === "paused";
    }, 20_000);
    writeFileSync(gatePath, "release\n", "utf8");
    const pausedStatus = await waitFor("paused after the checkpoint drained", async () => {
      const status = await runner.status({ runId });
      return status.state === "paused" ? status : null;
    }, 30_000);
    manifest.status.paused = pausedStatus;
    const pausedControl = (pausedStatus.controls ?? []).find((item) => item.commandId === PAUSE_COMMAND_ID);
    assert(
      "pause receipt is applied with the dispatch gate closed",
      pausedControl?.state === "applied" && pausedControl?.effect === "dispatch-gate-closed",
      pausedControl ?? null,
    );
    const gated = launchCounts(readLaunches(fixture));
    assert("paused run did not dispatch the next agent", (gated["after-pause"] ?? 0) === 0, gated);
    await sleep(800);
    const stillGated = launchCounts(readLaunches(fixture));
    assert("paused run stayed gated", (stillGated["after-pause"] ?? 0) === 0, stillGated);

    // --- explicit stop, then reconcile to a terminal state ------------------
    await runner.control({ runId, commandId: STOP_COMMAND_ID, action: "stop" });
    const stoppedStatus = await waitFor("stop applied and the run terminal", async () => {
      const status = await runner.status({ runId });
      const stop = (status.controls ?? []).find((item) => item.commandId === STOP_COMMAND_ID);
      return TERMINAL.has(status.state) && stop?.state === "applied" ? status : null;
    }, 45_000);
    manifest.status.stopped = stoppedStatus;
    manifest.controls.stopped = (stoppedStatus.controls ?? []).filter((item) => [PAUSE_COMMAND_ID, STOP_COMMAND_ID].includes(item.commandId));
    assert("stopped run is terminal and was not completed", stoppedStatus.state !== "completed", stoppedStatus.state);
    writeJson(manifest.artifacts.stoppedStatus, stoppedStatus);
    try {
      manifest.results.stopped = await runner.result({ runId });
    } catch (error) {
      manifest.results.stopped = { unavailable: error.message, kind: error?.details?.kind ?? null };
    }
    writeJson(manifest.artifacts.stoppedResult, manifest.results.stopped);
    manifest.frames.stopped = await captureView(
      root, runId, companionStateDir, dynamicStateDir,
      join(viewDir, "stopped.txt"), join(viewDir, "stopped.json"),
    );
    // --- fresh controller process resumes the ordered prefix ----------------
    const afterStop = launchCounts(readLaunches(fixture));
    manifest.launchesAfterStop = afterStop;
    assert("stop left the parked dispatch unlaunched", (afterStop["after-pause"] ?? 0) === 0, afterStop);

    const controllerRun = await runProcess(process.execPath, [
      CONTROLLER_PATH,
      "--root", root,
      "--fixture", fixture,
      "--harnest-state-dir", companionStateDir,
      "--dynamic-state-dir", dynamicStateDir,
      "--run", runId,
      "--command-id", RESUME_COMMAND_ID,
      "--adapter", ADAPTER_PATH,
      ...(args.engine ? ["--engine", enginePath] : []),
      "--timeout-ms", String(args.timeoutMs),
    ], {
      timeoutMs: args.timeoutMs + 30_000,
      onSpawn: (child) => activeChildren.add(child),
    });
    activeChildren.delete(controllerRun.child);
    writeFileSync(join(fixture, "controller.stdout.txt"), controllerRun.stdout, "utf8");
    writeFileSync(join(fixture, "controller.stderr.txt"), controllerRun.stderr, "utf8");
    check(controllerRun.code === 0, `fresh controller exit ${controllerRun.code}: ${(controllerRun.stderr || controllerRun.stdout).slice(0, 800)}`);
    const controllerResume = readJson(manifest.artifacts.controllerResume);
    check(controllerResume, `fresh controller did not write ${manifest.artifacts.controllerResume}`);
    manifest.controllerResume = controllerResume;
    assert("resume ran in a fresh controller process", controllerResume.pid !== process.pid, { controller: controllerResume.pid, parent: process.pid });
    assert("resume preserved the run id", controllerResume.runId === runId, controllerResume.runId);
    assert("resume created attempt 2", controllerResume.attempt === 2, controllerResume.attempt);
    assert("resumed run completed", controllerResume.state === "completed", controllerResume.state);

    const afterResume = launchCounts(readLaunches(fixture));
    manifest.launchesAfterResume = afterResume;
    assert(
      "prefix lanes were reused without relaunching",
      ["plan", "work-pi", "work-opencode", "work-claude", "work-codex"].every((label) => afterResume[label] === 1),
      afterResume,
    );
    assert(
      "the failed lane and the invalidated suffix re-ran after resume",
      ["work-cursor", "work-gemini", "work-amp"].every((label) => afterResume[label] === 2)
        && afterResume.checkpoint === 2 && afterResume["after-pause"] === 1,
      afterResume,
    );

    // --- final status, result and per-invocation drill-in -------------------
    const finalStatus = await runner.status({ runId });
    const finalResult = await runner.result({ runId });
    manifest.status.final = finalStatus;
    manifest.results.final = finalResult;
    writeJson(manifest.artifacts.finalStatus, finalStatus);
    writeJson(manifest.artifacts.finalResult, finalResult);
    assert("final run completed", finalStatus.state === "completed", finalStatus.state);
    const output = finalResult.output ?? null;
    assert("branch returned proceed", output?.branch === "proceed", output?.branch ?? null);
    assert(
      "all seven lanes completed on resume",
      output?.completedCount === 7 && Array.isArray(output?.failedLabels) && output.failedLabels.length === 0,
      { completedCount: output?.completedCount, failedLabels: output?.failedLabels },
    );
    assert("parameterized items reduced after seven targets", output?.itemCount === 5 && output?.total === 35, { itemCount: output?.itemCount, total: output?.total });
    assert("checkpoint and after-pause results are present", output?.checkpoint === "checkpoint" && output?.afterPause === "after-pause", output ?? null);

    const labels = ["plan", "work-pi", "work-opencode", "work-claude", "work-codex", "work-cursor", "work-gemini", "work-amp", "checkpoint", "after-pause"];
    const invocations = finalStatus.invocations ?? [];
    assert("all ten invocations are present", invocations.length === 10 && labels.every((label) => invocations.some((call) => call.label === label)), invocations.map((call) => call.label));
    assert("invocation ordinals are 0..9", invocations.every((call, index) => call.ordinal === index), invocations.map((call) => call.ordinal));
    assert("every invocation completed", invocations.every((call) => call.state === "completed"), invocations.map((call) => [call.label, call.state]));
    assert("every invocation has a job and session id", invocations.every((call) => call.jobId && call.sessionId), invocations.map((call) => [call.label, call.jobId, call.sessionId]));
    const attemptsByLabel = Object.fromEntries(invocations.map((call) => [call.label, call.attempts]));
    assert(
      "prefix attempts were not repeated",
      ["plan", "work-pi", "work-opencode", "work-claude", "work-codex"].every((label) => attemptsByLabel[label] === 1),
      attemptsByLabel,
    );
    assert("the failed agent retried on resume", attemptsByLabel["work-cursor"] === 2, attemptsByLabel);
    assert("later Gemini and Amp lanes replayed after the failed agent", attemptsByLabel["work-gemini"] === 2 && attemptsByLabel["work-amp"] === 2, attemptsByLabel);
    assert(
      "the checkpoint re-ran after the failure invalidated the suffix",
      attemptsByLabel.checkpoint === 2,
      attemptsByLabel,
    );
    assert("the parked dispatch ran once on resume", attemptsByLabel["after-pause"] === 2, attemptsByLabel);

    const inspectCall = typeof runner.inspect === "function"
      ? (input) => runner.inspect(input)
      : (await importFromRoot("src/dynamic-inspect.mjs")).inspectDynamicInvocation.bind(null, runner);
    for (const call of invocations) {
      const inspect = await inspectCall({ runId, invocationId: call.id });
      manifest.inspects[call.id] = inspect;
      writeJson(join(inspectDir, `${call.id}.json`), inspect);
      assert(`inspect covers ${call.label}`, inspect.totalAttempts === call.attempts && inspect.attempts.length === call.attempts, { total: inspect.totalAttempts, attempts: inspect.attempts.length });
    }
    const failedAttempt = manifest.inspects[invocations.find((call) => call.label === "work-cursor")?.id]?.attempts?.[0];
    assert("history keeps the failed first attempt of the retried lane", failedAttempt?.state === "failed", failedAttempt ?? null);

    const jobIds = [...new Set(invocations.map((call) => call.jobId).filter(Boolean))];
    const traceOf = typeof companion.traceReference === "function"
      ? (jobId) => companion.traceReference({ jobId }, { limit: 20 })
      : (jobId) => companion.trace(jobId, { limit: 20 });
    for (const jobId of jobIds) {
      manifest.traces[jobId] = await traceOf(jobId);
      writeJson(join(traceDir, `${jobId}.json`), manifest.traces[jobId]);
    }
    assert("every invocation job has a readable trace", jobIds.every((jobId) => manifest.traces[jobId] != null), jobIds);

    manifest.frames.final = await captureView(root, runId, companionStateDir, dynamicStateDir, join(viewDir, "final.txt"), join(viewDir, "final.json"));
    const missingLabels = labels.filter((label) => !manifest.frames.final.includes(label));
    assert("canonical CLI frame lists every invocation", missingLabels.length === 0, missingLabels);
    assert("canonical CLI frame shows completion", manifest.frames.final.includes("completed"), null);
    // --- parameterized saved-workflow rerun ---------------------------------
    const saved = await registry.save({ name: "dynamic-demo", source: WORKFLOW_SOURCE, scope: "user" });
    manifest.savedWorkflow = saved;
    const definition = await registry.get({ name: "dynamic-demo", scope: "user" });
    assert("saved workflow round-trips by revision", definition.revision === saved.revision && definition.source === WORKFLOW_SOURCE, { revision: definition.revision });
    const rerun = await runner.start({
      requestId: `demo-saved-${Date.now().toString(36)}`,
      name: definition.name,
      source: definition.source,
      args: { items: [1, 2, 3], pauseGate: null, maxHoldMs: 0, failCursor: false },
      cwd: workDir,
      target: "auto",
      route: {},
      policy: { write: true, tools: [], maxCostUsd: null },
      metadata: { savedWorkflow: { name: definition.name, scope: definition.scope, revision: definition.revision } },
      execution: { background: true, timeoutMs: 90_000, maxConcurrency: 6, maxAgents: 40, prefixStaggerMs: 0 },
    });
    const savedRunId = rerun.runId;
    activeRunIds.add(savedRunId);
    manifest.runIds.savedRerun = savedRunId;
    assert("saved rerun has a distinct run id", savedRunId !== runId, { runId, savedRunId });
    const savedStatus = await waitFor("saved rerun terminal", async () => {
      const status = await runner.status({ runId: savedRunId });
      return TERMINAL.has(status.state) ? status : null;
    }, 90_000);
    const savedResult = await runner.result({ runId: savedRunId });
    manifest.savedRerun = {
      runId: savedRunId,
      definition: { name: definition.name, scope: definition.scope, revision: definition.revision },
      status: savedStatus,
      result: savedResult,
    };
    assert("saved rerun completed", savedStatus.state === "completed", savedStatus.state);
    assert(
      "saved rerun used its own parameters",
      savedResult.output?.itemCount === 3 && savedResult.output?.total === 21 && savedResult.output?.failedLabels?.length === 0,
      savedResult.output ?? null,
    );
    manifest.frames.savedRerun = await captureView(
      root, savedRunId, companionStateDir, dynamicStateDir,
      join(viewDir, "saved-rerun.txt"), join(viewDir, "saved-rerun.json"),
    );
    assert("saved rerun frame renders the workflow name", manifest.frames.savedRerun.includes("dynamic-demo") && manifest.frames.savedRerun.includes("completed"), manifest.frames.savedRerun.slice(0, 200));

    // --- history drill-in across every run ----------------------------------
    const history = await runner.history({ limit: 50 });
    manifest.history = history;
    writeJson(manifest.artifacts.history, history);
    assert(
      "history lists both the resumed run and the saved rerun",
      history.runs.some((run) => run.runId === runId) && history.runs.some((run) => run.runId === savedRunId),
      history.runs.map((run) => run.runId),
    );
    const page1 = await runner.history({ limit: 1 });
    const page2 = page1.nextCursor ? await runner.history({ limit: 1, cursor: page1.nextCursor }) : null;
    manifest.historyPages = { page1, page2 };
    assert(
      "history pagination returns disjoint pages",
      page2 !== null && page1.runs[0]?.runId !== page2.runs[0]?.runId,
      { page1: page1.runs.map((run) => run.runId), page2: page2?.runs.map((run) => run.runId) },
    );

    // --- launch evidence across every process -------------------------------
    const launches = readLaunches(fixture);
    const counts = launchCounts(launches);
    const pids = [...new Set(launches.map((entry) => entry.pid))];
    manifest.launches = { records: launches, counts, pids };
    writeJson(join(fixture, "launch-counts.json"), { counts, pids });
    const expectedCounts = {
      plan: 2,
      "work-pi": 2,
      "work-opencode": 2,
      "work-claude": 2,
      "work-codex": 2,
      "work-cursor": 3,
      "work-gemini": 3,
      "work-amp": 3,
      checkpoint: 3,
      "after-pause": 2,
    };
    assert(
      "launch counts match the expected replay and rerun totals",
      Object.entries(expectedCounts).every(([label, expected]) => counts[label] === expected),
      { counts, expected: expectedCounts },
    );
    assert("child work ran in at least two OS processes", pids.length >= 2, pids);
    assert("every launch came from the fake adapter contract", launches.every((entry) => entry.target && entry.label && entry.requestId), launches.length);
    outcome = `DEMO_OK fixture=${fixture} runId=${manifest.runIds.initial ?? "none"} savedRunId=${manifest.runIds.savedRerun ?? "none"} finalState=${manifest.status.final?.state ?? "none"}`;
  } catch (error) {
    exitCode = 1;
    manifest.error = { message: error?.message ?? String(error), kind: error?.details?.kind ?? null };
    outcome = `DEMO_FAILED ${manifest.error.message} fixture=${fixture}`;
  } finally {
    await stopAll();
    writeJson(manifest.artifacts.manifest, manifest);
    out.write(`${outcome}\nDEMO_ARTIFACTS ${fixture}\n`);
  }
  return exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      process.stderr.write(`demo failed: ${error?.message ?? String(error)}\n`);
      process.exitCode = 1;
    });
}
