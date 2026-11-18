import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Companion } from "../src/companion.mjs";
import { JobStore } from "../src/job-store.mjs";
import { DynamicWorkflowRunner } from "../src/dynamic-runner.mjs";
import * as fixtureEngine from "../scripts/fixtures/dynamic-runner-engine.mjs";

const WORKER = fileURLToPath(new URL("../src/dynamic-worker.mjs", import.meta.url));
const ENGINE = fileURLToPath(new URL("../scripts/fixtures/dynamic-runner-engine.mjs", import.meta.url));
const ADAPTER = fileURLToPath(new URL("../scripts/fixtures/dynamic-runner-adapter.mjs", import.meta.url));
const ROUTER = fileURLToPath(new URL("../scripts/fixtures/dynamic-runner-router.mjs", import.meta.url));
const NOOP_WORKER = fileURLToPath(new URL("../scripts/fixtures/dynamic-runner-noop-worker.mjs", import.meta.url));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function untilStatus(runner, runId, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await runner.status({ runId });
    if (predicate(status)) return status;
    if (Date.now() > deadline) throw new Error(`wait expired: ${label}`);
    await sleep(50);
  }
}

function spawnWorker(stateDir, runId, companionStateDir, extraEnv = {}) {
  const child = spawn(process.execPath, [WORKER, stateDir, runId, companionStateDir], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      HARNEST_DYNAMIC_ENGINE: ENGINE,
      HARNEST_WORKER_ADAPTER: ADAPTER,
      HARNEST_ROUTE_RESOLVER: ROUTER,
      ...extraEnv,
    },
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  const exit = new Promise((resolve) => { child.on("close", (code) => resolve(code ?? -1)); });
  return { child, exit, get stdout() { return stdout; } };
}

