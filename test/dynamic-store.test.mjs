import assert from "node:assert/strict";
import fs, { appendFile, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DynamicStore } from "../src/dynamic-store.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "harnest-dyn-store-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const store = new DynamicStore(root);
  const runId = "dyn-" + "a".repeat(64);
  const record = () => ({ runId, requestId: "req-1", state: "queued", revision: 0, createdAt: "t0", updatedAt: "t0", calls: [], journalSequence: 0 });
  return { root, store, runId, record, run: (overrides = {}) => ({ ...record(), ...overrides }) };
}

test("createRun persists record, spec and request index", async (t) => {
  const f = await fixture(t);
  const created = await f.store.createRun({
    runId: f.runId, requestId: "req-1", record: f.run(), specRevision: { revision: 1, scriptDigest: "d", argsDigest: "a", createdAt: "t0", spec: { source: "x" } },
  });
  assert.equal(created.created, true);
  const stored = await f.store.readRun(f.runId);
  assert.equal(stored.requestId, "req-1");
  assert.equal((await f.store.readSpecs(f.runId)).revisions[0].spec.source, "x");
  assert.equal(await f.store.locateRequest("req-1"), f.runId);
  assert.deepEqual(await f.store.listRunIds(), [f.runId]);
  const journal = await f.store.readJournal(f.runId);
  assert.equal(journal.events[0].type, "created");
});

test("concurrent createRun for the same request deduplicates to one run", async (t) => {
  const f = await fixture(t);
  const spec = { revision: 1, scriptDigest: "d", argsDigest: "a", createdAt: "t0", spec: { source: "x" } };
  const results = await Promise.all(Array.from({ length: 8 }, () =>
    f.store.createRun({ runId: f.runId, requestId: "req-1", record: f.run(), specRevision: spec })));
  assert.equal(results.filter((item) => item.created).length, 1);
  assert.equal(new Set(results.map((item) => item.runId)).size, 1);
});

test("createRun repairs a crash between record write and index write", async (t) => {
  const f = await fixture(t);
  await f.store.transact(f.runId, () => ({ record: f.run() }));
  // Index deliberately missing; the scan must find the run by requestId.
  const created = await f.store.createRun({ runId: "dyn-" + "b".repeat(64), requestId: "req-1", record: f.run(), specRevision: { revision: 1, scriptDigest: "d", argsDigest: "a", createdAt: "t0", spec: {} } });
  assert.equal(created.created, false);
  assert.equal(created.runId, f.runId);
});

test("transact bumps revision and appends journal atomically", async (t) => {
  const f = await fixture(t);
  await f.store.transact(f.runId, () => ({ record: f.run() }));
  const result = await f.store.transact(f.runId, (record) => {
    record.state = "running";
    return { record, journal: [{ type: "claimed", at: "t1" }] };
  });
  assert.equal(result.record.revision, 2);
  assert.equal(result.journal[0].sequence, 1);
  assert.equal(result.record.journalSequence, 1);
  assert.equal((await f.store.readRun(f.runId)).state, "running");
  const noop = await f.store.transact(f.runId, () => null);
  assert.equal(noop, null);
});

test("journal pagination returns ordered pages", async (t) => {
  const f = await fixture(t);
  await f.store.appendJournal(f.runId, [{ type: "a" }, { type: "b" }, { type: "c" }], 0);
  const first = await f.store.readJournal(f.runId, { limit: 2 });
  assert.deepEqual(first.events.map((event) => event.type), ["a", "b"]);
  assert.equal(first.hasMore, true);
  assert.equal(first.nextSequence, 2);
  const second = await f.store.readJournal(f.runId, { afterSequence: first.nextSequence, limit: 2 });
  assert.deepEqual(second.events.map((event) => event.type), ["c"]);
  assert.equal(second.hasMore, false);
  assert.equal(await f.store.journalTail(f.runId), 3);
});

test("spec revisions are append-only and content-fenced", async (t) => {
  const f = await fixture(t);
  const base = { revision: 1, scriptDigest: "d1", argsDigest: "a", createdAt: "t0", spec: { source: "one" } };
  await f.store.appendSpecRevision(f.runId, base);
  await f.store.appendSpecRevision(f.runId, base);
  assert.equal((await f.store.readSpecs(f.runId)).revisions.length, 1);
  await f.store.appendSpecRevision(f.runId, { ...base, revision: 2, scriptDigest: "d2", spec: { source: "two" } });
  assert.equal((await f.store.readSpecs(f.runId)).revisions.length, 2);
  await assert.rejects(
    () => f.store.appendSpecRevision(f.runId, { ...base, scriptDigest: "other", spec: { source: "changed" } }),
    /different content/,
  );
  assert.equal((await f.store.readSpecs(f.runId)).revisions[0].spec.source, "one");
});

