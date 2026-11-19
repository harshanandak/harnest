import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Companion } from "../src/companion.mjs";
import { JobStore } from "../src/job-store.mjs";
import { createReceipt, normalizeRequest } from "../src/protocol.mjs";
import { summarizeUsage } from "../src/usage.mjs";

const passthroughRoute = async (request) => request;

async function fixture(adapterFactory, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "harnest-test-"));
  const store = new JobStore(root);
  return {
    root,
    store,
    companion: new Companion({ store, adapterFactory, routeResolver: passthroughRoute, ...options }),
  };
}

test("ACP cleanup uncertainty is persisted and blocks direct resume", async (t) => {
  let launches = 0;
  const { root, companion } = await fixture(() => ({
    async run() {
      launches += 1;
      throw Object.assign(new Error("ACP process exit was not verified"), {
        details: { kind: "transport", unsafeResume: true, cleanupError: [{ component: "process", message: "exit unverified" }] },
      });
    },
  }));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const receipt = await companion.start({
    requestId: "unsafe-acp-direct",
    target: "acp",
    task: "run the configured ACP agent",
    cwd: process.cwd(),
    route: { agent: "fixture-agent" },
    policy: { write: true },
  });
  assert.equal(receipt.state, "failed");
  assert.equal(receipt.error.details.unsafeResume, true);
  assert.equal(receipt.error.details.cleanupError[0].component, "process");
  await assert.rejects(
    () => companion.resume(receipt.jobId),
    (error) => error.details?.kind === "unsafe-resume",
  );
  assert.equal(launches, 1, "direct resume must not relaunch an unverified native process");
});

test("an ACP session observed only on failure survives persistence and resumes that native session", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harnest-acp-failure-session-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const request = {
    requestId: "acp-failure-session",
    target: "acp",
    task: "continue the configured ACP agent",
    cwd: process.cwd(),
    context: { marker: "identity-stays-stable" },
    route: { agent: "fixture-agent" },
    policy: { write: true },
  };
  const first = new Companion({
    store: new JobStore(root),
    routeResolver: passthroughRoute,
    adapterFactory: () => ({
      async run() {
        throw Object.assign(new Error("failed after ACP session creation"), {
          details: { kind: "downstream", sessionId: "  native-acp-session  " },
        });
      },
    }),
  });
  const failed = await first.start(request);
  assert.equal(failed.state, "failed");
  assert.equal(failed.sessionId, "  native-acp-session  ");
  assert.equal(failed.error.details.sessionId, "  native-acp-session  ");

  const resumedRequests = [];
  const fresh = new Companion({
    store: new JobStore(root),
    routeResolver: passthroughRoute,
    adapterFactory: () => ({
      async run(resumed) {
        resumedRequests.push(resumed);
        return { sessionId: resumed.execution.sessionId, result: { finalText: "continued native ACP session" } };
      },
    }),
  });
  const durable = await fresh.status(failed.jobId);
  assert.equal(durable.sessionId, "  native-acp-session  ");
  assert.equal(durable.requestId, request.requestId);
  assert.equal(durable.contextDigest, failed.contextDigest);
  const completed = await fresh.resume(failed.jobId);
  assert.equal(completed.state, "completed");
  assert.equal(resumedRequests.length, 1);
  assert.equal(resumedRequests[0].execution.sessionId, "  native-acp-session  ", "resume must preserve the exact observed native session token");
  assert.deepEqual(resumedRequests[0].context, request.context);
});

test("a cancelled ACP run retains a pre-progress native session without persisting a mutated identity", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harnest-acp-cancelled-session-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const request = {
    requestId: "acp-cancelled-session",
    target: "acp",
    task: "continue the cancelled ACP agent",
    cwd: process.cwd(),
    route: { agent: "fixture-agent" },
    policy: { write: true },
  };
  const first = new Companion({
    store: new JobStore(root),
    routeResolver: passthroughRoute,
    adapterFactory: () => ({
      async run() {
        throw Object.assign(new Error("cancelled after ACP session creation"), {
          details: { kind: "abort", aborted: true, sessionId: "native-cancelled-session" },
        });
      },
    }),
  });
  const cancelled = await first.start(request);
  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.error, null);
  assert.equal(cancelled.sessionId, "native-cancelled-session");

  const resumedRequests = [];
  const fresh = new Companion({
    store: new JobStore(root),
    routeResolver: passthroughRoute,
    adapterFactory: () => ({
      async run(resumed) {
        resumedRequests.push(resumed);
        return { sessionId: resumed.execution.sessionId, result: { finalText: "continued cancelled ACP session" } };
      },
    }),
  });
  assert.equal((await fresh.status(cancelled.jobId)).sessionId, "native-cancelled-session");
  assert.equal((await fresh.resume(cancelled.jobId)).state, "completed");
  assert.equal(resumedRequests[0].execution.sessionId, "native-cancelled-session");

  const unsafeIdentity = new Companion({
    stateDir: join(root, "unsafe-identity"),
    routeResolver: passthroughRoute,
    adapterFactory: () => ({
      async run() {
        throw Object.assign(new Error("failed with unsafe identity"), {
          details: { kind: "downstream", sessionId: "api_key=private-value" },
        });
      },
    }),
  });
  const rejectedIdentity = await unsafeIdentity.start({ ...request, requestId: "acp-redacted-session" });
  assert.equal(rejectedIdentity.sessionId, null, "a redaction-mutated native identity must be explicitly unavailable");
  assert.equal(rejectedIdentity.error.details.sessionId, undefined);
});

test("multi-model comparison sends identical read-only context to distinct resolved routes", async (t) => {
  const seen = [];
  const { root, companion } = await fixture(() => ({
    async run(request) {
      seen.push(request);
      return { result: { finalText: `opinion:${request.route.model}` }, route: request.route };
    },
  }), { routeResolver: async (request) => request });
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  const comparison = await companion.compare({
    request: {
      requestId: "compare-opinions",
      target: "pi",
      task: "Research the same question.",
      cwd: process.cwd(),
      context: { question: "Which option is better?" },
      policy: { write: false },
    },
    candidates: [
      { name: "first", route: { provider: "gateway-a", model: "model-a" } },
      { name: "second", route: { provider: "gateway-b", model: "model-b" } },
    ],
  });

  assert.equal(comparison.state, "completed");
  assert.equal(comparison.lanes.length, 2);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].task, seen[1].task);
  assert.equal(seen[0].contextDigest, seen[1].contextDigest);
  assert.deepEqual(new Set(seen.map((request) => request.route.model)), new Set(["model-a", "model-b"]));
  assert.deepEqual(comparison.lanes.map((lane) => lane.receipt.result.finalText).sort(), ["opinion:model-a", "opinion:model-b"]);
});

