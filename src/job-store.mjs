import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { jobStateDirectory } from "./daemon-settings.mjs";
import { redactSecrets } from "./process.mjs";
import { TERMINAL_STATES } from "./protocol.mjs";

const TRACE_CHUNK_BYTES = 64 * 1024;
const ADAPTER_LINE_BYTES = 2 * 1024 * 1024;
// CLI and native JSONL transports default to 2 MiB input lines. OpenCode has the
// largest trace projection: the raw event (up to 6x for JSON number expansion),
// session and workflow IDs retained from two earlier lines (up to 3x each for
// UTF-8 replacement), and MAX_PROTOCOL_TEXT_CHARS (1,048,576) of cumulative text
// at up to 6 bytes per UTF-16 code unit (\uXXXX). Leave 64 KiB for the envelope,
// including OpenCode's 2,000-character activity and 256-character event type.
export const TRACE_RECORD_BYTES = ADAPTER_LINE_BYTES * (6 + 2 * 3) + 1_048_576 * 6 + TRACE_CHUNK_BYTES;
const TRACE_CACHE_ENTRIES = 512;
const TRACE_CACHE_BYTES = 8 * 1024 * 1024;
const TRACE_CHECKPOINT_VERSION = 4;

function parseTraceRecord(bytes, end) {
  const text = bytes.toString("utf8");
  if (!text.trim()) return null;
  try {
    const record = JSON.parse(text);
    if (record && typeof record === "object" && !Array.isArray(record)) return { record, end };
  } catch { /* Report malformed JSON without including raw event data in the diagnostic. */ }
  return { malformed: true, end };
}

async function* traceRecords(handle, start, size, skipFirst = false, metrics) {
  const chunk = Buffer.allocUnsafe(Math.min(TRACE_CHUNK_BYTES, size - start));
  let recordBuffer = Buffer.alloc(0);
  let pending = 0;
  if (metrics) Object.assign(metrics, { readBufferBytes: chunk.length, peakRecordBufferBytes: 0 });
  for (let position = start; position < size;) {
    const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, size - position), position);
    if (!bytesRead) break;
    const bytes = chunk.subarray(0, bytesRead);
    for (let offset = 0; offset < bytes.length;) {
      const newline = bytes.indexOf(10, offset);
      const stop = newline < 0 ? bytes.length : newline;
      const part = bytes.subarray(offset, stop);
      if (!skipFirst) {
        if (pending + part.length > TRACE_RECORD_BYTES) {
          yield { oversized: true };
          return;
        }
        if (pending || newline < 0) {
          const needed = pending + part.length;
          if (needed > recordBuffer.length) {
            const capacity = Math.max(needed, TRACE_CHUNK_BYTES, 2 * recordBuffer.length);
            const grown = Buffer.allocUnsafe(Math.min(TRACE_RECORD_BYTES, capacity));
            recordBuffer.copy(grown, 0, 0, pending);
            recordBuffer = grown;
            if (metrics) metrics.peakRecordBufferBytes = grown.length;
          }
          part.copy(recordBuffer, pending);
          pending = needed;
        }
        if (newline >= 0) {
          const parsed = parseTraceRecord(pending ? recordBuffer.subarray(0, pending) : part, position + newline + 1);
          if (parsed) yield parsed;
          pending = 0;
        }
      }
      if (newline >= 0) skipFirst = false;
      offset = stop + 1;
    }
    position += bytesRead;
  }
  if (pending) {
    const parsed = parseTraceRecord(recordBuffer.subarray(0, pending), size);
    if (parsed) yield parsed;
  }
}

function traceSizeError(lastSafeSequence, malformedRecords = 0) {
  return Object.assign(new Error(`trace record exceeds ${TRACE_RECORD_BYTES} bytes (last safe sequence ${lastSafeSequence})`), {
    details: { kind: "persistence", lastSafeSequence, malformedRecords },
  });
}