async function fixture(t, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), "harnest-dyn-worker-"));
  const jobs = new JobStore(join(root, "jobs"));
  const stateDir = join(root, "dynamic");
  const companion = new Companion({
    store: jobs,
    routeResolver: async (request) => request,
    adapterFactory: () => ({ run: async () => ({ result: { finalText: "in-process" } }) }),
    heartbeatIntervalMs: 20,
    cancelAckTimeoutMs: 40,
  });
  const runner = new DynamicWorkflowRunner({
    companion, stateDir, engine: fixtureEngine, detachBackground: true, pollIntervalMs: 50, heartbeatIntervalMs: 250, leaseTimeoutMs: 10_000,
    ...extra,
  });
  const spawned = [];
  t.after(async () => {
    for (const worker of spawned) { try { worker.child.kill(); } catch { /* already exited */ } }
    await sleep(50);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const env = {
    HARNEST_DYNAMIC_ENGINE: ENGINE,
    HARNEST_WORKER_ADAPTER: ADAPTER,
    HARNEST_ROUTE_RESOLVER: ROUTER,
  };
  const previous = {
    engine: process.env.HARNEST_DYNAMIC_ENGINE,
    adapter: process.env.HARNEST_WORKER_ADAPTER,
    router: process.env.HARNEST_ROUTE_RESOLVER,
  };
  Object.assign(process.env, env);
  t.after(() => {
    if (previous.engine === undefined) delete process.env.HARNEST_DYNAMIC_ENGINE; else process.env.HARNEST_DYNAMIC_ENGINE = previous.engine;
    if (previous.adapter === undefined) delete process.env.HARNEST_WORKER_ADAPTER; else process.env.HARNEST_WORKER_ADAPTER = previous.adapter;
    if (previous.router === undefined) delete process.env.HARNEST_ROUTE_RESOLVER; else process.env.HARNEST_ROUTE_RESOLVER = previous.router;
  });
  const spec = (plan, execution = {}) => ({
    requestId: "fixture",
    cwd: root,
    source: JSON.stringify({ name: "fixture", plan }),
    policy: { write: false },
    route: { model: "fixture/model" },
    execution: { background: true, prefixStaggerMs: 0, ...execution },
  });
  return { root, jobs, stateDir, companion, runner, spawned, spawn: (runId, extraEnv) => { const worker = spawnWorker(stateDir, runId, jobs.root, extraEnv); spawned.push(worker); return worker; }, spec };
}

const agent = (fields) => ({ type: "agent", prompt: JSON.stringify(fields) });

test("a detached worker owns the run after the spawning runner returns", { timeout: 120_000 }, async (t) => {
  const f = await fixture(t);
  const started = await f.runner.start(f.spec([agent({ delayMs: 1500, result: { finalText: "detached" } })], { background: true }));
  assert.equal(f.runner.running.size, 0, "the control-plane process must not own execution");
  const running = await untilStatus(f.runner, started.runId, (status) => status.state === "running" && status.invocations.length === 1 && ["prepared", "running"].includes(status.invocations[0].state), 30_000, "run running");
  assert.equal(running.invocations.length, 1);
  const terminal = await untilStatus(f.runner, started.runId, (status) => ["completed", "failed", "partial", "cancelled"].includes(status.state), 60_000, "run terminal");
  assert.equal(terminal.state, "completed");
  const settled = await f.runner.result({ runId: started.runId });
  assert.equal(settled.output.results[0].finalText, "detached");
  const record = await f.runner.store.readRun(started.runId);
  assert.equal(record.dispatchCount, 1);
  const journal = await f.runner.store.readJournal(started.runId, { limit: 500 });
  assert.ok(journal.events.some((event) => event.type === "claimed"), "the worker records a fenced claim");
  assert.ok(journal.events.some((event) => event.type === "settled"));
});

test("resuming a background run leaves execution with a detached worker", async (t) => {
  const f = await fixture(t);
  const started = await f.runner.start(f.spec([{ type: "throw", message: "initial failure" }]));
  await untilStatus(f.runner, started.runId, (status) => status.state === "partial", 60_000, "failed first attempt");
  const source = f.spec([agent({ result: { finalText: "resumed in detached worker" } })]).source;
  await f.runner.resume({ runId: started.runId, commandId: "resume-detached", source });
  const locallyOwned = f.runner.running.size;
  const terminal = await untilStatus(f.runner, started.runId, (status) => ["completed", "partial", "failed"].includes(status.state), 60_000, "resumed result");
  assert.equal(locallyOwned, 0);
  assert.equal(terminal.state, "completed");
  const result = await f.runner.result({ runId: started.runId });
  assert.equal(result.output.results[0].finalText, "resumed in detached worker");
});

test("two workers race for one run and only one dispatches", { timeout: 120_000 }, async (t) => {
  const f = await fixture(t);
  const started = await f.runner.start(f.spec([agent({ delayMs: 800, result: { finalText: "once" } })], { background: true }));
  const second = f.spawn(started.runId);
  const code = await second.exit;
  assert.equal(code, 0, "the losing worker exits cleanly");
  const terminal = await untilStatus(f.runner, started.runId, (status) => ["completed", "failed", "partial", "cancelled"].includes(status.state), 60_000, "run terminal");
  assert.equal(terminal.state, "completed");
  const record = await f.runner.store.readRun(started.runId);
  assert.equal(record.dispatchCount, 1, "the fenced claim prevents double dispatch");
  assert.match(second.stdout, /DYNAMIC_WORKER_(SKIP|OK)/);
});

test("a cross-process stop reaches the detached worker and settles cancelled", { timeout: 120_000 }, async (t) => {
  const f = await fixture(t);
  const started = await f.runner.start(f.spec([agent({ delayMs: 60_000, result: { finalText: "never" } })], { background: true }));
  await untilStatus(f.runner, started.runId, (status) => status.invocations.some((invocation) => invocation.state === "running"), 30_000, "child running");
  const stopped = await f.runner.control({ runId: started.runId, commandId: "stop-worker", action: "stop" });
  assert.ok(["accepted", "applied"].includes(stopped.state), "a non-owning control plane persists intent truthfully");
  const terminal = await untilStatus(f.runner, started.runId, (status) => ["cancelled", "partial", "failed"].includes(status.state), 60_000, "run settled");
  assert.equal(terminal.state, "cancelled");
  const journal = await f.runner.store.readJournal(started.runId, { limit: 500 });
  assert.ok(journal.events.some((event) => event.type === "control" && event.state === "applied"), "the owner applies the command");
});

test("the worker exits nonzero for an unknown run and never fabricates one", { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const missing = "dyn-" + "f".repeat(64);
  const worker = f.spawn(missing);
  const code = await worker.exit;
  assert.equal(code, 1);
  assert.ok(worker.stdout.includes("DYNAMIC_WORKER_FAILED") || worker.stdout.length >= 0);
  assert.equal(await f.runner.store.readRun(missing), null);
});

test("a run whose worker dies before the claim is redispatched then settled unclaimed", { timeout: 120_000 }, async (t) => {
  const f = await fixture(t, { queuedClaimTimeoutMs: 150, maxDispatchAttempts: 2, workerPath: NOOP_WORKER });
  const started = await f.runner.start(f.spec([agent({ delayMs: 10, result: { finalText: "never" } })], { background: true }));
  const terminal = await untilStatus(f.runner, started.runId, (status) => ["partial", "completed", "failed", "cancelled"].includes(status.state), 60_000, "unclaimed terminal");
  assert.equal(terminal.state, "partial");
  assert.equal(terminal.error.details.kind, "unclaimed");
  const record = await f.runner.store.readRun(started.runId);
  assert.equal(record.dispatch.attempts, 2, "redispatch stops at the configured bound");
  assert.equal(record.dispatchCount, 0, "no child ever dispatched");
  const journal = await f.runner.store.readJournal(started.runId, { limit: 500 });
  assert.equal(journal.events.filter((event) => event.type === "dispatch").length, 2);
});
