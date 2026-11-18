import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFile, mkdtemp, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JobStore, readTracePage, TRACE_RECORD_BYTES } from "../src/job-store.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "harnest-trace-performance-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const store = new JobStore(root);
  const job = { request: { requestId: "trace-fixture" }, receipt: { jobId: "trace-fixture", state: "running" }, lease: { ownerId: "owner" } };
  await store.put(job);
  return { root, store, job, jobId: job.receipt.jobId };
}

const event = (text) => ({ at: "2026-09-17T00:00:00.000Z", event: { type: "delta", text } });

test("byte-seek pages match full replay with variable UTF-8 lines and malformed records", async (t) => {
  const { store, jobId } = await fixture(t);
  const expected = Array.from({ length: 3_000 }, (_, index) => ({
    sequence: index + 1, ...event(`${index}: ${"界🧪".repeat((index % 200) + 1)}`),
  }));
  await writeFile(store.tracePath(jobId), expected.map((record, index) => `${JSON.stringify(record)}\n${index % 97 === 0 ? "{malformed\n" : ""}`).join(""));
  for (const afterSequence of [0, 1, 50, 255, 1_501, 2_990, 3_000, 9_000]) {
    for (const limit of [1, 50, 200]) {
      const page = await store.readTrace(jobId, { afterSequence, limit });
      assert.deepEqual(page.events, expected.slice(afterSequence, afterSequence + limit));
      assert.equal(page.hasMore, afterSequence + limit < expected.length);
      assert.equal(page.nextSequence, page.events.at(-1)?.sequence || afterSequence);
    }
  }
  for (const limit of [1, 50, 200]) {
    const page = await store.readTrace(jobId, { limit });
    assert.deepEqual(page.events, expected.slice(-limit));
    assert.equal(page.hasMore, true);
  }
});

test("caught-up and tail reads use a fraction of a deep journal's bytes", async (t) => {
  const { store, jobId } = await fixture(t);
  const lines = Array.from({ length: 30_000 }, (_, index) => JSON.stringify({ sequence: index + 1, ...event("x".repeat(200)) }));
  const path = store.tracePath(jobId);
  await writeFile(path, `${lines.join("\n")}\n`);
  const size = (await stat(path)).size;
  for (const options of [{ limit: 50 }, { afterSequence: 30_000, limit: 50 }, { afterSequence: 15_000, limit: 50 }]) {
    let bytes = 0;
    const page = await readTracePage(path, { ...options, openFile: async (...args) => {
      const handle = await open(...args);
      return {
        stat: () => handle.stat(), close: () => handle.close(),
        async read(...readArgs) { const result = await handle.read(...readArgs); bytes += result.bytesRead; return result; },
      };
    } });
    assert.ok(bytes < size / 4, `${JSON.stringify(options)} read ${bytes}/${size} bytes`);
    assert.equal(page.events.length, options.afterSequence === 30_000 ? 0 : 50);
    console.log(`trace bytes ${JSON.stringify(options)}: ${bytes}/${size}`);
  }
});

