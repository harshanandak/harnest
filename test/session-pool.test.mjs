import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionAdapterPool } from "../src/session-pool.mjs";
import { Companion } from "../src/companion.mjs";
import { LazySessionAdapter } from "../src/adapters/index.mjs";
import { acquireSessionLease } from "../src/session-lease.mjs";
import { execFileSync } from "node:child_process";

test("pool reuses only explicit matching sessions and rejects concurrent ownership", async () => {
  const pool = new SessionAdapterPool();
  let created = 0;
  const create = () => ({ n: ++created, close() {} });
  const request = { target: "claude", cwd: process.cwd(), policy: { write: false }, execution: {} };
  const first = await pool.acquire(request, create);
  await first.release({ sessionId: "native" });
  const next = await pool.acquire({ ...request, execution: { sessionId: "native" } }, create);
  assert.equal(next.adapter, first.adapter);
  await assert.rejects(pool.acquire({ ...request, execution: { sessionId: "native" } }, create), /active owner/);
  await next.release({ sessionId: "native" });
  await assert.rejects(pool.acquire({ ...request, policy: { write: true }, execution: { sessionId: "native" } }, create), /changed/);
  const independent = await pool.acquire(request, create);
  assert.notEqual(independent.adapter, first.adapter);
  await independent.release();
  await pool.close();
});

test("cancellation during lazy import cannot launch a native session afterwards", async () => {
  let finishImport;
  let launched = 0;
  const adapter = new LazySessionAdapter(() => new Promise((resolve) => { finishImport = resolve; }));
  const controller = new AbortController();
  const run = adapter.run({}, { signal: controller.signal });
  controller.abort();
  finishImport({ default: class { run() { launched++; } close() {} } });
  await assert.rejects(run, { details: { kind: "abort", aborted: true } });
  await adapter.close();
  assert.equal(launched, 0);
});

test("failed lazy import still permits cleanup without masking the original error", async () => {
  const adapter = new LazySessionAdapter(async () => { throw new Error("missing package"); });
  await assert.rejects(adapter.run({}), /missing package/);
  await adapter.close();
});

test("pool bounds unnamed active owners and shutdown closes busy leases", async () => {
  const pool = new SessionAdapterPool({ limit: 2 });
  let closed = 0;
  const request = { target: "claude", cwd: process.cwd(), execution: {} };
  const create = () => ({ close() { closed++; } });
  const first = await pool.acquire(request, create);
  await pool.acquire(request, create);
  await assert.rejects(pool.acquire(request, create), /capacity/);
  await pool.close();
  assert.equal(closed, 2);
  await first.release({ sessionId: "late" });
  assert.equal(pool.entries.size, 0);
  await assert.rejects(pool.acquire(request, create), /closed/);
});

test("native session leases prevent independent pools from resuming the same conversation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harnest-native-lease-"));
  const first = new SessionAdapterPool({ lockDir: root });
  const second = new SessionAdapterPool({ lockDir: root });
  t.after(async () => { await first.close(); await second.close(); await rm(root, { recursive: true, force: true }); });
  const request = { target: "claude", cwd: root, execution: { sessionId: "native" } };
  const one = await first.acquire(request, () => ({ close() {} }));
  await assert.rejects(second.acquire(request, () => { throw new Error("must not spawn"); }), /leased by another owner/);
  await one.release();
  const two = await second.acquire(request, () => ({ close() {} }));
  await two.release();
});

test("new native identities are leased before active progress becomes visible", async (t) => {
  for (const target of ["claude", "codex", "cursor"]) {
    const root = await mkdtemp(join(tmpdir(), "harnest-native-active-"));
    let announce;
    let finish;
    const announced = new Promise((resolve) => { announce = resolve; });
    const held = new Promise((resolve) => { finish = resolve; });
    const first = new Companion({ stateDir: root, routeResolver: async (r) => r, adapterFactory: () => ({
      async run(request, { onProgress }) {
        await onProgress({ type: "session", sessionId: "fresh-native" });
        announce();
        await held;
        return { sessionId: "fresh-native", result: { finalText: "finished" } };
      },
      close() {},
    }) });
    let secondLaunches = 0;
    const second = new Companion({ stateDir: root, routeResolver: async (r) => r, adapterFactory: () => { secondLaunches++; return { run() {}, close() {} }; } });
    t.after(async () => { finish(); await first.close(); await second.close(); await rm(root, { recursive: true, force: true }); });
    const request = { target, cwd: root, task: "read", execution: { transport: "session", timeoutMs: 5000 } };
    const started = await first.start({ ...request, requestId: "owner", execution: { ...request.execution, background: true } });
    const completion = first.ownedCompletion(started.jobId);
    await announced;
    assert.equal((await second.status(started.jobId)).sessionId, "fresh-native");
    const refused = await second.start({ ...request, requestId: "second-owner", execution: { ...request.execution, sessionId: "fresh-native" } });
    assert.equal(refused.state, "failed");
    assert.match(refused.error.message, /leased by another owner/);
    assert.equal(secondLaunches, 0);
    finish();
    assert.equal((await completion).state, "completed");
  }
});

