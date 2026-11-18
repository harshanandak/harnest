
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Companion } from "../src/companion.mjs";
import { JobStore } from "../src/job-store.mjs";
import { normalizeRequest } from "../src/protocol.mjs";
import { resolvePolicyRoute } from "../src/routing-policy.mjs";

const rankedResolver = async (request) => ({
  ...request,
  metadata: {
    ...request.metadata,
    harnest: {
      routingDecision: {
        version: 2,
        mode: "auto",
        selected: "first",
        rankedRoutes: [
          { id: "first", target: "pi", score: 100, route: { provider: "one", model: "works" } },
          { id: "second", target: "cursor", score: 50, route: { provider: "cursor", model: "backup" } },
        ],
      },
    },
  },
});

function transportError() {
  return Object.assign(new Error("spawn pi ENOENT"), { details: { kind: "transport" } });
}

test("read-only transport failure falls back to the next ranked route once", async (t) => {
  const seen = [];
  const root = await mkdtemp(join(tmpdir(), "harnest-fallback-"));
  const companion = new Companion({
    store: new JobStore(root),
    routeResolver: rankedResolver,
    adapterFactory: (target) => ({
      async run(request) {
        seen.push(target);
        if (target === "pi") throw transportError();
        return { result: { finalText: "fallback success" }, sessionId: "cursor-s-1", route: request.route };
      },
    }),
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  const receipt = await companion.start({
    requestId: "fallback-readonly",
    target: "pi",
    task: "research quietly",
    cwd: process.cwd(),
    policy: { write: false },
    execution: { sessionId: "old-session" },
  });
  assert.deepEqual(seen, ["pi", "cursor"]);
  assert.equal(receipt.state, "completed");
  assert.equal(receipt.target, "cursor");
  assert.equal(receipt.result.finalText, "fallback success");
  assert.equal(receipt.routingFallbacks.length, 1);
  assert.equal(receipt.routingFallbacks[0].from.target, "pi");
  assert.equal(receipt.routingFallbacks[0].to.target, "cursor");
  assert.equal(receipt.routingFallbacks[0].errorKind, "transport");
  assert.equal(receipt.routingFallbacks[0].keptSession, false);
});

test("fallback snapshots each attempt's latest usage and resets it per attempt", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harnest-fallback-usage-"));
  const companion = new Companion({
    store: new JobStore(root),
    routeResolver: rankedResolver,
    adapterFactory: (target) => ({
      async run(request, { onProgress } = {}) {
        if (target === "pi") {
          // Two cumulative snapshots: the attempt result must be the latest,
          // not the sum of both updates.
          onProgress?.({ type: "pi_progress", usage: { tokens: { input: 5, output: 1, cacheRead: 4, cacheWrite: 1, total: 11 }, cost: 0.001 } });
          onProgress?.({ type: "pi_progress", usage: { tokens: { input: 7, output: 2, cacheRead: 6, cacheWrite: 1, total: 16 }, cost: 0.002 } });
          throw transportError();
        }
        return {
          result: { finalText: "fallback success" },
          route: request.route,
          usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1 },
        };
      },
    }),
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const receipt = await companion.start({
    requestId: "fallback-usage-ledger",
    target: "pi",
    task: "research quietly",
    cwd: process.cwd(),
    policy: { write: false },
    execution: { sessionId: "old-session" },
  });

  assert.equal(receipt.state, "completed");
  assert.equal(receipt.target, "cursor");
  // The completed attempt's usage is the receipt's legacy usage; the failed
  // provider's counters were not inherited.
  assert.deepEqual(receipt.usage, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1 });
  assert.equal(receipt.usageAttempts.length, 2);
  const [failed, completed] = receipt.usageAttempts;
  assert.equal(failed.attempt, 1);
  assert.equal(failed.target, "pi");
  assert.equal(failed.state, "failed");
  assert.equal(failed.usageReported, true);
  assert.deepEqual(failed.usage, { tokens: { input: 7, output: 2, cacheRead: 6, cacheWrite: 1, total: 16 }, cost: 0.002 });
  assert.equal(failed.usageSummary.inputTokens, 14);
  assert.equal(failed.usageSummary.cacheReadTokens, 6);
  assert.equal(failed.usageSummary.inputSemantics, "exclusive");
  assert.equal(completed.attempt, 2);
  assert.equal(completed.target, "cursor");
  assert.equal(completed.state, "completed");
  assert.equal(completed.usageReported, true);
  // Cursor semantics stay unknown, so the inclusive total is not claimed.
  assert.equal(completed.usageSummary.inputTokens, null);
  assert.equal(completed.usageSummary.inputSemantics, "unknown");
  assert.equal(completed.usageSummary.cacheReadTokens, 2);
  const reread = await companion.status(receipt.jobId);
  assert.deepEqual(reread.usageAttempts, receipt.usageAttempts);
});

test("an attempt that never reports usage stays unknown instead of zero", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harnest-fallback-usage-unknown-"));
  const companion = new Companion({
    store: new JobStore(root),
    routeResolver: rankedResolver,
    adapterFactory: (target) => ({
      async run() {
        if (target === "pi") throw transportError();
        return { result: { finalText: "silent success" } };
      },
    }),
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const receipt = await companion.start({
    requestId: "fallback-usage-unknown",
    target: "pi",
    task: "research quietly",
    cwd: process.cwd(),
    policy: { write: false },
  });

  assert.equal(receipt.state, "completed");
  assert.equal(receipt.usage, null);
  assert.equal(receipt.usageSummary ?? null, null);
  assert.equal(receipt.usageAttempts.length, 2);
  for (const attempt of receipt.usageAttempts) {
    assert.equal(attempt.usageReported, false);
    assert.equal(attempt.usage, null);
    assert.equal(attempt.usageSummary, null);
  }
});

test("write-capable runs never fall back after transport failure", async (t) => {
  const seen = [];
  const root = await mkdtemp(join(tmpdir(), "harnest-fallback-write-"));
  const companion = new Companion({
    store: new JobStore(root),
    routeResolver: rankedResolver,
    adapterFactory: () => ({
      async run(request) {
        seen.push(request.target);
        throw transportError();
      },
    }),
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  const receipt = await companion.start({
    requestId: "fallback-write",
    target: "pi",
    task: "edit files",
    cwd: process.cwd(),
    policy: { write: true },
  });
  assert.deepEqual(seen, ["pi"]);
  assert.equal(receipt.state, "failed");
  assert.equal(receipt.target, "pi");
});

test("read-only task failure falls back once (stuck here, try next)", async (t) => {
  const seen = [];
  const root = await mkdtemp(join(tmpdir(), "harnest-fallback-downstream-"));
  const companion = new Companion({
    store: new JobStore(root),
    routeResolver: rankedResolver,
    adapterFactory: () => ({
      async run(request) {
        seen.push(request.target);
        if (request.target === "pi") {
          throw Object.assign(new Error("model produced no usable answer"), { details: { kind: "downstream" } });
        }
        return { result: { finalText: "second harness succeeded" }, route: request.route };
      },
    }),
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  const receipt = await companion.start({
    requestId: "fallback-downstream",
    target: "pi",
    task: "research quietly",
    cwd: process.cwd(),
    policy: { write: false },
  });
  assert.deepEqual(seen, ["pi", "cursor"]);
  assert.equal(receipt.state, "completed");
  assert.equal(receipt.routingFallbacks[0].errorKind, "downstream");
});

test("write-capable task failure never falls back", async (t) => {
  const seen = [];
  const root = await mkdtemp(join(tmpdir(), "harnest-fallback-write-downstream-"));
  const companion = new Companion({
    store: new JobStore(root),
    routeResolver: rankedResolver,
    adapterFactory: () => ({
      async run(request) {
        seen.push(request.target);
        throw Object.assign(new Error("model produced no usable answer"), { details: { kind: "downstream" } });
      },
    }),
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  const receipt = await companion.start({
    requestId: "fallback-write-downstream",
    target: "pi",
    task: "edit files",
    cwd: process.cwd(),
    policy: { write: true },
  });
  assert.deepEqual(seen, ["pi"]);
  assert.equal(receipt.state, "failed");
});

test("metadata.routing.fallbacks:false opts out of failover", async (t) => {
  const seen = [];
  const root = await mkdtemp(join(tmpdir(), "harnest-fallback-optout-"));
  const companion = new Companion({
    store: new JobStore(root),
    routeResolver: rankedResolver,
    adapterFactory: () => ({
      async run(request) {
        seen.push(request.target);
        throw transportError();
      },
    }),
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  const receipt = await companion.start({
    requestId: "fallback-optout",
    target: "pi",
    task: "research quietly",
    cwd: process.cwd(),
    policy: { write: false },
    metadata: { routing: { fallbacks: false } },
  });
  assert.deepEqual(seen, ["pi"]);
  assert.equal(receipt.state, "failed");
});
