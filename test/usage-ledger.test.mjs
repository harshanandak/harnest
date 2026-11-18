import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Companion } from "../src/companion.mjs";
import { PiAdapter } from "../src/adapters/pi.mjs";
import { JobStore } from "../src/job-store.mjs";
import { createReceipt, normalizeRequest } from "../src/protocol.mjs";
import { addUsageToTotals, emptyUsageTotals } from "../src/usage.mjs";

const passthroughRoute = async (request) => request;
const transportError = () => Object.assign(new Error("spawn ENOENT"), { details: { kind: "transport" } });
const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
const NULL_SUMMARY = {
  inputTokens: null,
  uncachedInputTokens: null,
  inputSemantics: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  costUsd: null,
};

function rankedResolver() {
  return async (request) => ({
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
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t, name, { adapterFactory, routeResolver = passthroughRoute } = {}) {
  const root = await mkdtemp(join(tmpdir(), `harnest-${name}-`));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const store = new JobStore(root);
  return { root, store, companion: new Companion({ store, routeResolver, adapterFactory }) };
}

test("Pi terminal statistics survive a rejected completion contract", async (t) => {
  const stats = { tokens: { input: 12, output: 4, cacheRead: 8, cacheWrite: 2, total: 26 }, cost: 0.03 };
  const text = "answer without the required canary";
  const spawnFn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const emit = (value) => child.stdout.emit("data", Buffer.from(`${JSON.stringify(value)}\n`));
    child.kill = () => { queueMicrotask(() => child.emit("close", null, "SIGTERM")); return true; };
    child.stdin = { write(line) {
      const command = JSON.parse(line);
      const response = (data) => emit({ type: "response", id: command.id, command: command.type, success: true, data });
      if (command.type === "get_state") response({ sessionId: "pi-usage-test", model: { provider: "openai", id: "fake" } });
      else if (command.type === "get_session_stats") response(stats);
      else if (command.type === "get_last_assistant_text") response({ text });
      else if (command.type === "abort") child.kill();
      else if (command.type === "prompt") {
        response({});
        emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
        emit({ type: "agent_settled" });
      }
      return true;
    } };
    return child;
  };
  const { companion, store } = await fixture(t, "pi-rejected-usage", {
    adapterFactory: () => new PiAdapter({ command: "fake-pi", spawnFn }),
  });
  const receipt = await companion.start({ requestId: "pi-rejected-usage", target: "pi", cwd: process.cwd(), task: "t", context: { requiredText: ["MISSING_CANARY"] } });
  assert.equal(receipt.state, "failed");
  assert.equal(receipt.error.details.kind, "completion-contract");
  assert.equal(receipt.usageAttempts[0].state, "failed");
  assert.equal(receipt.usageAttempts[0].usageReported, true);
  assert.deepEqual(receipt.usageAttempts[0].usage, stats);
  assert.equal(receipt.usageSummary.inputTokens, 22);
  assert.equal(receipt.usageTotals.costUsd, 0.03);
  assert.equal(receipt.usageTotals.reportedAttempts, 1);
  assert.deepEqual((await store.get(receipt.jobId)).receipt.usageTotals, receipt.usageTotals);
});

test("interrupted complete counters remain a lower bound after resume", async (t) => {
  const usage = { tokens: { input: 2, output: 3, cacheRead: 4, cacheWrite: 0, total: 9 }, cost: 0.01 };
  const summary = { inputTokens: 6, uncachedInputTokens: 2, inputSemantics: "exclusive", outputTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 0, costUsd: 0.01 };
  const { companion, store } = await fixture(t, "interrupted-coverage", {
    adapterFactory: () => ({ async run() { return { result: { finalText: "ok" }, usage, usageSummary: summary }; } }),
  });
  for (const withTotals of [false, true]) {
    const request = normalizeRequest({ requestId: `interrupted-${withTotals}`, target: "pi", task: "t", cwd: process.cwd() });
    const receipt = createReceipt(request, { state: "partial", error: { name: "InterruptedExecution", message: "owner exited" } });
    receipt.usageAttempts = [{ attempt: 1, jobId: receipt.jobId, target: "pi", route: {}, state: "running", usageReported: true, usage, usageSummary: summary }];
    if (withTotals) receipt.usageTotals = emptyUsageTotals();
    await store.putIfRequestAbsent({ request, receipt, trace: { eventCount: 0 }, lease: null, controls: [] });
    const resumed = await companion.resume(receipt.jobId);
    assert.equal(resumed.state, "completed");
    assert.equal(resumed.usageTotals.reportedAttempts, 2);
    assert.equal(resumed.usageTotals.outputTokens, 6);
    assert.equal(resumed.usageTotals.partial, true, "the owner may have exited after spending more than its last snapshot");
  }
});

test("a closed attempt's late progress cannot touch the retry ledger or receipt", async (t) => {
  const cursorStarted = deferred();
  const releaseCursor = deferred();
  let piProgress = null;
  const { companion } = await fixture(t, "usage-late", {
    routeResolver: rankedResolver(),
    adapterFactory: (target) => (target === "pi" ? {
      async run(_request, { onProgress } = {}) {
        piProgress = onProgress;
        throw transportError();
      },
    } : {
      async run() {
        cursorStarted.resolve();
        await releaseCursor.promise;
        return { result: { finalText: "cursor ok" } };
      },
    }),
  });

  const pending = companion.start({
    requestId: "usage-late",
    target: "pi",
    task: "t",
    cwd: process.cwd(),
    policy: { write: false },
  });
  await cursorStarted.promise;
  // Attempt 1 is closed and attempt 2 is in flight: this callback is stale and
  // must be dropped entirely.
  piProgress?.({ type: "pi_progress", usage: { tokens: { input: 99, output: 1, cacheRead: 0, cacheWrite: 0, total: 100 }, cost: 0.5 } });
  releaseCursor.resolve();
  const receipt = await pending;

  assert.equal(receipt.state, "completed");
  assert.equal(receipt.target, "cursor");
  assert.equal(receipt.usage, null);
  assert.equal(receipt.usageSummary, null);
  assert.deepEqual(
    receipt.usageAttempts.map((entry) => [entry.attempt, entry.target, entry.state, entry.usageReported, entry.usage, entry.usageSummary]),
    [
      [1, "pi", "failed", false, null, null],
      [2, "cursor", "completed", false, null, null],
    ],
  );
});

test("an unconfirmed OpenCode zero accumulator stays null and never becomes reported usage", async (t) => {
  const { companion } = await fixture(t, "usage-unconfirmed", {
    adapterFactory: () => ({
      async run(_request, { onProgress } = {}) {
        await onProgress?.({ type: "step_finish", usage: { ...ZERO }, usageReported: null });
        throw transportError();
      },
    }),
  });
  const receipt = await companion.start({
    requestId: "usage-unconfirmed",
    target: "opencode",
    task: "t",
    cwd: process.cwd(),
    route: { provider: "x", model: "y" },
  });

  assert.equal(receipt.state, "failed");
  assert.deepEqual(receipt.usage, ZERO, "legacy raw accumulator is preserved");
  assert.equal(receipt.usageSummary, null, "canonical summary must not invent zeros");
  assert.equal(receipt.usageAttempts[0].usageReported, false);
  assert.equal(receipt.usageAttempts[0].usageSummary, null);
});

test("an all-null terminal summary is canonical null, not confirmed usage", async (t) => {
  const { companion } = await fixture(t, "usage-null-summary", {
    adapterFactory: () => ({
      async run() {
        return { result: { finalText: "ok" }, usage: { ...ZERO }, usageReported: {}, usageSummary: { ...NULL_SUMMARY } };
      },
    }),
  });
  const receipt = await companion.start({
    requestId: "usage-null-summary",
    target: "opencode",
    task: "t",
    cwd: process.cwd(),
    route: { provider: "x", model: "y" },
  });

  assert.equal(receipt.state, "completed");
  assert.deepEqual(receipt.usage, ZERO);
  assert.equal(receipt.usageSummary, null);
  assert.equal(receipt.usageAttempts[0].usageReported, false);
  assert.equal(receipt.usageAttempts[0].usageSummary, null);
  const schema = JSON.parse(await readFile(new URL("../schemas/handoff-receipt.schema.json", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(receipt).filter((key) => !Object.hasOwn(schema.properties, key)), [], "adapter-only usage evidence must not escape the receipt schema");
});

test("explicit zeros and mixed reported keys are kept exactly as reported", async (t) => {
  const { companion } = await fixture(t, "usage-mixed", {
    adapterFactory: () => ({
      async run(_request, { onProgress } = {}) {
        await onProgress?.({
          type: "step_finish",
          usage: { input: 3, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
          usageReported: { input: true, cacheRead: true, cacheWrite: true },
        });
        throw transportError();
      },
    }),
  });
  const receipt = await companion.start({
    requestId: "usage-mixed",
    target: "opencode",
    task: "t",
    cwd: process.cwd(),
    route: { provider: "x", model: "y" },
  });

  assert.equal(receipt.usageAttempts[0].usageReported, true);
  assert.deepEqual(receipt.usageAttempts[0].usageSummary, {
    inputTokens: 3,
    uncachedInputTokens: 3,
    inputSemantics: "exclusive",
    outputTokens: null,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: null,
  });
  assert.deepEqual(receipt.usageSummary, receipt.usageAttempts[0].usageSummary);
});

test("a terminal failure keeps the last confirmed attempt summary at the top level", async (t) => {
  const { companion } = await fixture(t, "usage-failure", {
    adapterFactory: () => ({
      async run(_request, { onProgress } = {}) {
        await onProgress?.({ type: "cursor_progress", usage: { inputTokens: 50, outputTokens: 9, cacheReadTokens: 4, cacheWriteTokens: 2 } });
        throw transportError();
      },
    }),
  });
  const receipt = await companion.start({
    requestId: "usage-failure",
    target: "cursor",
    task: "t",
    cwd: process.cwd(),
    policy: { write: false },
    route: { provider: "x", model: "y" },
  });

  assert.equal(receipt.state, "failed");
  assert.equal(receipt.usageAttempts[0].state, "failed");
  assert.equal(receipt.usageAttempts[0].usageReported, true);
  assert.equal(receipt.usageSummary.cacheReadTokens, 4);
  assert.equal(receipt.usageSummary.outputTokens, 9);
});

test("a retry clears the failed attempt's summary instead of inheriting it", async (t) => {
  const { companion } = await fixture(t, "usage-retry-clear", {
    routeResolver: rankedResolver(),
    adapterFactory: (target) => ({
      async run(_request, { onProgress } = {}) {
        if (target === "pi") {
          await onProgress?.({ type: "pi_progress", usage: { tokens: { input: 99, output: 1, cacheRead: 0, cacheWrite: 0, total: 100 }, cost: 0.5 } });
          throw transportError();
        }
        return { result: { finalText: "cursor ok" } };
      },
    }),
  });
  const receipt = await companion.start({
    requestId: "usage-retry-clear",
    target: "pi",
    task: "t",
    cwd: process.cwd(),
    policy: { write: false },
  });

  assert.equal(receipt.state, "completed");
  assert.equal(receipt.target, "cursor");
  assert.equal(receipt.usage, null);
  assert.equal(receipt.usageSummary, null, "the failed attempt's summary must not leak into the retry");
  assert.equal(receipt.usageAttempts[0].usageSummary.cacheReadTokens, 0);
  assert.equal(receipt.usageAttempts[0].usageReported, true);
  assert.equal(receipt.usageAttempts[1].usageReported, false);
});

test("resume carries the parent's immutable ledger, totals and lineage without duplication", async (t) => {
  let calls = 0;
  const { companion } = await fixture(t, "usage-resume", {
    adapterFactory: () => ({
      async run(_request, { onProgress } = {}) {
        calls += 1;
        if (calls === 1) {
          await onProgress?.({ type: "cursor_progress", usage: { inputTokens: 50, outputTokens: 9, cacheReadTokens: 4, cacheWriteTokens: 2 } });
          throw transportError();
        }
        return { result: { finalText: "ok" }, usage: { inputTokens: 3, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } };
      },
    }),
  });
  const first = await companion.start({
    requestId: "usage-resume",
    target: "cursor",
    task: "t",
    cwd: process.cwd(),
    policy: { write: false },
    route: { provider: "x", model: "y" },
  });
  const resumed = await companion.resume(first.jobId);

  assert.equal(resumed.resumeOf, first.jobId);
  assert.equal(resumed.usageAttempts.length, 2);
  assert.deepEqual(resumed.usageAttempts[0], first.usageAttempts[0]);
  assert.equal(resumed.usageAttempts[0].jobId, first.jobId);
  assert.equal(resumed.usageAttempts[0].attempt, 1);
  assert.equal(resumed.usageAttempts[1].jobId, resumed.jobId);
  assert.equal(resumed.usageAttempts[1].attempt, 2);
  assert.equal(resumed.usageTotals.reportedAttempts, 2);

  const third = await companion.resume(resumed.jobId, { task: "follow up" });
  assert.equal(third.resumeOf, resumed.jobId);
  assert.equal(third.usageAttempts.length, 3);
  assert.deepEqual(third.usageAttempts.slice(0, 2).map((entry) => entry.jobId), [first.jobId, resumed.jobId]);
  assert.equal(third.usageAttempts[2].attempt, 3);
  assert.equal(third.usageAttempts[2].jobId, third.jobId);
});

test("resume caps an unbounded carried ledger and keeps totals plus dropped count", async (t) => {
  const { store, companion } = await fixture(t, "usage-cap", {
    adapterFactory: () => ({
      async run() {
        return { result: { finalText: "ok" } };
      },
    }),
  });
  const request = normalizeRequest({
    requestId: "usage-cap",
    target: "pi",
    task: "seed",
    cwd: process.cwd(),
    policy: { write: false },
  });
  const receipt = createReceipt(request, {
    state: "failed",
    error: { name: "SeedError", message: "seeded parent", details: { kind: "downstream" } },
  });
  const entries = Array.from({ length: 25 }, (_, index) => ({
    attempt: index + 1,
    jobId: `seed-${index + 1}`,
    target: "pi",
    route: {},
    state: "failed",
    usageReported: true,
    usage: { tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: 0 },
    usageSummary: {
      inputTokens: 1,
      uncachedInputTokens: 1,
      inputSemantics: "exclusive",
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
    },
  }));
  receipt.usageAttempts = entries;
  receipt.usageAttemptsDropped = 0;
  receipt.usageTotals = entries.reduce((totals, entry) => addUsageToTotals(totals, entry.usageSummary), emptyUsageTotals());
  await store.putIfRequestAbsent({
    request,
    receipt,
    trace: { eventCount: 0, lastEventAt: null, lastActivity: null, progress: receipt.trace.progress },
    lease: null,
    controls: [],
  });

  const resumed = await companion.resume(receipt.jobId);
  assert.equal(resumed.usageAttemptsDropped, 6, "five carry-drops plus one hard-cap eviction");
  assert.equal(resumed.usageAttempts.length, 20);
  assert.equal(resumed.usageAttempts[0].jobId, "seed-7");
  assert.equal(resumed.usageAttempts[0].attempt, 7);
  assert.equal(resumed.usageAttempts.at(-1).attempt, 26);
  assert.equal(resumed.usageTotals.reportedAttempts, 25, "carried totals cover the dropped entries");
  assert.equal(resumed.usageTotals.partial, true, "the new silent attempt is recorded as unreported");
});

test("cancel folds the live entry into totals once and resume keeps the sum", async (t) => {
  const progressCommitted = deferred();
  let calls = 0;
  const { companion } = await fixture(t, "usage-cancel-resume", {
    adapterFactory: () => ({
      async run(_request, { signal, onProgress } = {}) {
        calls += 1;
        if (calls === 1) {
          await onProgress?.({ type: "cursor_progress", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1 } });
          progressCommitted.resolve();
          await new Promise((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", resolve, { once: true });
          });
          throw Object.assign(new Error("aborted"), { details: { aborted: true } });
        }
        return {
          result: { finalText: "ok" },
          usage: { inputTokens: 3, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      },
    }),
  });
  const started = await companion.start({
    requestId: "usage-cancel-resume",
    target: "cursor",
    task: "t",
    cwd: process.cwd(),
    policy: { write: false },
    route: { provider: "x", model: "y" },
    execution: { background: true },
  });
  await progressCommitted.promise;
  const execution = companion.running.get(started.jobId).promise;
  await companion.cancel(started.jobId);
  const cancelled = await execution;

  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.usageTotals.reportedAttempts, 1, "the live cancelled entry is folded");
  assert.equal(cancelled.usageTotals.outputTokens, 5);
  assert.equal(cancelled.usageTotals.cacheReadTokens, 2);
  assert.equal(cancelled.usageTotals.cacheWriteTokens, 1);
  assert.equal(cancelled.usageTotals.partial, true);

  // A repeated cancel is idempotent: same terminal receipt, no second fold.
  const again = await companion.cancel(started.jobId);
  assert.deepEqual(again.usageTotals, cancelled.usageTotals);
  assert.equal(again.usageAttempts.length, 1);

  const resumed = await companion.resume(cancelled.jobId, { execution: { background: false } });
  assert.equal(resumed.state, "completed");
  assert.equal(resumed.usageTotals.reportedAttempts, 2);
  assert.equal(resumed.usageTotals.outputTokens, 6);
  assert.equal(resumed.usageTotals.cacheReadTokens, 2, "the cancelled attempt's usage is summed exactly once");
  assert.equal(resumed.usageAttempts[0].state, "cancelled");
  assert.equal(resumed.usageAttempts[0].usageSummary.outputTokens, 5);
});

test("resume folds a stale crashed running entry into totals exactly once", async (t) => {
  const { store, companion } = await fixture(t, "usage-stale", {
    adapterFactory: () => ({
      async run() {
        return { result: { finalText: "ok" } };
      },
    }),
  });

  const runningEntry = {
    attempt: 1,
    jobId: "seed-stale-1",
    target: "cursor",
    route: {},
    state: "running",
    usageReported: true,
    usage: { inputTokens: 7, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 },
    usageSummary: {
      inputTokens: null,
      uncachedInputTokens: null,
      inputSemantics: "unknown",
      outputTokens: 7,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: null,
    },
  };

  const buildParent = async (requestId, withTotals) => {
    const request = normalizeRequest({ requestId, target: "cursor", task: "seed", cwd: process.cwd(), policy: { write: false } });
    const receipt = createReceipt(request, {
      state: "partial",
      error: { name: "InterruptedExecution", message: "seeded parent", details: { kind: "interrupted" } },
    });
    receipt.usageAttempts = [{ ...runningEntry, jobId: `${requestId}-job` }];
    receipt.usageAttemptsDropped = 0;
    if (withTotals) receipt.usageTotals = emptyUsageTotals();
    await store.putIfRequestAbsent({
      request,
      receipt,
      trace: { eventCount: 0, lastEventAt: null, lastActivity: null, progress: receipt.trace.progress },
      lease: null,
      controls: [],
    });
    return receipt;
  };

  for (const withTotals of [true, false]) {
    const requestId = withTotals ? "usage-stale-totals" : "usage-stale-derived";
    const parent = await buildParent(requestId, withTotals);
    const resumed = await companion.resume(parent.jobId);

    assert.equal(resumed.usageTotals.reportedAttempts, 1, `${requestId}: the running entry is counted once`);
    assert.equal(resumed.usageTotals.outputTokens, 7);
    assert.equal(resumed.usageTotals.cacheReadTokens, 0);
    assert.equal(resumed.usageAttempts[0].state, "partial", `${requestId}: the interrupted entry is truthful`);
    assert.equal(resumed.usageTotals.unreportedAttempts, 1, `${requestId}: the silent resumed attempt is unreported`);

    const storedParent = await store.get(parent.jobId);
    assert.equal(storedParent.receipt.usageAttempts[0].state, "running", `${requestId}: the parent receipt is not mutated`);
    assert.equal(storedParent.receipt.usageTotals?.reportedAttempts ?? 0, 0);
  }
});

test("a valueless terminal summary cannot erase a known progress summary", async (t) => {
  const { companion } = await fixture(t, "usage-clobber", {
    adapterFactory: () => ({
      async run(_request, { onProgress } = {}) {
        await onProgress?.({ type: "cursor_progress", usage: { inputTokens: 50, outputTokens: 9, cacheReadTokens: 4, cacheWriteTokens: 2 } });
        return { result: { finalText: "ok" }, usage: null, usageSummary: null };
      },
    }),
  });
  const receipt = await companion.start({
    requestId: "usage-clobber",
    target: "cursor",
    task: "t",
    cwd: process.cwd(),
    policy: { write: false },
    route: { provider: "x", model: "y" },
  });

  assert.equal(receipt.state, "completed");
  assert.equal(receipt.usage, null, "the legacy raw field keeps its own contract");
  assert.equal(receipt.usageSummary.outputTokens, 9);
  assert.equal(receipt.usageSummary.cacheReadTokens, 4);
  assert.equal(receipt.usageAttempts[0].usageReported, true);
  assert.equal(receipt.usageAttempts[0].usageSummary.outputTokens, 9);
  assert.equal(receipt.usageTotals.reportedAttempts, 1);
  assert.equal(receipt.usageTotals.outputTokens, 9);
});

test("the hard cap holds across a resumed attempt and an in-run fallback", async (t) => {
  const { store, companion } = await fixture(t, "usage-cap-fallback", {
    routeResolver: rankedResolver(),
    adapterFactory: (target) => ({
      async run(_request, { onProgress } = {}) {
        await onProgress?.({ type: "cursor_progress", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1 } });
        if (target === "pi") throw transportError();
        return { result: { finalText: "ok" }, usage: { inputTokens: 3, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } };
      },
    }),
  });
  const request = normalizeRequest({ requestId: "usage-cap-fallback", target: "pi", task: "seed", cwd: process.cwd(), policy: { write: false } });
  const receipt = createReceipt(request, {
    state: "failed",
    error: { name: "SeedError", message: "seeded parent", details: { kind: "downstream" } },
  });
  const summary = {
    inputTokens: 1,
    uncachedInputTokens: 1,
    inputSemantics: "exclusive",
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
  };
  receipt.usageAttempts = Array.from({ length: 20 }, (_, index) => ({
    attempt: index + 1,
    jobId: `seed-${index + 1}`,
    target: "pi",
    route: {},
    state: "failed",
    usageReported: true,
    usage: {},
    usageSummary: summary,
  }));
  receipt.usageAttemptsDropped = 0;
  receipt.usageTotals = receipt.usageAttempts.reduce((totals, entry) => addUsageToTotals(totals, entry.usageSummary), emptyUsageTotals());
  await store.putIfRequestAbsent({
    request,
    receipt,
    trace: { eventCount: 0, lastEventAt: null, lastActivity: null, progress: receipt.trace.progress },
    lease: null,
    controls: [],
  });

  const resumed = await companion.resume(receipt.jobId);

  assert.equal(resumed.state, "completed");
  assert.equal(resumed.usageAttempts.length, 20, "the ledger never exceeds the hard cap");
  assert.equal(resumed.usageAttemptsDropped, 2, "one eviction per opened attempt after the carried cap");
  assert.equal(resumed.usageAttempts[0].attempt, 3);
  assert.equal(resumed.usageAttempts.at(-1).attempt, 22);
  assert.equal(resumed.usageTotals.reportedAttempts, 22, "both fallback attempts are folded once");
  assert.equal(resumed.usageTotals.unreportedAttempts, 0);
  // 20 seed attempts (1 each) + the failed attempt's progress (5) + the
  // completed attempt's terminal usage, which supersedes its progress (1).
  assert.equal(resumed.usageTotals.outputTokens, 26);
});

test("cancel persists the live ledger once with a truthful cancelled state", async (t) => {
  const progressCommitted = deferred();
  const { companion, store } = await fixture(t, "usage-cancel", {
    adapterFactory: () => ({
      async run(_request, { signal, onProgress } = {}) {
        await onProgress?.({ type: "cursor_progress", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1 } });
        progressCommitted.resolve();
        await new Promise((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", resolve, { once: true });
        });
        throw Object.assign(new Error("aborted"), { details: { aborted: true } });
      },
    }),
  });
  const started = await companion.start({
    requestId: "usage-cancel",
    target: "cursor",
    task: "t",
    cwd: process.cwd(),
    policy: { write: false },
    route: { provider: "x", model: "y" },
    execution: { background: true },
  });
  await progressCommitted.promise;

  const live = await store.get(started.jobId);
  assert.equal(live.receipt.usageAttempts.length, 1);
  assert.equal(live.receipt.usageAttempts[0].state, "running");
  assert.equal(live.receipt.usageAttempts[0].usageReported, true);

  const execution = companion.running.get(started.jobId).promise;
  await companion.cancel(started.jobId);
  const cancelled = await execution;
  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.usageAttempts.length, 1, "the running entry is not duplicated");
  assert.equal(cancelled.usageAttempts[0].state, "cancelled");
  assert.equal(cancelled.usageAttempts[0].usageReported, true);
  assert.equal(cancelled.usageSummary.cacheReadTokens, 2);
  assert.deepEqual(cancelled.usage, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1 });

  const reread = await companion.status(started.jobId);
  assert.deepEqual(reread.usageAttempts, cancelled.usageAttempts);
});