// File handles and byte offsets are local to one read. Replacements, truncation,
// and appends by another process cannot leave a cached page pointing elsewhere.
export async function readTracePage(path, { afterSequence = null, limit = 50, openFile = open } = {}) {
  const handle = await openFile(path, "r").catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!handle) return { events: [], nextSequence: afterSequence || 0, hasMore: false };
  try {
    const { size } = await handle.stat();
    let selected = [];
    if (afterSequence === null) {
      for (let window = TRACE_CHUNK_BYTES; ; window *= 2) {
        const start = Math.max(0, size - window);
        selected = [];
        for await (const { record, oversized } of traceRecords(handle, start, size, start > 0)) {
          if (oversized) throw traceSizeError(Number(selected.at(-1)?.sequence) || 0);
          if (!record) continue;
          selected.push(record);
          if (selected.length > limit + 1) selected.shift();
        }
        if (selected.length > limit || start === 0) break;
      }
      const hasMore = selected.length > limit;
      selected = selected.slice(-limit);
      return { events: selected, nextSequence: Number(selected.at(-1)?.sequence) || 0, hasMore };
    }

    // The journal assigns monotonic sequences under its trace lock. Seek by
    // sequence, then stream the earliest page after the cursor, not the tail.
    let lower = 0;
    let upper = size;
    while (upper - lower > TRACE_CHUNK_BYTES) {
      const midpoint = Math.floor((lower + upper) / 2);
      let pivot = null;
      for await (const candidate of traceRecords(handle, midpoint, size, true)) {
        if (candidate.oversized) throw traceSizeError(afterSequence);
        if (Number.isFinite(Number(candidate.record?.sequence))) { pivot = candidate; break; }
      }
      if (pivot && Number(pivot.record.sequence) <= afterSequence) lower = pivot.end;
      else upper = midpoint;
    }
    for await (const { record, oversized } of traceRecords(handle, lower, size)) {
      if (oversized) throw traceSizeError(Number(selected.at(-1)?.sequence) || afterSequence);
      if (Number(record?.sequence) <= afterSequence || !Number.isFinite(Number(record?.sequence))) continue;
      selected.push(record);
      if (selected.length > limit) break;
    }
    const hasMore = selected.length > limit;
    selected = selected.slice(0, limit);
    return { events: selected, nextSequence: Number(selected.at(-1)?.sequence) || afterSequence || 0, hasMore };
  } finally {
    await handle.close();
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isTransientWindows(error) {
  return process.platform === "win32" && ["EPERM", "EACCES", "EBUSY"].includes(error?.code);
}

async function retryWindowsTransient(work, attempts = 10) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      if (!isTransientWindows(error) || attempt >= attempts) throw error;
      await wait(Math.min(10 * (2 ** attempt), 250));
    }
  }
}

function compactProgressText(value) {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return redactSecrets(String(value))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function sanitizeTraceValue(value, depth = 0) {
  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    return redactSecrets(value).slice(0, 4_000);
  }
  if (depth >= 6) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeTraceValue(item, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, 50).map(([key, item]) => [key,
      /^(?:authorization|proxy-authorization|api[-_]?key|token|secret|password)$/i.test(key)
        ? "[REDACTED]" : sanitizeTraceValue(item, depth + 1)]));
  }
  return String(value).slice(0, 4_000);
}

function progressFromRecord(previous, record) {
  const data = record?.event?.data ?? record?.event ?? {};
  if (["heartbeat", "usage"].includes(data.type)
    || (["codex_delta", "gemini_delta", "amp_delta", "acp_update"].includes(data.type) && !compactProgressText(data.text))) return previous ?? null;
  const raw = data?.event && typeof data.event === "object" ? data.event : {};
  const part = raw?.part && typeof raw.part === "object" ? raw.part : {};
  const phase = [data.phase, data.state, part?.state?.title, part.tool, data.type, record?.event?.type]
    .map(compactProgressText).find(Boolean) || previous?.phase || "progress";
  const current = [
    data.tool,
    part?.state?.title,
    part.tool,
    part.text,
    raw.text,
    data.line,
    data.text,
    data.message,
    data.phase,
    data.state,
    data.type,
    record?.activity,
  ].map(compactProgressText).find(Boolean);
  if (!current || ["heartbeat", "usage"].includes(current.toLowerCase())) return previous ?? null;
  const recent = [...(previous?.recent || [])];
  if (recent.at(-1) !== current) recent.push(current);
  const at = typeof record?.at === "string" ? record.at : null;
  let activeTool = previous?.activeTool ?? null;
  if (data.type === "codex_tool" && compactProgressText(data.tool)) {
    if (data.phase === "started") activeTool = {
      name: compactProgressText(data.tool), callId: compactProgressText(data.callId) || null,
      startedAt: activeTool?.callId && activeTool.callId === data.callId ? activeTool.startedAt : at,
    };
    else if (data.phase === "completed" && (!data.callId || data.callId === activeTool?.callId)) activeTool = null;
  }
  return {
    phase,
    current,
    recent: recent.slice(-5),
    ...(Array.isArray(data.tasklist) ? { tasklist: data.tasklist.slice(0, 20).filter((item) => item && typeof item === "object").map((item) => ({
      title: compactProgressText(item.content ?? item.title ?? item.text).slice(0, 200),
      status: compactProgressText(item.status ?? item.state).slice(0, 40),
    })), tasklistTotal: data.tasklist.length } : previous?.tasklist ? { tasklist: previous.tasklist, tasklistTotal: previous.tasklistTotal } : {}),
    lastMeaningfulAt: at || new Date().toISOString(),
    activeTool,
  };
}

