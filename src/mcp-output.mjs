import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { open, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { protectWindowsPath } from "./windows-acl.mjs";

export const STATUS_RESPONSE_BYTES = 16 * 1024;
export const PAGE_RESPONSE_BYTES = 64 * 1024;
// Leave room for the JSON-RPC envelope, protocol metadata and stdio framing.
const ENVELOPE_BYTES = 1024;
const bytes = (text) => Buffer.byteLength(text, "utf8");
const fitsWire = (response, budget) => bytes(JSON.stringify(response)) + ENVELOPE_BYTES <= budget;

export function dataResponse(key, value, json = JSON.stringify(value)) {
  return { content: [{ type: "text", text: json }], structuredContent: { [key]: value } };
}

function measure(key, value) {
  const json = JSON.stringify(value);
  const response = dataResponse(key, value, json);
  // Both MCP representations count, including the extra escaping of text.
  const size = bytes(json);
  return {
    json,
    response,
    fits: (budget) =>
      2 * size + ENVELOPE_BYTES <= budget && fitsWire(response, budget),
  };
}

const reference = (tool, args) => ({ tool, arguments: args });
const validation = (message) => Object.assign(new Error(message), { details: { kind: "validation" } });

function projection(receipt) {
  const { result, controls, ...status } = receipt;
  return {
    ...status,
    ...(controls?.length ? { controlCount: controls.length } : { controls: [] }),
    resultRef: reference("handoff_result", { jobId: receipt.jobId }),
  };
}

function preview(value, limit = 160) {
  if (typeof value !== "string") return value;
  const prefix = value.slice(0, limit);
  return prefix === value ? value : prefix + "…";
}

function receiptHeader(status) {
  const {
    protocolVersion,
    jobId,
    contextDigest,
    target,
    state,
    cancellation,
    recovery,
    error,
    resultRef,
    controlCount,
  } = status;
  const details = error?.details;
  const { lookupKey, ...recoveryState } = recovery ?? {};
  const header = {
    protocolVersion,
    jobId,
    contextDigest,
    target,
    state,
    cancellation,
    resultRef,
    controlCount,
    recovery: recovery && recoveryState,
    error: error && {
      name: preview(error.name),
      message: preview(error.message, 320),
      details: details && {
        kind: preview(details.kind),
        code: preview(details.code),
        signal: preview(details.signal),
        hint: preview(details.hint),
        aborted: details.aborted,
        timedOut: details.timedOut,
        uncertain: details.uncertain,
        unsafeResume: details.unsafeResume,
      },
    },
  };
  // Consumers persist the outer fields as lookup keys. An identity that
  // cannot fit here remains available in the full JSON via the continuation.
  const identities = {
    requestId: status.requestId,
    sessionId: status.sessionId,
    workflowRunId: status.workflowRunId,
    recovery: recovery && { ...recoveryState, lookupKey },
    route: status.route,
  };
  for (const [key, value] of Object.entries(identities)) {
    if (measure("receipt", { ...header, [key]: value }).fits(STATUS_RESPONSE_BYTES - 4096)) {
      header[key] = value;
    }
  }
  return header;
}

// Search on the serialized MCP size and never split a UTF-8 code point.
function fragment(source, offset, build, budget) {
  if (offset >= source.length || (source[offset] & 0xc0) === 0x80) {
    throw validation("page offset does not point to a UTF-8 character in the item");
  }
  let low = offset + 1;
  let high = Math.min(source.length, offset + budget);
  let best;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    let end = middle;
    while ((source[end] & 0xc0) === 0x80) end--;
    const measured = build(source.toString("utf8", offset, end), end);
    if (measured.fits(budget)) {
      if (end > offset) best = measured;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (!best) throw validation("response metadata leaves no room for a page");
  return best.response;
}

const checksum = (value) => createHash("sha256").update(value).digest("hex");

function jsonPage(chunk, offset, end, originalBytes, continuation) {
  return {
    encoding: "json-utf8",
    chunk,
    offset,
    originalBytes,
    omittedBytes: originalBytes - end,
    omittedCount: Number(end < originalBytes),
    continuation: end < originalBytes ? continuation : null,
  };
}

function receiptPage(tool, json, header, cursor, budget) {
  const source = Buffer.from(json, "utf8");
  const version = checksum(source);
  const cursorAt = (offset) => checksum(JSON.stringify([tool, header.jobId, version, offset])) + "." + offset;
  const offset = cursor ? Number(cursor.split(".")[1]) : 0;
  if (cursor && cursor !== cursorAt(offset))
    throw validation("invalid or stale receipt cursor; restart pagination without a cursor");
  return fragment(
    source,
    offset,
    (chunk, end) =>
      measure("receipt", {
        ...header,
        page: jsonPage(chunk, offset, end, source.length,
          reference(tool, { jobId: header.jobId, cursor: cursorAt(end) })),
      }),
    budget,
  );
}

function compactHeader(receipt) {
  const status = projection(receipt);
  if (measure("receipt", status).fits(STATUS_RESPONSE_BYTES - 4096)) return status;
  return {
    ...receiptHeader(status),
    projection: {
      originalBytes: bytes(JSON.stringify(status)),
      omittedCount: 1,
      continuation: reference("handoff_status", { jobId: receipt.jobId }),
    },
  };
}

export function statusResponse(receipt, cursor) {
  const status = projection(receipt);
  const full = measure("receipt", status);
  if (!cursor && full.fits(STATUS_RESPONSE_BYTES - 4096)) return full.response;
  const activeTool = status.trace?.progress?.activeTool;
  let json = full.json;
  if (activeTool) {
    // The caller can derive elapsedMs from startedAt. A ticking value would
    // invalidate a cursor even while no new trace event has arrived.
    const { elapsedMs, ...tool } = activeTool;
    json = JSON.stringify({
      ...status,
      trace: { ...status.trace, progress: { ...status.trace.progress, activeTool: tool } },
    });
  }
  return receiptPage("handoff_status", json, receiptHeader(status), cursor, STATUS_RESPONSE_BYTES);
}

export function activeReceiptResponse(receipt) {
  const full = measure("receipt", receipt);
  return full.fits(STATUS_RESPONSE_BYTES) ? full.response : statusResponse(receipt);
}

export function resultResponse(receipt, cursor) {
  const full = measure("receipt", receipt);
  if (!cursor && full.fits(PAGE_RESPONSE_BYTES)) return full.response;
  const header = { ...compactHeader(receipt), ...(receipt.result === null ? { result: null } : {}) };
  return receiptPage("handoff_result", full.json, header, cursor, PAGE_RESPONSE_BYTES);
}

function recordsPage(key, records, build) {
  // Measure the original window once without building an oversized MCP response.
  const lengths = records.map((record) => bytes(JSON.stringify(record)));
  const originalBytes =
    lengths.reduce((total, size) => total + size, 0) + Math.max(0, records.length - 1) + 2;
  let count = 0;
  let usedBytes = 2;
  let best;
  for (; count <= records.length && usedBytes <= PAGE_RESPONSE_BYTES; count++) {
    const page = build(records.slice(0, count), originalBytes, records.length - count);
    const candidate = measure(key, page);
    if (!candidate.fits(PAGE_RESPONSE_BYTES)) break;
    best = { response: candidate.response, count, originalBytes };
    usedBytes += (lengths[count] ?? 0) + 1;
  }
  if (!best) throw validation("response metadata exceeds the page budget");
  return best;
}

function sequenceResponse(key, tool, identity, field, source, options) {
  const { afterSequence, itemOffset, itemCursor, limit } = options;
  const records = source[field];
  const first = records[0];
  const start = afterSequence ?? (first ? first.sequence - 1 : 0);
  const next = (sequence, offset, cursor) =>
    reference(tool, {
      ...identity,
      afterSequence: sequence,
      ...(limit === undefined ? {} : { limit }),
      ...(offset === undefined ? {} : { itemOffset: offset, itemCursor: cursor }),
    });
  const best = recordsPage(key, records, (entries, originalBytes, omittedCount) => {
    const nextSequence = entries.at(-1)?.sequence ?? start;
    return {
      ...source,
      [field]: entries,
      nextSequence,
      hasMore: omittedCount > 0 || source.hasMore,
      ...(omittedCount > 0 || (afterSequence != null && source.hasMore)
        ? {
            page: { originalBytes, omittedCount, continuation: next(nextSequence) },
          }
        : {}),
    };
  });
  if ((itemOffset === undefined) !== (itemCursor === undefined)) {
    throw validation("itemOffset and itemCursor must come from the same page continuation");
  }
  if (itemOffset === undefined && (best.count || !first)) return best.response;
  if (!first || (itemOffset !== undefined && (afterSequence == null || first.sequence !== start + 1))) {
    throw validation("the item for this page is no longer available");
  }
  const data = Buffer.from(JSON.stringify(first), "utf8");
  const version = checksum(data);
  const cursorAt = (offset) => checksum(JSON.stringify([tool, identity, first.sequence, limit, version, offset]));
  if (itemCursor && itemCursor !== cursorAt(itemOffset)) {
    throw validation("invalid or stale item cursor; restart from the last complete sequence");
  }
  const { originalBytes } = best;
  return fragment(
    data,
    itemOffset ?? 0,
    (chunk, end) => {
      const complete = end === data.length;
      const hasMore = !complete || records.length > 1 || (afterSequence != null && source.hasMore);
      return measure(key, {
        ...source,
        [field]: [],
        nextSequence: complete ? first.sequence : first.sequence - 1,
        hasMore,
        page: {
          originalBytes,
          omittedCount: records.length - Number(complete),
          item: {
            sequence: first.sequence,
            encoding: "json-utf8",
            chunk,
            offset: itemOffset ?? 0,
            originalBytes: data.length,
            omittedBytes: data.length - end,
          },
          continuation: hasMore
            ? complete ? next(first.sequence) : next(first.sequence - 1, end, cursorAt(end))
            : null,
        },
      });
    },
    PAGE_RESPONSE_BYTES,
  );
}

export function traceResponse({ receipt, ...trace }, options) {
  return sequenceResponse(
    "trace",
    "handoff_trace",
    { jobId: receipt.jobId },
    "events",
    { ...trace, receipt: compactHeader(receipt) },
    options,
  );
}

export function boardResponse(board, options) {
  return sequenceResponse("board", "handoff_read", { topic: board.topic }, "entries", board, options);
}

export function postResponse(entry) {
  const full = measure("post", entry);
  if (full.fits(PAGE_RESPONSE_BYTES)) return full.response;
  const { message, ...identity } = entry;
  return measure("post", {
    ...identity,
    page: {
      originalBytes: bytes(JSON.stringify(entry)),
      omittedCount: 1,
      continuation: reference("handoff_read", {
        topic: entry.topic,
        afterSequence: entry.sequence - 1,
        limit: 1,
      }),
    },
  }).response;
}

function sessionsCursor(sessions, { offset, limit, state, target }) {
  return checksum(JSON.stringify([offset, limit, state, target, sessions.map(({ jobId }) => jobId)]));
}

export function sessionsResponse(sessions, { offset = 0, cursor, ...options }) {
  if (cursor && cursor !== sessionsCursor(sessions, { ...options, offset })) {
    throw validation("invalid or stale session cursor; restart the session list");
  }
  return recordsPage("sessions", sessions.map(compactHeader), (rows, originalBytes, omittedCount) => {
    const next = { ...options, limit: omittedCount, offset: offset + rows.length };
    return {
      sessions: rows,
      ...(omittedCount && {
        page: {
          originalBytes,
          omittedCount,
          continuation: reference("handoff_sessions", {
            ...next,
            cursor: sessionsCursor(sessions.slice(rows.length), next),
          }),
        },
      }),
    };
  }).response;
}

// Large incidental responses (including mutating tools) need a snapshot so
// that following a continuation cannot rerun work or observe a different view.
const MAX_SNAPSHOTS = 16;
const SNAPSHOT_BYTES = 64 * 1024 * 1024;
let snapshotDirectory;

function responseDirectory() {
  if (!snapshotDirectory) {
    const directory = mkdtempSync(join(tmpdir(), "harnest-mcp-pages-"));
    process.once("exit", () => {
      try { rmSync(directory, { recursive: true, force: true }); } catch { /* best effort */ }
    });
    if (process.platform === "win32") protectWindowsPath(directory, { directory: true });
    snapshotDirectory = directory;
  }
  return snapshotDirectory;
}

const EXPIRED_SNAPSHOT = "this page snapshot is no longer available (the daemon restarted, or newer large " +
  "responses replaced it). Recover from the identifiers in the first page header: read each lane or job " +
  "with handoff_result using its jobId, and runs or graphs with their status tools. Do not rerun " +
  "handoff_review or handoff_compare to recover: that starts new work.";

// Bounded copy of an error so a paged response keeps its diagnosis on the first page.
function boundedError(error) {
  if (error === null || error === undefined) return error;
  if (typeof error !== "object") return preview(String(error), 1024);
  return {
    ...(error.kind !== undefined && { kind: preview(String(error.kind)) }),
    ...(error.code !== undefined && { code: preview(String(error.code)) }),
    message: preview(String(error.message ?? JSON.stringify(error)), 1024),
  };
}

// Per-lane identity for compare and review results, so every lane stays reachable through
// handoff_result even after the paged snapshot expires.
function laneRecovery(value) {
  const lanes = Array.isArray(value?.lanes) ? value.lanes : value?.rounds?.at?.(-1)?.lanes;
  if (!Array.isArray(lanes)) return undefined;
  return lanes.slice(0, 16).map((lane) => ({
    name: preview(String(lane?.name ?? "")),
    jobId: lane?.jobId ?? lane?.receipt?.jobId ?? null,
    state: lane?.state ?? lane?.receipt?.state ?? (lane?.error ? "failed" : null),
    ...(lane?.error && { error: boundedError(lane.error) }),
  }));
}

export function createResponseBoundary() {
  const snapshots = new Map();
  let snapshotBytes = 0;

  const cursorAt = (id, offset) => id + "." + offset + "." + checksum(id + "." + offset);
  const pageRef = (id, offset) => reference("handoff_page", { cursor: cursorAt(id, offset) });

  async function save(source, tool, key, budget) {
    const id = randomUUID();
    const path = join(responseDirectory(), id);
    try {
      await writeFile(path, source, { mode: 0o600, flag: "wx" });
    } catch (error) {
      await unlink(path).catch(() => {});
      throw error;
    }
    snapshots.set(id, { path, tool, key, budget, length: source.length });
    snapshotBytes += source.length;
    while (snapshots.size > MAX_SNAPSHOTS || (snapshots.size > 1 && snapshotBytes > SNAPSHOT_BYTES)) {
      const oldest = snapshots.keys().next().value;
      const entry = snapshots.get(oldest);
      snapshots.delete(oldest);
      snapshotBytes -= entry.length;
      await unlink(entry.path).catch(() => {});
    }
    return id;
  }

  async function read(cursor) {
    const [id, position] = cursor.split(".");
    const offset = Number(position);
    const entry = snapshots.get(id);
    if (!entry || cursor !== cursorAt(id, offset) || offset >= entry.length) {
      throw validation("invalid or expired response cursor; " + EXPIRED_SNAPSHOT);
    }
    const handle = await open(entry.path, "r").catch(() => null);
    if (!handle) throw validation("response snapshot expired while paging; " + EXPIRED_SNAPSHOT);
    try {
      const window = Buffer.allocUnsafe(Math.min(entry.budget + 4, entry.length - offset));
      let loaded = 0;
      while (loaded < window.length) {
        const { bytesRead } = await handle.read(window, loaded, window.length - loaded, offset + loaded);
        if (!bytesRead) throw validation("response snapshot changed while paging");
        loaded += bytesRead;
      }
      return fragment(window, 0, (chunk, consumed) => {
        const end = offset + consumed;
        return measure("response", {
          tool: entry.tool,
          key: entry.key,
          page: jsonPage(chunk, offset, end, entry.length, pageRef(id, end)),
        });
      }, entry.budget);
    } finally {
      await handle.close();
    }
  }

  async function bound(tool, response, project) {
    const budget = tool.endsWith("_status") ? STATUS_RESPONSE_BYTES : PAGE_RESPONSE_BYTES;
    const projected = project(response);
    // Skip encoding a second oversized copy of text just to reject it.
    if (projected.content.every(({ text }) => typeof text !== "string" || bytes(text) < budget) &&
        fitsWire(projected, budget)) return projected;

    if (response.isError) {
      const error = response.structuredContent?.error;
      const body = {
        error: {
          kind: preview(error?.kind ?? "Error"),
          message: preview(error?.message ?? response.content[0]?.text ?? "Tool failed", 1024),
        },
        runtime: response.structuredContent?.runtime,
      };
      const compact = project({
        content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body, isError: true,
      });
      if (fitsWire(compact, budget)) return compact;
      throw new Error("MCP tool error exceeds its response budget");
    }

    const [[key, value]] = Object.entries(response.structuredContent);
    const source = Buffer.from(response.content[0].text, "utf8");
    const header = {};
    const diagnostics = {
      error: value?.error === undefined ? undefined : boundedError(value.error),
      errors: Array.isArray(value?.errors) ? value.errors.slice(0, 10).map(boundedError) : undefined,
      errorCount: Array.isArray(value?.errors) && value.errors.length > 10 ? value.errors.length : undefined,
      lanes: laneRecovery(value),
    };
    // Identity and state first, then diagnostics and lane recovery, each kept only while the
    // header still leaves room for page content.
    for (const field of ["comparisonId", "reviewId", "graphId", "runId", "requestId", "contextDigest",
      "state", "revision", "cancellation", "recoveryRequired", "counts", "error", "errors", "errorCount", "lanes"]) {
      const fieldValue = field in diagnostics ? diagnostics[field] : value?.[field];
      if (fieldValue !== undefined && measure(key, { ...header, [field]: fieldValue }).fits(budget - 4096)) {
        header[field] = fieldValue;
      }
    }
    const id = await save(source, tool, key, budget);
    const first = fragment(source, 0, (chunk, end) => measure(key, {
      ...header,
      page: jsonPage(chunk, 0, end, source.length, pageRef(id, end)),
    }), budget);
    const page = project(first);
    if (fitsWire(page, budget)) return page;
    throw new Error("MCP continuation exceeds its response budget");
  }

  return { read, bound };
}
