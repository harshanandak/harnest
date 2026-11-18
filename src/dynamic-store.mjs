// Durable store for dynamic workflow runs.
//
// Layout beneath the store root:
//   runs/<runId>.json          compact run record (mutable snapshot)
//   runs/<runId>.specs.json    immutable spec revisions (append-only)
//   runs/<runId>.journal.jsonl append-only lifecycle/replay journal
//   requests/<sha256>.json     requestId -> runId dedup index
//
// Writes are temp-file + rename atomic; mutations serialize behind a run
// lock. This is deliberately an independent implementation rather than a copy
// of GraphStore's private transact: GraphStore couples its snapshot to a
// graph-shaped lease sidecar, and reusing it would require editing graph
// files. The lead can lift this behind a shared helper later.
import { mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { gunzip, gzip } from "node:zlib";
import { promisify } from "node:util";
import { dynamicError, RUN_TERMINAL } from "./dynamic-protocol.mjs";

export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Retention compression is bounded: a journal larger than this is refused with
// an explicit error rather than truncated or streamed unbounded.
export const MAX_JOURNAL_BYTES = 16 * 1024 * 1024;
const compress = promisify(gzip);
const decompress = promisify(gunzip);
const retentionLimit = (value) => {
  if (!Number.isInteger(value) || value < 1 || value > MAX_JOURNAL_BYTES) throw dynamicError("validation", `journal processing bound must be between 1 and ${MAX_JOURNAL_BYTES}`);
  return value;
};
const TRANSIENT = ["EPERM", "EACCES", "EBUSY"];
const lockTails = new Map();
const controlState = (record) => structuredClone(Object.fromEntries(
  ["runId", "revision", "state", "lease", "attempt", "pause", "cancellation", "deadlineAt", "controls"].map((key) => [key, record[key]]),
));

async function retry(work, attempts = 30) {
  for (let n = 0; ; n += 1) {
    try { return await work(); } catch (error) {
      if (!(process.platform === "win32" && TRANSIENT.includes(error?.code)) || n >= attempts) throw error;
      await wait(Math.min(10 * 2 ** n, 500));
    }
  }
}

const RUN_ID = /^dyn-[a-f0-9]{64}$/;

function safeParse(line) {
  try { return JSON.parse(line); } catch { return null; }
}

export class DynamicStore {
  constructor(root, { renameFile = rename } = {}) {
    if (typeof renameFile !== "function") throw dynamicError("validation", "dynamic store rename must be a function");
    this.root = root;
    this.rename = renameFile;
    this.transactions = new Map();
    this.journalHeads = new Map();
    this.controlStates = new Map();
  }

  runPath(runId) {
    if (typeof runId !== "string" || !RUN_ID.test(runId)) throw dynamicError("validation", "invalid runId");
    return join(this.root, `${runId}.json`);
  }

  specPath(runId) {
    this.runPath(runId);
    return join(this.root, `${runId}.specs.json`);
  }

  journalPath(runId) {
    this.runPath(runId);
    return join(this.root, `${runId}.journal.jsonl`);
  }

  archivePath(runId) {
    this.journalPath(runId);
    return `${this.journalPath(runId)}.gz`;
  }

  indexPath(requestId) {
    if (typeof requestId !== "string" || !requestId.trim()) throw dynamicError("validation", "invalid requestId");
    return join(this.root, "requests", `${createHash("sha256").update(requestId).digest("hex")}.json`);
  }

  async #atomicWrite(path, value) {
    const payload = typeof value === "string" ? value : Buffer.isBuffer(value) || value instanceof Uint8Array ? value : `${JSON.stringify(value)}\n`;
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await retry(() => writeFile(temp, payload, { mode: 0o600 }));
    try { await retry(() => this.rename(temp, path)); } finally { await unlink(temp).catch(() => undefined); }
  }

  #withLock(lockPath, work) {
    const absolute = resolve(lockPath);
    const key = process.platform === "win32" ? absolute.toLowerCase() : absolute;
    const previous = lockTails.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(() => this.#withFileLock(lockPath, work));
    lockTails.set(key, operation);
    const cleanup = () => { if (lockTails.get(key) === operation) lockTails.delete(key); };
    operation.then(cleanup, cleanup);
    return operation;
  }

  async #withFileLock(lockPath, work) {
    await mkdir(dirname(lockPath), { recursive: true });
    let handle;
    for (let attempt = 0; attempt < 2000; attempt += 1) {
      try { handle = await open(lockPath, "wx", 0o600); break; } catch (error) {
        const exists = error?.code === "EEXIST";
        const transient = process.platform === "win32" && TRANSIENT.includes(error?.code);
        if (!exists && !transient) throw error;
        if (exists) {
          const info = await stat(lockPath).catch(() => null);
          if (info && Date.now() - info.mtimeMs > 120_000) { await unlink(lockPath).catch(() => undefined); continue; }
        }
        await wait(10);
      }
    }
    if (!handle) throw dynamicError("persistence", `timed out acquiring dynamic store lock: ${lockPath}`);
    try { return await work(); } finally {
      await handle.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
    }
  }

  async #readMaybe(path) {
    try { return JSON.parse(await retry(() => readFile(path, "utf8"))); } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async readRun(runId) {
    return this.#readMaybe(this.runPath(runId));
  }

  async #fileSignature(path) {
    const info = await stat(path, { bigint: true }).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    return info ? `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}` : "missing";
  }

  #rememberControlState(runId, entry) {
    this.controlStates.delete(runId);
    if (this.controlStates.size >= 128) this.controlStates.delete(this.controlStates.keys().next().value);
    this.controlStates.set(runId, entry);
  }

  async readControlState(runId) {
    const path = this.runPath(runId);
    const signature = await this.#fileSignature(path);
    const cached = this.controlStates.get(runId);
    if (cached?.signature === signature) return structuredClone(cached.state);
    const record = await this.readRun(runId);
    if (!record) return null;
    const state = controlState(record);
    if (signature === await this.#fileSignature(path)) this.#rememberControlState(runId, { signature, state });
    return structuredClone(state);
  }

  async readSpecs(runId) {
    return this.#readMaybe(this.specPath(runId));
  }

  async appendSpecRevision(runId, revision) {
    const path = this.specPath(runId);
    return this.#withLock(`${path}.lock`, async () => {
      const specs = (await this.#readMaybe(path)) ?? { runId, revisions: [] };
      const prior = specs.revisions.find((item) => item.revision === revision.revision);
      if (prior) {
        if (prior.scriptDigest !== revision.scriptDigest) throw dynamicError("persistence", "spec revision already exists with different content");
        return specs;
      }
      specs.revisions.push(revision);
      await this.#atomicWrite(path, specs);
      return specs;
    });
  }

  // Primary mutation primitive. `work(record)` returns null for a no-op or
  // `{record, journal}` where journal is an array of event objects. Journal
  // append and snapshot write happen under the same run lock, so a crash
  // can leave diagnostic events ahead of their snapshot. Callers cannot
  // dispatch until publication succeeds; later writes advance past that tail.
  transact(runId, work) {
    try { this.runPath(runId); } catch (error) { return Promise.reject(error); }
    let queue = this.transactions.get(runId);
    if (!queue) {
      queue = [];
      this.transactions.set(runId, queue);
      setImmediate(() => { void this.#flushTransactions(runId, queue); });
    }
    return new Promise((resolve, reject) => queue.push({ work, resolve, reject }));
  }

  async #flushTransactions(runId, queue) {
    while (queue.length) {
      const entries = queue.splice(0, 32);
      try {
        const results = await this.#commitTransactions(runId, entries);
        for (let index = 0; index < entries.length; index++) {
          const result = results[index];
          if (Object.hasOwn(result, "error")) entries[index].reject(result.error);
          else entries[index].resolve(result.value);
        }
      } catch (error) { for (const entry of entries) entry.reject(error); }
    }
    this.transactions.delete(runId);
  }

  async #commitTransactions(runId, entries) {
    const path = this.runPath(runId);
    return this.#withLock(`${path}.lock`, () => this.#withLock(`${this.journalPath(runId)}.lock`, async () => {
      let current = await this.#readMaybe(path);
      const startSequence = Math.max(current?.journalSequence ?? 0, await this.#journalTail(runId));
      let sequence = startSequence;
      const events = [];
      const results = [];
      let changed = false;
      for (const entry of entries) {
        try {
          // A rejected callback cannot mutate the next callback's input.
          const priorRevision = current?.revision;
          const outcome = await entry.work(changed ? structuredClone(current) : current);
          if (!outcome) {
            if (!changed) current = await this.#readMaybe(path);
            results.push({ value: null });
            continue;
          }
          const next = outcome.record;
          if (!next || typeof next !== "object") throw dynamicError("persistence", "dynamic store mutation must return a record");
          next.revision = (Number.isSafeInteger(priorRevision) ? priorRevision : 0) + 1;
          const journal = (Array.isArray(outcome.journal) ? outcome.journal : []).map((event, index) => ({ ...event, sequence: sequence + index + 1 }));
          sequence += journal.length;
          next.journalSequence = sequence;
          events.push(...journal);
          current = next;
          changed = true;
          results.push({ value: { record: next, journal } });
        } catch (error) {
          if (!changed) current = await this.#readMaybe(path);
          results.push({ error });
        }
      }
      // All callers remain pending until the journal and snapshot are durable.
      if (events.length) await this.#appendJournalUnlocked(runId, events, startSequence);
      if (changed) {
        const state = controlState(current);
        await this.#atomicWrite(path, current);
        this.#rememberControlState(runId, { signature: await this.#fileSignature(path), state });
      }
      return results;
    }));
  }

  async #appendJournalUnlocked(runId, events, startSequence) {
    const path = this.journalPath(runId);
    const lines = [];
    let sequence = startSequence;
    const records = events.map((event) => {
      const record = { ...event, sequence: ++sequence };
      lines.push(`${JSON.stringify(record)}\n`);
      return record;
    });
    const separator = this.journalHeads.get(runId)?.rawTerminated === false ? "\n" : "";
    await retry(() => writeFile(path, separator + lines.join(""), { encoding: "utf8", mode: 0o600, flag: "a" }));
    this.#rememberJournalHead(runId, { signature: await this.#journalSignature(runId), sequence, rawTerminated: true });
    return records;
  }

  async appendJournal(runId, events, startSequence) {
    const path = this.journalPath(runId);
    return this.#withLock(`${path}.lock`, async () => {
      // A supplied sequence may advance the journal but cannot reuse numbers
      // from a batch whose snapshot publication failed.
      const start = Math.max(Number.isSafeInteger(startSequence) ? startSequence : 0, await this.#journalTail(runId));
      return this.#appendJournalUnlocked(runId, events, start);
    });
  }

  async #readBounded(path, limit) {
    const file = await open(path, "r").catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    if (!file) return null;
    try {
      if ((await file.stat()).size > limit) throw dynamicError("limit", `journal exceeds the ${limit}-byte processing bound; refused without truncation`);
      const chunks = [];
      let size = 0;
      for (;;) {
        const buffer = Buffer.alloc(Math.min(65536, limit + 1 - size));
        const { bytesRead } = await file.read(buffer, 0, buffer.length);
        size += bytesRead;
        if (size > limit) throw dynamicError("limit", `journal exceeds the ${limit}-byte processing bound; refused without truncation`);
        if (!bytesRead) return Buffer.concat(chunks, size);
        chunks.push(buffer.subarray(0, bytesRead));
      }
    } finally { await file.close(); }
  }

  async #readArchiveText(runId, maxJournalBytes) {
    const compressed = await this.#readBounded(this.archivePath(runId), maxJournalBytes + 65536);
    if (!compressed) return null;
    let text;
    try { text = (await decompress(compressed, { maxOutputLength: maxJournalBytes })).toString("utf8"); } catch (error) {
      throw dynamicError("persistence", `journal archive is unreadable: ${error?.message ?? error}`);
    }
    if (Number.isFinite(maxJournalBytes) && Buffer.byteLength(text, "utf8") > maxJournalBytes) {
      throw dynamicError("persistence", `journal archive exceeds the ${maxJournalBytes}-byte processing bound`);
    }
    return text;
  }

  // Canonical merged view: archived prefix plus the live raw tail, deduplicated
  // by sequence. Only byte-identical overlap is accepted; any same-sequence
  // divergence fails closed so nothing is silently lost or reordered.
  async #journalLines(runId, { maxJournalBytes = MAX_JOURNAL_BYTES } = {}) {
    retentionLimit(maxJournalBytes);
    const archivedText = await this.#readArchiveText(runId, maxJournalBytes);
    const rawText = (await this.#readBounded(this.journalPath(runId), maxJournalBytes))?.toString("utf8") ?? "";
    const archivedLines = (archivedText ?? "").split(/\r?\n/).filter((line) => line.trim());
    const rawLines = rawText.split(/\r?\n/).filter((line) => line.trim());
    const seen = new Map();
    const lines = [];
    let maxArchivedSequence = 0;
    for (const line of archivedLines) {
      const event = safeParse(line);
      if (event && Number.isSafeInteger(event.sequence)) {
        const pool = seen.get(event.sequence);
        if (pool) pool.push(line); else seen.set(event.sequence, [line]);
        maxArchivedSequence = Math.max(maxArchivedSequence, event.sequence);
      }
      lines.push(line);
    }
    for (const line of rawLines) {
      const event = safeParse(line);
      if (!event || !Number.isSafeInteger(event.sequence) || event.sequence > maxArchivedSequence) { lines.push(line); continue; }
      // Byte-identical overlap (a crashed compression) is dropped exactly
      // once; anything else for the same sequence fails closed. The baseline
      // store can legitimately contain duplicate sequence numbers (the
      // `created` event and the first transaction both start at 0), so the
      // archived copies are matched as a multiset.
      const pool = seen.get(event.sequence);
      const index = pool ? pool.indexOf(line) : -1;
      if (index === -1) {
        throw dynamicError("persistence", `journal overlap diverges at sequence ${event.sequence}; refusing to merge`);
      }
      pool.splice(index, 1);
    }
    if (lines.reduce((bytes, line) => bytes + Buffer.byteLength(line) + 1, 0) > maxJournalBytes) throw dynamicError("limit", `merged journal exceeds the ${maxJournalBytes}-byte processing bound`);
    return { lines, archivedLines, rawLines, maxArchivedSequence, rawTerminated: !rawText || rawText.endsWith("\n") };
  }

  // Terminal-history journal compression. Only the append-only journal is
  // touched: snapshot, spec revisions, request index and child receipts are
  // never rewritten, and native leases are left alone.
  async compressJournal(runId, { beforeISO, apply = false, maxJournalBytes = MAX_JOURNAL_BYTES, hooks = {} } = {}) {
    retentionLimit(maxJournalBytes);
    const before = Date.parse(beforeISO);
    if (!Number.isFinite(before)) throw dynamicError("validation", "beforeISO must be a valid ISO timestamp");
    const path = this.runPath(runId);
    return this.#withLock(`${path}.lock`, () => this.#withLock(`${this.journalPath(runId)}.lock`, async () => {
      const record = await this.readRun(runId);
      if (!record) throw dynamicError("not-found", "dynamic run not found");
      if (!RUN_TERMINAL.has(record.state) || record.lease) {
        throw dynamicError("retention-active", `run ${runId} is ${record.state}${record.lease ? " with a live lease" : ""}; retention refuses active runs`);
      }
      const merged = await this.#journalLines(runId, { maxJournalBytes });
      const selected = [];
      const tail = [];
      const maxArchived = merged.maxArchivedSequence;
      // Partition the canonical merged history: archived lines and timestamp-
      // eligible new lines stay in the compressed prefix; the first line that
      // cannot join the prefix ends selection so compression never skips
      // interior history. The archive content is exactly `selected`.
      for (const line of merged.lines) {
        const event = safeParse(line);
        const at = Date.parse(event?.at ?? "");
        const archived = event && Number.isSafeInteger(event.sequence) && event.sequence <= maxArchived;
        if (!tail.length && (archived || (event && Number.isSafeInteger(event.sequence) && Number.isFinite(at) && at <= before))) selected.push(line);
        else tail.push(line);
      }
      const allLines = selected;
      const content = allLines.length ? `${allLines.join("\n")}\n` : "";
      const digest = createHash("sha256").update(content, "utf8").digest("hex");
      const archivedSequence = safeParse(allLines.at(-1) ?? "")?.sequence ?? maxArchived;
      const receipt = {
        applied: apply === true, runId, beforeISO, archivedSequence,
        archivedLines: allLines.length, selectedLines: selected.length, tailLines: tail.length,
        archiveBytes: 0, digest, archivePath: this.archivePath(runId), rawPath: this.journalPath(runId),
      };
      if (apply !== true || !selected.length) return receipt;
      const gz = await compress(Buffer.from(content, "utf8"));
      await this.#atomicWrite(this.archivePath(runId), gz);
      await hooks.afterArchiveWrite?.(receipt);
      const readback = await this.#readArchiveText(runId, maxJournalBytes);
      if (createHash("sha256").update(readback, "utf8").digest("hex") !== digest) {
        throw dynamicError("persistence", "journal archive readback digest mismatch; source left untouched");
      }
      receipt.archiveBytes = gz.length;
      await hooks.beforeRawRewrite?.(receipt);
      if (tail.length) await this.#atomicWrite(this.journalPath(runId), `${tail.join("\n")}\n`);
      else await unlink(this.journalPath(runId)).catch((error) => { if (error.code !== "ENOENT") throw error; });
      return receipt;
    }));
  }

  // Reverse path: merge the archived prefix back into the live raw journal and
  // remove the archive. Refuses active runs like compression does.
  async restoreJournal(runId, { maxJournalBytes = MAX_JOURNAL_BYTES, hooks = {} } = {}) {
    retentionLimit(maxJournalBytes);
    const path = this.runPath(runId);
    return this.#withLock(`${path}.lock`, () => this.#withLock(`${this.journalPath(runId)}.lock`, async () => {
      const record = await this.readRun(runId);
      if (!record) throw dynamicError("not-found", "dynamic run not found");
      if (!RUN_TERMINAL.has(record.state) || record.lease) {
        throw dynamicError("retention-active", `run ${runId} is ${record.state}; restore refuses active runs`);
      }
      const archivedText = await this.#readArchiveText(runId, maxJournalBytes);
      if (archivedText === null) return { restored: false, runId, reason: "no-archive", rawPath: this.journalPath(runId) };
      const merged = await this.#journalLines(runId, { maxJournalBytes });
      const content = merged.lines.length ? `${merged.lines.join("\n")}\n` : "";
      await this.#atomicWrite(this.journalPath(runId), content);
      const receipt = { restored: true, runId, lines: merged.lines.length, archivePath: this.archivePath(runId), rawPath: this.journalPath(runId) };
      await hooks.beforeArchiveUnlink?.(receipt);
      await unlink(this.archivePath(runId));
      return receipt;
    }));
  }

  async journalTail(runId) {
    return this.#withLock(`${this.journalPath(runId)}.lock`, () => this.#journalTail(runId));
  }

  async #journalTail(runId) {
    const signature = await this.#journalSignature(runId);
    const known = this.journalHeads.get(runId);
    if (known?.signature === signature) return known.sequence;
    const { lines, rawTerminated } = await this.#journalLines(runId);
    let sequence = 0;
    for (const line of lines) {
      const event = safeParse(line);
      if (event) sequence = Math.max(sequence, Number(event.sequence) || 0);
    }
    this.#rememberJournalHead(runId, { signature, sequence, rawTerminated });
    return sequence;
  }

  async #journalSignature(runId) {
    const paths = [this.journalPath(runId), this.archivePath(runId)];
    return (await Promise.all(paths.map((path) => this.#fileSignature(path)))).join("|");
  }

  #rememberJournalHead(runId, head) {
    this.journalHeads.delete(runId);
    if (this.journalHeads.size >= 128) this.journalHeads.delete(this.journalHeads.keys().next().value);
    this.journalHeads.set(runId, head);
  }

  async readJournal(runId, { afterSequence = null, limit = 100 } = {}) {
    if (afterSequence !== null && (!Number.isInteger(afterSequence) || afterSequence < 0)) throw dynamicError("validation", "afterSequence must be a nonnegative integer");
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw dynamicError("validation", "journal limit must be between 1 and 500");
    return this.#withLock(`${this.journalPath(runId)}.lock`, async () => {
      const { lines } = await this.#journalLines(runId);
      const events = [];
      for (const line of lines) {
        const record = safeParse(line);
        if (!record) continue;
        if (afterSequence !== null && Number(record.sequence) <= afterSequence) continue;
        events.push(record);
      }
      const selected = events.slice(0, limit);
      return { events: selected, nextSequence: Number(selected.at(-1)?.sequence) || afterSequence || 0, hasMore: events.length > limit };
    });
  }

  async #scanForRequest(requestId) {
    const ids = await this.listRunIds();
    for (const runId of ids) {
      const record = await this.readRun(runId);
      if (record?.requestId === requestId) return record;
    }
    return null;
  }

  // Idempotent run creation. The request index lock serializes concurrent
  // starts; a crash between the run write and the index write is repaired by
  // scanning run records under the same lock.
  async createRun({ runId, requestId, record, specRevision }) {
    const index = this.indexPath(requestId);
    return this.#withLock(`${index}.lock`, async () => {
      const indexed = await this.#readMaybe(index);
      if (indexed?.runId) {
        const existing = await this.readRun(indexed.runId);
        if (existing) return { created: false, runId: indexed.runId, record: existing };
      }
      const scanned = await this.#scanForRequest(requestId);
      if (scanned) {
        await this.#atomicWrite(index, { requestId, runId: scanned.runId });
        return { created: false, runId: scanned.runId, record: scanned };
      }
      await this.#atomicWrite(this.specPath(runId), { runId, revisions: [specRevision] });
      const journal = await this.appendJournal(runId, [{ type: "created", at: record.createdAt, requestId }], 0);
      const created = { ...record, journalSequence: journal.at(-1).sequence };
      await this.#atomicWrite(this.runPath(runId), created);
      await this.#atomicWrite(index, { requestId, runId });
      return { created: true, runId, record: created };
    });
  }

  async locateRequest(requestId) {
    const indexed = await this.#readMaybe(this.indexPath(requestId));
    if (indexed?.runId) return indexed.runId;
    const scanned = await this.#scanForRequest(requestId);
    return scanned?.runId ?? null;
  }

  async listRunIds() {
    const entries = await readdir(this.root, { withFileTypes: true }).catch((error) => { if (error?.code === "ENOENT") return []; throw error; });
    return entries
      .filter((entry) => entry.isFile() && RUN_ID.test(entry.name.replace(/\.json$/, "")) && entry.name.endsWith(".json"))
      .map((entry) => entry.name.slice(0, -5))
      .sort();
  }
}
