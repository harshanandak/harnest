import assert from "node:assert/strict";
import test from "node:test";
import { STATUS_RESPONSE_BYTES, traceResponse } from "../src/mcp-output.mjs";

test("compact trace receipt keeps trace.progress without the tasklist", () => {
  const progress = {
    phase: "build", current: "step 3", recent: ["read", "edit"], lastMeaningfulAt: "2026-11-20T00:00:00.000Z",
    tasklist: Array.from({ length: 20 }, (_, i) => ({ title: `task ${i}`, status: "pending" })), tasklistTotal: 20,
  };
  const receipt = {
    protocolVersion: 1, jobId: "job-1", state: "running", target: "codex",
    request: { task: "x".repeat(STATUS_RESPONSE_BYTES) },
    trace: { eventCount: 4, lastActivity: null, progress },
  };
  const header = traceResponse({ receipt, events: [], nextSequence: 0 }, {}).structuredContent.trace.receipt;
  assert.ok(header.projection, "a receipt this large falls back to the compact header");
  const { tasklist, tasklistTotal, ...kept } = progress;
  assert.deepEqual(header.trace, { eventCount: 4, lastActivity: null, progress: kept });
});
