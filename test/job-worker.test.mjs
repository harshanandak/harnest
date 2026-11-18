// Detached background execution: the worker claims a queued job with the
// same fenced semantics as an in-process run, and the job survives the
// process that started it. The fixture adapters (written into a temp dir,
// selected with HARNEST_WORKER_ADAPTER) never call real harnesses.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { Companion } from "../src/companion.mjs";
import { JobStore } from "../src/job-store.mjs";
import { createReceipt, normalizeRequest } from "../src/protocol.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workerPath = join(root, "src", "job-worker.mjs");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TERMINAL_STATES = new Set(["completed", "failed", "cancelled", "partial"]);

async function until(read, predicate, { timeoutMs = 30_000, intervalMs = 200, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (predicate(last)) return last;
    await wait(intervalMs);
  }
  throw new Error(`${label} was not reached within ${timeoutMs}ms; last=${JSON.stringify(last)?.slice(0, 400)}`);
}

async function scratch(t, prefix = "harnest-job-worker-") {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  return directory;
}

// Writes a fixture adapter module. `runExport` selects the run-function seam
// instead of adapterFactory; `gate` holds the run until a release file
// appears so a test can prove who owns the execution; `throwMessage` makes
// the adapter throw so a worker failure can be observed end to end.
async function writeAdapterModule(directory, name, { gate = false, runExport = false, throwMessage = null, finalText = "WORKER_FIXTURE_RESULT" } = {}) {
  const path = join(directory, name);
  await writeFile(path, `
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.env.HARNEST_WORKER_TEST_DIR;
async function execute(request, { onProgress }) {
  await onProgress({ type: "text", text: "worker fixture progress" });
  appendFileSync(join(dir, "runs.jsonl"), JSON.stringify({ pid: process.pid, requestId: request.requestId }) + "\\n");
  ${throwMessage
    ? `throw new Error(${JSON.stringify(throwMessage)});`
    : `${gate
      ? `writeFileSync(join(dir, "started.json"), JSON.stringify({ pid: process.pid, requestId: request.requestId }));
  const release = join(dir, "release");
  while (!existsSync(release)) await new Promise((resolve) => setTimeout(resolve, 50));`
      : `await new Promise((resolve) => setTimeout(resolve, 150));`}
  return { sessionId: "worker-session", result: { finalText: ${JSON.stringify(finalText)} } };`}
}
${runExport ? "export async function run(request, context) { return execute(request, context); }" : "export const adapterFactory = () => ({ run: execute });"}
`);
  return path;
}

// Writes a worker adapter module that dies during import: the worker starts,
// records the spawn, and exits before the fenced claim, leaving the job
// queued exactly like a crash or a bad worker environment.
async function writeDiesOnImportModule(directory, name) {
  const path = join(directory, name);
  await writeFile(path, `
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(join(directory, "spawns.jsonl"))}, "spawn\\n");
throw new Error("worker fixture cannot initialize");
`);
  return path;
}

// Creates a queued job exactly as Companion.start persists it before a
// detached worker is spawned.
async function queuedJob(directory, requestId, execution = { background: true, timeoutMs: 30_000 }) {
  const store = new JobStore(join(directory, "jobs"));
  const request = normalizeRequest({ requestId, target: "pi", task: "synthetic worker job", cwd: directory, execution });
  const receipt = createReceipt(request);
  const claim = await store.putIfRequestAbsent({
    request,
    receipt,
    trace: { eventCount: 0, lastEventAt: null, lastActivity: null, progress: receipt.trace.progress },
    lease: null,
    controls: [],
  });
  assert.equal(claim.created, true);
  return { store, jobId: receipt.jobId };
}

function spawnWorker(directory, jobId, adapterPath, options = {}) {
  return spawn(process.execPath, [workerPath, join(directory, "jobs"), jobId], {
    env: { ...process.env, HARNEST_WORKER_TEST_DIR: directory, HARNEST_WORKER_ADAPTER: adapterPath },
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function capture(child) {
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => { stdout += chunk; });
  child.stderr?.on("data", (chunk) => { stderr += chunk; });
  return { stdout: () => stdout, stderr: () => stderr };
}

function exitOf(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
}

test("job worker claims a queued job, executes it through the adapterFactory seam, and exits at terminal", { timeout: 60_000 }, async (t) => {
  const directory = await scratch(t);
  const adapter = await writeAdapterModule(directory, "factory-adapter.mjs", { finalText: "WORKER_CANARY_FACTORY" });
  const { store, jobId } = await queuedJob(directory, "worker-claims-factory");

  const child = spawnWorker(directory, jobId, adapter);
  const logs = capture(child);
  const code = await exitOf(child);
  assert.equal(code, 0, logs.stderr());
  assert.match(logs.stdout(), /JOB_WORKER_OK/);

  const job = await store.get(jobId);
  assert.equal(job.receipt.state, "completed");
  assert.equal(job.receipt.result.finalText, "WORKER_CANARY_FACTORY");
  assert.equal(job.receipt.sessionId, "worker-session");
  assert.equal(job.lease, null);
  const runs = (await readFile(join(directory, "runs.jsonl"), "utf8")).trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].pid, child.pid, "the adapter ran in the worker process");
});

