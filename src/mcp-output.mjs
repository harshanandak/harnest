import { createHash } from "node:crypto";

export const STATUS_RESPONSE_BYTES = 16 * 1024;
export const PAGE_RESPONSE_BYTES = 64 * 1024;
// Leave room for the JSON-RPC envelope, protocol metadata and stdio framing.
const ENVELOPE_BYTES = 1024;
const bytes = (text) => Buffer.byteLength(text, "utf8");

function measure(key, value) {
  const json = JSON.stringify(value);
  const response = {
    content: [{ type: "text", text: json }],
    structuredContent: { [key]: value },
  };
  // Both MCP representations count, including the extra escaping of text.
  const size = bytes(json);
  return {
    json,
    response,
    fits: (budget) =>
      2 * size + ENVELOPE_BYTES <= budget && bytes(JSON.stringify(response)) + ENVELOPE_BYTES <= budget,
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

function receiptPage(tool, json, header, cursor, budget) {
  const source = Buffer.from(json, "utf8");
  const version = createHash("sha256").update(source).digest("hex");
  const [expectedVersion, rawOffset] = cursor?.split(".") ?? [];
  if (cursor && expectedVersion !== version)
    throw validation("receipt changed; restart pagination without a cursor");
  const offset = cursor ? Number(rawOffset) : 0;
  return fragment(
    source,
    offset,
    (chunk, end) =>
      measure("receipt", {
        ...header,
        page: {
          encoding: "json-utf8",
          chunk,
          offset,
          originalBytes: source.length,
          omittedBytes: source.length - end,
          omittedCount: Number(end < source.length),
          continuation:
            end < source.length
              ? reference(tool, { jobId: header.jobId, cursor: `${version}.${end}` })
              : null,
        },
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
  const { afterSequence, itemOffset, limit } = options;
  const records = source[field];
  const first = records[0];
  const start = afterSequence ?? (first ? first.sequence - 1 : 0);
  const next = (sequence, offset = undefined) =>
    reference(tool, {
      ...identity,
      afterSequence: sequence,
      ...(limit === undefined ? {} : { limit }),
      ...(offset === undefined ? {} : { itemOffset: offset }),
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
  if (itemOffset === undefined && (best.count || !first)) return best.response;
  if (!first || (itemOffset !== undefined && (afterSequence == null || first.sequence !== start + 1))) {
    throw validation("the item for this page is no longer available");
  }
  const data = Buffer.from(JSON.stringify(first), "utf8");
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
            ? next(complete ? first.sequence : first.sequence - 1, complete ? undefined : end)
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

export function sessionsResponse(sessions, { offset = 0, ...options }) {
  return recordsPage("sessions", sessions.map(compactHeader), (rows, originalBytes, omittedCount) => ({
    sessions: rows,
    ...(omittedCount
      ? {
          page: {
            originalBytes,
            omittedCount,
            continuation: reference("handoff_sessions", {
              ...options,
              limit: omittedCount,
              offset: offset + rows.length,
            }),
          },
        }
      : {}),
  })).response;
}
