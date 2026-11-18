// Fleet view: counts, per-agent progress + recent messages, steer modes.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Companion } from "../src/companion.mjs";
import { steerFor } from "../src/companion.mjs";
import { JobStore } from "../src/job-store.mjs";
import { createReceipt, normalizeRequest, terminalReceipt } from "../src/protocol.mjs";

async function tempCompanion(t, adapterFactory) {
  const root = await mkdtemp(join(tmpdir(), "harnest-fleet-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return new Companion({
    store: new JobStore(root),
    boardDir: join(root, "boards"),
    adapterFactory,
    routeResolver: async (request) => request,
  });
}

function gateAdapter({ beforeProgress } = {}) {
  const gate = Promise.withResolvers();
  const progress = new Map();
  function progressFor(requestId) {
    if (!progress.has(requestId)) progress.set(requestId, Promise.withResolvers());
    return progress.get(requestId);
  }
  return {
    release: gate.resolve,
    progressReady: (requestId) => progressFor(requestId).promise,
    factory: () => ({
      async run(request, { onProgress } = {}) {
        await beforeProgress?.(request);
        await onProgress?.({ type: "progress", text: `working on ${request.requestId}` });
        progressFor(request.requestId).resolve();
        await gate.promise;
        return { result: { finalText: `done:${request.requestId}` }, sessionId: `s-${request.requestId}`, workflowRunId: null };
      },
      async control(command) {
        return { harness: "fake", command: command.kind, delivery: command.delivery };
      },
    }),
  };
}

function startJob(companion, requestId, target = "pi", route = {}) {
  return companion.start({
    requestId, target, task: "hold", cwd: process.cwd(), route,
    execution: { background: true, timeoutMs: 10_000 },
  });
}

async function waitForProgress(companion, adapter, receipt) {
  const completion = companion.ownedCompletion(receipt.jobId);
  assert.ok(completion, `${receipt.requestId} has no in-process owner`);
  await Promise.race([
    adapter.progressReady(receipt.requestId),
    completion.then(({ state }) => assert.fail(`${receipt.requestId} settled as ${state} before publishing progress`)),
  ]);
}

test("empty fleet reports zero agents", async (t) => {
  const companion = await tempCompanion(t, gateAdapter().factory);
  const fleet = await companion.fleet();
  assert.deepEqual(fleet.agents, []);
  assert.equal(fleet.active, 0);
  assert.deepEqual(fleet.byState, {});
});

test("fleet counts all matching jobs beyond both display caps and filters after recovery", { timeout: 30_000 }, async (t) => {
  const companion = await tempCompanion(t, () => { throw new Error("synthetic snapshots must not launch"); });
  for (let index = 0; index < 105; index += 1) {
    const request = normalizeRequest({ requestId: `snapshot-${index}`, target: "pi", task: "synthetic", cwd: process.cwd() });
    const isOldRunning = index === 0;
    const isStale = index === 1;
    const at = new Date(Date.now() - (105 - index) * 100).toISOString();
    let receipt = { ...createReceipt(request), createdAt: at, updatedAt: at };
    if (isOldRunning || isStale) receipt.state = "running";
    else receipt = terminalReceipt(receipt, "completed", { result: { finalText: "done" } });
    const job = { request, receipt, trace: {}, controls: [], lease: receipt.state === "running" ? {
      ownerId: "another-process", pid: 1, heartbeatAt: isStale ? "2020-01-01T00:00:00.000Z" : new Date().toISOString(),
    } : null };
    // Fleet reads snapshots, so seed those directly without building 105
    // unrelated request indexes or exercising the launch/persistence path.
    await writeFile(companion.store.path(receipt.jobId), JSON.stringify(job));
  }
  const filtered = await companion.fleet({ state: "running", recent: 0 });
  assert.equal(filtered.agents.length, 1);
  assert.equal(filtered.agents[0].requestId, "snapshot-0");
  assert.equal(filtered.active, 1);
  const partial = await companion.fleet({ state: "partial", recent: 0 });
  assert.equal(partial.agents.length, 1);
  assert.equal(partial.agents[0].requestId, "snapshot-1");
  const fleet = await companion.fleet({ recent: 0 });
  assert.equal(fleet.active, 1);
  assert.deepEqual(fleet.byState, { completed: 103, partial: 1, running: 1 });
  assert.equal(fleet.total, 105);
  assert.equal(fleet.displayed, 20);
  assert.equal(fleet.limit, 20);
  assert.equal(fleet.hasMore, true);
  assert.equal(fleet.countsScope, "all-matching-jobs");
  assert.ok(!fleet.agents.some((agent) => agent.requestId === "snapshot-0"));
  const capped = await companion.fleet({ limit: 100, recent: 0 });
  assert.equal(capped.displayed, 100);
  assert.equal(capped.active, 1);
  assert.equal(capped.total, 105);
  assert.equal(capped.hasMore, true);
});