test("closed stdin becomes a durable detached-worker failure rather than an unclaimed job", { timeout: 60_000 }, async (t) => {
  const directory = await scratch(t);
  const adapter = join(directory, "closed-stdin-adapter.mjs");
  await writeFile(adapter, `
import { runProcess } from ${JSON.stringify(pathToFileURL(join(root, "src", "process.mjs")).href)};
export async function run(request, { signal }) {
  await runProcess(process.execPath, ["-e", "process.exit(0)"], {
    stdinLines: ["x".repeat(80000)], signal, timeoutMs: request.execution.timeoutMs,
  });
  throw Object.assign(new Error("child supplied no terminal output"), { details: { kind: "downstream" } });
}
`);
  const { store, jobId } = await queuedJob(directory, "closed-stdin-durable");
  const child = spawnWorker(directory, jobId, adapter);
  const logs = capture(child);
  assert.equal(await exitOf(child), 0, logs.stderr());
  const job = await new JobStore(store.root).get(jobId);
  assert.equal(job.receipt.state, "failed");
  assert.equal(job.lease, null);
  assert.ok(["transport", "downstream"].includes(job.receipt.error.details.kind));
  assert.doesNotMatch(logs.stderr(), /Unhandled 'error' event/);
});

test("worker bootstrap diagnostics redact complete authorization payloads", { timeout: 60_000 }, async (t) => {
  const directory = await scratch(t);
  const adapter = join(directory, "bootstrap-failure.mjs");
  const sentinel = "synthetic-bootstrap-payload";
  await writeFile(adapter, `throw new Error(${JSON.stringify(`Authorization: Basic ${sentinel}`)});`);
  const { jobId } = await queuedJob(directory, "bootstrap-redaction");
  const child = spawnWorker(directory, jobId, adapter);
  const logs = capture(child);
  assert.equal(await exitOf(child), 1);
  assert.match(logs.stderr(), /\[REDACTED\]/);
  assert.equal(logs.stderr().includes(sentinel), false);
});

test("job worker supports the run-function seam and does not execute a terminal job again", { timeout: 60_000 }, async (t) => {
  const directory = await scratch(t);
  const adapter = await writeAdapterModule(directory, "run-adapter.mjs", { runExport: true, finalText: "WORKER_CANARY_RUN" });
  const { store, jobId } = await queuedJob(directory, "worker-claims-run");

  const first = spawnWorker(directory, jobId, adapter);
  assert.equal(await exitOf(first), 0);
  assert.equal((await store.get(jobId)).receipt.state, "completed");

  const second = spawnWorker(directory, jobId, adapter);
  const secondLogs = capture(second);
  assert.equal(await exitOf(second), 0, secondLogs.stderr());
  assert.match(secondLogs.stdout(), /JOB_WORKER_OK/);
  const runs = (await readFile(join(directory, "runs.jsonl"), "utf8")).trim().split(/\r?\n/);
  assert.equal(runs.length, 1, "a terminal job must not run its adapter again");
});

test("runQueued completes a queued job in-process and refuses a fenced job", { timeout: 30_000 }, async (t) => {
  const directory = await scratch(t);
  const { store, jobId } = await queuedJob(directory, "run-queued-in-process");
  let runs = 0;
  const companion = new Companion({
    stateDir: store.root,
    routeResolver: async (request) => request,
    adapterFactory: () => ({
      async run() {
        runs += 1;
        return { sessionId: "in-process-session", result: { finalText: "IN_PROCESS_CANARY" } };
      },
    }),
  });

  const receipt = await companion.runQueued(jobId);
  assert.equal(receipt.state, "completed");
  assert.equal(receipt.result.finalText, "IN_PROCESS_CANARY");
  assert.equal(runs, 1);
  assert.equal((await companion.runQueued(jobId)).state, "completed");
  assert.equal(runs, 1, "an already-terminal job is returned, not re-run");

  const owned = await queuedJob(directory, "run-queued-owned");
  await store.transition(owned.jobId, (job) => {
    job.receipt.state = "running";
    job.lease = { ownerId: "other-worker", pid: 1, host: "test", heartbeatAt: new Date().toISOString() };
    return job;
  });
  await assert.rejects(companion.runQueued(owned.jobId), (error) => error.details.kind === "claim-conflict");
  assert.equal(runs, 1);
});