test("a bound native identity cannot silently change before release", async (t) => {
  const pool = new SessionAdapterPool();
  t.after(() => pool.close());
  const owner = await pool.acquire({ target: "claude", cwd: process.cwd() }, () => ({ close() {} }));
  await owner.bind("first");
  await assert.rejects(owner.bind("different"), /identity changed/);
  await assert.rejects(owner.release({ sessionId: "different" }), /identity changed/);
  assert.equal(pool.entries.size, 0);
});

test("release racing shutdown cannot republish a closed session or leave its lease", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harnest-release-close-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pool = new SessionAdapterPool({ lockDir: root });
  let closes = 0;
  const owner = await pool.acquire({ target: "claude", cwd: root }, () => ({ close() { closes++; } }));
  const releasing = owner.release({ sessionId: "new-native" });
  const closing = pool.close();
  await Promise.all([releasing, closing]);
  assert.equal(closes, 1);
  assert.equal(pool.owned.size, 0);
  assert.equal(pool.entries.size, 0);
  const unlock = await acquireSessionLease(root, JSON.stringify(["claude", "new-native"]));
  await unlock();
});

test("a dead coordinator does not authorize reuse while its native child survives", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harnest-native-stale-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const module = new URL("../src/session-lease.mjs", import.meta.url).href;
  const childPid = Number(execFileSync(process.execPath, ["--input-type=module", "-e", `import { spawn } from 'node:child_process'; import { acquireSessionLease } from ${JSON.stringify(module)}; await acquireSessionLease(process.argv[1], 'native'); const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { detached:true, stdio:'ignore' }); child.unref(); console.log(child.pid); process.exit(0);`, root], { timeout: 10000, encoding: "utf8", stdio: "pipe" }).trim());
  assert.ok(Number.isInteger(childPid) && childPid > 0);
  t.after(() => { try { process.kill(childPid); } catch (error) { if (error.code !== "ESRCH") throw error; } });
  process.kill(childPid, 0);
  await assert.rejects(acquireSessionLease(root, "native"), /leased by another owner/);
});

test("cleanup failure preserves successful output and the original downstream error", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harnest-session-cleanup-"));
  const companion = new Companion({ stateDir: root, routeResolver: async (r) => r, adapterFactory: () => ({
    async run(request) {
      if (request.task === "fail") throw Object.assign(new Error("native downstream failure"), { details: { kind: "downstream" } });
      return { result: { finalText: "paid output retained" } };
    },
    close() { throw new Error("close exploded"); },
  }) });
  t.after(async () => { await companion.close(); await rm(root, { recursive: true, force: true }); });
  const request = { requestId: "complete", cwd: process.cwd(), target: "claude", task: "succeed", execution: { transport: "session" } };
  const completed = await companion.start(request);
  assert.equal(completed.state, "completed");
  assert.equal(completed.result.finalText, "paid output retained");
  assert.match(completed.cleanupError.message, /close exploded/);
  const failed = await companion.start({ ...request, requestId: "failure", task: "fail" });
  assert.match(failed.error.message, /native downstream failure/);
  assert.match(failed.cleanupError.message, /close exploded/);
  assert.equal(failed.state, "partial");
  await assert.rejects(companion.resume(failed.jobId), { details: { kind: "unsafe-resume" } });
});

test("a cancelled session with failed release persists a valid partial receipt", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harnest-session-cancel-cleanup-"));
  let ready;
  const started = new Promise((resolve) => { ready = resolve; });
  const companion = new Companion({ stateDir: root, detachBackground: false, routeResolver: async (r) => r, adapterFactory: () => ({
    run(_request, { signal }) {
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(Object.assign(new Error("stopped"), { details: { aborted: true } })), { once: true });
        ready();
      });
    },
    close() { throw new Error("native close could not be confirmed"); },
  }) });
  t.after(async () => { await companion.close(); await rm(root, { recursive: true, force: true }); });
  const queued = await companion.start({ requestId: "cancel-cleanup", cwd: root, target: "claude", task: "run", execution: { background: true, transport: "session" } });
  await started;
  const completion = companion.ownedCompletion(queued.jobId);
  await companion.cancel(queued.jobId);
  await completion;
  const receipt = await companion.result(queued.jobId);
  assert.equal(receipt.state, "partial");
  assert.match(receipt.error.message, /native close could not be confirmed/);
  assert.match(receipt.cleanupError.message, /native close could not be confirmed/);
  assert.equal(receipt.cancellation.state, "unacknowledged");
  await assert.rejects(companion.resume(queued.jobId), { details: { kind: "unsafe-resume" } });
});

