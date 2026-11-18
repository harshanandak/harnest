import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { DynamicStore, MAX_JOURNAL_BYTES } from "../src/dynamic-store.mjs";
import { main as retentionMain } from "../scripts/dynamic-retention.mjs";

const AT = (index) => new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();

async function fixture(t, { state = "completed" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "harnest-dyn-retention-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const store = new DynamicStore(root);
  const runId = `dyn-${"a".repeat(64)}`;
  await store.createRun({
    runId,
    requestId: "retention-run",
    record: { runId, requestId: "retention-run", state: "queued", revision: 0, createdAt: AT(0), updatedAt: AT(0), journalSequence: 0 },
    specRevision: { revision: 1, scriptDigest: "d", argsDigest: "a", createdAt: AT(0), spec: { source: "return 1;" } },
  });
  async function append(count, startIndex = 1) {
    const events = Array.from({ length: count }, (_, offset) => ({ at: AT(startIndex + offset), type: "progress", index: startIndex + offset }));
    const start = await store.journalTail(runId);
    await store.appendJournal(runId, events, start);
    return events;
  }
  async function settle(extra = {}) {
    await store.transact(runId, (record) => {
      record.state = state;
      record.lease = null;
      record.completedAt = AT(999);
      Object.assign(record, extra);
      return { record };
    });
  }
  if (state === "completed") await settle();
  return { root, store, runId, append, settle };
}

async function eventsOf(store, runId) {
  return (await store.readJournal(runId, { limit: 500 })).events;
}

test("retention refuses an active run or live lease and leaves the journal untouched", async (t) => {
  const f = await fixture(t, { state: "running" });
  await f.append(3);
  const before = await f.store.readJournal(f.runId, { limit: 500 });
  await assert.rejects(
    () => f.store.compressJournal(f.runId, { beforeISO: AT(500), apply: true }),
    (error) => error.details?.kind === "retention-active",
  );
  await assert.rejects(() => stat(f.store.archivePath(f.runId)), /ENOENT/);
  assert.deepEqual((await f.store.readJournal(f.runId, { limit: 500 })).events, before.events);
  // A terminal run that somehow still holds a lease is refused the same way.
  const g = await fixture(t);
  await g.append(2);
  await g.store.transact(g.runId, (record) => { record.lease = { ownerId: "other", fence: 1, heartbeatAt: Date.now(), timeoutMs: 30_000 }; return { record }; });
  await assert.rejects(
    () => g.store.compressJournal(g.runId, { beforeISO: AT(500), apply: true }),
    (error) => error.details?.kind === "retention-active",
  );
});

test("a completed history compresses to exact sequences, verified digest and unchanged snapshot/spec", async (t) => {
  const f = await fixture(t);
  await f.append(4);
  const leasePath = join(f.root, `${f.runId}.lease`);
  await writeFile(leasePath, JSON.stringify({ ownerId: "native", heartbeatAt: Date.now() }), "utf8");
  const before = await eventsOf(f.store, f.runId);
  assert.equal(before.length, 5, "created + four events");
  const receipt = await f.store.compressJournal(f.runId, { beforeISO: AT(500), apply: true });
  assert.equal(receipt.applied, true);
  assert.equal(receipt.archivedLines, 5);
  assert.equal(receipt.tailLines, 0);
  assert.equal(receipt.archivedSequence, 5);
  assert.equal(receipt.digest.length, 64);
  assert.ok((await stat(f.store.archivePath(f.runId))).size > 0);
  const after = await eventsOf(f.store, f.runId);
  assert.deepEqual(after.map((event) => event.sequence), before.map((event) => event.sequence));
  const fresh = new DynamicStore(f.root);
  assert.deepEqual((await eventsOf(fresh, f.runId)).map((event) => event.sequence), [1, 2, 3, 4, 5]);
  assert.equal((await fresh.readRun(f.runId)).state, "completed");
  assert.equal((await fresh.readSpecs(f.runId)).revisions[0].spec.source, "return 1;");
  assert.ok((await stat(leasePath)).size > 0, "native lease files are never pruned");
});

test("beforeISO keeps newer entries in the raw tail and post-compression appends preserve history", async (t) => {
  const f = await fixture(t);
  await f.append(4);
  const receipt = await f.store.compressJournal(f.runId, { beforeISO: AT(2), apply: true });
  assert.equal(receipt.selectedLines, 3, "created + two early events");
  assert.equal(receipt.tailLines, 2);
  await f.store.appendJournal(f.runId, [{ at: AT(6), type: "progress", index: 6 }]);
  const events = await eventsOf(f.store, f.runId);
  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4, 5, 6]);
  assert.equal(await f.store.journalTail(f.runId), 6);
  assert.equal(events[0].type, "created");
  assert.equal(events.at(-1).index, 6);
});