test("multi-model comparison rejects duplicate resolved routes before launching", async (t) => {
  let launches = 0;
  const { root, companion } = await fixture(() => ({
    async run() {
      launches += 1;
      return { result: { finalText: "unexpected" } };
    },
  }), { routeResolver: async (request) => ({ ...request, route: { provider: "same", model: "same" } }) });
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  await assert.rejects(companion.compare({
    request: { requestId: "compare-duplicate", target: "pi", task: "same", cwd: process.cwd() },
    candidates: [
      { name: "one", route: { model: "one" } },
      { name: "two", route: { model: "two" } },
    ],
  }), /resolve to the same route/);
  assert.equal(launches, 0);
});

test("read-only comparison and review reject OpenCode before starting any lane", async (t) => {
  let launches = 0;
  const { root, companion } = await fixture(() => ({
    async run() {
      launches += 1;
      return { result: { finalText: "unexpected" } };
    },
  }), { routeResolver: async (request) => request });
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const request = { requestId: "read-only-fanout", target: "pi", task: "same", cwd: process.cwd() };
  const lanes = [
    { name: "pi", target: "pi", route: { model: "one" } },
    { name: "open-code", target: "opencode", route: { model: "test/two" } },
  ];
  for (const [tool, key] of [["compare", "candidates"], ["review", "reviewers"]]) {
    await assert.rejects(companion[tool]({ request, [key]: lanes }), /cannot enforce read-only/);
  }
  assert.equal(launches, 0);
});

test("multi-model comparison rejects shared-checkout writes", async (t) => {
  const { root, companion } = await fixture(() => ({ async run() { return { result: { finalText: "unexpected" } }; } }), {
    routeResolver: async (request) => request,
  });
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  await assert.rejects(companion.compare({
    request: { requestId: "compare-write", target: "opencode", task: "edit", cwd: process.cwd(), policy: { write: true } },
    candidates: [
      { name: "one", route: { model: "one" } },
      { name: "two", route: { model: "two" } },
    ],
  }), /must be read-only/);
});

test("multi-model comparison preserves successful receipts when one lane fails", async (t) => {
  const { root, companion } = await fixture(() => ({
    async run(request) {
      if (request.route.model === "fails") throw new Error("independent provider failure");
      return { result: { finalText: "independent success" }, route: request.route };
    },
  }), { routeResolver: async (request) => request });
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const comparison = await companion.compare({
    request: { requestId: "compare-partial", target: "pi", task: "research", cwd: process.cwd() },
    candidates: [
      { name: "works", route: { provider: "one", model: "works" } },
      { name: "fails", route: { provider: "two", model: "fails" } },
    ],
  });
  assert.equal(comparison.state, "partial");
  assert.equal(comparison.lanes.find((lane) => lane.name === "works").receipt.result.finalText, "independent success");
  assert.equal(comparison.lanes.find((lane) => lane.name === "fails").receipt.state, "failed");
});

test("foreground handoff returns a parent-visible terminal receipt", async (t) => {
  const { root, companion } = await fixture(() => ({
    async run(request) {
      return {
        sessionId: "session-canary",
        workflowRunId: "flow-canary",
        route: request.route,
        result: { finalText: "PARENT_RECEIVED_TERMINAL_PAYLOAD" },
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
  }));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  const receipt = await companion.start({
    requestId: "foreground-canary-request",
    target: "opencode",
    policy: { write: true },
    task: "return canary",
    cwd: process.cwd(),
    context: { canary: "PARENT_RECEIVED_TERMINAL_PAYLOAD" },
  });
  assert.equal(receipt.state, "completed");
  assert.equal(receipt.result.finalText, "PARENT_RECEIVED_TERMINAL_PAYLOAD");
  assert.equal(receipt.sessionId, "session-canary");
});

test("terminal usageSummary survives persistence and a fresh Companion result/trace for all seven targets", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harnest-usage-flow-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const store = new JobStore(root);
  const fixtures = {
    opencode: {
      raw: { input: 3, output: 6, cacheRead: 2, cacheWrite: 1, cost: 0.01, contextTokens: 9, turns: 1 },
      reported: { input: true, output: true, cacheRead: true, cacheWrite: true, cost: true },
    },
    pi: {
      raw: { sessionId: "pi-s", tokens: { input: 12, output: 4, cacheRead: 8, cacheWrite: 2, total: 26 }, cost: 0.03 },
      reported: null,
    },
    cursor: {
      raw: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1 },
      reported: null,
    },
    claude: {
      raw: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 10, cacheWriteTokens: 5, totalCostUsd: 0.01 },
      reported: null,
    },
    codex: {
      raw: { input_tokens: 12, cached_input_tokens: 8, output_tokens: 4, reasoning_output_tokens: 1 },
      reported: null,
    },
    gemini: {
      raw: { input_tokens: 12, output_tokens: 4 },
      reported: null,
    },
    amp: {
      raw: { inputTokens: 12, outputTokens: 4 },
      reported: null,
    },
  };
  const first = new Companion({
    store,
    routeResolver: passthroughRoute,
    adapterFactory: (target) => ({
      async run(request) {
        const fixture = fixtures[target];
        return {
          sessionId: `session-${target}`,
          route: request.route,
          result: { finalText: `${target} done` },
          usage: fixture.raw,
          usageSummary: summarizeUsage(target, fixture.raw, { reported: fixture.reported }),
        };
      },
    }),
  });

  const receipts = {};
  for (const target of Object.keys(fixtures)) {
    receipts[target] = await first.start({
      requestId: `usage-flow-${target}`,
      target,
      task: `run ${target}`,
      cwd: process.cwd(),
      route: target === "amp" ? { variant: "medium" } : { model: target === "gemini" ? "gemini-fixture" : "fixture-model" },
      policy: { write: ["opencode", "amp"].includes(target) },
    });
  }

  const fresh = new Companion({
    store,
    routeResolver: passthroughRoute,
    adapterFactory: () => ({ async run() { throw new Error("a fresh read must not launch an adapter"); } }),
  });
  for (const target of Object.keys(fixtures)) {
    const receipt = receipts[target];
    const expected = ["gemini", "amp"].includes(target)
      ? null
      : summarizeUsage(target, fixtures[target].raw, { reported: fixtures[target].reported });
    assert.equal(receipt.state, "completed");
    assert.deepEqual(receipt.usageSummary, expected);
    if (["gemini", "amp"].includes(target)) {
      assert.equal(receipt.usageSummary, null, `${target} stays truthful until its native usage shape is verified`);
    } else {
      assert.notEqual(receipt.usageSummary.cacheReadTokens, null, `${target} must expose a reported cache read`);
    }
    const reread = await fresh.result(receipt.jobId);
    assert.deepEqual(reread.usageSummary, expected, `${target} summary must survive job-store re-read`);
    const trace = await fresh.traceReference({ jobId: receipt.jobId });
    assert.deepEqual(trace.receipt.usageSummary, expected, `${target} summary must survive the trace view`);
  }
});