function traceStamp(info) {
  return info ? [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs, info.birthtimeNs].join(":") : null;
}

function traceCheckpoint(state) {
  // Bump the version when the summary projection/redaction rules change.
  return { version: TRACE_CHECKPOINT_VERSION, stamp: state.stamp, summary: structuredClone(state.summary) };
}

function traceSummaryOf(last, eventCount, progress, recovery) {
  return {
    eventCount,
    lastEventAt: typeof last?.at === "string" ? last.at || null : null,
    lastActivity: compactProgressText(last?.activity || last?.event?.type) || null,
    progress,
    ...(recovery ? { recovery } : {}),
  };
}

export async function foldTrace(handle, size, metrics) {
  let sequence = 0;
  let lineCount = 0;
  let malformedRecords = 0;
  let lastSafeSequence = 0;
  let last = null;
  let progress = null;
  for await (const { record, oversized } of traceRecords(handle, 0, size, false, metrics)) {
    if (oversized) throw traceSizeError(sequence, malformedRecords);
    lineCount++;
    if (!record) {
      malformedRecords++;
      lastSafeSequence = sequence;
      continue;
    }
    const value = Number(record.sequence);
    if (Number.isSafeInteger(value)) sequence = Math.max(sequence, value);
    progress = progressFromRecord(progress, record);
    last = record;
  }
  const recovery = malformedRecords ? { malformedRecords, lastSafeSequence } : null;
  return { sequence, summary: traceSummaryOf(last, sequence || lineCount, progress, recovery) };
}