test("a crash after the archive write leaves history exactly once and the retry succeeds", async (t) => {
  const f = await fixture(t);
  await f.append(3);
  const before = await eventsOf(f.store, f.runId);
  await assert.rejects(
    () => f.store.compressJournal(f.runId, { beforeISO: AT(500), apply: true, hooks: { afterArchiveWrite: () => { throw new Error("injected crash after archive"); } } }),
    /injected crash after archive/,
  );
  // The archive and the still-full raw journal overlap byte-identically.
  const merged = await eventsOf(f.store, f.runId);
  assert.deepEqual(merged.map((event) => event.sequence), before.map((event) => event.sequence));
  const receipt = await f.store.compressJournal(f.runId, { beforeISO: AT(500), apply: true });
  assert.equal(receipt.applied, true);
  assert.equal(receipt.tailLines, 0);
  const after = await eventsOf(f.store, f.runId);
  assert.deepEqual(after.map((event) => event.sequence), before.map((event) => event.sequence));
});

test("divergent overlap and corrupt archives fail closed", async (t) => {
  const f = await fixture(t);
  await f.append(2);
  await f.store.compressJournal(f.runId, { beforeISO: AT(1), apply: true });
  // Same sequence, different bytes in the raw tail: never silently deduped.
  const raw = await readFile(f.store.journalPath(f.runId), "utf8");
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const divergent = JSON.stringify({ sequence: 1, at: AT(0), type: "tampered" });
  await writeFile(f.store.journalPath(f.runId), `${[divergent, ...lines].join("\n")}\n`, "utf8");
  await assert.rejects(() => eventsOf(f.store, f.runId), (error) => error.details?.kind === "persistence" && /diverges/.test(error.message));
  // A corrupt archive is an explicit failure, never a silent empty history.
  const g = await fixture(t);
  await g.append(1);
  await writeFile(g.store.archivePath(g.runId), Buffer.from("not gzip"), "utf8");
  await assert.rejects(() => eventsOf(g.store, g.runId), (error) => error.details?.kind === "persistence");
  await assert.rejects(
    () => g.store.compressJournal(g.runId, { beforeISO: AT(500), apply: true }),
    (error) => error.details?.kind === "persistence",
  );
});

test("oversized journals are refused without truncating the source", async (t) => {
  const f = await fixture(t);
  await f.append(3);
  const before = await eventsOf(f.store, f.runId);
  await assert.rejects(
    () => f.store.compressJournal(f.runId, { beforeISO: AT(500), apply: true, maxJournalBytes: 8 }),
    (error) => error.details?.kind === "limit" && /without truncation/.test(error.message),
  );
  assert.deepEqual((await eventsOf(f.store, f.runId)).map((event) => event.sequence), before.map((event) => event.sequence));
  assert.equal(MAX_JOURNAL_BYTES, 16 * 1024 * 1024);
});

test("restore merges the archive back and removes it", async (t) => {
  const f = await fixture(t);
  await f.append(3);
  const before = await eventsOf(f.store, f.runId);
  await f.store.compressJournal(f.runId, { beforeISO: AT(2), apply: true });
  const receipt = await f.store.restoreJournal(f.runId);
  assert.equal(receipt.restored, true);
  await assert.rejects(() => stat(f.store.archivePath(f.runId)), /ENOENT/);
  assert.deepEqual((await eventsOf(f.store, f.runId)).map((event) => event.sequence), before.map((event) => event.sequence));
  const again = await f.store.restoreJournal(f.runId);
  assert.equal(again.restored, false);
  assert.equal(again.reason, "no-archive");
});