test("background result preserves the same receipt and context digest", async (t) => {
  const { root, companion } = await fixture(() => ({
    async run() {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { result: { finalText: "done" }, sessionId: "s1", workflowRunId: "w1" };
    },
  }));
  t.after(() => rm(root, { recursive: true, force: true }));

  const queued = await companion.start({
    requestId: "background-request",
    target: "pi",
    task: "background",
    cwd: process.cwd(),
    context: { stable: true },
    execution: { background: true },
  });
  assert.equal(queued.state, "queued");
  let receipt;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    receipt = await companion.status(queued.jobId);
    if (receipt.state === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(receipt.state, "completed");
  assert.equal(receipt.contextDigest, queued.contextDigest);
  assert.deepEqual(await companion.result(queued.jobId), receipt);
});

test("detachBackground hands a background job to a detached worker process", { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harnest-test-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const adapterPath = join(root, "worker-adapter.mjs");
  await writeFile(adapterPath, `
import { appendFileSync } from "node:fs";
export const adapterFactory = () => ({
  async run(request) {
    appendFileSync(${JSON.stringify(join(root, "runs.jsonl"))}, JSON.stringify({ pid: process.pid }) + "\\n");
    await new Promise((resolve) => setTimeout(resolve, 200));
    return { sessionId: "detached-session", result: { finalText: "DETACHED_CANARY" } };
  },
});
`);
  const previous = process.env.HARNEST_WORKER_ADAPTER;
  process.env.HARNEST_WORKER_ADAPTER = adapterPath;
  t.after(() => {
    if (previous === undefined) delete process.env.HARNEST_WORKER_ADAPTER;
    else process.env.HARNEST_WORKER_ADAPTER = previous;
  });
  let inProcessRuns = 0;
  const store = new JobStore(root);
  const companion = new Companion({
    store,
    detachBackground: true,
    routeResolver: passthroughRoute,
    adapterFactory: () => ({ async run() { inProcessRuns += 1; return { result: { finalText: "must not run in process" } }; } }),
  });

  const receipt = await companion.start({
    requestId: "detached-background-request",
    target: "pi",
    task: "run in the detached worker",
    cwd: process.cwd(),
    execution: { background: true, timeoutMs: 20_000 },
  });
  assert.equal(receipt.state, "queued");
  assert.equal(inProcessRuns, 0, "the calling process must not run a detached adapter");

  let settled;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    settled = (await store.get(receipt.jobId)).receipt;
    if (["completed", "failed", "cancelled", "partial"].includes(settled.state)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(settled.state, "completed");
  assert.equal(settled.result.finalText, "DETACHED_CANARY");
  assert.equal(settled.sessionId, "detached-session");
  const runs = (await readFile(join(root, "runs.jsonl"), "utf8")).trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(runs.length, 1);
  assert.notEqual(runs[0].pid, process.pid);
});

test("detachBackground leaves foreground runs in the calling process", async (t) => {
  const { root, companion } = await fixture(() => ({
    async run() {
      return { result: { finalText: "foreground-in-process" } };
    },
  }), { detachBackground: true });
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  const receipt = await companion.start({
    requestId: "detach-foreground-request",
    target: "pi",
    task: "stay in process",
    cwd: process.cwd(),
    execution: { timeoutMs: 10_000 },
  });
  assert.equal(receipt.state, "completed");
  assert.equal(receipt.result.finalText, "foreground-in-process");
});

test("a foreground conversion recorded in request metadata is carried into the durable receipt", async (t) => {
  const { root, companion } = await fixture(() => ({
    async run() {
      return { result: { finalText: "converted" }, sessionId: "converted-session" };
    },
  }));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  const receipt = await companion.start({
    requestId: "foreground-converted-request",
    target: "pi",
    task: "converted foreground",
    cwd: process.cwd(),
    execution: { background: true, timeoutMs: 120_000 },
    metadata: {
      harnest: {
        execution: {
          foregroundConverted: true,
          convertedAt: "2026-09-15T00:00:00.000Z",
          requestedTimeoutMs: 120_000,
          safeForegroundWaitMs: 55_000,
          hint: "poll handoff_status with its jobId or requestId",
        },
      },
    },
  });
  assert.equal(receipt.state, "queued");
  assert.equal(receipt.execution.foregroundConverted, true);
  assert.equal(receipt.execution.requestedTimeoutMs, 120_000);
  assert.equal(receipt.execution.safeForegroundWaitMs, 55_000);
  assert.match(receipt.execution.hint, /handoff_status/);

  let settled;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    settled = await companion.status(receipt.jobId);
    if (settled.state === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(settled.state, "completed");
  assert.equal(settled.execution.foregroundConverted, true, "the conversion flag survives to the terminal receipt");
});

test("cancel is distinct from downstream failure", async (t) => {
  let entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  const { root, companion } = await fixture(() => ({
    async run(_request, { signal }) {
      entered();
      await new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { details: { aborted: true } })), {
          once: true,
        });
      });
    },
  }));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  const queued = await companion.start({
    requestId: "cancel-request",
    target: "pi",
    task: "cancel me",
    cwd: process.cwd(),
    execution: { background: true },
  });
  await ready;
  const execution = companion.running.get(queued.jobId).promise;
  const requested = await companion.cancel(queued.jobId);
  assert.equal(requested.state, "running");
  assert.equal(requested.cancellation.state, "requested");
  const receipt = await execution;
  assert.equal(receipt.state, "cancelled");
  assert.equal(receipt.cancellation.state, "acknowledged");
  assert.equal(receipt.error, null);
});

