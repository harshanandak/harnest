import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Companion } from "../src/companion.mjs";
import { GraphRunner } from "../src/graph.mjs";
import { createReceipt, normalizeRequest } from "../src/protocol.mjs";

async function fixture(t, options = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), "harnest-field-recovery-"));
  const companion = new Companion({ stateDir, routeResolver: async (request) => request, ...options });
  t.after(async () => {
    await companion.close();
    await rm(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return companion;
}

async function runningJob(companion) {
  const request = normalizeRequest({ requestId: "field-progress", target: "codex", task: "inspect", cwd: process.cwd() });
  const startedAt = new Date(Date.now() - 600_000).toISOString();
  const receipt = createReceipt(request, { state: "running", startedAt });
  await companion.store.put({ request, receipt, events: [], lease: { ownerId: "other", heartbeatAt: new Date().toISOString() } });
  return receipt;
}

test("heartbeat and empty Codex deltas cannot hide a meaningful-activity stall", async (t) => {
  const companion = await fixture(t);
  const receipt = await runningJob(companion);
  for (const data of [{ type: "codex_delta", text: "inspecting" }, { type: "heartbeat" }, { type: "codex_delta", text: "" }, { type: "usage", usage: { totalTokens: 1 } }]) {
    await companion.store.appendEvent(receipt.jobId, { at: data.text ? receipt.startedAt : new Date().toISOString(), event: { type: "progress", data } });
  }
  const status = await companion.status(receipt.jobId);
  assert.equal(status.state, "running");
  assert.equal(status.trace.progress.current, "inspecting");
  assert.equal(status.trace.progress.lastMeaningfulAt, receipt.startedAt);
  assert.equal(status.trace.progress.stalled, true);
  assert.equal(status.trace.progress.stall.thresholdMs, 300_000);
});

test("status retains the active downstream tool and its duration until the matching completion", async (t) => {
  const companion = await fixture(t);
  const receipt = await runningJob(companion);
  await companion.store.appendEvent(receipt.jobId, { at: receipt.startedAt, event: { type: "progress", data: { type: "codex_tool", phase: "started", tool: "context_mode.ctx_execute", callId: "tool-1" } } });
  let status = await companion.status(receipt.jobId);
  assert.equal(status.trace.progress.current, "context_mode.ctx_execute");
  assert.equal(status.trace.progress.activeTool.name, "context_mode.ctx_execute");
  assert.ok(status.trace.progress.activeTool.elapsedMs >= 600_000);
  await companion.store.appendEvent(receipt.jobId, { event: { type: "progress", data: { type: "codex_tool", phase: "completed", tool: "context_mode.ctx_execute", callId: "tool-1", status: "completed" } } });
  status = await companion.status(receipt.jobId);
  assert.equal(status.trace.progress.activeTool, null);
  assert.equal(status.trace.progress.stalled, false);
});

test("local cancellation cannot claim stopped while its adapter ignores abort", async (t) => {
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const companion = await fixture(t, { cancelAckTimeoutMs: 20, adapterFactory: () => ({ async run() { started(); return new Promise(() => {}); } }) });
  const queued = await companion.start({ requestId: "field-cancel", target: "pi", task: "hold", cwd: process.cwd(), execution: { background: true } });
  await ready;
  const requested = await companion.cancel(queued.jobId);
  assert.equal(requested.cancellation.state, "requested");
  assert.equal(requested.state, "running");
  let settled;
  for (let count = 0; count < 100; count++) {
    settled = await companion.status(queued.jobId);
    if (settled.state === "partial") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(settled.state, "partial");
  assert.equal(settled.cancellation.state, "unacknowledged");
  assert.equal(settled.error.details.kind, "cancel-unacknowledged");
});

test("local cancellation acknowledges settled adapter exit evidence", async (t) => {
  let entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  const companion = await fixture(t, { adapterFactory: () => ({ async run(_request, { signal }) {
    entered();
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    throw Object.assign(new Error("child stopped"), { details: { aborted: true, code: null, signal: "SIGTERM" } });
  } }) });
  const queued = await companion.start({ requestId: "field-cancel-exit", target: "pi", task: "hold", cwd: process.cwd(), execution: { background: true } });
  await ready;
  const execution = companion.running.get(queued.jobId).promise;
  await companion.cancel(queued.jobId);
  const settled = await execution;
  assert.equal(settled.state, "cancelled");
  assert.equal(settled.cancellation.state, "acknowledged");
  assert.deepEqual(settled.cancellation.downstreamExit, { code: null, signal: "SIGTERM" });
  const schema = JSON.parse(await readFile(new URL("../schemas/handoff-receipt.schema.json", import.meta.url), "utf8"));
  const cancellationSchema = schema.properties.cancellation;
  assert.equal(cancellationSchema.additionalProperties, false);
  assert.deepEqual(cancellationSchema.properties.downstreamExit, {
    type: ["object", "null"],
    additionalProperties: false,
    required: ["code", "signal"],
    properties: {
      code: { type: ["integer", "null"] },
      signal: { type: ["string", "null"] },
    },
  });
  assert.ok(settled.cancellation.downstreamExit.code === null || Number.isInteger(settled.cancellation.downstreamExit.code));
  assert.ok(settled.cancellation.downstreamExit.signal === null || typeof settled.cancellation.downstreamExit.signal === "string");
});

test("an active job keeps its cancellation heartbeat referenced until the adapter settles", async (t) => {
  let entered, heartbeat;
  const ready = new Promise((resolve) => { entered = resolve; });
  const setInterval = globalThis.setInterval;
  const heartbeatIntervalMs = 5;
  t.mock.method(globalThis, "setInterval", (callback, interval, ...args) => {
    const timer = setInterval(callback, interval, ...args);
    if (interval === heartbeatIntervalMs) heartbeat = timer;
    return timer;
  });
  const companion = await fixture(t, { heartbeatIntervalMs, adapterFactory: () => ({ async run(_request, { signal }) {
    entered();
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    throw Object.assign(new Error("child stopped"), { details: { aborted: true } });
  } }) });
  const queued = await companion.start({ requestId: "field-cancel-heartbeat", target: "pi", task: "hold", cwd: process.cwd(), execution: { background: true } });
  await ready;
  const keepsLoopAlive = heartbeat?.hasRef();
  const execution = companion.ownedCompletion(queued.jobId);
  // Write the intent as an external caller would. Only the heartbeat can
  // deliver it to this adapter's AbortSignal.
  await companion.store.transition(queued.jobId, (job) => {
    job.receipt.cancellation = { state: "requested", requestedAt: new Date().toISOString() };
    return job;
  });
  const settled = await execution;
  assert.equal(settled.state, "cancelled");
  assert.equal(settled.cancellation.state, "acknowledged");
  assert.equal(keepsLoopAlive, true, "the cancellation heartbeat must keep the event loop alive");
});

test("cancellation preserves cleanup uncertainty from the settled adapter", async (t) => {
  let entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  const cleanupError = [{ component: "process", message: "exit unverified" }];
  const companion = await fixture(t, { adapterFactory: () => ({ async run(_request, { signal }) {
    entered();
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    await new Promise((resolve) => setImmediate(resolve));
    throw Object.assign(new Error("ACP owned process cleanup could not be verified"), {
      details: { kind: "cancel-unacknowledged", aborted: true, unsafeResume: true, cleanupError },
    });
  } }) });
  const queued = await companion.start({
    requestId: "field-cancel-unsafe", target: "acp", task: "hold", cwd: process.cwd(),
    route: { agent: "fixture" }, policy: { write: true }, execution: { background: true },
  });
  await ready;
  const execution = companion.ownedCompletion(queued.jobId);
  await companion.cancel(queued.jobId);
  await execution;
  const settled = await companion.result(queued.jobId);
  assert.equal(settled.state, "partial");
  assert.equal(settled.cancellation.state, "unacknowledged");
  assert.equal(settled.error.details.unsafeResume, true);
  assert.deepEqual(settled.error.details.cleanupError, cleanupError);
  await assert.rejects(companion.resume(queued.jobId), { details: { kind: "unsafe-resume" } });
});

test("graph stop gives the child an acknowledgement window after dispatching old cancellation intent", async (t) => {
  let entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  const companion = await fixture(t, { cancelAckTimeoutMs: 1000, adapterFactory: () => ({ async run(_request, { signal }) {
    entered();
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    throw Object.assign(new Error("child stopped"), { details: { aborted: true } });
  } }) });
  const runner = new GraphRunner({ companion, pollIntervalMs: 10 });
  let stops = 0;
  const cancel = companion.cancel.bind(companion);
  companion.cancel = (...args) => { stops++; return cancel(...args); };
  const queued = await runner.start({ requestId: "field-old-graph-cancel", cwd: process.cwd(), nodes: [{ id: "one", target: "pi", task: "hold" }], execution: { background: true } });
  await ready;
  await runner.store.transact(queued.graphId, async (record, save) => {
    record.cancellation = { state: "requested", requestedAt: new Date(Date.now() - 60_000).toISOString() };
    await save(record);
  });
  await runner.running.get(queued.graphId);
  const settled = await runner.result(queued.graphId);
  assert.equal(settled.state, "cancelled");
  assert.equal(settled.cancellation.state, "acknowledged");
  assert.equal(stops, 1);
});

test("external graph cancellation reserves the child stop before the owner loop observes it", async (t) => {
  let entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  const companion = await fixture(t, {
    cancelAckTimeoutMs: 1_000,
    adapterFactory: () => ({ async run(_request, { signal }) {
      entered();
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      await new Promise((resolve) => setTimeout(resolve, 100));
      throw Object.assign(new Error("child stopped"), { details: { aborted: true, code: null, signal: "SIGTERM" } });
    } }),
  });
  const runner = new GraphRunner({ companion, pollIntervalMs: 5 });
  let stops = 0;
  const cancel = companion.cancel.bind(companion);
  companion.cancel = (...args) => { stops += 1; return cancel(...args); };
  const queued = await runner.start({
    requestId: "field-external-graph-cancel",
    cwd: process.cwd(),
    nodes: [{ id: "one", target: "pi", task: "hold" }],
    execution: { background: true },
  });
  await ready;
  await Promise.all([runner.cancel(queued.graphId), runner.cancel(queued.graphId)]);
  await runner.running.get(queued.graphId);
  const settled = await runner.result(queued.graphId);
  assert.equal(settled.state, "cancelled");
  assert.equal(settled.cancellation.state, "acknowledged");
  assert.equal(stops, 1);
});

test("graph cancellation replays a reserved stop after the cancelling caller crashes", async (t) => {
  let entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  const companion = await fixture(t, {
    cancelAckTimeoutMs: 1_000,
    adapterFactory: () => ({ async run(_request, { signal }) {
      entered();
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      throw Object.assign(new Error("child stopped"), { details: { aborted: true } });
    } }),
  });
  const runner = new GraphRunner({ companion, pollIntervalMs: 5, leaseTimeoutMs: 100 });
  let stops = 0;
  const cancel = companion.cancel.bind(companion);
  companion.cancel = (...args) => { stops += 1; return cancel(...args); };
  const queued = await runner.start({
    requestId: "field-crashed-graph-cancel",
    cwd: process.cwd(),
    nodes: [{ id: "one", target: "pi", task: "hold" }],
    execution: { background: true },
  });
  await ready;
  const childId = await runner.store.transact(queued.graphId, async (record, save) => {
    assert.ok(record.nodes[0].jobId, "the graph must publish the launched child");
    record.cancellation = { state: "requested", requestedAt: new Date().toISOString() };
    record.nodes[0].attempts[0].stopRequestedAt = new Date().toISOString();
    await save(record);
    return record.nodes[0].jobId;
  });

  try {
    for (let count = 0; count < 200 && stops === 0; count++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(stops, 1, "the owner must replay the stop whose reservation survived the caller");
    await runner.running.get(queued.graphId);
    const settled = await runner.result(queued.graphId);
    const attempt = settled.nodes[0].attempts[0];
    assert.equal(settled.state, "cancelled");
    assert.equal(settled.cancellation.state, "acknowledged");
    assert.ok(attempt.stopRequestedAt);
    assert.ok(attempt.stopDispatchedAt);
  } finally {
    if (stops === 0) await companion.cancel(childId);
    await runner.running.get(queued.graphId);
  }
});

test("external graph cancellation force-settles a stuck child after one stop request", { timeout: 30_000 }, async (t) => {
  let entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  const companion = await fixture(t, {
    cancelAckTimeoutMs: 1,
    heartbeatIntervalMs: 5,
    adapterFactory: () => ({ async run() {
      entered();
      return new Promise(() => {});
    } }),
  });
  const runner = new GraphRunner({ companion, pollIntervalMs: 5, leaseTimeoutMs: 1_000 });
  let stops = 0;
  companion.cancel = async (jobId) => { stops++; return companion.status(jobId); };
  const queued = await runner.start({
    requestId: "field-external-graph-cancel-stuck",
    cwd: process.cwd(),
    nodes: [{ id: "one", target: "pi", task: "hold" }],
    execution: { background: true },
  });
  await ready;
  const childId = await runner.store.transact(queued.graphId, (record) => record.nodes[0].jobId);
  assert.ok(childId, "the graph must publish the launched child");
  const childReceipt = await companion.status(childId);
  const status = companion.status.bind(companion);
  // Emulate a remote owner: the observer sees a running child after reserving
  // its stop, but cannot observe local adapter settlement.
  companion.status = async (jobId) => jobId === childId
    ? { ...childReceipt, state: "running", cancellation: { state: "requested", requestedAt: new Date().toISOString(), acknowledgedAt: null } }
    : status(jobId);
  const requested = await runner.cancel(queued.graphId);
  assert.equal(requested.state, "running");
  let settled;
  for (let count = 0; count < 700; count++) {
    settled = await runner.status(queued.graphId);
    if (settled.state === "partial") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(settled.state, "partial");
  assert.equal(settled.cancellation.state, "unacknowledged");
  assert.equal(settled.nodes[0].error.details.kind, "cancel-unacknowledged");
  assert.equal(stops, 1);
});

test("slow heartbeat persistence cannot queue a backlog ahead of cancellation", async (t) => {
  let entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  const companion = await fixture(t, { heartbeatIntervalMs: 5, adapterFactory: () => ({ async run(_request, { signal }) {
    entered();
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    throw Object.assign(new Error("child stopped"), { details: { aborted: true } });
  } }) });
  const queued = await companion.start({ requestId: "field-heartbeat-backlog", target: "pi", task: "hold", cwd: process.cwd(), execution: { background: true } });
  await ready;
  const execution = companion.running.get(queued.jobId).promise;
  const put = companion.store.put.bind(companion.store);
  let puts = 0, blocked, release;
  const firstPut = new Promise((resolve) => { blocked = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  companion.store.put = async (...args) => { puts++; blocked(); await gate; return put(...args); };
  await firstPut;
  await new Promise((resolve) => setTimeout(resolve, 50));
  try {
    await companion.cancel(queued.jobId);
  } finally {
    release();
  }
  const settled = await execution;
  assert.equal(settled.state, "cancelled");
  assert.equal(settled.cancellation.state, "acknowledged");
  assert.equal(puts, 1, "heartbeat ticks must share the in-flight persistence write");
});