test("fleet counts running agents with progress and recent messages", async (t) => {
  const entered = Promise.withResolvers();
  const progress = Promise.withResolvers();
  const g = gateAdapter({ beforeProgress(request) {
    if (request.requestId !== "fleet-a") return;
    entered.resolve();
    return progress.promise;
  } });
  const companion = await tempCompanion(t, g.factory);
  try {
    const jobA = await startJob(companion, "fleet-a");
    const jobB = await startJob(companion, "fleet-b");
    await Promise.race([entered.promise, companion.ownedCompletion(jobA.jobId)]);
    const before = (await companion.fleet({ recent: 2 })).agents.find((agent) => agent.jobId === jobA.jobId);
    assert.equal(before.state, "running");
    assert.ok(!before.recentMessages.some((message) => message.activity === "progress"));

    progress.resolve();
    await Promise.all([jobA, jobB].map((job) => waitForProgress(companion, g, job)));
    const fleet = await companion.fleet({ recent: 2 });
    assert.equal(fleet.active, 2);
    assert.equal(fleet.byState.running, 2);
    const byRequest = new Map(fleet.agents.map((a) => [a.requestId, a]));
    for (const id of ["fleet-a", "fleet-b"]) {
      const agent = byRequest.get(id);
      assert.ok(agent, `fleet must include ${id}`);
      assert.equal(agent.target, "pi");
      assert.equal(agent.steer.mode, "live");
      assert.ok(agent.recentMessages.length <= 2);
      assert.ok(agent.recentMessages.every((m) => Number.isInteger(m.sequence) && typeof m.at === "string" && typeof m.activity === "string"));
      assert.ok(agent.recentMessages.some((m) => m.activity === "progress"));
    }
    assert.notEqual(byRequest.get("fleet-a").jobId, byRequest.get("fleet-b").jobId);
  } finally {
    progress.resolve();
    g.release();
    await Promise.allSettled([...companion.running.values()].map(({ promise }) => promise));
  }
});

test("fleet steer modes match target control semantics", async (t) => {
  const g = gateAdapter();
  const companion = await tempCompanion(t, g.factory);
  try {
    await waitForProgress(companion, g, await startJob(companion, "fleet-pi", "pi"));
    await waitForProgress(companion, g, await startJob(companion, "fleet-codex", "codex", { provider: "openai", model: "m" }));
    await waitForProgress(companion, g, await startJob(companion, "fleet-v2", "opencode", { provider: "p", model: "m", harnessVersion: "v2" }));
    await waitForProgress(companion, g, await startJob(companion, "fleet-v1", "opencode", { provider: "p", model: "m" }));
    const fleet = await companion.fleet({ state: "running", recent: 0 });
    const byRequest = new Map(fleet.agents.map((a) => [a.requestId, a]));
    assert.equal(byRequest.get("fleet-pi").steer.mode, "live");
    assert.equal(byRequest.get("fleet-codex").steer.mode, "resume");
    assert.match(byRequest.get("fleet-codex").steer.hint, /one-shot/);
    assert.equal(byRequest.get("fleet-v2").steer.mode, "live");
    assert.equal(byRequest.get("fleet-v1").steer.mode, "resume");
    assert.match(byRequest.get("fleet-v1").steer.hint, /V1 controls fail closed/);
  } finally {
    g.release();
    await Promise.allSettled([...companion.running.values()].map(({ promise }) => promise));
  }
});

test("terminal jobs steer via resume and filters apply", async (t) => {
  const companion = await tempCompanion(t, () => ({
    async run(request) {
      return { result: { finalText: `done:${request.requestId}` }, sessionId: "s", workflowRunId: null };
    },
  }));
  await companion.start({
    requestId: "fleet-term", target: "cursor", task: "one shot",
    cwd: process.cwd(), execution: { background: false, timeoutMs: 10_000 },
  });
  const fleet = await companion.fleet({ recent: 1 });
  assert.equal(fleet.active, 0);
  assert.equal(fleet.byState.completed, 1);
  assert.equal(fleet.agents[0].steer.mode, "resume");
  assert.equal((await companion.fleet({ state: "running" })).agents.length, 0);
  assert.equal((await companion.fleet({ target: "cursor" })).agents.length, 1);
  assert.equal((await companion.fleet({ target: "pi" })).agents.length, 0);
  await assert.rejects(companion.fleet({ recent: 11 }), /recent must be/);
  await assert.rejects(companion.fleet({ recent: -1 }), /recent must be/);
});

test("steer matrix: live only when running, queued is pending", () => {
  assert.equal(steerFor({ state: "running", target: "pi" }).mode, "live");
  assert.equal(steerFor({ state: "running", target: "opencode", route: { harnessVersion: "v2" } }).mode, "live");
  assert.equal(steerFor({ state: "queued", target: "pi" }).mode, "pending");
  assert.equal(steerFor({ state: "queued", target: "pi" }).hint.includes("not started"), true);
  assert.equal(steerFor({ state: "completed", target: "pi" }).mode, "resume");
});

test("uncertain controls count as pending in fleet", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const companion = await tempCompanion(t, () => ({
    async run() {
      await gate;
      return { result: { finalText: "done" }, sessionId: "s", workflowRunId: null };
    },
    async control(command) {
      if (command.commandId === "iffy-1") {
        throw Object.assign(new Error("acknowledgement lost"), { details: { kind: "control", uncertain: true } });
      }
      return { harness: "fake", command: command.kind, delivery: command.delivery };
    },
  }));
  const queued = await companion.start({
    requestId: "fleet-uncertain", target: "pi", task: "hold",
    cwd: process.cwd(), execution: { background: true, timeoutMs: 10_000 },
  });
  for (let i = 0; i < 100; i += 1) {
    if ((await companion.status(queued.jobId)).state === "running") break;
    await new Promise((r) => setTimeout(r, 10));
  }
  await companion.message(queued.jobId, { commandId: "iffy-1", message: "maybe?", delivery: "steer" });
  const fleet = await companion.fleet({ recent: 0 });
  assert.equal(fleet.agents[0].controlsPending, 1);
  release();
});