test("reads survive a torn write: rename is atomic, temp files are ignored", async (t) => {
  const f = await fixture(t);
  await f.store.transact(f.runId, () => ({ record: f.run() }));
  await writeFile(join(f.root, `${f.runId}.json.tmp`), "{torn", "utf8");
  const record = await f.store.readRun(f.runId);
  assert.equal(record.requestId, "req-1");
  assert.deepEqual(await f.store.listRunIds(), [f.runId], "temp files are not runs");
  const raw = await readFile(join(f.root, `${f.runId}.json`), "utf8");
  assert.ok(raw.endsWith("\n"));
});

test("a live snapshot read survives ENOENT during replacement", async (t) => {
  const f = await fixture(t);
  await f.store.transact(f.runId, () => ({ record: f.run({ state: "running" }) }));
  const runPath = f.store.runPath(f.runId);
  const replacing = Promise.withResolvers();
  const allowRename = Promise.withResolvers();
  const writer = new DynamicStore(f.root, { renameFile: async (source, target) => {
    replacing.resolve();
    await allowRename.promise;
    await rename(source, target);
  } });
  const publication = writer.transact(f.runId, (record) => ({ record }));
  await Promise.race([replacing.promise, publication]);

  const originalRead = fs.readFile;
  let injected = false;
  const stub = t.mock.method(fs, "readFile", async (path, ...args) => {
    if (path === runPath && !injected) {
      injected = true;
      allowRename.resolve();
      throw Object.assign(new Error("injected ENOENT during snapshot replacement"), { code: "ENOENT" });
    }
    return originalRead(path, ...args);
  });
  syncBuiltinESMExports();
  let snapshot;
  try {
    snapshot = await f.store.readRun(f.runId);
  } finally {
    stub.mock.restore();
    syncBuiltinESMExports();
    allowRename.resolve();
    await publication;
  }
  assert.equal(injected, true);
  assert.equal(snapshot?.state, "running");
  assert.equal(snapshot.revision, 2);
});

test("invalid run ids and missing runs fail closed", async (t) => {
  const f = await fixture(t);
  await assert.rejects(() => f.store.readRun("../escape"), /invalid runId/);
  assert.equal(await f.store.readRun("dyn-" + "c".repeat(64)), null);
});