test("two workers racing one queued job execute it exactly once", { timeout: 60_000 }, async (t) => {
  const directory = await scratch(t);
  const adapter = await writeAdapterModule(directory, "race-adapter.mjs", { finalText: "RACE_CANARY" });
  const { store, jobId } = await queuedJob(directory, "worker-race");

  const children = [spawnWorker(directory, jobId, adapter), spawnWorker(directory, jobId, adapter)]
    .map((child) => ({ child, logs: capture(child) }));
  const codes = await Promise.all(children.map(({ child }) => exitOf(child)));
  for (const [index, code] of codes.entries()) assert.equal(code, 0, children[index].logs.stderr());

  const settled = await until(() => store.get(jobId), (job) => TERMINAL_STATES.has(job.receipt.state), { label: "race job terminal" });
  assert.equal(settled.receipt.state, "completed");
  const runs = (await readFile(join(directory, "runs.jsonl"), "utf8")).trim().split(/\r?\n/);
  assert.equal(runs.length, 1, "the fenced claim must admit exactly one worker");
});

test("a detached background job survives caller death and completes while polled from a fresh process", { timeout: 90_000 }, async (t) => {
  const directory = await scratch(t, "harnest-job-survival-");
  const adapter = await writeAdapterModule(directory, "gated-adapter.mjs", { runExport: true, gate: true, finalText: "SURVIVAL_CANARY" });
  const companionUrl = new URL("../src/companion.mjs", import.meta.url).href;
  const starterScript = `
import { join } from "node:path";
import { Companion } from ${JSON.stringify(companionUrl)};
const companion = new Companion({
  stateDir: join(process.env.HARNEST_SURVIVAL_DIR, "jobs"),
  detachBackground: true,
  routeResolver: async (request) => request,
  adapterFactory: () => { throw new Error("the caller process must not run this adapter"); },
});
const receipt = await companion.start({ requestId: "survival-job", target: "pi", task: "survive caller death", cwd: process.env.HARNEST_SURVIVAL_DIR, execution: { background: true, timeoutMs: 60_000 } });
process.stdout.write(JSON.stringify({ jobId: receipt.jobId, state: receipt.state, pid: process.pid }) + "\\n");
process.exit(0);
`;
  const starter = spawn(process.execPath, ["--input-type=module", "-e", starterScript], {
    env: { ...process.env, HARNEST_SURVIVAL_DIR: directory, HARNEST_WORKER_TEST_DIR: directory, HARNEST_WORKER_ADAPTER: adapter },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let starterStderr = "";
  starter.stderr.on("data", (chunk) => { starterStderr += chunk; });
  const started = await new Promise((resolve, reject) => {
    let text = "";
    const timer = setTimeout(() => { starter.kill(); reject(new Error(`starter did not report a receipt: ${starterStderr}`)); }, 30_000);
    starter.stdout.on("data", (chunk) => {
      text += chunk;
      const line = text.split(/\r?\n/).find(Boolean);
      if (line) { clearTimeout(timer); resolve(JSON.parse(line)); }
    });
    starter.once("exit", (code) => { clearTimeout(timer); reject(new Error(`starter exited before reporting a receipt: ${code} ${starterStderr}`)); });
  });
  assert.equal(started.state, "queued");
  assert.equal(await exitOf(starter), 0, starterStderr);

  // The worker is gated on a release file that is written only after the
  // starter process is gone, so completion proves the detached owner.
  const workerStarted = await until(
    () => readFile(join(directory, "started.json"), "utf8").then(JSON.parse, () => null),
    Boolean,
    { label: "detached worker start" },
  );
  assert.notEqual(workerStarted.pid, started.pid, "the job must run in a process other than the caller");
  assert.notEqual(workerStarted.pid, process.pid);

  await writeFile(join(directory, "release"), "release");
  const store = new JobStore(join(directory, "jobs"));
  const settled = await until(() => store.get(started.jobId), (job) => TERMINAL_STATES.has(job.receipt.state), {
    timeoutMs: 60_000,
    label: "durable terminal receipt",
  });
  assert.equal(settled.receipt.state, "completed");
  assert.equal(settled.receipt.result.finalText, "SURVIVAL_CANARY");
  assert.equal(settled.receipt.sessionId, "worker-session");
  assert.equal(settled.lease, null);
  const runs = (await readFile(join(directory, "runs.jsonl"), "utf8")).trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].pid, workerStarted.pid);
});