test("owner adopts a pre-recorded cancellation intent and aborts the live run", async (t) => {
  let aborted = false;
  const { root, companion } = await fixture(() => ({
    async run(_request, { signal }) {
      await new Promise((resolve) => {
        if (signal.aborted) return resolve();
        const timer = setTimeout(resolve, 5_000);
        signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
      if (signal.aborted) { aborted = true; throw Object.assign(new Error("stopped"), { details: { aborted: true } }); }
      return { result: { finalText: "completed" } };
    },
  }));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  const queued = await companion.start({
    requestId: "adopt-cancel-request",
    target: "pi",
    task: "hold me",
    cwd: process.cwd(),
    execution: { background: true },
  });
  // The graph runner's cross-process #stop records the intent first; the owner
  // must still adopt it and abort its live run instead of returning a status.
  await companion.store.transition(queued.jobId, (job) => {
    job.receipt.cancellation = { state: "requested", requestedAt: new Date().toISOString(), requestedBy: "other-process", acknowledgedAt: null };
    return job;
  });
  let receipt = await companion.cancel(queued.jobId);
  for (let attempt = 0; attempt < 300 && receipt.state !== "cancelled"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    receipt = await companion.status(queued.jobId);
  }
  assert.equal(receipt.state, "cancelled");
  assert.equal(receipt.cancellation.state, "acknowledged");
  assert.equal(aborted, true, "the live run must observe the abort");
});

test("cancel returns promptly and cannot acknowledge a stuck worker", async (t) => {
  let entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  const { root, companion } = await fixture(() => ({
    async run() {
      entered();
      await new Promise(() => {});
    },
  }), { cancelAckTimeoutMs: 20 });
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  const queued = await companion.start({
    requestId: "stuck-cancel-request",
    target: "pi",
    task: "never settles",
    cwd: process.cwd(),
    execution: { background: true },
  });
  await ready;
  const execution = companion.running.get(queued.jobId).promise;
  const receipt = await Promise.race([
    companion.cancel(queued.jobId),
    new Promise((_, reject) => setTimeout(() => reject(new Error("cancel did not return promptly")), 5_000)),
  ]);
  assert.equal(receipt.state, "running");
  assert.equal(receipt.cancellation.state, "requested");
  const settled = await execution;
  assert.equal(settled.state, "partial");
  assert.equal(settled.cancellation.state, "unacknowledged");
  assert.equal(settled.error.details.kind, "cancel-unacknowledged");
  assert.equal(companion.running.has(queued.jobId), false);
});

test("status reconciles a stale heartbeat even when the worker remains registered", async (t) => {
  const { root, store, companion } = await fixture(() => ({
    async run() {
      await new Promise(() => {});
    },
  }));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  const queued = await companion.start({
    requestId: "stale-registered-request",
    target: "pi",
    task: "stale worker",
    cwd: process.cwd(),
    execution: { background: true },
  });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const current = await store.get(queued.jobId);
    if (current.receipt.state === "running") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const staleAt = new Date(Date.now() - 120_000).toISOString();
  await store.transition(queued.jobId, (current) => {
    current.lease.heartbeatAt = staleAt;
    current.receipt.recovery.heartbeatAt = staleAt;
    return current;
  });

  const receipt = await companion.status(queued.jobId);
  assert.equal(receipt.state, "partial");
  assert.equal(receipt.error.details.kind, "interrupted");
  assert.equal(companion.running.has(queued.jobId), false);
});

test("transport failure cannot masquerade as findings", async (t) => {
  const { root, companion } = await fixture(() => ({
    async run() {
      throw new Error("transport unavailable");
    },
  }));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  const receipt = await companion.start({ requestId: "transport-failure-request", target: "opencode", task: "fail", cwd: process.cwd(), policy: { write: true } });
  assert.equal(receipt.state, "failed");
  assert.match(receipt.error.message, /transport unavailable/);
  assert.equal(receipt.result, null);
});

test("late progress persistence cannot overwrite a terminal receipt", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harnest-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  class DelayedSnapshotStore extends JobStore {
    async put(job) {
      const snapshot = structuredClone(job);
      if (snapshot.trace?.eventCount && snapshot.receipt.state === "running") {
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      return super.put(snapshot);
    }
  }
  const companion = new Companion({
    store: new DelayedSnapshotStore(root),
    routeResolver: passthroughRoute,
    adapterFactory: () => ({
      async run(_request, { onProgress }) {
        void onProgress({ phase: "late-write" });
        return { result: { finalText: "done" }, sessionId: "s-race", workflowRunId: "w-race" };
      },
    }),
  });
  const receipt = await companion.start({ requestId: "late-progress-race-request", target: "pi", task: "race", cwd: process.cwd() });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(receipt.state, "completed");
  assert.equal((await companion.status(receipt.jobId)).state, "completed");
});

test("append-only trace and request-id lookup survive outside the compact receipt", { timeout: 30_000 }, async (t) => {
  const { root, store, companion } = await fixture(() => ({
    async run(_request, { onProgress }) {
      await onProgress({ type: "tool", text: "read PROBE.md" });
      await onProgress({ type: "model", text: "verified marker" });
      return { result: { finalText: "done" }, sessionId: "s-trace", workflowRunId: "w-trace" };
    },
  }));
  t.after(() => rm(root, { recursive: true, force: true }));

  const receipt = await companion.start({
    requestId: "request-trace-lookup",
    target: "opencode",
    policy: { write: true },
    task: "trace",
    cwd: process.cwd(),
  });
  const trace = (await readFile(store.tracePath(receipt.jobId), "utf8"))
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  const snapshot = await store.get(receipt.jobId);

  assert.equal(receipt.state, "completed");
  assert.equal(receipt.trace.eventCount, trace.length);
  assert.equal(receipt.trace.progress.phase, "completed");
  assert.deepEqual(receipt.trace.progress.recent.slice(-3), ["read PROBE.md", "verified marker", "completed"]);
  assert.equal(snapshot.progress, undefined);
  assert.equal((await companion.statusByRequestId("request-trace-lookup")).jobId, receipt.jobId);
  assert.equal((await companion.resultReference({ requestId: "request-trace-lookup" })).state, "completed");
  const firstPage = await companion.traceReference({ requestId: "request-trace-lookup" }, { afterSequence: 0, limit: 2 });
  assert.equal(firstPage.events.length, 2);
  assert.equal(firstPage.hasMore, true);
  const nextPage = await companion.traceReference({ jobId: receipt.jobId }, { afterSequence: firstPage.nextSequence, limit: 20 });
  assert.ok(nextPage.events.some((record) => record.event?.type === "state" && record.event?.state === "completed"));
  assert.equal(nextPage.hasMore, false);
  const sessions = await companion.sessions({ target: "opencode" });
  assert.equal(sessions.sessions[0].jobId, receipt.jobId);
});

test("status reuses its own job snapshot instead of re-reading it for the trace summary", async (t) => {
  const { root, store, companion } = await fixture(() => ({
    async run(_request, { onProgress }) {
      await onProgress({ type: "model", text: "read PROBE.md" });
      return { result: { finalText: "done" }, sessionId: "s-snapshot", workflowRunId: "w-snapshot" };
    },
  }));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const receipt = await companion.start({ requestId: "status-snapshot-reuse", target: "opencode", task: "trace", cwd: process.cwd(), policy: { write: true } });
  assert.equal(receipt.state, "completed");

  // Instrument after start: the run's own bookkeeping reads must not count.
  const realGet = store.get.bind(store);
  const realSummary = store.traceSummary.bind(store);
  let jobReads = 0;
  let summaries = 0;
  let snapshotSummaries = 0;
  store.get = (...args) => { jobReads += 1; return realGet(...args); };
  store.traceSummary = (jobId, options = {}) => {
    summaries += 1;
    if (options.snapshot) snapshotSummaries += 1;
    return realSummary(jobId, options);
  };

  const status = await companion.status(receipt.jobId);
  assert.equal(jobReads, 1, "status must read the job snapshot exactly once");
  assert.equal(summaries, 1);
  assert.equal(snapshotSummaries, 1, "status must pass its already-read snapshot to traceSummary");
  assert.equal(status.state, "completed");
  assert.equal(status.trace.eventCount, receipt.trace.eventCount);
  assert.ok(status.trace.progress.recent.includes("read PROBE.md"), JSON.stringify(status.trace.progress));
});

test("trace retrieval redacts secrets and bounds transcript strings", async (t) => {
  const { root, store, companion } = await fixture(() => ({
    async run(_request, { onProgress }) {
      await onProgress({ type: "model", text: `api_key=private-value ${"x".repeat(5_000)}` });
      return { result: { finalText: "done" }, sessionId: "s-redact", workflowRunId: "w-redact" };
    },
  }));
  t.after(() => rm(root, { recursive: true, force: true }));
  const receipt = await companion.start({ requestId: "trace-redaction", target: "opencode", task: "trace", cwd: process.cwd(), policy: { write: true } });
  const trace = await store.readTrace(receipt.jobId, { afterSequence: 0, limit: 20 });
  const serialized = JSON.stringify(trace.events);
  assert.doesNotMatch(serialized, /private-value/);
  assert.match(serialized, /\[REDACTED\]/);
  assert.ok(serialized.length < 30_000);
});

test("running status reports semantic progress instead of heartbeat-only health", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { root, companion } = await fixture(() => ({
    async run(_request, { onProgress }) {
      await onProgress({ type: "tool", phase: "synthesis", text: "challenging remediation findings" });
      await gate;
      return { result: { finalText: "done" }, sessionId: "s-progress", workflowRunId: "w-progress" };
    },
  }));
  t.after(() => rm(root, { recursive: true, force: true }));

  const queued = await companion.start({
    requestId: "semantic-progress-request",
    target: "opencode",
    policy: { write: true },
    task: "report progress",
    cwd: process.cwd(),
    execution: { background: true, timeoutMs: 1_000 },
  });
  let running;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    running = await companion.status(queued.jobId);
    if (running.trace.progress?.current === "challenging remediation findings") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(running.state, "running");
  assert.equal(running.trace.progress.phase, "synthesis");
  assert.equal(running.trace.progress.current, "challenging remediation findings");
  assert.ok(running.trace.progress.recent.includes("challenging remediation findings"));
  release();
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const status = await companion.status(queued.jobId);
    if (status.state === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal((await companion.result(queued.jobId)).state, "completed");
});

test("live controls are durable, acknowledged, and idempotent", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const delivered = [];
  const adapter = {
    async run() {
      await gate;
      return { result: { finalText: "controlled" }, sessionId: "s-control", workflowRunId: null };
    },
    async control(command) {
      delivered.push(command);
      return { harness: "fake", command: command.kind, delivery: command.delivery };
    },
  };
  const { root, companion } = await fixture(() => adapter);
  t.after(() => rm(root, { recursive: true, force: true }));

  const queued = await companion.start({
    requestId: "live-control-request",
    target: "pi",
    task: "wait for control",
    cwd: process.cwd(),
    execution: { background: true, timeoutMs: 2_000 },
  });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((await companion.status(queued.jobId)).state === "running") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const message = await companion.message(queued.jobId, {
    commandId: "control-message-1",
    message: "Focus on the timeout edge case.",
    delivery: "steer",
  });
  assert.equal(message.state, "applied");
  assert.equal(message.effect, "next_agent_step");
  assert.equal(delivered.length, 1);

  const duplicate = await companion.message(queued.jobId, {
    commandId: "control-message-1",
    message: "Focus on the timeout edge case.",
    delivery: "steer",
  });
  assert.deepEqual(duplicate, message);
  assert.equal(delivered.length, 1);
  await assert.rejects(
    companion.message(queued.jobId, {
      commandId: "control-message-1",
      message: "A conflicting payload.",
      delivery: "steer",
    }),
    /already belongs to a different control/,
  );

  const reroute = await companion.reroute(queued.jobId, {
    commandId: "control-route-1",
    route: { provider: "openrouter", model: "deepseek/deepseek-v4-flash-0731" },
    message: "Continue with the cheaper route.",
    delivery: "follow_up",
  });
  assert.equal(reroute.state, "applied");
  assert.equal(reroute.effect, "next_model_request");
  const status = await companion.status(queued.jobId);
  assert.equal(status.controls.length, 2);
  assert.deepEqual(status.controls.map((control) => control.state), ["applied", "applied"]);

  release();
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((await companion.status(queued.jobId)).state === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await companion.result(queued.jobId);
});

test("one worker can steer another worker's handoff by job id", { timeout: 30_000 }, async (t) => {
  let releaseA;
  let releaseB;
  const gateA = new Promise((resolve) => { releaseA = resolve; });
  const gateB = new Promise((resolve) => { releaseB = resolve; });
  const delivered = [];
  const adapter = {
    async run(request) {
      await (request.requestId.includes("worker-a") ? gateA : gateB);
      return { result: { finalText: "done" }, sessionId: "s-x", workflowRunId: null };
    },
    async control(command) {
      delivered.push(command);
      return { harness: "fake", command: command.kind, delivery: command.delivery };
    },
  };
  const { root, companion } = await fixture(() => adapter);
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const startBoth = (key) => companion.start({
    requestId: key,
    target: "pi",
    task: "parallel worker",
    cwd: process.cwd(),
    execution: { background: true, timeoutMs: 2_000 },
  });
  const [jobA, jobB] = await Promise.all([startBoth("worker-a-job"), startBoth("worker-b-job")]);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const [a, b] = await Promise.all([companion.status(jobA.jobId), companion.status(jobB.jobId)]);
    if (a.state === "running" && b.state === "running") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  // Worker A discovers B's job and speaks to it; B's own controls stay empty.
  const found = await companion.sessions({ limit: 10 });
  assert.ok(found.sessions.some((s) => s.jobId === jobB.jobId));
  const message = await companion.message(jobB.jobId, {
    commandId: "a-to-b-1",
    message: "A here: prioritize the timeout edge case.",
    delivery: "steer",
  });
  assert.equal(message.state, "applied");
  const statusB = await companion.status(jobB.jobId);
  assert.equal(statusB.controls.length, 1);
  assert.equal(statusB.controls[0].commandId, "a-to-b-1");
  const statusA = await companion.status(jobA.jobId);
  assert.equal(statusA.controls.length, 0);
  // B can answer through the trace the next poll reads.
  const trace = await companion.traceReference({ jobId: jobB.jobId }, {});
  assert.ok(trace.events.some((e) => JSON.stringify(e).includes("a-to-b-1")));
  releaseA();
  releaseB();
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const [aState, bState] = [(await companion.status(jobA.jobId)).state, (await companion.status(jobB.jobId)).state];
    if (aState === "completed" && bState === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
});

test("a failed or ambiguous control is reported without failing the handoff", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { root, companion } = await fixture(() => ({
    async run() {
      await gate;
      return { result: { finalText: "main run survived" }, sessionId: "s-control-error" };
    },
    async control(command) {
      if (command.commandId === "uncertain-control") {
        throw Object.assign(new Error("acknowledgement lost"), { details: { kind: "control", uncertain: true } });
      }
      if (command.kind === "reroute") {
        throw Object.assign(new Error("model changed; prompt acknowledgement lost"), { details: { kind: "control", uncertain: true, modelSwitchApplied: true } });
      }
      throw Object.assign(new Error("control rejected"), { details: { kind: "control" } });
    },
  }));
  t.after(() => rm(root, { recursive: true, force: true }));
  const queued = await companion.start({
    requestId: "control-error-request",
    target: "opencode",
    policy: { write: true },
    task: "keep running",
    cwd: process.cwd(),
    execution: { background: true, timeoutMs: 2_000 },
  });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((await companion.status(queued.jobId)).state === "running") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const rejected = await companion.message(queued.jobId, {
    commandId: "rejected-control",
    message: "reject me",
  });
  assert.equal(rejected.state, "rejected");
  const uncertain = await companion.message(queued.jobId, {
    commandId: "uncertain-control",
    message: "maybe delivered",
  });
  assert.equal(uncertain.state, "uncertain");
  const switched = await companion.reroute(queued.jobId, {
    commandId: "partial-reroute",
    route: { provider: "fixture", model: "updated" },
    message: "maybe delivered after switching models",
  });
  assert.equal(switched.state, "uncertain");
  assert.equal(switched.effect, "delivery_unconfirmed");
  assert.deepEqual(switched.acknowledgement, { modelSwitchApplied: true, promptAcknowledged: false });
  assert.deepEqual((await companion.status(queued.jobId)).controls.at(-1).acknowledgement, switched.acknowledgement);
  release();
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((await companion.status(queued.jobId)).state === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal((await companion.result(queued.jobId)).state, "completed");
});

test("outer wall-clock timeout terminates a job even when an adapter never settles", async (t) => {
  const { root, companion } = await fixture(() => ({
    async run() {
      return new Promise(() => {});
    },
  }));
  t.after(() => rm(root, { recursive: true, force: true }));

  const receipt = await Promise.race([
    companion.start({
      requestId: "outer-timeout-request",
      target: "pi",
      task: "never settle",
      cwd: process.cwd(),
      execution: { timeoutMs: 30 },
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("outer deadline did not settle the job")), 10_000)),
  ]);
  assert.equal(receipt.state, "failed");
  assert.equal(receipt.error.details.kind, "timeout");
  assert.equal(receipt.error.details.timedOut, true);
  assert.match(receipt.error.message, /exceeded 30ms wall-clock timeout/);
});

test("a progress-event flood cannot hold a timed-out job in running", async (t) => {
  const { root, companion } = await fixture(() => ({
    async run(_request, { onProgress }) {
      for (let index = 0; index < 1_000; index += 1) {
        void onProgress({ type: "tool_execution_update", index });
      }
      return new Promise(() => {});
    },
  }));
  t.after(() => rm(root, { recursive: true, force: true }));

  const startedAt = Date.now();
  const receipt = await companion.start({
    requestId: "progress-flood-timeout-request",
    target: "pi",
    task: "never settles",
    cwd: process.cwd(),
    execution: { timeoutMs: 50 },
  });

  assert.equal(receipt.state, "failed");
  assert.equal(receipt.error.details.kind, "timeout");
  assert.ok(Date.now() - startedAt < 10_000, "terminal timeout was delayed by progress persistence");
  assert.ok(receipt.trace.eventCount >= 1_000);
});

test("a stale running job reconciles to resumable partial instead of staying stuck", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harnest-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new JobStore(root);
  const request = normalizeRequest({
    requestId: "request-stale-worker",
    target: "pi",
    task: "recover",
    cwd: process.cwd(),
  });
  const receipt = createReceipt(request, {
    state: "running",
    startedAt: "2020-01-01T00:00:00.000Z",
    recovery: {
      lookupKey: request.requestId,
      canResume: false,
      heartbeatAt: "2020-01-01T00:00:00.000Z",
    },
  });
  await store.put({
    request,
    receipt,
    trace: { eventCount: 0, lastEventAt: null, lastActivity: null },
    lease: { ownerId: "dead-worker", pid: 1, heartbeatAt: "2020-01-01T00:00:00.000Z" },
  });

  const fresh = new Companion({ store, adapterFactory: () => ({ run() {} }) });
  const recovered = await fresh.statusByRequestId(request.requestId);
  assert.equal(recovered.state, "partial");
  assert.equal(recovered.recovery.canResume, true);
  assert.equal(recovered.error.details.kind, "interrupted");
  assert.equal((await fresh.resultReference({ requestId: request.requestId })).state, "partial");
});

test("a recovered stale lease cannot be overwritten by the original worker", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harnest-lease-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new JobStore(root);
  const request = normalizeRequest({
    requestId: "lease-race-request",
    target: "pi",
    task: "lease race",
    cwd: process.cwd(),
  });
  const receipt = createReceipt(request, {
    state: "running",
    startedAt: "2020-01-01T00:00:00.000Z",
    recovery: { lookupKey: request.requestId, canResume: false, heartbeatAt: "2020-01-01T00:00:00.000Z" },
  });
  const original = {
    request,
    receipt,
    trace: { eventCount: 0, lastEventAt: null, lastActivity: null },
    lease: { ownerId: "original-worker", pid: 1, heartbeatAt: "2020-01-01T00:00:00.000Z" },
  };
  await store.put(original);

  const recoveryProcess = new Companion({ store, ownerId: "recovery-process", adapterFactory: () => ({ run() {} }) });
  assert.equal((await recoveryProcess.status(receipt.jobId)).state, "partial");

  original.lease = null;
  original.receipt = { ...original.receipt, state: "completed", completedAt: new Date().toISOString() };
  assert.equal(await store.put(original, { expectedLeaseOwner: "original-worker" }), null);
  assert.equal((await store.get(receipt.jobId)).receipt.state, "partial");
});