test("concurrent mutations share a commit but no caller completes before its durable snapshot", async (t) => {
  const f = await fixture(t);
  await f.store.transact(f.runId, () => ({ record: f.run({ count: 0 }) }));
  let enter;
  let release;
  const writing = new Promise((resolve) => { enter = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  let writes = 0;
  let completed = 0;
  const store = new DynamicStore(f.root, { renameFile: async (source, destination) => {
    if (destination === f.store.runPath(f.runId)) { writes++; enter(); await held; }
    return rename(source, destination);
  } });
  const calls = Array.from({ length: 20 }, () => store.transact(f.runId, (record) => {
    record.count++;
    return { record, journal: [{ type: "increment", count: record.count }] };
  }).then((result) => { completed++; return result; }));
  try {
    await writing;
    assert.equal(completed, 0);
    assert.equal((await f.store.readRun(f.runId)).count, 0);
  } finally { release(); }
  const results = await Promise.all(calls);
  assert.equal(writes, 1, "one simultaneous cohort must not rewrite the whole snapshot per mutation");
  assert.deepEqual(results.map((result) => result.record.count), Array.from({ length: 20 }, (_, i) => i + 1));
  assert.equal((await f.store.readRun(f.runId)).count, 20);
  assert.deepEqual((await f.store.readJournal(f.runId)).events.map((event) => event.sequence), Array.from({ length: 20 }, (_, i) => i + 1));
});

test("rejected mutations cannot poison queued work or overwrite a newer owner", async (t) => {
  const f = await fixture(t);
  await f.store.transact(f.runId, () => ({ record: f.run({ count: 0, owner: "old" }) }));
  const results = await Promise.allSettled([
    f.store.transact(f.runId, (record) => { record.count = 9000; throw new Error("first callback failed"); }),
    f.store.transact(f.runId, (record) => { record.owner = "new"; return { record }; }),
    f.store.transact(f.runId, (record) => { if (record.owner !== "old") throw new Error("lease lost"); record.owner = "old"; return { record }; }),
    f.store.transact(f.runId, (record) => { record.count = 1000; throw null; }),
    f.store.transact(f.runId, (record) => { record.count++; return { record }; }),
  ]);
  assert.deepEqual(results.map((result) => result.status), ["rejected", "fulfilled", "rejected", "rejected", "fulfilled"]);
  const fresh = new DynamicStore(f.root);
  const stored = await fresh.readRun(f.runId);
  assert.equal(stored.count, 1);
  assert.equal(stored.owner, "new");
  await fresh.transact(f.runId, (record) => { record.count++; return { record }; });
  assert.equal((await f.store.readRun(f.runId)).count, 2);
});

test("creation and the first transaction have distinct losslessly pageable journal sequences", async (t) => {
  const f = await fixture(t);
  await f.store.createRun({ runId: f.runId, requestId: "req-1", record: f.run(), specRevision: { revision: 1, spec: {} } });
  await f.store.transact(f.runId, (record) => ({ record, journal: [{ type: "claimed" }] }));
  const first = await f.store.readJournal(f.runId, { limit: 1 });
  const second = await f.store.readJournal(f.runId, { limit: 1, afterSequence: first.nextSequence });
  assert.deepEqual([...first.events, ...second.events].map(({ type, sequence }) => [type, sequence]), [["created", 1], ["claimed", 2]]);
  assert.equal((await f.store.readRun(f.runId)).journalSequence, 2);
});

test("publication failure rejects every caller and the next batch cannot reuse journal sequences", async (t) => {
  const f = await fixture(t);
  await f.store.transact(f.runId, () => ({ record: f.run({ count: 0, controls: [] }) }));
  await f.store.readControlState(f.runId);
  const broken = new DynamicStore(f.root, { renameFile: async (source, target) => {
    if (target === f.store.runPath(f.runId)) throw new Error("injected publication failure");
    return rename(source, target);
  } });
  const outcomes = await Promise.allSettled([1, 2].map((count) => broken.transact(f.runId, (record) => {
    record.count = count;
    record.controls.push({ commandId: String(count) });
    return { record, journal: [{ type: "unpublished", count }] };
  })));
  assert.ok(outcomes.every((entry) => entry.status === "rejected"));
  assert.equal((await f.store.readRun(f.runId)).count, 0);
  assert.deepEqual((await f.store.readControlState(f.runId)).controls, []);
  await f.store.transact(f.runId, (record) => { record.count = 3; return { record, journal: [{ type: "retry" }] }; });
  assert.deepEqual((await f.store.readJournal(f.runId)).events.map((event) => event.sequence), [1, 2, 3]);
  assert.equal((await f.store.readRun(f.runId)).journalSequence, 3);
});

test("a torn journal suffix cannot swallow the next event", async (t) => {
  const f = await fixture(t);
  await f.store.appendJournal(f.runId, [{ type: "before" }]);
  await appendFile(f.store.journalPath(f.runId), '{"type":"torn');
  await f.store.appendJournal(f.runId, [{ type: "after" }], 0);
  assert.deepEqual((await f.store.readJournal(f.runId)).events.map(({ type, sequence }) => [type, sequence]), [["before", 1], ["after", 2]]);
});

test("compact control reads detect remote writes and do not leak mutable cache references", async (t) => {
  const f = await fixture(t);
  await f.store.transact(f.runId, () => ({ record: f.run({ controls: [], pause: { requested: false } }) }));
  const first = await f.store.readControlState(f.runId);
  first.pause.requested = true;
  assert.equal((await f.store.readControlState(f.runId)).pause.requested, false);
  assert.equal(Object.hasOwn(first, "calls"), false);
  const remote = new DynamicStore(f.root);
  await remote.transact(f.runId, (record) => { record.pause.requested = true; record.controls.push({ commandId: "remote" }); return { record }; });
  const changed = await f.store.readControlState(f.runId);
  assert.equal(changed.pause.requested, true);
  assert.equal(changed.controls[0].commandId, "remote");
  assert.equal(changed.revision, first.revision + 1);
});