test("failQueued terminalizes a queued or self-leased job and leaves terminal or foreign-leased jobs alone", { timeout: 30_000 }, async (t) => {
  const directory = await scratch(t, "harnest-job-failqueued-");
  const companion = new Companion({
    stateDir: join(directory, "jobs"),
    ownerId: "worker-under-test",
    routeResolver: async (request) => request,
    adapterFactory: () => ({ async run() { return { result: { finalText: "unused" } }; } }),
  });
  const { store, jobId } = await queuedJob(directory, "failqueued-unclaimed");
  const failure = Object.assign(new Error("worker environment is broken"), { details: { kind: "worker-env" } });

  const failed = await companion.failQueued(jobId, failure);
  assert.equal(failed.state, "failed");
  assert.equal(failed.error.message, "worker environment is broken");
  assert.equal(failed.error.details.kind, "worker-env");
  assert.equal((await store.get(jobId)).lease, null);

  // Terminal: a later failure must never rewrite the receipt.
  const again = await companion.failQueued(jobId, new Error("must not overwrite"));
  assert.equal(again.state, "failed");
  assert.equal(again.error.message, "worker environment is broken");
  assert.equal(again.completedAt, failed.completedAt);

  // Running under this process's lease: the worker failed mid-run.
  const owned = await queuedJob(directory, "failqueued-self-leased");
  await store.transition(owned.jobId, (job) => {
    job.receipt.state = "running";
    job.receipt.startedAt = new Date().toISOString();
    job.lease = { ownerId: "worker-under-test", pid: process.pid, host: "test", heartbeatAt: new Date().toISOString() };
    return job;
  });
  const running = await companion.failQueued(owned.jobId, new Error("adapter exploded"));
  assert.equal(running.state, "failed");
  assert.equal(running.error.message, "adapter exploded");
  assert.equal((await store.get(owned.jobId)).lease, null);

  // Running under another live process: never touched.
  const foreign = await queuedJob(directory, "failqueued-foreign-leased");
  await store.transition(foreign.jobId, (job) => {
    job.receipt.state = "running";
    job.lease = { ownerId: "other-worker", pid: 1, host: "test", heartbeatAt: new Date().toISOString() };
    return job;
  });
  const untouched = await companion.failQueued(foreign.jobId, new Error("must not overwrite"));
  assert.equal(untouched.state, "running");
  assert.equal((await store.get(foreign.jobId)).lease.ownerId, "other-worker");
});

test("a worker whose adapter throws terminalizes the job as failed promptly with the error recorded", { timeout: 60_000 }, async (t) => {
  const directory = await scratch(t);
  const adapter = await writeAdapterModule(directory, "throwing-adapter.mjs", { throwMessage: "synthetic adapter explosion" });
  const { store, jobId } = await queuedJob(directory, "worker-throwing-adapter");

  const startedAt = Date.now();
  const child = spawnWorker(directory, jobId, adapter);
  const logs = capture(child);
  assert.equal(await exitOf(child), 0, logs.stderr());
  assert.match(logs.stdout(), /JOB_WORKER_OK/);

  const job = await store.get(jobId);
  assert.equal(job.receipt.state, "failed");
  assert.match(job.receipt.error.message, /synthetic adapter explosion/);
  assert.equal(job.lease, null);
  assert.ok(Date.now() - startedAt < 30_000, "the failure must be terminal without waiting out the 60s stale window");
});

