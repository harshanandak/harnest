import assert from "node:assert/strict";
import fs, { mkdtemp, open, rm, stat } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JobStore, foldTrace } from "../src/job-store.mjs";

const mib = 1024 * 1024;
const event = (text, data = {}) => ({
  at: "2026-11-18T00:00:00.000Z",
  event: { type: "progress", data: { type: "delta", text, ...data } },
});
const job = (jobId, state = "running") => ({ receipt: { jobId, state } });

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "harnest-trace-retention-"));
  t.after(() => rm(root, { recursive: true }));
  return new JobStore(root);
}

function stubFs(t, name, wrapper) {
  const original = fs[name];
  t.mock.method(fs, name, (...args) => wrapper(original, ...args));
  syncBuiltinESMExports();
  t.after(() => {
    fs[name].mock.restore();
    syncBuiltinESMExports();
  });
}

test("10,000 job summaries churn through the count limit and recover after reopen", async (t) => {
  const store = await fixture(t);
  for (let start = 0; start < 10_000; start += 25) {
    await Promise.all(Array.from({ length: 25 }, (_, offset) => {
      const index = start + offset;
      return store.commit(job(`churn-${index}`), event(`progress ${index}`));
    }));
    assert.ok(store.traceCacheUsage().entries <= 512);
    assert.ok(store.traceCacheUsage().accountedBytes <= 8 * mib);
  }
  assert.equal(store.traceCacheUsage().entries, 512);
  assert.equal((await store.appendEvent("churn-0", event("after eviction"))).sequence, 2);
  const reopened = new JobStore(store.root);
  const summary = await reopened.traceSummary("churn-0");
  assert.equal(summary.eventCount, 2);
  assert.deepEqual(summary.progress.recent, ["progress 0", "after eviction"]);
  assert.equal((await reopened.traceSummary("churn-9999")).progress.current, "progress 9999");
});

test("the byte budget evicts before the count limit and terminal writes release checkpoints", async (t) => {
  const store = await fixture(t);
  const tasklist = Array.from({ length: 20 }, () => ({ title: "界".repeat(200), status: "界".repeat(40) }));
  const events = Array.from({ length: 5 }, (_, index) => event(`${index}${"界".repeat(499)}`, { tasklist }));
  for (let start = 0; start < 512; start += 16) {
    await Promise.all(Array.from({ length: 16 }, (_, offset) => store.commitBatch(job(`bytes-${start + offset}`), events)));
    assert.ok(store.traceCacheUsage().accountedBytes <= 8 * mib);
  }
  const before = store.traceCacheUsage();
  assert.ok(before.entries > 0 && before.entries < 512);
  assert.ok(before.accountedBytes > 7 * mib);
  await store.put(job("bytes-511", "completed"));
  assert.equal(store.traceCacheUsage().entries, before.entries - 1);
  await store.appendEvent("bytes-511", event("terminal append"));
  assert.equal(store.traceCacheUsage().entries, before.entries - 1);
  const final = await store.commit(job("bytes-511", "completed"), event("terminal commit"));
  assert.equal(final.traceCheckpoint.summary.eventCount, 7);
  assert.equal(store.traceCacheUsage().entries, before.entries - 1);
});

test("eviction during snapshot publication cannot discard the writer's checkpoint", async (t) => {
  const store = await fixture(t);
  const jobId = "pending";
  await store.commit(job(jobId), event("first"));
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let notify;
  const appended = new Promise((resolve) => { notify = resolve; });
  const lock = `${store.tracePath(jobId)}.lock`;
  let paused = false;
  stubFs(t, "unlink", async (unlink, path) => {
    if (path === lock && !paused) {
      paused = true;
      notify();
      await blocked;
    }
    return unlink(path);
  });

  const writing = store.commit(job(jobId), event("second"));
  try {
    await Promise.race([appended, writing.then(() => assert.fail("Writer did not pause after its append"))]);
    for (let start = 0; start < 512; start += 16) {
      await Promise.all(Array.from({ length: 16 }, (_, offset) => store.appendEvent(`evict-${start + offset}`, event("churn"))));
    }
    assert.equal(store.traceCacheUsage().entries, 512);
  } finally {
    release();
    await writing;
  }
  assert.equal((await store.get(jobId)).traceCheckpoint.summary.eventCount, 2);
  assert.equal((await store.appendEvent(jobId, event("third"))).sequence, 3);
});

test("failed snapshot publication leaves the appended sequence and projection recoverable", async (t) => {
  const store = await fixture(t);
  const jobId = "snapshot-failure";
  await store.commit(job(jobId), event("first"));
  let fail = true;
  stubFs(t, "rename", (rename, from, to) => {
    if (fail && to === store.path(jobId)) throw Object.assign(new Error("injected publication failure"), { code: "EIO" });
    return rename(from, to);
  });
  await assert.rejects(store.commit(job(jobId, "completed"), event("appended")), /injected publication failure/);
  assert.equal((await store.get(jobId)).traceCheckpoint.summary.eventCount, 1);
  const reopened = new JobStore(store.root);
  assert.equal((await reopened.traceSummary(jobId)).progress.current, "appended");
  fail = false;
  assert.equal((await reopened.commit(job(jobId, "completed"), event("completed"))).traceCheckpoint.summary.eventCount, 3);
  assert.equal(reopened.traceCacheUsage().entries, 0);
});

test("deep journals recover with record-sized buffering and retain the maximum valid sequence", async (t) => {
  const store = await fixture(t);
  const jobId = "large";
  const path = store.tracePath(jobId);
  const record = (sequence, text, payload) => `${JSON.stringify({ sequence, ...event(text, { payload }) })}\n`;
  const large = record(40, "large", "界".repeat(100_000));
  const writer = await open(path, "w");
  try {
    const chunk = record(1, "small", "x".repeat(200)).repeat(2048);
    for (let index = 0; index < 32; index++) await writer.writeFile(chunk);
    await writer.writeFile(`${large}{malformed\n${record(2, "last")}`);
  } finally {
    await writer.close();
  }
  const { size } = await stat(path);
  assert.ok(size > 16 * mib);
  const reader = await open(path, "r");
  const metrics = {};
  try {
    const recovered = await foldTrace(reader, size, metrics);
    assert.equal(recovered.sequence, 40);
    assert.equal(recovered.summary.progress.current, "last");
    assert.deepEqual(recovered.summary.recovery, { malformedRecords: 1, lastSafeSequence: 40 });
    assert.ok(metrics.peakRecordBufferBytes >= Buffer.byteLength(large) - 1);
    assert.ok(metrics.peakRecordBufferBytes <= 512 * 1024);
    assert.equal(metrics.readBufferBytes, 64 * 1024);
  } finally {
    await reader.close();
  }
  assert.equal((await store.traceSummary(jobId)).eventCount, 40);
  assert.equal((await store.appendEvent(jobId, event("next"))).sequence, 41);
});
