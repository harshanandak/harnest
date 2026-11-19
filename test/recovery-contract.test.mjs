import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Companion } from "../src/companion.mjs";
import { BoardStore } from "../src/board.mjs";
import { JobStore } from "../src/job-store.mjs";
import { terminalReceipt } from "../src/protocol.mjs";

const routeResolver = async (request) => request;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const output = { result: { finalText: "synthetic result" }, sessionId: "fake-session", workflowRunId: null };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "harnest-recovery-contract-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return root;
}

async function until(read, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await wait(10);
  }
  throw new Error("synthetic worker did not reach expected state within deadline");
}

test("custom stores isolate boards; default location and explicit overrides are preserved", { timeout: 30_000 }, async (t) => {
  const root = await fixture(t);
  const options = { routeResolver };
  const storeCompanion = new Companion({ ...options, store: new JobStore(root) });
  const dirCompanion = new Companion({ ...options, stateDir: root });
  assert.equal(storeCompanion.boards.root, join(root, "boards"));
  assert.equal(dirCompanion.boards.root, join(root, "boards"));
  assert.equal(new Companion(options).boards.root, new BoardStore().root);
  assert.equal(new Companion({ ...options, stateDir: root, boardDir: join(root, "override") }).boards.root, join(root, "override"));
  const explicit = new BoardStore(join(root, "injected"));
  assert.equal(new Companion({ ...options, stateDir: root, boards: explicit }).boards, explicit);
  await storeCompanion.postToBoard({ topic: "isolated", from: "fake-worker", message: "only in temp" });
  assert.equal((await dirCompanion.readBoard({ topic: "isolated" })).entries.length, 1);
  assert.match(await readFile(join(root, "boards", "isolated.board.jsonl"), "utf8"), /only in temp/);
});

test("unsuccessful receipts preserve observed identity and the latest cumulative usage without inventing a result", { timeout: 30_000 }, async (t) => {
  for (const mode of ["timeout", "throw", "cancel", "recovery"]) {
    await t.test(mode, async (t) => {
      const root = await fixture(t);
      const keepAlive = setInterval(() => {}, 100);
      t.after(() => clearInterval(keepAlive));
      let progressWritten = false;
      const usage = { input: 120, output: 40, cost: 0.031, turns: 2 };
      const companion = new Companion({
        stateDir: root, routeResolver,
        adapterFactory: () => ({ async run(_request, { onProgress }) {
          // Cumulative snapshots are emitted in order and awaited together:
          // sequential durability waits would let a loaded host's write latency
          // cross the 500ms deadline before the latest snapshot is observed.
          const first = onProgress({ type: "step_finish", sessionId: "observed-session", workflowRunId: "observed-workflow", usage: { input: 60, output: 20, cost: 0.015, turns: 1 } });
          const second = onProgress({ type: "step_finish", sessionId: "observed-session", usage });
          const text = onProgress({ type: "text", usage, finalText: "unvalidated partial text" });
          await first;
          await second;
          await text;
          progressWritten = true;
          if (mode === "throw") throw new Error("synthetic transport failure");
          await new Promise(() => {});
        } }),
      });
      const queued = await companion.start({ requestId: `observed-${mode}`, target: "opencode", task: "synthetic evidence", cwd: root, policy: { write: true }, execution: { background: true, timeoutMs: mode === "timeout" ? 500 : 10000 } });
      await until(async () => progressWritten, Boolean);
      if (mode === "cancel") await companion.cancel(queued.jobId);
      if (mode === "recovery") await companion.store.transition(queued.jobId, (job) => {
        job.lease.heartbeatAt = "2020-01-01T00:00:00.000Z";
        return job;
      });
      const receipt = await until(() => companion.status(queued.jobId), (value) => ["failed", "partial", "cancelled"].includes(value.state));
      assert.equal(receipt.sessionId, "observed-session");
      assert.equal(receipt.workflowRunId, "observed-workflow");
      assert.deepEqual(receipt.usage, usage);
      assert.equal(receipt.result, null);
      const durable = await companion.store.get(queued.jobId);
      assert.equal(durable.receipt.sessionId, "observed-session");
      assert.deepEqual(durable.receipt.usage, usage);
    });
  }
});