test("fresh processes recover appended events beyond the committed snapshot checkpoint", async (t) => {
  const { root, store, job, jobId } = await fixture(t);
  await store.commitBatch(job, [event("first"), event("second")], { expectedLeaseOwner: "owner" });
  const checkpoint = (await store.get(jobId)).traceCheckpoint;
  assert.equal(checkpoint.summary.eventCount, 2);
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const { JobStore } = await import(${JSON.stringify(new URL("../src/job-store.mjs", import.meta.url).href)});
    await new JobStore(${JSON.stringify(root)}).appendEvent(${JSON.stringify(jobId)}, ${JSON.stringify(event("appended-before-crash"))});
  `], { encoding: "utf8", timeout: 10_000, windowsHide: true });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  const restarted = new JobStore(root);
  const recovered = await restarted.traceSummary(jobId);
  assert.equal(recovered.eventCount, 3);
  assert.equal(recovered.progress.current, "appended-before-crash");
  assert.equal((await restarted.get(jobId)).traceCheckpoint.summary.eventCount, 2, "recovery read must not overwrite a worker snapshot");
  await store.commitBatch(job, [event("fourth")], { expectedLeaseOwner: "owner" });
  assert.deepEqual((await restarted.readTrace(jobId, { afterSequence: 0 })).events.map((record) => record.sequence), [1, 2, 3, 4]);
  const summary = await restarted.traceSummary(jobId);
  assert.equal(summary.eventCount, 4);
  assert.ok(summary.progress.recent.includes("appended-before-crash"));
  assert.equal(summary.progress.current, "fourth");
  const before = await readFile(store.path(jobId), "utf8");
  assert.equal(await store.commitBatch(job, [event("stale")], { expectedLeaseOwner: "stale-owner" }), null);
  assert.equal(await readFile(store.path(jobId), "utf8"), before);
});

test("same-size replacement invalidates writer sequences and summary checkpoints", async (t) => {
  const { store, job, jobId } = await fixture(t);
  await store.commitBatch(job, [event("first")], { expectedLeaseOwner: "owner" });
  const path = store.tracePath(jobId);
  const raw = await readFile(path, "utf8");
  const replacement = raw.replace('"sequence":1', '"sequence":9').replace("first", "ninth");
  assert.equal(Buffer.byteLength(replacement), Buffer.byteLength(raw));
  await writeFile(`${path}.replacement`, replacement);
  await rename(`${path}.replacement`, path);
  const observer = new JobStore(store.root);
  assert.equal((await observer.traceSummary(jobId)).eventCount, 9);
  assert.equal((await observer.traceSummary(jobId)).progress.current, "ninth");
  const summary = await store.traceSummary(jobId);
  assert.equal(summary.eventCount, 9);
  assert.equal(summary.progress.current, "ninth");
  assert.equal((await store.readTrace(jobId)).events[0].sequence, 9);
  await store.commitBatch(job, [event("tenth")], { expectedLeaseOwner: "owner" });
  assert.equal((await store.traceSummary(jobId)).eventCount, 10);
  assert.deepEqual((await store.readTrace(jobId)).events.map((record) => record.sequence), [9, 10]);
});

test("in-place edits and truncation invalidate checkpoints even at the same byte length", async (t) => {
  const { store, job, jobId } = await fixture(t);
  await store.commitBatch(job, [event("first"), event("other")], { expectedLeaseOwner: "owner" });
  const path = store.tracePath(jobId);
  const raw = await readFile(path, "utf8");
  await writeFile(path, raw.replace("other", "newer"));
  assert.equal((await store.traceSummary(jobId)).progress.current, "newer");
  await writeFile(path, `${JSON.stringify({ sequence: 7, ...event("reset") })}\n`);
  await store.commitBatch(job, [event("eighth")], { expectedLeaseOwner: "owner" });
  assert.deepEqual((await store.readTrace(jobId)).events.map((record) => record.sequence), [7, 8]);
  assert.equal((await store.traceSummary(jobId)).progress.current, "eighth");
});

test("a torn final line cannot swallow a later durable event", async (t) => {
  const { store, job, jobId } = await fixture(t);
  await store.commitBatch(job, [event("first")], { expectedLeaseOwner: "owner" });
  await appendFile(store.tracePath(jobId), '{"sequence":2,"event":');
  assert.deepEqual((await store.traceSummary(jobId)).recovery, { malformedRecords: 1, lastSafeSequence: 1 });
  await store.commitBatch(job, [event("recovered")], { expectedLeaseOwner: "owner" });
  const restarted = new JobStore(store.root);
  assert.deepEqual((await restarted.readTrace(jobId)).events.map((record) => record.sequence), [1, 2]);
  const summary = await restarted.traceSummary(jobId);
  assert.equal(summary.progress.current, "recovered");
  assert.deepEqual(summary.recovery, { malformedRecords: 1, lastSafeSequence: 1 });
});

test("oversized records fail recovery with the last safe sequence and leave the journal intact", async (t) => {
  const { store, job, jobId } = await fixture(t);
  await store.commitBatch(job, [event("first")], { expectedLeaseOwner: "owner" });
  const path = store.tracePath(jobId);
  await appendFile(path, `${JSON.stringify({ sequence: 2, ...event("x".repeat(TRACE_RECORD_BYTES)) })}\n`);
  const before = await stat(path);
  const oversized = (error) => {
    assert.match(error.message, /trace record exceeds/);
    assert.equal(error.details.lastSafeSequence, 1);
    return true;
  };
  await assert.rejects(store.traceSummary(jobId), oversized);
  await assert.rejects(store.appendEvent(jobId, event("must not append")), oversized);
  assert.equal((await stat(path)).size, before.size);
});

test("byte pages preserve long UTF-8 records and leave concurrent appends for the next cursor", async (t) => {
  const { store, jobId } = await fixture(t);
  const path = store.tracePath(jobId);
  const expected = [
    { sequence: 1, ...event("界🧪".repeat(30_000)) },
    { sequence: 2, ...event("second") },
  ];
  await writeFile(path, `${expected.map((record) => JSON.stringify(record)).join("\n")}\n`);
  let appended = false;
  const page = await readTracePage(path, { afterSequence: 0, openFile: async (...args) => {
    const handle = await open(...args);
    return {
      stat: () => handle.stat(), close: () => handle.close(),
      async read(...readArgs) {
        if (!appended) {
          appended = true;
          await appendFile(path, `${JSON.stringify({ sequence: 3, ...event("third") })}\n`);
        }
        return handle.read(...readArgs);
      },
    };
  } });
  assert.deepEqual(page.events, expected);
  assert.equal(page.nextSequence, 2);
  assert.deepEqual((await store.readTrace(jobId, { afterSequence: page.nextSequence })).events.map((record) => record.sequence), [3]);
});

test("old snapshots and unknown checkpoint versions fall back to journal replay", async (t) => {
  const { store, job, jobId } = await fixture(t);
  await store.commitBatch(job, [event("truth")], { expectedLeaseOwner: "owner" });
  job.traceCheckpoint.version = 0;
  job.traceCheckpoint.summary.progress.current = "stale projection";
  await store.put(job);
  assert.equal((await store.traceSummary(jobId)).progress.current, "truth");
  delete job.traceCheckpoint;
  await store.put(job);
  assert.equal((await store.traceSummary(jobId)).progress.current, "truth");
});

test("a matching snapshot skips the second job read and still returns the checkpoint summary", async (t) => {
  const { store, job, jobId } = await fixture(t);
  await store.commitBatch(job, [event("first"), event("second")], { expectedLeaseOwner: "owner" });
  const snapshot = await store.get(jobId);
  assert.equal(snapshot.traceCheckpoint.version, 4);
  const realGet = store.get.bind(store);
  let reads = 0;
  store.get = (...args) => { reads += 1; return realGet(...args); };
  try {
    const summary = await store.traceSummary(jobId, { snapshot });
    assert.equal(reads, 0, "a matching snapshot must avoid a second durable job read");
    assert.equal(summary.eventCount, 2);
    assert.equal(summary.progress.current, "second");
  } finally {
    store.get = realGet;
  }
});

test("a stale snapshot is validated against the live journal and replayed", async (t) => {
  const { root, store, job, jobId } = await fixture(t);
  await store.commitBatch(job, [event("first")], { expectedLeaseOwner: "owner" });
  const stale = await store.get(jobId);
  assert.equal(stale.traceCheckpoint.summary.progress.current, "first");
  // Another process appends without rewriting the snapshot this caller holds.
  await new JobStore(root).appendEvent(jobId, event("appended-elsewhere"));
  const summary = await store.traceSummary(jobId, { snapshot: stale });
  assert.equal(summary.eventCount, 2, "a stale checkpoint must not mask an appended journal record");
  assert.equal(summary.progress.current, "appended-elsewhere");
});

test("a foreign snapshot is ignored rather than summarizing the requested job", async (t) => {
  const { store, job, jobId } = await fixture(t);
  await store.commitBatch(job, [event("own-truth")], { expectedLeaseOwner: "owner" });
  const other = { request: { requestId: "trace-other" }, receipt: { jobId: "trace-other", state: "running" }, lease: { ownerId: "owner" } };
  await store.put(other);
  await store.commitBatch(other, [event("foreign-truth")], { expectedLeaseOwner: "owner" });
  const summary = await store.traceSummary(jobId, { snapshot: other });
  assert.equal(summary.progress.current, "own-truth", "a snapshot for another job must not be trusted");
});