test("a progress persistence failure becomes a terminal failure receipt", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harnest-persist-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  class FailingProgressStore extends JobStore {
    async commitBatch(job, events, options) {
      if (events.some((event) => event?.event?.type === "progress")) {
        throw Object.assign(new Error("simulated ENOSPC"), { code: "ENOSPC" });
      }
      return super.commitBatch(job, events, options);
    }
  }
  const store = new FailingProgressStore(root);
  const companion = new Companion({
    store,
    routeResolver: passthroughRoute,
    adapterFactory: () => ({
      async run(_request, { onProgress }) {
        await onProgress({ type: "progress", text: "checkpoint" });
        return { result: { finalText: "must not win" } };
      },
    }),
  });

  const receipt = await companion.start({
    requestId: "persistence-failure-request",
    target: "opencode",
    policy: { write: true },
    task: "persist",
    cwd: process.cwd(),
  });
  assert.equal(receipt.state, "failed");
  assert.match(receipt.error.message, /simulated ENOSPC/);
  assert.equal((await store.get(receipt.jobId)).receipt.state, "failed");
});

test("an initial claim persistence failure is durably recorded before returning", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harnest-initial-persist-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let runs = 0;
  class FailingInitialCommitStore extends JobStore {
    async commitBatch(job, events, options) {
      if (events.some((event) => event?.event?.type === "state" && event.event.state === "running")) {
        throw Object.assign(new Error("simulated initial ENOSPC"), { code: "ENOSPC" });
      }
      return super.commitBatch(job, events, options);
    }
  }
  const store = new FailingInitialCommitStore(root);
  const companion = new Companion({
    store,
    routeResolver: passthroughRoute,
    adapterFactory: () => ({ async run() { runs += 1; return { result: { finalText: "must not run" } }; } }),
  });
  const receipt = await companion.start({
    requestId: "initial-persistence-failure",
    target: "pi",
    task: "fail before spend",
    cwd: process.cwd(),
  });
  assert.equal(runs, 0);
  assert.equal(receipt.state, "failed");
  assert.equal((await store.get(receipt.jobId)).receipt.state, "failed");
});