test("heartbeat persistence never queues behind a slow store", { timeout: 30_000 }, async (t) => {
  const root = await fixture(t);
  const keepAlive = setInterval(() => {}, 100);
  t.after(() => clearInterval(keepAlive));
  let adapterFinished = false;
  const companion = new Companion({
    stateDir: root, routeResolver,
    heartbeatIntervalMs: 1,
    adapterFactory: () => ({ async run() { await wait(300); adapterFinished = true; return output; } }),
  });
  // Every durable write is slow. A heartbeat that enqueues one persist per tick
  // builds a backlog that delays the terminal receipt behind it; one in-flight
  // heartbeat at a time keeps the terminal write within a write or two.
  const realPut = companion.store.put.bind(companion.store);
  let writes = 0;
  companion.store.put = async (...args) => { writes += 1; await wait(40); return realPut(...args); };
  const receipt = await companion.start({ requestId: "slow-heartbeat", target: "pi", task: "synthetic slow store", cwd: root, execution: { background: true, timeoutMs: 10_000 } });
  await until(() => adapterFinished, Boolean);
  const finishedAt = Date.now();
  const durable = await until(() => companion.store.get(receipt.jobId), (job) => ["completed", "failed", "partial", "cancelled"].includes(job.receipt.state));
  assert.equal(durable.receipt.state, "completed");
  const terminalDelayMs = Date.now() - finishedAt;
  assert.ok(terminalDelayMs < 2500, `terminal receipt waited ${terminalDelayMs}ms behind ${writes} heartbeat writes`);
});

test("concurrent resume claims one child, survives lost index, and supports chained completed-session follow-ups", { timeout: 30_000 }, async (t) => {
  const root = await fixture(t);
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const adapterFactory = () => ({
    async run(request) {
      calls += 1;
      if (!request.metadata.resumeOf) throw new Error("synthetic initial failure");
      assert.equal(request.execution.sessionId, request.metadata.resumeOf ? "fake-session" : null);
      await gate;
      return output;
    },
  });
  const first = new Companion({ stateDir: root, routeResolver, adapterFactory });
  const second = new Companion({ stateDir: root, routeResolver, adapterFactory });
  const failed = await first.start({ requestId: "resume-once", target: "pi", task: "test resume", cwd: root, execution: { sessionId: "fake-session" } });
  assert.equal(failed.state, "failed");
  const receipts = await Promise.all(Array.from({ length: 8 }, (_, index) => (index % 2 ? first : second).resume(failed.jobId, { execution: { background: true } })));
  assert.equal(new Set(receipts.map((receipt) => receipt.jobId)).size, 1);
  const childId = receipts[0].jobId;
  assert.notEqual(childId, failed.jobId);
  await until(async () => calls, (value) => value === 2);
  assert.equal((await first.resume(failed.jobId)).jobId, childId);
  await assert.rejects(first.resume(failed.jobId, { task: "different work" }), (error) => error.details.kind === "request-conflict");
  // A late write from an older attempt must not move request lookup backwards.
  await first.store.put(await first.store.get(failed.jobId));
  assert.equal(await second.store.jobIdForRequest(failed.requestId), childId);
  await rm(first.store.requestPath(failed.requestId));
  assert.equal((await second.resume(failed.jobId)).jobId, childId);
  assert.equal(calls, 2);
  release();
  await until(() => first.status(childId), (value) => value.state === "completed");
  assert.equal((await first.resume(failed.jobId)).jobId, childId);
  await assert.rejects(first.resume(childId), (error) => error.details.kind === "follow-up-required");
  assert.equal(calls, 2);
  const followup = await first.resume(childId, { task: "explicit next turn", execution: { background: false } });
  assert.equal(followup.state, "completed");
  assert.notEqual(followup.jobId, childId);
  assert.equal((await second.resume(childId, { task: "explicit next turn" })).jobId, followup.jobId);
  await assert.rejects(second.resume(followup.jobId), (error) => error.details.kind === "follow-up-required");
  assert.equal(calls, 3);
  assert.equal(await first.store.jobIdForRequest(failed.requestId), followup.jobId);
  assert.equal((await first.store.jobIdsForRequest(failed.requestId)).length, 3);
});