test("Companion retains the selected session adapter across explicit follow-ups", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harnest-session-pool-"));
  let created = 0;
  const companion = new Companion({ stateDir: root, routeResolver: async (r) => r, adapterFactory: (target, options, request) => {
    assert.equal(request.execution.transport, "session");
    created++;
    return { run: async () => ({ sessionId: "native", result: { finalText: "result" } }), close() {} };
  } });
  t.after(async () => { await companion.sessionPool.close(); await rm(root, { recursive: true, force: true }); });
  const request = { requestId: "first", cwd: process.cwd(), target: "claude", task: "read", execution: { background: false, transport: "session" } };
  const first = await companion.start(request);
  const next = await companion.start({ ...request, requestId: "second", execution: { ...request.execution, sessionId: first.sessionId } });
  assert.equal(first.state, "completed");
  assert.equal(next.state, "completed");
  assert.equal(created, 1);
});

test("SDK delivery without native acknowledgement never becomes applied", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harnest-session-control-"));
  let ready;
  const started = new Promise((resolve) => { ready = resolve; });
  let finish;
  const result = new Promise((resolve) => { finish = resolve; });
  const companion = new Companion({ stateDir: root, routeResolver: async (r) => r, adapterFactory: () => ({
    run: async () => { ready(); return result; },
    control: async () => ({ delivered: true, acknowledged: false, consumed: false }),
  }) });
  t.after(async () => { finish({ result: { finalText: "done" } }); await rm(root, { recursive: true, force: true }); });
  const job = await companion.start({ requestId: "control", cwd: process.cwd(), target: "claude", task: "read", execution: { background: true, transport: "session" } });
  await started;
  const control = await companion.message(job.jobId, { commandId: "message", message: "guidance" });
  assert.equal(control.state, "uncertain");
  assert.equal(control.acknowledgement.consumed, false);
  finish({ result: { finalText: "done" } });
  await companion.running.get(job.jobId)?.promise;
});

test("classified provider reset metadata survives the durable receipt boundary", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harnest-limit-reset-"));
  const resetAt = new Date(Date.now() + 60000).toISOString();
  const companion = new Companion({ stateDir: root, routeResolver: async (r) => r, adapterFactory: () => ({
    async run() { throw Object.assign(new Error("native provider limit"), { details: { kind: "usage-limit", resetAt } }); },
  }) });
  t.after(async () => { await companion.close(); await rm(root, { recursive: true, force: true }); });
  const receipt = await companion.start({ requestId: "reset", cwd: root, target: "pi", task: "read" });
  const stored = await companion.result(receipt.jobId);
  assert.equal(stored.error.details.kind, "usage-limit");
  assert.equal(stored.error.details.resetAt, resetAt);
});

test("owned completion is not observable until the terminal receipt is durable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harnest-owned-completion-"));
  const companion = new Companion({ stateDir: root, routeResolver: async (request) => request, adapterFactory: () => ({ async run() { return { result: { finalText: "durable result" } }; } }) });
  const commit = companion.store.commitBatch.bind(companion.store);
  let release;
  let entered;
  const held = new Promise((resolve) => { release = resolve; });
  const committing = new Promise((resolve) => { entered = resolve; });
  companion.store.commitBatch = async (job, ...args) => {
    if (job.receipt.state === "completed") { entered(); await held; }
    return commit(job, ...args);
  };
  t.after(async () => { release(); await companion.close(); await rm(root, { recursive: true, force: true }); });
  const started = await companion.start({ requestId: "owned", cwd: root, target: "pi", task: "read", execution: { background: true } });
  const completion = companion.ownedCompletion(started.jobId);
  assert.ok(completion);
  let settled = false;
  completion.then(() => { settled = true; });
  await committing;
  assert.equal(settled, false);
  release();
  const receipt = await completion;
  assert.equal(receipt.result.finalText, "durable result");
  assert.equal((await companion.store.get(started.jobId)).receipt.state, "completed");
});