test("an unwritable terminal state never returns an undurable failure receipt", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harnest-terminal-persist-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  class FailingTerminalStore extends JobStore {
    async commitBatch(job, events, options) {
      if (events.some((event) => event?.event?.type === "state" && event.event.state === "completed")) {
        throw Object.assign(new Error("simulated terminal ENOSPC"), { code: "ENOSPC" });
      }
      return super.commitBatch(job, events, options);
    }

    async put(job, options) {
      if (job.receipt?.state === "failed" && options?.expectedLeaseOwner) return null;
      return super.put(job, options);
    }
  }
  const store = new FailingTerminalStore(root);
  const companion = new Companion({
    store,
    routeResolver: passthroughRoute,
    adapterFactory: () => ({ async run() { return { result: { finalText: "completed in memory only" } }; } }),
  });
  await assert.rejects(companion.start({
    requestId: "terminal-persistence-failure",
    target: "pi",
    task: "fail terminal persistence",
    cwd: process.cwd(),
  }), /did not reach a durable terminal state/);
  const jobId = await store.jobIdForRequest("terminal-persistence-failure");
  assert.equal((await store.get(jobId)).receipt.state, "running");
});

test("request index retains every resume attempt while resolving the latest", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harnest-index-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new JobStore(root);
  const request = normalizeRequest({ requestId: "multi-attempt", target: "pi", task: "index", cwd: process.cwd() });
  const first = { request, receipt: createReceipt(request), trace: {}, lease: null };
  const second = { request, receipt: createReceipt(request), trace: {}, lease: null };
  await store.put(first);
  await store.put(second);
  assert.equal(await store.jobIdForRequest(request.requestId), second.receipt.jobId);
  assert.deepEqual(await store.jobIdsForRequest(request.requestId), [first.receipt.jobId, second.receipt.jobId]);
});