async function remoteWorker(t, root, { ignoreAbort = false } = {}) {
  const companionUrl = new URL("../src/companion.mjs", import.meta.url).href;
  const script = `
    import { Companion } from ${JSON.stringify(companionUrl)};
    import { writeFile } from "node:fs/promises";
    import { join } from "node:path";
    const root = process.env.HARNEST_FIXTURE_ROOT;
    const keepAlive = setInterval(() => {}, 100);
    let ready;
    const started = new Promise(resolve => { ready = resolve; });
    const companion = new Companion({
      stateDir: root, heartbeatIntervalMs: 100, cancelAckTimeoutMs: ${ignoreAbort ? 150 : 2000},
      routeResolver: async (request) => request,
      adapterFactory: () => ({ async run(request, { signal }) {
        ready();
        return new Promise((resolve, reject) => {
          const stop = async () => {
            await writeFile(join(root, "aborted"), "aborted");
            if (${JSON.stringify(ignoreAbort)}) return;
            await new Promise((done) => setTimeout(done, 50));
            await writeFile(join(root, "stopped"), "stopped");
            reject(Object.assign(new Error("fake child stopped"), { details: { aborted: true } }));
          };
          if (signal.aborted) void stop();
          else signal.addEventListener("abort", stop, { once: true });
        });
      }, async control() { throw new Error("remote control must never reach adapter"); } }),
    });
    const receipt = await companion.start({ requestId: "remote-job", target: "pi", task: "synthetic remote", cwd: root, execution: { background: true, timeoutMs: 10000 } });
    await started;
    process.stdout.write(receipt.jobId + '\\n');
    await companion.running.get(receipt.jobId)?.promise;
    clearInterval(keepAlive);
  `;
  const child = spawn("node", ["--input-type=module", "-e", script], {
    env: { ...process.env, HARNEST_FIXTURE_ROOT: root }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
  t.after(async () => { if (child.exitCode === null) child.kill(); await exited; });
  const jobId = await new Promise((resolve, reject) => {
    let text = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("synthetic worker startup exceeded deadline")); }, 30_000);
    child.stdout.on("data", chunk => {
      text += chunk;
      if (text.includes("\n")) { clearTimeout(timer); resolve(text.trim()); }
    });
    exited.then(code => { clearTimeout(timer); reject(new Error(`synthetic worker exited before ready: ${code}: ${stderr}`)); }, error => { clearTimeout(timer); reject(error); });
  });
  return { jobId, exited, stderr: () => stderr };
}

test("remote ownership is actionable and cancel stays running until owner acknowledges adapter stop", { timeout: 60_000 }, async (t) => {
  const root = await fixture(t);
  const worker = await remoteWorker(t, root);
  const observer = new Companion({ stateDir: root, routeResolver });
  const agent = (await observer.fleet({ recent: 0 })).agents[0];
  assert.equal(agent.steer.mode, "owner-required");
  assert.equal(agent.ownership.local, false);
  assert.notEqual(agent.ownership.pid, process.pid);
  assert.ok(agent.ownership.ownerId);
  assert.ok(agent.ownership.host);
  await Promise.all([
    observer.message(worker.jobId, { commandId: "remote-message", message: "hold" }),
    observer.reroute(worker.jobId, { commandId: "remote-route", route: { provider: "fake", model: "fake" } }),
  ].map((operation) => assert.rejects(operation, (error) => error.details.kind === "control-owner" && /originating/.test(error.details.hint))));
  const requested = await observer.cancel(worker.jobId);
  assert.equal(requested.state, "running");
  assert.equal(requested.cancellation.state, "requested");
  const settled = await until(() => observer.status(worker.jobId), (receipt) => receipt.state === "cancelled");
  assert.equal(settled.cancellation.state, "acknowledged");
  assert.ok(settled.cancellation.acknowledgedAt);
  assert.equal(await readFile(join(root, "stopped"), "utf8"), "stopped");
  assert.equal(await worker.exited, 0, worker.stderr());
  assert.equal((await observer.store.get(worker.jobId)).lease, null);
});