test("status re-dispatches a queued detached job whose worker died before claiming and settles it unclaimed at the cap", { timeout: 90_000 }, async (t) => {
  const directory = await scratch(t, "harnest-job-unclaimed-");
  const { store, jobId } = await queuedJob(directory, "worker-never-claims");

  // Inside the claim window, status must not spawn anything.
  const patient = new Companion({
    store,
    routeResolver: async (request) => request,
    detachBackground: true,
    queuedClaimTimeoutMs: 60_000,
    adapterFactory: () => { throw new Error("the polling process must not run this adapter"); },
  });
  const early = await patient.status(jobId);
  assert.equal(early.state, "queued");
  assert.equal(early.dispatch, undefined);
  assert.equal(await readFile(join(directory, "spawns.jsonl"), "utf8").catch(() => ""), "", "no worker may spawn before the claim window");

  const adapter = await writeDiesOnImportModule(directory, "dies-on-import.mjs");
  const previous = process.env.HARNEST_WORKER_ADAPTER;
  process.env.HARNEST_WORKER_ADAPTER = adapter;
  t.after(() => {
    if (previous === undefined) delete process.env.HARNEST_WORKER_ADAPTER;
    else process.env.HARNEST_WORKER_ADAPTER = previous;
  });
  const companion = new Companion({
    store,
    routeResolver: async (request) => request,
    detachBackground: true,
    queuedClaimTimeoutMs: 150,
    maxDispatchAttempts: 3,
    adapterFactory: () => { throw new Error("the polling process must not run this adapter"); },
  });

  const seenAttempts = new Set();
  const settled = await until(async () => {
    const receipt = await companion.status(jobId);
    if (Number.isInteger(receipt.dispatch?.attempts)) seenAttempts.add(receipt.dispatch.attempts);
    return receipt;
  }, (receipt) => receipt.state === "partial", { timeoutMs: 60_000, intervalMs: 40, label: "unclaimed cap settled" });

  assert.deepEqual([...seenAttempts].sort((left, right) => left - right), [1, 2, 3], "status must observe each dispatch attempt before the cap");
  assert.equal(settled.error.details.kind, "unclaimed");
  assert.equal(settled.error.details.attempts, 3);
  assert.equal(settled.error.details.maxAttempts, 3);
  assert.match(settled.error.details.hint, /resume/);
  assert.match(settled.error.details.hint, /inspect/);
  assert.equal(settled.recovery.canResume, true);
  assert.equal(settled.recoveryRequired, true);
  assert.equal(settled.dispatch.attempts, 3);
  assert.equal(settled.dispatch.maxAttempts, 3);
  assert.ok(Number.isFinite(Date.parse(settled.dispatch.lastAttemptAt)));
  assert.equal((await store.get(jobId)).lease, null);

  const spawns = await until(
    () => readFile(join(directory, "spawns.jsonl"), "utf8").then((text) => text.trim().split(/\r?\n/).filter(Boolean), () => []),
    (lines) => lines.length >= 3,
    { timeoutMs: 30_000, intervalMs: 100, label: "three spawned workers" },
  );
  assert.equal(spawns.length, 3, "each dispatch attempt must actually spawn one worker");

  const stable = await companion.status(jobId);
  assert.equal(stable.state, "partial");
  assert.equal(stable.dispatch.attempts, 3);
});

test("a hard-killed worker mid-run reconciles to resumable partial once its lease goes stale", { timeout: 90_000 }, async (t) => {
  const directory = await scratch(t, "harnest-job-killed-");
  const adapter = await writeAdapterModule(directory, "gated-hang-adapter.mjs", { runExport: true, gate: true });
  const { store, jobId } = await queuedJob(directory, "worker-killed-mid-run", { background: true, timeoutMs: 120_000 });

  const child = spawnWorker(directory, jobId, adapter);
  capture(child);
  const started = await until(
    () => readFile(join(directory, "started.json"), "utf8").then(JSON.parse, () => null),
    Boolean,
    { label: "worker claim and adapter start" },
  );
  assert.equal(started.pid, child.pid);
  const running = await store.get(jobId);
  assert.equal(running.receipt.state, "running");
  assert.equal(running.lease.pid, child.pid);

  child.kill();
  await exitOf(child);

  // Simulate the 60s stale window for the dead lease, then reconcile from a
  // fresh process. Retries cover a transient store lock left by the kill.
  const staleAt = new Date(Date.now() - 120_000).toISOString();
  await until(
    () => store.transition(jobId, (job) => {
      if (!job.lease) return null;
      job.lease.heartbeatAt = staleAt;
      job.receipt.recovery = { ...job.receipt.recovery, heartbeatAt: staleAt };
      return job;
    }).catch(() => null),
    Boolean,
    { timeoutMs: 30_000, label: "stale lease backdate" },
  );
  const companion = new Companion({
    store,
    routeResolver: async (request) => request,
    adapterFactory: () => ({ async run() { throw new Error("must not run"); } }),
  });
  const recovered = await companion.status(jobId);
  assert.equal(recovered.state, "partial");
  assert.equal(recovered.error.details.kind, "interrupted");
  assert.equal(recovered.recovery.canResume, true);
  assert.equal((await store.get(jobId)).lease, null);
});