test("repeating the same request ID is idempotent and cannot double-spend", async (t) => {
  let runs = 0;
  const { root, companion } = await fixture(() => ({
    async run() {
      runs += 1;
      return { result: { finalText: "once" } };
    },
  }));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = { requestId: "idempotent-request", target: "pi", task: "run once", cwd: process.cwd() };
  const first = await companion.start(input);
  const second = await companion.start(input);
  assert.equal(second.jobId, first.jobId);
  assert.equal(runs, 1);
  await assert.rejects(
    companion.start({ ...input, task: "different task" }),
    /already belongs to a different handoff/,
  );
});

test("concurrent starts atomically claim a request ID and cannot double-spend", async (t) => {
  let runs = 0;
  const root = await mkdtemp(join(tmpdir(), "harnest-concurrent-claim-test-"));
  const adapterFactory = () => ({
    async run() {
      runs += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { result: { finalText: "once concurrently" } };
    },
  });
  const firstCompanion = new Companion({ store: new JobStore(root), adapterFactory, routeResolver: passthroughRoute });
  const secondCompanion = new Companion({ store: new JobStore(root), adapterFactory, routeResolver: passthroughRoute });
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = { requestId: "concurrent-idempotent-request", target: "pi", task: "run once", cwd: process.cwd() };
  const [first, second] = await Promise.all([firstCompanion.start(input), secondCompanion.start(input)]);
  assert.equal(second.jobId, first.jobId);
  let terminal = await firstCompanion.status(first.jobId);
  for (let attempt = 0; attempt < 500 && !["completed", "failed", "partial", "cancelled"].includes(terminal.state); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    terminal = await firstCompanion.status(first.jobId);
  }
  assert.equal(terminal.state, "completed", JSON.stringify(terminal));
  assert.equal(runs, 1);
});

test("request lookup rebuilds a missing index from durable job snapshots", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harnest-index-recovery-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new JobStore(root);
  const request = normalizeRequest({ requestId: "rebuild-index", target: "pi", task: "recover", cwd: process.cwd() });
  const job = { request, receipt: createReceipt(request), trace: {}, lease: null };
  await store.put(job);
  await rm(store.requestPath(request.requestId), { force: true });
  assert.equal(await store.jobIdForRequest(request.requestId), job.receipt.jobId);
  assert.deepEqual(await store.jobIdsForRequest(request.requestId), [job.receipt.jobId]);
});