test("remote cancellation that cannot confirm adapter stop becomes partial, never cancelled", { timeout: 30_000 }, async (t) => {
  const root = await fixture(t);
  const worker = await remoteWorker(t, root, { ignoreAbort: true });
  const observer = new Companion({ stateDir: root, routeResolver });
  assert.equal((await observer.cancel(worker.jobId)).state, "running");
  const settled = await until(() => observer.status(worker.jobId), (receipt) => receipt.state === "partial");
  assert.equal(settled.error.details.kind, "cancel-unacknowledged");
  assert.equal(settled.cancellation.state, "unacknowledged");
  assert.equal(await readFile(join(root, "aborted"), "utf8"), "aborted");
  assert.equal(await worker.exited, 0, worker.stderr());
});

test("remote owner aborts on lost lease even without progress events", { timeout: 30_000 }, async (t) => {
  const root = await fixture(t);
  const worker = await remoteWorker(t, root);
  const observer = new Companion({ stateDir: root, routeResolver });
  await observer.store.transition(worker.jobId, (job) => {
    // Revoke atomically. Backdating then calling status races a healthy
    // heartbeat, which correctly refreshes the lease before recovery.
    job.lease = null;
    job.receipt = terminalReceipt(job.receipt, "partial", { error: { message: "synthetic lease revocation", details: { kind: "interrupted" } } });
    return job;
  });
  assert.equal((await observer.status(worker.jobId)).state, "partial");
  await until(() => readFile(join(root, "aborted"), "utf8").catch(() => null), Boolean);
  assert.equal(await worker.exited, 0, worker.stderr());
  assert.equal((await observer.status(worker.jobId)).state, "partial");
});

test("cancel intent survives stale progress writes and a completion race stays truthful", { timeout: 30_000 }, async (t) => {
  const root = await fixture(t);
  const observer = new Companion({ stateDir: root, routeResolver, adapterFactory: () => ({ async run() { return output; } }) });
  const receipt = await observer.start({ requestId: "cancel-write-race", target: "pi", task: "synthetic state", cwd: root });
  const snapshot = await observer.store.get(receipt.jobId);
  snapshot.receipt.state = "running";
  snapshot.receipt.result = null;
  snapshot.lease = { ownerId: "remote-owner", pid: 1, heartbeatAt: new Date().toISOString() };
  await observer.store.put(snapshot);
  const writer = new JobStore(root);
  const requested = await observer.cancel(receipt.jobId);
  assert.equal(requested.state, "running");
  const repeat = await observer.cancel(receipt.jobId);
  assert.deepEqual(repeat.cancellation, requested.cancellation);
  await writer.commitBatch(snapshot, [{ at: new Date().toISOString(), activity: "late progress", event: { type: "progress" } }], { expectedLeaseOwner: "remote-owner" });
  assert.deepEqual((await writer.get(receipt.jobId)).receipt.cancellation, requested.cancellation);
  snapshot.lease = null;
  snapshot.receipt = terminalReceipt(snapshot.receipt, "completed", output);
  await writer.put(snapshot, { expectedLeaseOwner: "remote-owner" });
  const settled = await observer.status(receipt.jobId);
  assert.equal(settled.state, "completed");
  assert.equal(settled.cancellation.state, "completed-before-cancel");
  assert.equal(settled.cancellation.acknowledgedAt, null);
});