test("duplicate historical sequence numbers survive compression byte-for-byte", async (t) => {
  const f = await fixture(t);
  // The baseline store can emit sequence 1 twice: the `created` event and the
  // first direct append both start from 0. Retention must preserve that.
  await appendFile(f.store.journalPath(f.runId), JSON.stringify({ at: AT(1), type: "progress", index: 1, sequence: 1 }) + "\n");
  await appendFile(f.store.journalPath(f.runId), JSON.stringify({ at: AT(2), type: "progress", index: 2, sequence: 2 }) + "\n");
  const before = await eventsOf(f.store, f.runId);
  assert.deepEqual(before.map((event) => event.sequence), [1, 1, 2]);
  const receipt = await f.store.compressJournal(f.runId, { beforeISO: AT(500), apply: true });
  assert.equal(receipt.applied, true);
  const after = await eventsOf(f.store, f.runId);
  assert.equal(JSON.stringify(after), JSON.stringify(before), "duplicate sequences preserved in order");
});

test("the retention CLI defaults to inspection and applies only the named terminal run", async (t) => {
  const f = await fixture(t);
  await f.append(3);
  const output = [];
  const io = { stdout: { write: (text) => output.push(text) }, stderr: { write: (text) => output.push(text) } };
  const inspectCode = await retentionMain(["--root", f.root, "--run", f.runId, "--json"], io);
  assert.equal(inspectCode, 0);
  const inspect = JSON.parse(output.pop());
  assert.equal(inspect.applied, false);
  assert.equal(inspect.selectedLines, 4);
  await assert.rejects(() => stat(f.store.archivePath(f.runId)), /ENOENT/);
  const applyCode = await retentionMain(["--root", f.root, "--run", f.runId, "--before", AT(500), "--apply", "--json"], io);
  assert.equal(applyCode, 0);
  const applied = JSON.parse(output.pop());
  assert.equal(applied.applied, true);
  assert.ok((await stat(f.store.archivePath(f.runId))).size > 0);
  // An active run is refused by the CLI with a non-zero exit and no archive.
  const g = await fixture(t, { state: "running" });
  await g.append(1);
  const refused = await retentionMain(["--root", g.root, "--run", g.runId, "--before", AT(500), "--apply"], io);
  assert.equal(refused, 1);
  await assert.rejects(() => stat(g.store.archivePath(g.runId)), /ENOENT/);
});

test("concurrent history readers wait for a consistent compression generation", async (t) => {
  const f = await fixture(t);
  await f.append(4);
  const before = await eventsOf(f.store, f.runId);
  let release;
  let entered;
  const blocked = new Promise((resolve) => { release = resolve; });
  const writing = new Promise((resolve) => { entered = resolve; });
  t.after(() => release());
  const compressing = f.store.compressJournal(f.runId, { beforeISO: AT(500), apply: true, hooks: { afterArchiveWrite: async () => { entered(); await blocked; } } });
  await writing;
  const reader = new DynamicStore(f.root);
  const reading = eventsOf(reader, f.runId);
  release();
  await compressing;
  assert.deepEqual(await reading, before);
});

test("archive expansion and merged history obey the processing bound before replacing source", async (t) => {
  const f = await fixture(t);
  await writeFile(f.store.archivePath(f.runId), gzipSync(Buffer.alloc(4096, 65)));
  const raw = await readFile(f.store.journalPath(f.runId));
  await assert.rejects(f.store.restoreJournal(f.runId, { maxJournalBytes: 1024 }), /archive is unreadable/);
  assert.deepEqual(await readFile(f.store.journalPath(f.runId)), raw);
  await assert.rejects(f.store.compressJournal(f.runId, { beforeISO: AT(5), maxJournalBytes: MAX_JOURNAL_BYTES + 1 }), /processing bound/);
  const g = await fixture(t);
  await g.append(8);
  await g.store.compressJournal(g.runId, { beforeISO: AT(4), apply: true });
  const tail = await readFile(g.store.journalPath(g.runId));
  const full = await eventsOf(g.store, g.runId);
  const bound = Buffer.byteLength(full.map((event) => JSON.stringify(event)).join("\n"));
  await assert.rejects(g.store.restoreJournal(g.runId, { maxJournalBytes: bound }), /merged journal exceeds/);
  assert.deepEqual(await readFile(g.store.journalPath(g.runId)), tail);
});