test("request recovery skips known unrelated snapshots and still discovers new orphan jobs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harnest-index-hints-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new JobStore(root);
  const makeJob = (requestId) => {
    const request = normalizeRequest({ requestId, target: "pi", task: "read", cwd: root });
    return { request, receipt: createReceipt(request), trace: {}, lease: null };
  };
  const unrelated = makeJob("unrelated");
  await store.putIfRequestAbsent(unrelated);
  const lock = `${store.path(unrelated.receipt.jobId)}.lock`;
  await writeFile(lock, "held");
  try {
    const orphan = makeJob("orphan");
    await writeFile(store.path(orphan.receipt.jobId), JSON.stringify(orphan));
    const recovered = await store.putIfRequestAbsent(makeJob("orphan"));
    assert.equal(recovered.created, false);
    assert.equal(recovered.job.receipt.jobId, orphan.receipt.jobId);
    assert.equal((await store.putIfRequestAbsent(makeJob("new"))).created, true);
  } finally { await rm(lock); }
  await rm(store.requestPath("unrelated"));
  assert.equal(await store.jobIdForRequest("unrelated"), unrelated.receipt.jobId);
});

test("every job update path rejects changing a persisted request identity", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harnest-request-immutable-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new JobStore(root);
  const request = normalizeRequest({ requestId: "original", target: "pi", task: "read", cwd: root });
  const job = { request, receipt: createReceipt(request), trace: {}, lease: null };
  await store.putIfRequestAbsent(job);
  const changed = structuredClone(job);
  changed.request.requestId = "changed";
  await assert.rejects(store.put(changed), /requestId cannot change/);
  await assert.rejects(store.commitBatch(changed, [{ type: "progress" }]), /requestId cannot change/);
  await assert.rejects(store.transition(job.receipt.jobId, (current) => { current.request.requestId = "changed"; return current; }), /requestId cannot change/);
  assert.equal((await store.get(job.receipt.jobId)).request.requestId, "original");
});

test("a colliding resume job ID cannot overwrite another request or corrupt its index", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harnest-resume-collision-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new JobStore(root);
  const makeJob = (requestId) => {
    const request = normalizeRequest({ requestId, target: "pi", task: "read", cwd: root });
    return { request, receipt: createReceipt(request), trace: {}, lease: null };
  };
  const victim = makeJob("victim");
  const parent = makeJob("parent");
  await store.putIfRequestAbsent(victim);
  await store.putIfRequestAbsent(parent);
  const child = makeJob("parent");
  child.request.metadata.resumeOf = parent.receipt.jobId;
  child.receipt.jobId = victim.receipt.jobId;
  await assert.rejects(store.putIfResumeAbsent(child, parent.receipt.jobId), /job already exists/);
  assert.equal((await store.get(victim.receipt.jobId)).request.requestId, "victim");
  assert.equal(await store.jobIdForRequest("victim"), victim.receipt.jobId);
  assert.deepEqual(await store.jobIdsForRequest("parent"), [parent.receipt.jobId]);
  await rm(store.requestPath("victim"));
  assert.equal(await store.jobIdForRequest("victim"), victim.receipt.jobId);
});

test("request recovery fails closed while an existing snapshot lock is unavailable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harnest-locked-recovery-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new JobStore(root);
  const request = normalizeRequest({ requestId: "locked-recovery", target: "pi", task: "recover safely", cwd: process.cwd() });
  const existing = { request, receipt: createReceipt(request), trace: {}, lease: null };
  await store.put(existing);
  await rm(store.requestPath(request.requestId), { force: true });
  const lockPath = `${store.path(existing.receipt.jobId)}.lock`;
  await writeFile(lockPath, "", "utf8");

  const candidate = { request, receipt: createReceipt(request), trace: {}, lease: null };
  await assert.rejects(store.putIfRequestAbsent(candidate), /timed out acquiring state lock/);
  await rm(lockPath, { force: true });
  const recovered = await store.putIfRequestAbsent(candidate);
  assert.equal(recovered.created, false);
  assert.equal(recovered.job.receipt.jobId, existing.receipt.jobId);
});

test("a malformed trace tail cannot reset monotonic event sequencing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harnest-trace-recovery-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new JobStore(root);
  const first = await store.appendEvent("trace-corruption", { at: new Date().toISOString(), event: { type: "first" } });
  await appendFile(store.tracePath("trace-corruption"), "{malformed\n", "utf8");
  const second = await store.appendEvent("trace-corruption", { at: new Date().toISOString(), event: { type: "second" } });
  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
});

test("completion contracts reject plausible text with missing evidence", async (t) => {
  const { root, companion } = await fixture(() => ({
    async run() {
      return { result: { finalText: "marker matched", evidence: [], tests: [], risks: [] } };
    },
  }));
  t.after(() => rm(root, { recursive: true, force: true }));
  const receipt = await companion.start({
    requestId: "completion-contract-request",
    target: "pi",
    task: "verify marker",
    cwd: process.cwd(),
    context: {
      requiredResultFields: ["evidence", "tests"],
      requiredText: ["COMPANION_CANARY"],
    },
  });
  assert.equal(receipt.state, "failed");
  assert.equal(receipt.error.name, "CompletionContractError");
  assert.match(receipt.error.message, /evidence, tests/);
  assert.match(receipt.error.message, /COMPANION_CANARY/);
});

test("canaries match standalone lines but not quoted prose", async (t) => {
  const outputs = {
    quoted: "I will not echo COMPANION_CANARY_2 in prose.",
    inline: "Work complete: COMPANION_CANARY_2",
    exact: "Work complete.\nCOMPANION_CANARY_2",
    prefixed: "Work complete.\nRESULT: COMPANION_CANARY_2",
  };
  const { root, companion } = await fixture(() => ({
    async run(request) {
      return { result: { finalText: outputs[request.task] } };
    },
  }));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const start = (task) => companion.start({
    requestId: `canary-matching-${task}`,
    target: "pi",
    task,
    cwd: process.cwd(),
    context: { requiredResultFields: ["finalText"], requiredText: ["COMPANION_CANARY_2"] },
  });
  assert.equal((await start("quoted")).state, "failed", "quoting the token inside a sentence must not pass");
  assert.equal((await start("inline")).state, "failed", "the token embedded in a line must not pass");
  assert.equal((await start("exact")).state, "completed");
  assert.equal((await start("prefixed")).state, "completed");
});

test("canary values normalize surrounding whitespace before comparison", async (t) => {
  const { root, companion } = await fixture(() => ({
    async run() {
      return { result: { finalText: "work complete\nDONE" } };
    },
  }));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const receipt = await companion.start({
    requestId: "canary-whitespace-request",
    target: "pi",
    task: "whitespace canary",
    cwd: process.cwd(),
    context: { requiredText: ["DONE\n", " DONE ", ""] },
  });
  assert.equal(receipt.state, "completed", JSON.stringify(receipt.error));
});