async function traceStat(path) {
  return stat(path, { bigint: true }).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

function changedTrace(sequence) {
  return Object.assign(new Error(`trace changed during journal I/O (last safe sequence ${sequence})`), {
    details: { kind: "persistence", lastSafeSequence: sequence },
  });
}

async function recoverTrace(path, handle, info) {
  const stamp = traceStamp(info);
  const size = Number(info.size);
  const state = await foldTrace(handle, size);
  const lastByte = Buffer.alloc(1);
  if (size) await handle.read(lastByte, 0, 1, size - 1);
  if (traceStamp(await handle.stat({ bigint: true })) !== stamp || traceStamp(await traceStat(path)) !== stamp) {
    throw changedTrace(state.sequence);
  }
  return Object.freeze({ ...state, stamp, newline: !size || lastByte[0] === 10 });
}

export class JobStore {
  #traceState = new Map();
  #traceCacheBytes = 0;

  constructor(root = jobStateDirectory()) {
    this.root = root;
    this.requestIdentities = new Map();
  }

  traceCacheUsage() {
    return { entries: this.#traceState.size, accountedBytes: this.#traceCacheBytes };
  }

  #forgetTrace(jobId) {
    const entry = this.#traceState.get(jobId);
    if (!entry) return;
    this.#traceState.delete(jobId);
    this.#traceCacheBytes -= entry.bytes;
  }

  #cachedTrace(jobId, stamp) {
    const entry = this.#traceState.get(jobId);
    if (!entry) return null;
    if (entry.state.stamp !== stamp) {
      this.#forgetTrace(jobId);
      return null;
    }
    this.#traceState.delete(jobId);
    this.#traceState.set(jobId, entry);
    return entry.state;
  }

  #rememberTrace(jobId, state) {
    this.#forgetTrace(jobId);
    const serialized = JSON.stringify(state);
    const bytes = Buffer.byteLength(jobId) + Buffer.byteLength(serialized);
    if (bytes > TRACE_CACHE_BYTES) return;
    while (this.#traceState.size >= TRACE_CACHE_ENTRIES || this.#traceCacheBytes + bytes > TRACE_CACHE_BYTES) {
      this.#forgetTrace(this.#traceState.keys().next().value);
    }
    // A projected substring can still reference the original event's backing string.
    this.#traceState.set(jobId, { state: Object.freeze(JSON.parse(serialized)), bytes });
    this.#traceCacheBytes += bytes;
  }

  path(jobId) {
    if (!/^[a-zA-Z0-9-]+$/.test(jobId)) {
      throw Object.assign(new TypeError("invalid job id"), { details: { kind: "not-found", hint: "verify the jobId from the queued receipt or handoff_sessions" } });
    }
    return join(this.root, `${jobId}.json`);
  }

  tracePath(jobId) {
    this.path(jobId);
    return join(this.root, `${jobId}.events.jsonl`);
  }

  requestPath(requestId) {
    if (typeof requestId !== "string" || !requestId.trim()) {
      throw Object.assign(new TypeError("invalid request id"), { details: { kind: "not-found", hint: "verify the caller-owned requestId" } });
    }
    const digest = createHash("sha256").update(requestId).digest("hex");
    return join(this.root, "requests", `${digest}.json`);
  }

  async #atomicWrite(path, value) {
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await retryWindowsTransient(() => writeFile(temp, value, { encoding: "utf8", mode: 0o600 }));
    try {
      await retryWindowsTransient(() => rename(temp, path));
    } finally {
      await unlink(temp).catch(() => undefined);
    }
  }

  async #withLock(lockPath, work) {
    await mkdir(dirname(lockPath), { recursive: true });
    let handle;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        handle = await open(lockPath, "wx", 0o600);
        break;
      } catch (error) {
        const exists = error?.code === "EEXIST";
        const transient = process.platform === "win32" && ["EPERM", "EACCES", "EBUSY"].includes(error?.code);
        if (!exists && !transient) throw error;
        if (exists) {
          const info = await stat(lockPath).catch(() => null);
          if (info && Date.now() - info.mtimeMs > 120_000) {
            await unlink(lockPath).catch(() => undefined);
            continue;
          }
        }
        await wait(10);
      }
    }
    if (!handle) {
      throw Object.assign(new Error(`timed out acquiring state lock: ${lockPath}`), {
        details: { kind: "persistence", hint: "another process holds the job lock; retry the read" },
      });
    }
    try {
      return await work();
    } finally {
      await handle.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
    }
  }

  async #readMaybe(path) {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async #indexRequest(job) {
    const requestId = job.request?.requestId;
    if (!requestId) return;
    const path = this.requestPath(requestId);
    await this.#withLock(`${path}.lock`, async () => {
      const existing = await this.#readMaybe(path);
      const jobIds = [...new Set([...(existing?.jobIds || []), existing?.jobId, job.receipt.jobId].filter(Boolean))];
      const latestJobId = jobIds.at(-1);
      await this.#atomicWrite(path, `${JSON.stringify({
        requestId,
        jobId: latestJobId,
        latestJobId,
        jobIds,
      }, null, 2)}\n`);
    });
  }

  async #recoverRequestIndex(requestId) {
    const jobs = await this.#recoverRequestJobs(requestId);
    for (const job of jobs) await this.#indexRequest(job);
    return jobs;
  }

  async putIfRequestAbsent(job) {
    const requestId = job.request?.requestId;
    if (!requestId) throw new TypeError("job requestId is required");
    const requestPath = this.requestPath(requestId);
    return this.#withLock(`${requestPath}.lock`, async () => {
      let index = await this.#readMaybe(requestPath);
      if (!index) {
        const jobs = await this.#recoverRequestJobs(requestId);
        if (jobs.length) {
          const latest = jobs.at(-1);
          const jobIds = jobs.map((entry) => entry.receipt.jobId);
          index = { requestId, jobId: latest.receipt.jobId, latestJobId: latest.receipt.jobId, jobIds };
          await this.#atomicWrite(requestPath, `${JSON.stringify(index, null, 2)}\n`);
          return { created: false, job: latest };
        }
      }
      if (index) {
        const jobId = index.latestJobId || index.jobId;
        if (index.requestId !== requestId || typeof jobId !== "string") {
          throw new Error(`request index is invalid: ${requestId}`);
        }
        return { created: false, job: await this.get(jobId) };
      }

      const jobPath = this.path(job.receipt.jobId);
      await this.#withLock(`${jobPath}.lock`, async () => {
        if (await this.#readMaybe(jobPath)) throw new Error(`job already exists: ${job.receipt.jobId}`);
        await this.#atomicWrite(jobPath, `${JSON.stringify(job, null, 2)}\n`);
      });
      await this.#atomicWrite(requestPath, `${JSON.stringify({
        requestId,
        jobId: job.receipt.jobId,
        latestJobId: job.receipt.jobId,
        jobIds: [job.receipt.jobId],
      }, null, 2)}\n`);
      this.#rememberRequestIdentity(`${job.receipt.jobId}.json`, requestId);
      return { created: true, job };
    });
  }

  async #recoverRequestJobs(requestId) {
    const entries = await readdir(this.root, { withFileTypes: true }).catch((error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
    const jobs = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      // Job request identities are immutable. Re-read matches and discover new
      // filenames, but do not reopen every unrelated job for each new request.
      const known = this.requestIdentities.get(entry.name);
      if (known !== undefined && known !== requestId) continue;
      const path = join(this.root, entry.name);
      const job = await this.#withLock(`${path}.lock`, () => this.#readMaybe(path));
      if (typeof job?.request?.requestId === "string") this.#rememberRequestIdentity(entry.name, job.request.requestId);
      if (job?.request?.requestId === requestId && job?.receipt?.jobId) jobs.push(job);
    }
    jobs.sort((left, right) => String(left.receipt.createdAt).localeCompare(String(right.receipt.createdAt)));
    return jobs;
  }

  #rememberRequestIdentity(name, requestId) {
    this.requestIdentities.delete(name);
    if (this.requestIdentities.size >= 8192) this.requestIdentities.delete(this.requestIdentities.keys().next().value);
    this.requestIdentities.set(name, requestId);
  }

  #assertRequestIdentity(requestId, job) {
    if (requestId !== undefined && job?.request?.requestId !== requestId) throw Object.assign(new Error("a job's requestId cannot change"), { details: { kind: "persistence" } });
  }

  async putIfResumeAbsent(job, parentJobId) {
    const requestId = job.request.requestId;
    const requestPath = this.requestPath(requestId);
    return this.#withLock(`${requestPath}.lock`, async () => {
      // Scan under the request lock as well as consulting the index: a worker
      // can die after writing its child snapshot but before updating the index.
      const jobs = await this.#recoverRequestJobs(requestId);
      const child = jobs.find((entry) => entry.request.metadata?.resumeOf === parentJobId);
      const index = await this.#readMaybe(requestPath);
      const jobIds = [...new Set([...(index?.jobIds || []), ...jobs.map((entry) => entry.receipt.jobId)])];
      if (!jobs.some((entry) => entry.receipt.jobId === parentJobId)) throw new Error(`resume parent not found: ${parentJobId}`);
      if (!child) {
        const latest = jobIds.at(-1);
        if (latest !== parentJobId) {
          throw Object.assign(new Error(`resume parent ${parentJobId} is not the latest attempt`), {
            details: { kind: "resume-conflict", hint: "retrieve the latest attempt by requestId, then resume that job" },
          });
        }
        const path = this.path(job.receipt.jobId);
        await this.#withLock(`${path}.lock`, async () => {
          if (await this.#readMaybe(path)) throw new Error(`job already exists: ${job.receipt.jobId}`);
          await this.#atomicWrite(path, `${JSON.stringify(job, null, 2)}\n`);
        });
        jobIds.push(job.receipt.jobId);
      }
      await this.#atomicWrite(requestPath, `${JSON.stringify({
        requestId, jobId: jobIds.at(-1), latestJobId: jobIds.at(-1), jobIds,
      }, null, 2)}\n`);
      return { created: !child, job: child || job };
    });
  }

  #preserveCancellation(job, current) {
    if (!current?.receipt?.cancellation) return;
    job.receipt.cancellation = { ...current.receipt.cancellation, ...job.receipt.cancellation };
    if (current.receipt.cancellation.state === "requested" && job.receipt.state === "completed") {
      // Completion racing a cancellation request is not a stop acknowledgement.
      job.receipt.cancellation = { ...current.receipt.cancellation, state: "completed-before-cancel" };
    }
  }

  async #appendEventsUnlocked(jobId, events) {
    const path = this.tracePath(jobId);
    const handle = await retryWindowsTransient(() => open(path, "a+", 0o600));
    let records;
    let summary;
    let sequence;
    let written;
    try {
      const info = await handle.stat({ bigint: true });
      const previous = this.#cachedTrace(jobId, traceStamp(info)) ?? await recoverTrace(path, handle, info);
      sequence = previous.sequence;
      records = events.map((event) => ({ ...event, eventId: event.eventId || randomUUID(), sequence: ++sequence }));
      const lines = records.map((record) => {
        const line = JSON.stringify(record);
        if (Buffer.byteLength(line) > TRACE_RECORD_BYTES) throw traceSizeError(previous.sequence);
        return `${line}\n`;
      });
      const serialized = (previous.newline ? "" : "\n") + lines.join("");
      await handle.appendFile(serialized, "utf8");
      written = await handle.stat({ bigint: true });
      if (written.size !== info.size + BigInt(Buffer.byteLength(serialized))) throw changedTrace(previous.sequence);
      const progress = records.reduce(progressFromRecord, previous.summary.progress);
      summary = traceSummaryOf(records.at(-1), sequence, progress, previous.summary.recovery);
    } finally {
      await handle.close();
    }
    const info = await traceStat(path);
    // Windows can publish the final write timestamp when the write handle closes.
    if (info?.dev !== written.dev || info.ino !== written.ino || info.size !== written.size || info.birthtimeNs !== written.birthtimeNs) {
      throw changedTrace(sequence - records.length);
    }
    const state = Object.freeze({ sequence, summary, stamp: traceStamp(info), newline: true });
    this.#rememberTrace(jobId, state);
    // Snapshot publication uses this checkpoint even if other jobs evict it.
    return { record: records.at(-1), state };
  }

  async put(job, options = {}) {
    const path = this.path(job.receipt.jobId);
    const written = await this.#withLock(`${path}.lock`, async () => {
      const current = await this.#readMaybe(path);
      this.#assertRequestIdentity(current?.request?.requestId, job);
      if (options.expectedLeaseOwner && current?.lease?.ownerId !== options.expectedLeaseOwner) return false;
      this.#preserveCancellation(job, current);
      await this.#atomicWrite(path, `${JSON.stringify(job, null, 2)}\n`);
      if (TERMINAL_STATES.has(job.receipt.state)) this.#forgetTrace(job.receipt.jobId);
      return true;
    });
    if (written) await this.#indexRequest(job);
    return written ? job : null;
  }

  async commit(job, event, options = {}) {
    return this.commitBatch(job, [event], options);
  }

  async commitBatch(job, events, options = {}) {
    if (!Array.isArray(events) || !events.length) return job;
    const path = this.path(job.receipt.jobId);
    const written = await this.#withLock(`${path}.lock`, async () => {
      const current = await this.#readMaybe(path);
      this.#assertRequestIdentity(current?.request?.requestId, job);
      if (options.expectedLeaseOwner && current?.lease?.ownerId !== options.expectedLeaseOwner) return false;
      if (options.claim && (current?.receipt?.state !== "queued" || current?.lease)) return false;
      this.#preserveCancellation(job, current);
      const { record, state } = await this.#withLock(`${this.tracePath(job.receipt.jobId)}.lock`, () =>
        this.#appendEventsUnlocked(job.receipt.jobId, events));
      job.trace = {
        eventCount: record.sequence,
        lastEventAt: record.at,
        lastActivity: compactProgressText(record.activity || record.event?.type) || "progress",
        progress: structuredClone(state.summary.progress),
      };
      job.receipt = {
        ...job.receipt,
        trace: {
          ref: job.receipt.trace?.ref || `job:${job.receipt.jobId}:events`,
          ...job.trace,
        },
      };
      job.traceCheckpoint = traceCheckpoint(state);
      await this.#atomicWrite(path, `${JSON.stringify(job, null, 2)}\n`);
      if (TERMINAL_STATES.has(job.receipt.state)) this.#forgetTrace(job.receipt.jobId);
      return true;
    });
    return written ? job : null;
  }

  async transition(jobId, updater, eventFactory) {
    const path = this.path(jobId);
    let next = null;
    await this.#withLock(`${path}.lock`, async () => {
      const current = await this.#readMaybe(path);
      if (!current) {
        throw Object.assign(new Error(`job not found: ${jobId}`), {
          details: { kind: "not-found", hint: "verify the jobId from the queued receipt or handoff_sessions" },
        });
      }
      const requestId = current.request?.requestId;
      next = await updater(current);
      if (!next) return;
      this.#assertRequestIdentity(requestId, next);
      if (eventFactory) {
        const event = await eventFactory(next);
        const { record, state } = await this.#withLock(`${this.tracePath(jobId)}.lock`, () =>
          this.#appendEventsUnlocked(jobId, [event]));
        next.trace = {
          eventCount: record.sequence,
          lastEventAt: record.at,
          lastActivity: compactProgressText(record.activity || record.event?.type) || "progress",
          // Carry the last known semantic progress: transition events
          // (cancel, recovery) carry no progress of their own, and without
          // this the settled receipt reports progress null.
          progress: current.receipt?.trace?.progress ?? null,
        };
        next.receipt = {
          ...next.receipt,
          trace: { ref: next.receipt.trace?.ref || `job:${jobId}:events`, ...next.trace },
        };
        next.traceCheckpoint = traceCheckpoint(state);
      }
      await this.#atomicWrite(path, `${JSON.stringify(next, null, 2)}\n`);
      if (TERMINAL_STATES.has(next.receipt.state)) this.#forgetTrace(jobId);
    });
    if (next) await this.#indexRequest(next);
    return next;
  }

  async appendEvent(jobId, event) {
    const path = this.path(jobId);
    return this.#withLock(`${path}.lock`, async () => {
      const job = await this.#readMaybe(path);
      const terminal = TERMINAL_STATES.has(job?.receipt?.state);
      try {
        const { record } = await this.#withLock(`${this.tracePath(jobId)}.lock`, () => this.#appendEventsUnlocked(jobId, [event]));
        return record;
      } finally {
        if (terminal) this.#forgetTrace(jobId);
      }
    });
  }

  async traceSummary(jobId, { snapshot } = {}) {
    // Reuse a caller's already-read snapshot only for that same job; checkpoint
    // freshness is still validated below against a live trace stat.
    const job = snapshot?.receipt?.jobId === jobId
      ? snapshot
      : await this.get(jobId).catch((error) => {
        if (error.details?.kind === "not-found") return null;
        throw error;
      });
    const path = this.tracePath(jobId);
    if (TERMINAL_STATES.has(job?.receipt?.state)) this.#forgetTrace(jobId);
    const stamp = traceStamp(await traceStat(path));
    if (stamp && job?.traceCheckpoint?.version === TRACE_CHECKPOINT_VERSION && job.traceCheckpoint.summary && job.traceCheckpoint.stamp === stamp) {
      return job.traceCheckpoint.summary;
    }
    const cached = this.#cachedTrace(jobId, stamp);
    if (cached) return structuredClone(cached.summary);
    if (!stamp) return traceSummaryOf(null, 0, null);
    return this.#withLock(`${path}.lock`, async () => {
      const handle = await open(path, "r").catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (!handle) return traceSummaryOf(null, 0, null);
      try {
        const info = await handle.stat({ bigint: true });
        const state = this.#cachedTrace(jobId, traceStamp(info)) ?? await recoverTrace(path, handle, info);
        return structuredClone(state.summary);
      } finally {
        await handle.close();
      }
    });
  }

  async readTrace(jobId, options = {}) {
    await this.get(jobId);
    if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 200)) {
      throw Object.assign(new TypeError("trace limit must be an integer between 1 and 200"), { details: { kind: "validation" } });
    }
    if (options.afterSequence !== undefined && (!Number.isInteger(options.afterSequence) || options.afterSequence < 0)) {
      throw Object.assign(new TypeError("trace afterSequence must be an integer >= 0"), { details: { kind: "validation" } });
    }
    const limit = options.limit ?? 50;
    const afterSequence = options.afterSequence ?? null;
    const page = await readTracePage(this.tracePath(jobId), { limit, afterSequence });
    return {
      jobId,
      ...page,
      events: page.events.map((record) => sanitizeTraceValue(record)),
    };
  }

  async listReceipts(options = {}) {
    const limit = Math.max(1, Math.min(100, Number(options.limit) || 20));
    return (await this.listAllReceipts(options)).slice(0, limit);
  }

  async listAllReceipts(options = {}) {
    const entries = await readdir(this.root, { withFileTypes: true }).catch((error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
    const receipts = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/^[a-zA-Z0-9-]+\.json$/.test(entry.name)) continue;
      const jobId = entry.name.slice(0, -5);
      const job = await this.get(jobId);
      const receipt = job?.receipt;
      if (!receipt) continue;
      if (options.state && receipt.state !== options.state) continue;
      if (options.target && receipt.target !== options.target) continue;
      receipts.push(receipt);
    }
    receipts.sort((left, right) => String(right.updatedAt || right.createdAt).localeCompare(String(left.updatedAt || left.createdAt)));
    return receipts;
  }

  async jobIdForRequest(requestId) {
    let value = await this.#readMaybe(this.requestPath(requestId));
    if (!value) {
      const jobs = await this.#recoverRequestIndex(requestId);
      if (!jobs.length) {
        const error = new Error(`request not found: ${requestId}`);
        error.code = "ENOENT";
        error.details = { kind: "not-found", hint: "verify the caller-owned requestId; it is set before any downstream work starts" };
        throw error;
      }
      value = await this.#readMaybe(this.requestPath(requestId));
    }
    const jobId = value?.latestJobId || value?.jobId;
    if (value?.requestId !== requestId || typeof jobId !== "string") {
      throw new Error(`request index is invalid: ${requestId}`);
    }
    return jobId;
  }

  async jobIdsForRequest(requestId) {
    await this.jobIdForRequest(requestId);
    const value = await this.#readMaybe(this.requestPath(requestId));
    if (value?.requestId !== requestId) throw new Error(`request index is invalid: ${requestId}`);
    return [...new Set([...(value.jobIds || []), value.jobId, value.latestJobId].filter(Boolean))];
  }

  async get(jobId) {
    const path = this.path(jobId);
    return this.#withLock(`${path}.lock`, async () => {
      let raw;
      try {
        raw = await readFile(path, "utf8");
      } catch (error) {
        if (error?.code === "ENOENT") {
          throw Object.assign(new Error(`job not found: ${jobId}`), {
            details: { kind: "not-found", hint: "verify the jobId from the queued receipt or handoff_sessions" },
          });
        }
        throw error;
      }
      const job = JSON.parse(raw);
      if (TERMINAL_STATES.has(job?.receipt?.state)) this.#forgetTrace(jobId);
      return job;
    });
  }
}

// Observers must survive being killed without leaving locks or repairing an
// index. Sample atomically published files, retrying around active writers.
export class JobObserver {
  constructor(root) {
    this.paths = new JobStore(root);
  }

  async #readSnapshot(path) {
    const info = async (file) => stat(file, { bigint: true }).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    for (let attempt = 0; attempt < 200; attempt++) {
      if (!(await info(`${path}.lock`))) {
        const before = await info(path);
        let raw = null;
        try { raw = await readFile(path, "utf8"); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        const after = await info(path);
        if (!(await info(`${path}.lock`)) &&
            before?.ino === after?.ino && before?.size === after?.size &&
            before?.mtimeNs === after?.mtimeNs && before?.ctimeNs === after?.ctimeNs) {
          return raw === null ? null : JSON.parse(raw);
        }
      }
      await wait(10);
    }
    throw Object.assign(new Error("job snapshot is busy; retry observation without relaunching the job"), {
      details: { kind: "persistence" },
    });
  }

  async get(jobId) {
    const job = await this.#readSnapshot(this.paths.path(jobId));
    if (!job) throw Object.assign(new Error(`job not found: ${jobId}`), { details: { kind: "not-found" } });
    return job;
  }

  async jobIdForRequest(requestId) {
    const index = await this.#readSnapshot(this.paths.requestPath(requestId));
    if (!index) throw Object.assign(new Error("request index not found; recover with handoff_status and attach by jobId"), {
      details: { kind: "not-found" },
    });
    const jobId = index.latestJobId || index.jobId;
    if (index.requestId !== requestId || typeof jobId !== "string") throw new Error("invalid request index");
    this.paths.path(jobId);
    return jobId;
  }

  async readTrace(jobId, options = {}) {
    await this.get(jobId);
    if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 200)) {
      throw Object.assign(new TypeError("trace limit must be an integer between 1 and 200"), { details: { kind: "validation" } });
    }
    if (options.afterSequence !== undefined && (!Number.isInteger(options.afterSequence) || options.afterSequence < 0)) {
      throw Object.assign(new TypeError("trace afterSequence must be an integer >= 0"), { details: { kind: "validation" } });
    }
    const page = await readTracePage(this.paths.tracePath(jobId), { limit: options.limit ?? 50, afterSequence: options.afterSequence ?? null });
    return { jobId, ...page, events: page.events.map((record) => sanitizeTraceValue(record)) };
  }
}
