import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Companion } from "../src/companion.mjs";
import { JobStore } from "../src/job-store.mjs";
import { inspectDynamicInvocation } from "../src/dynamic-inspect.mjs";
import { completionWait, DynamicWorkflowRunner } from "../src/dynamic-runner.mjs";
import { invocationFingerprint, normalizeAgentOptions, normalizeDynamicSpec, runIdFor } from "../src/dynamic-protocol.mjs";
import { dynamicToolDefinitions } from "../src/dynamic-tools.mjs";
import { createRouteResolver } from "../src/routing.mjs";
import * as fixtureEngine from "../scripts/fixtures/dynamic-runner-engine.mjs";
import * as realEngine from "../src/dynamic-engine.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function waitForAbort(signal) {
  return new Promise((_, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(Object.assign(new Error("aborted"), { details: { aborted: true } }));
    };
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function until(work, predicate = (value) => value, timeoutMs = 15_000, label = "condition") {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await work();
    if (predicate(value)) return value;
    if (Date.now() > deadline) throw new Error(`wait expired: ${label}`);
    await sleep(10);
  }
}

async function fixture(t, run, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "harnest-dyn-run-"));
  const store = new JobStore(join(root, "jobs"));
  const companion = new Companion({
    store,
    routeResolver: async (request) => request,
    adapterFactory: () => ({ run }),
    heartbeatIntervalMs: 10,
    cancelAckTimeoutMs: 30,
    ...(options.companion ?? {}),
  });
  const runner = new DynamicWorkflowRunner({
    companion,
    engine: fixtureEngine,
    detachBackground: false,
    pollIntervalMs: 10,
    // Keep heartbeat churn low: this machine's temp fs costs tens of ms per
    // write, and the suite proves correctness, not throughput.
    heartbeatIntervalMs: 250,
    leaseTimeoutMs: 10_000,
    cancelAckTimeoutMs: 60,
    ...(options.runner ?? {}),
  });
  t.after(async () => {
    await Promise.allSettled([...runner.running.values()].map((active) => active.promise));
    await Promise.allSettled([...companion.running.values()].map((active) => active.promise));
    await sleep(30);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const spec = (plan, extra = {}) => {
    const { execution = {}, ...rest } = extra;
    return {
      requestId: "fixture",
      cwd: root,
      source: typeof plan === "string" ? plan : JSON.stringify({ name: "fixture", plan }),
      policy: { write: false },
      route: { model: "fixture/model" },
      execution: { background: false, prefixStaggerMs: 0, ...execution },
      ...rest,
    };
  };
  return { root, store, companion, runner, spec };
}

const call = (prompt, options) => ({ type: "agent", prompt: typeof prompt === "string" ? prompt : JSON.stringify(prompt), ...(options ? { options } : {}) });
const parallel = (calls) => ({ type: "parallel", calls });
const race = (calls) => ({ type: "race", calls });
const instruction = (fields) => JSON.stringify(fields);
const planOf = (plan, extra = {}) => JSON.stringify({ name: "fixture", plan, ...extra });

test("replay after history compression preserves the successful prefix and all journal events", async (t) => {
  const starts = { first: 0, retry: 0 };
  const f = await fixture(t, async (request) => {
    starts[request.task]++;
    if (request.task === "retry" && starts.retry === 1) throw new Error("first attempt fails");
    return { result: { finalText: request.task } };
  });
  const failed = await f.runner.start(f.spec([call("first", { target: "pi" }), call("retry", { target: "pi" })]));
  assert.equal(failed.state, "partial");
  const before = (await f.runner.store.readJournal(failed.runId, { limit: 500 })).events;
  await f.runner.store.compressJournal(failed.runId, { beforeISO: new Date().toISOString(), apply: true });
  const fresh = new DynamicWorkflowRunner({ companion: f.companion, stateDir: f.runner.store.root, engine: fixtureEngine, detachBackground: false });
  const completed = await fresh.resume({ runId: failed.runId, commandId: "after-compression" });
  assert.equal(completed.state, "completed", JSON.stringify(completed.error));
  assert.deepEqual(starts, { first: 1, retry: 2 });
  const after = (await fresh.store.readJournal(failed.runId, { limit: 500 })).events;
  assert.deepEqual(after.slice(0, before.length), before);
  assert.ok(after.length > before.length);
});

test("workflow rows publish the leased native session while its first turn is still running", async (t) => {
  let finish;
  const held = new Promise((resolve) => { finish = resolve; });
  const f = await fixture(t, async (request, { onProgress }) => {
    await onProgress({ type: "claude_session", sessionId: "live-native" });
    await held;
    return { sessionId: "live-native", result: { finalText: "finished" } };
  });
  try {
    const started = await f.runner.start(f.spec([call("live", { target: "claude" })], { execution: { background: true } }));
    const active = await until(() => f.runner.status({ runId: started.runId }), (record) => record.invocations[0]?.sessionId === "live-native", 5000, "live native row");
    assert.equal(active.state, "running");
    assert.equal(active.invocations[0].state, "running");
    finish();
    assert.equal((await waitTerminal(f.runner, started.runId)).state, "completed");
  } finally { finish(); await f.companion.close(); }
});

test("sequential plan dispatches all six named targets and preserves the status contract", { timeout: 30_000 }, async (t) => {
  const seen = [];
  const f = await fixture(t, async (request) => {
    seen.push(request.target);
    const usage = request.target === "pi" ? { input_tokens: 10, output_tokens: 5, total_cost_usd: 0.01 } : undefined;
    return { sessionId: `s-${request.target}`, result: { finalText: `done:${request.task}` }, ...(usage ? { usage } : {}) };
  });
  const targets = ["opencode", "pi", "cursor", "claude", "codex", "amp"];
  const plan = targets.map((target, index) => call(`PROMPT-${index}`, {
    target,
    route: target === "opencode" ? { model: "fixture/model" } : target === "amp" ? { variant: "medium" } : {},
    policy: { write: ["opencode", "amp"].includes(target) },
  }));
  const result = await f.runner.start(f.spec(plan, { requestId: "six", name: "six targets", policy: { write: true }, route: {} }));
  assert.equal(result.state, "completed", JSON.stringify({ error: result.error, invocations: result.invocations }));
  assert.equal(result.name, "six targets");
  assert.equal(result.attempt, 1);
  assert.deepEqual(result.output.results.map((value) => value.finalText), targets.map((target, index) => `done:PROMPT-${index}`));
  assert.equal(result.invocations.length, targets.length);
  assert.ok(result.invocations.every((invocation) => invocation.state === "completed"));
  assert.deepEqual(Object.keys(result).sort(), ["argsDigest", "attempt", "completedAt", "controls", "createdAt", "error", "invocations", "invocationsTotal", "name", "output", "phases", "phasesOmitted", "phasesTotal", "progress", "requestId", "revision", "runId", "scriptDigest", "startedAt", "state", "updatedAt", "usageTotals"].sort());
  const status = await f.runner.status({ runId: result.runId });
  assert.equal(JSON.stringify(status).includes("PROMPT-"), false, "status excludes raw prompts");
  assert.equal(JSON.stringify(status).includes("done:"), false, "status excludes child results");
  assert.equal(status.usageTotals.costUsd, 0.01);
  assert.equal(status.usageTotals.reportedAttempts, 1);
  assert.equal(status.usageTotals.partial, true, "unknown metrics keep totals partial");
  assert.deepEqual(seen.sort(), [...targets].sort());
  const runs = await f.runner.history({});
  assert.equal(runs.runs[0].scriptDigest, result.scriptDigest);
  assert.equal(JSON.stringify(runs).includes("PROMPT-"), false);
});

test("dynamic status and inspect summarize every phase across agent pages", { timeout: 60_000 }, async (t) => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const f = await fixture(t, async ({ task }) => {
    if (task === "fails") throw new Error("fixture failure");
    if (task === "hold") await held;
    const usage = task === "reports" ? { input_tokens: 14, output_tokens: 0, cached_input_tokens: 3 } : undefined;
    return { result: { finalText: task }, usage };
  });
  const tool = (name) => dynamicToolDefinitions(f.runner).find((item) => item.name === `handoff_dynamic_${name}`).run;
  const plan = [
    { type: "phase", title: "Draft" },
    parallel([call("reports"), call("no usage"), call("fails")]),
    { type: "phase", title: "Verify" },
    call("hold"),
  ];
  try {
    const { runId } = await f.runner.start(f.spec(plan, { target: "codex", execution: { background: true } }));
    const active = await until(() => tool("status")({ runId }), (status) => status.invocations[3]?.state === "running");
    const paged = await tool("status")({ runId, invocationLimit: 1 });
    assert.equal(paged.invocations.length, 1);
    assert.deepEqual(paged.phases, active.phases);
    const [draft, verify] = paged.phases;
    assert.equal(draft.title, "Draft");
    assert.equal(draft.counts.total, 3);
    assert.equal(draft.counts.completed, 2);
    assert.equal(draft.counts.failed, 1);
    assert.equal(draft.usageTotals.inputTokens, 14);
    assert.equal(draft.usageTotals.outputTokens, 0);
    assert.equal(draft.usageTotals.cacheReadTokens, 3);
    assert.equal(draft.usageTotals.cacheWriteTokens, null);
    assert.equal(draft.usageTotals.unreportedAttempts, 2);
    assert.equal(draft.usageTotals.partial, true);
    const draftCalls = active.invocations.slice(0, 3);
    const firstStart = Math.min(...draftCalls.map((call) => Date.parse(call.startedAt)));
    const lastSettle = Math.max(...draftCalls.map((call) => Date.parse(call.completedAt)));
    assert.equal(draft.elapsed.state, "settled");
    assert.equal(draft.elapsed.ms, lastSettle - firstStart);
    assert.equal(verify.title, "Verify");
    assert.equal(verify.counts.running, 1);
    assert.equal(verify.elapsed.state, "running");
    assert.equal(verify.elapsed.ms, null);
    assert.equal(verify.usageTotals.inputTokens, null);
    const inspected = await tool("inspect")({ runId, invocationId: active.invocations[2].id });
    assert.equal(inspected.phase, "Draft");
    assert.deepEqual(inspected.phaseSummary, draft);
    release();
    const terminal = await waitTerminal(f.runner, runId);
    assert.equal(terminal.phases[1].elapsed.state, "settled");
    assert.equal(terminal.phases[1].counts.completed, 1);
    assert.equal(terminal.phases[1].usageTotals.inputTokens, null);
  } finally {
    release();
  }
});

test("a zero-agent phase has no elapsed time or usage", async (t) => {
  const f = await fixture(t, () => assert.fail("a phase must not dispatch an agent"));
  const result = await f.runner.start(f.spec([{ type: "phase", title: "Plan" }]));
  const status = await f.runner.status({ runId: result.runId });
  assert.equal(result.state, "completed");
  assert.deepEqual(status.phases, result.phases);
  assert.equal(result.phases.length, 1);
  const [phase] = result.phases;
  assert.equal(phase.title, "Plan");
  assert.ok(Object.values(phase.counts).every((count) => count === 0));
  assert.equal(phase.usageTotals.reportedAttempts, 0);
  assert.equal(phase.usageTotals.unreportedAttempts, 0);
  assert.equal(phase.usageTotals.costUsd, null);
  assert.deepEqual(phase.elapsed, { state: "not-started", ms: null });
});

test("phase pages stay bounded across repeated zero-agent resumes", { timeout: 120_000 }, async (t) => {
  const f = await fixture(t, () => assert.fail("a phase must not dispatch an agent"));
  const titles = Array.from({ length: 25 }, (_, index) => `Phase ${index}`.padEnd(120, "."));
  const source = (batch) => planOf([
    ...titles.slice(batch * 5, batch * 5 + 5).map((title) => ({ type: "phase", title })),
    { type: "throw", message: "resume me" },
  ]);
  const first = await f.runner.start(f.spec(source(0)));
  const { runId } = first;
  assert.equal(first.state, "partial");
  for (let batch = 1; batch < 5; batch += 1) {
    const resumed = await f.runner.resume({ runId, commandId: `resume-${batch}`, source: source(batch) });
    assert.equal(resumed.state, "partial");
  }
  const tools = dynamicToolDefinitions(f.runner);
  for (const operation of ["status", "result"]) {
    const tool = tools.find((item) => item.name === `handoff_dynamic_${operation}`);
    const read = (input) => tool.run(tool.inputSchema.parse({ runId, ...input }));
    const page = await read();
    assert.equal(page.invocationsTotal, 0);
    assert.equal(page.phases.length, 20, `${operation} caps the default phase page`);
    assert.ok(Buffer.byteLength(JSON.stringify(page.phases)) < 16_000);
    assert.deepEqual(page.phases.map((phase) => phase.title), titles.slice(0, 20));
    assert.equal(page.phasesTotal, 25);
    assert.equal(page.phasesOmitted, 5);
    const next = await read({ phaseCursor: page.phasesNextCursor });
    assert.deepEqual(next.phases.map((phase) => phase.title), titles.slice(20));
    assert.equal(next.phasesTotal, 25);
    assert.equal(next.phasesOmitted, 20);
    assert.equal(next.phasesNextCursor, undefined);
    const limited = await read({ phaseCursor: page.phasesNextCursor, phaseLimit: 2 });
    assert.deepEqual(limited.phases.map((phase) => phase.title), titles.slice(20, 22));
    assert.equal(limited.phasesNextCursor, 21);
  }
});

test("automatic dynamic routing accepts a configured ACP agent without a model route", async (t) => {
  const seen = [];
  const f = await fixture(t, async (request) => {
    seen.push(request);
    return { result: { finalText: "generic ACP completed" } };
  }, {
    companion: {
      routeResolver: async (request) => ({ ...request, target: "acp", route: { agent: "fixture-agent" } }),
    },
  });
  const result = await f.runner.start(f.spec([
    call("generic", { target: "auto", route: {}, policy: { write: true } }),
  ], { requestId: "auto-acp-dynamic", target: "auto", route: {}, policy: { write: true } }));
  assert.equal(result.state, "completed", JSON.stringify(result.error));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].target, "acp");
  assert.deepEqual(seen[0].route, { agent: "fixture-agent" });
});

test("automatic dynamic routing accepts a variant-only Amp route", async (t) => {
  const seen = [];
  const f = await fixture(t, async (request) => {
    seen.push(request.route);
    return { result: { finalText: "Amp completed" } };
  }, {
    companion: { routeResolver: async (request) => ({ ...request, target: "amp", route: { variant: "low" } }) },
  });
  const result = await f.runner.start(f.spec([call("Amp", { target: "auto" })], { target: "auto", route: {}, policy: { write: true } }));
  assert.equal(result.state, "completed", JSON.stringify(result.error));
  assert.deepEqual(seen, [{ variant: "low" }]);
});

test("automatic dynamic validation accepts a Claude tool allow list and execution rejects incompatible routes", async (t) => {
  const routeResolver = createRouteResolver({
    config: { routing: { global: { candidates: [{ id: "pi-only", target: "pi", route: { model: "fixture/model" } }] } } },
    env: {},
    userPolicy: {},
  });
  const f = await fixture(t, async () => assert.fail("incompatible routes must not launch an agent"), { companion: { routeResolver } });
  const dispatched = [];
  f.companion.start = async (request) => { dispatched.push(request); assert.fail("incompatible routes must not dispatch"); };
  const workflow = f.spec([call("Review the change")], {
    target: "auto", route: {}, policy: { tools: { allow: ["Read"] } },
  });
  const validate = dynamicToolDefinitions(f.runner).find(({ name }) => name === "handoff_dynamic_validate");
  const validation = await validate.run(validate.inputSchema.parse({ workflow }));
  assert.equal(validation.valid, true);
  assert.deepEqual(validation.policy.tools, { allow: ["Read"] });

  const result = await f.runner.start(workflow);
  assert.equal(result.state, "partial");
  assert.equal(result.invocations.length, 1);
  assert.equal(result.invocations[0].state, "failed");
  assert.equal(result.invocations[0].error.details.kind, "policy");
  assert.match(result.invocations[0].error.message, /Pi does not support granular policy\.tools/);
  assert.deepEqual(dispatched, []);
});

test("dynamic resume refuses an ACP call whose owned-process cleanup is unverified", async (t) => {
  let launches = 0;
  const f = await fixture(t, async () => {
    launches += 1;
    throw Object.assign(new Error("ACP process exit was not verified"), {
      details: { kind: "transport", unsafeResume: true, cleanupError: [{ component: "process", message: "exit unverified" }] },
    });
  });
  const first = await f.runner.start(f.spec([
    call("generic", { target: "acp", route: { agent: "fixture-agent" }, policy: { write: true } }),
  ], { requestId: "unsafe-acp-dynamic", route: {}, policy: { write: true } }));
  assert.equal(first.state, "partial");
  await assert.rejects(
    () => f.runner.resume({ runId: first.runId, commandId: "unsafe-acp-retry", approveWrites: true }),
    (error) => error.details?.kind === "unsafe-resume",
  );
  assert.equal(launches, 1, "an unverified native process must not be launched again");
});

test("bounded concurrency never exceeds the requested cap", { timeout: 90_000 }, async (t) => {
  // Causal proof, not a timing window: every adapter holds its slot until two
  // run at once. A serial scheduler can never hold two and goes red on peak.
  let active = 0, peak = 0, released = false, release;
  const twoActive = new Promise((resolve) => { release = resolve; });
  const f = await fixture(t, async (request) => {
    const fields = JSON.parse(request.task);
    active += 1;
    peak = Math.max(peak, active);
    if (active >= 2 && !released) { released = true; release(); }
    if (!released) await Promise.race([twoActive, sleep(8_000)]);
    active -= 1;
    return { result: fields.result ?? { finalText: "ok" } };
  });
  const plan = [parallel([0, 1, 2, 3].map((index) => call(instruction({ result: { finalText: `c${index}` } }))))];
  const result = await f.runner.start(f.spec(plan, { execution: { maxConcurrency: 2 } }));
  assert.equal(result.state, "completed");
  assert.equal(peak, 2, "parallel calls must run up to but never past the cap");
});

test("ordered-prefix replay reuses completed calls and preserves recorded delivery order", { timeout: 60_000 }, async (t) => {
  const launches = { A: 0, B: 0 };
  const runId = runIdFor("race-replay");
  let runnerRef;
  const f = await fixture(t, async (request) => {
    const fields = JSON.parse(request.task);
    // Deterministic barrier: the sync call only returns once the runner has
    // durably recorded both prefix calls as completed, so the throw cannot
    // race their settle on a slow filesystem.
    if (fields.sync) {
      await until(
        async () => (await runnerRef.store.readRun(runId))?.calls,
        (calls) => Array.isArray(calls)
          && calls.find((call) => call.ordinal === 0)?.state === "completed"
          && calls.find((call) => call.ordinal === 1)?.state === "completed",
        30_000, "prefix calls persisted",
      );
      return { result: { finalText: "sync" } };
    }
    launches[fields.result.finalText] += 1;
    // A only finishes after B's completion has been persisted, which fixes
    // the recorded delivery order (B first) independent of fs latency.
    // Select by ordinal: record order follows async dispatch, not call order.
    if (fields.waitForB) {
      await until(
        async () => (await runnerRef.store.readRun(runId))?.calls,
        (calls) => calls?.find((call) => call.ordinal === 1)?.state === "completed",
        30_000, "B persisted completed",
      );
    }
    return { result: fields.result };
  });
  runnerRef = f.runner;
  const raceCalls = () => race([
    call(instruction({ waitForB: true, result: { finalText: "A" } })),
    call(instruction({ result: { finalText: "B" } })),
  ]);
  const first = await f.runner.start(f.spec([raceCalls(), call(instruction({ sync: true })), { type: "throw", message: "boom" }], { requestId: "race-replay" }));
  assert.equal(first.state, "partial");
  assert.equal(first.output, null, "a throwing script produces no output");
  assert.deepEqual(first.invocations.slice(0, 2).map((invocation) => invocation.state), ["completed", "completed"]);
  assert.deepEqual(launches, { A: 1, B: 1 });
  const second = await f.runner.resume({ runId: first.runId, commandId: "resume-1", source: planOf([raceCalls()]) });
  assert.equal(second.state, "completed");
  assert.equal(second.attempt, 2);
  const dsDiag = (await f.runner.store.readRun(first.runId)).calls.map((call) => [call.ordinal, call.state, call.deliverySeq, call.attempts.length]);
  assert.equal(second.output.results[0].finalText, "B", `delivery order must replay the original race winner (ds=${JSON.stringify(dsDiag)})`);
  assert.deepEqual(launches, { A: 1, B: 1 }, "matching completed calls must not relaunch");
  assert.deepEqual(second.invocations.slice(0, 2).map((invocation) => invocation.attempts), [1, 1]);
  assert.equal(second.invocations[0].state, "completed");
  assert.equal(second.invocations[0].route.model, "fixture/model");
});

test("a changed fingerprint invalidates the suffix while the prefix stays cached", { timeout: 30_000 }, async (t) => {
  const launches = { P: 0, Q: 0, Q2: 0 };
  const f = await fixture(t, async (request) => {
    const fields = JSON.parse(request.task);
    launches[fields.result.finalText] += 1;
    return { result: fields.result };
  });
  const p = () => call(instruction({ result: { finalText: "P" } }));
  const first = await f.runner.start(f.spec([p(), call(instruction({ result: { finalText: "Q" } })), { type: "throw", message: "boom" }], { requestId: "suffix" }));
  assert.equal(first.state, "partial");
  const second = await f.runner.resume({
    runId: first.runId, commandId: "resume-2",
    source: planOf([p(), call(instruction({ result: { finalText: "Q2" } }))]),
  });
  assert.equal(second.state, "completed");
  assert.deepEqual(launches, { P: 1, Q: 1, Q2: 1 });
  assert.equal(second.invocations[1].attempts, 2, "the changed call keeps its prior attempt in history");
  assert.equal(second.invocations[0].attempts, 1, "the unchanged prefix is reused");
});

test("an invalid replacement source leaves the resume command and run untouched", async (t) => {
  const f = await fixture(t, async () => ({ result: { finalText: "ok" } }));
  const first = await f.runner.start(f.spec([{ type: "throw", message: "initial failure" }]));
  const { runId } = first;
  assert.equal(first.state, "partial");
  const before = await f.runner.store.readRun(runId);
  const specs = await f.runner.store.readSpecs(runId);
  await assert.rejects(f.runner.resume({ runId, commandId: "replace", source: "invalid source" }), /expects a JSON script/);
  const after = await f.runner.store.readRun(runId);
  assert.equal(after.state, "partial");
  assert.deepEqual(after, before);
  assert.deepEqual(await f.runner.store.readSpecs(runId), specs);

  const corrected = { runId, commandId: "replace", source: planOf([call("new revision")]) };
  const resumed = await f.runner.resume(corrected);
  assert.equal(resumed.state, "completed");
  assert.equal(resumed.attempt, 2);
  assert.equal((await f.runner.store.readRun(runId)).scriptRevision, 2);
  assert.equal((await f.runner.resume(corrected)).attempt, 2);
});

test("agent schema mismatch fails the invocation, preserves usage and cannot be replayed", async (t) => {
  let launches = 0;
  const f = await fixture(t, async () => ({
    result: { finalText: JSON.stringify({ risk: ++launches === 1 ? "unknown" : "high" }) },
    usage: { input_tokens: 3, output_tokens: 2 },
  }));
  const schema = { type: "object", properties: { risk: { enum: ["low", "high"] } }, required: ["risk"], additionalProperties: false };
  const first = await f.runner.start(f.spec([call("classify", { target: "codex", schema })]));
  assert.equal(first.state, "partial");
  assert.equal(first.invocations[0].state, "failed");
  assert.equal(first.invocations[0].error.details.kind, "output-schema");
  assert.equal(first.usageTotals.inputTokens, 3);
  assert.deepEqual(first.output.results, [null]);

  const second = await f.runner.resume({ runId: first.runId, commandId: "retry-schema" });
  assert.equal(second.state, "completed");
  assert.equal(second.invocations[0].attempts, 2);
  assert.equal(second.usageTotals.inputTokens, 6);
  assert.deepEqual(JSON.parse(second.output.results[0].finalText), { risk: "high" });
  assert.equal(launches, 2);
});

async function waitForCall(runner, runId, ordinal, states, timeoutMs = 30_000) {
  return until(
    async () => runner.store.readRun(runId),
    (record) => record?.calls?.some((call) => call.ordinal === ordinal && states.includes(call.state)),
    timeoutMs, `call ${ordinal} in ${states.join("/")}`,
  );
}

async function waitTerminal(runner, runId, timeoutMs = 60_000) {
  return until(async () => runner.status({ runId }), (status) => ["completed", "failed", "cancelled", "partial"].includes(status.state), timeoutMs, "run terminal");
}

test("pause drains in-flight work without new dispatch and does not extend the deadline", { timeout: 90_000 }, async (t) => {
  const seen = [];
  const f = await fixture(t, async (request) => {
    const fields = JSON.parse(request.task);
    seen.push(fields.result.finalText);
    await sleep(fields.delayMs ?? 0);
    return { result: fields.result };
  });
  const started = await f.runner.start(f.spec([
    call(instruction({ delayMs: 400, result: { finalText: "first" } })),
    call(instruction({ delayMs: 0, result: { finalText: "second" } })),
  ], { requestId: "pause", execution: { background: true } }));
  await waitForCall(f.runner, started.runId, 0, ["running"]);
  const deadline = (await f.runner.store.readRun(started.runId)).deadlineAt;
  const paused = await f.runner.control({ runId: started.runId, commandId: "pause-1", action: "pause" });
  assert.equal(paused.state, "applied");
  await until(async () => f.runner.store.readRun(started.runId), (record) => record.state === "paused", 30_000, "run paused");
  await sleep(120);
  assert.deepEqual(seen, ["first"], "paused run must not dispatch the next call");
  assert.equal((await f.runner.store.readRun(started.runId)).deadlineAt, deadline, "pause must not extend the deadline");
  const continued = await f.runner.control({ runId: started.runId, commandId: "continue-1", action: "continue" });
  assert.equal(continued.state, "applied");
  const terminal = await waitTerminal(f.runner, started.runId);
  assert.equal(terminal.state, "completed");
  assert.deepEqual(seen, ["first", "second"]);
  const record = await f.runner.store.readRun(started.runId);
  assert.deepEqual(record.controls.map((command) => command.state), ["applied", "applied"]);
});

test("stop cancels in-flight children and settles cancelled after reconciliation", { timeout: 90_000 }, async (t) => {
  const seen = [];
  const f = await fixture(t, async (request, { signal }) => {
    const fields = JSON.parse(request.task);
    seen.push(fields.result.finalText);
    await waitForAbort(signal);
    return { result: fields.result };
  });
  const started = await f.runner.start(f.spec([
    call(instruction({ delayMs: 2000, result: { finalText: "first" } })),
    call(instruction({ delayMs: 0, result: { finalText: "second" } })),
  ], { requestId: "stop", execution: { background: true } }));
  await waitForCall(f.runner, started.runId, 0, ["running"]);
  const stopped = await f.runner.control({ runId: started.runId, commandId: "stop-1", action: "stop" });
  assert.equal(stopped.state, "applied");
  const terminal = await waitTerminal(f.runner, started.runId);
  assert.equal(terminal.state, "cancelled");
  assert.deepEqual(seen, ["first"], "the second call must never dispatch after stop");
  assert.equal(terminal.invocations[0].state, "cancelled");
  const record = await f.runner.store.readRun(started.runId);
  assert.equal(record.cancellation.state, "acknowledged");
  assert.equal(record.calls.some((item) => item.uncertain), false, "an acknowledged cancellation is not uncertain");
});

test("resume reuses the completed prefix after an unpolled stop settles the previous attempt", { timeout: 30_000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const heldEngine = () => {
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    return { entered, release, engine: {
      ...fixtureEngine,
      runScript: (options) => fixtureEngine.runScript({
        ...options,
        onLog: async () => {
          entered.resolve();
          await release.promise;
        },
      }),
    } };
  };
  const first = heldEngine();
  const second = heldEngine();
  const launches = [];
  const f = await fixture(t, ({ task }) => {
    launches.push(task);
    if (task === "suffix" && launches.length === 2) throw new Error("first suffix attempt failed");
    return { result: { finalText: task } };
  }, { runner: { engine: first.engine } });
  const resumer = new DynamicWorkflowRunner({
    companion: f.companion, engine: second.engine, detachBackground: false, clock: () => 1,
  });
  const spec = f.spec([call("prefix", { target: "pi" }), call("suffix", { target: "pi" }), { type: "log", message: "hold before settling" }]);
  const runId = runIdFor(spec.requestId);
  const started = f.runner.start(spec);
  let resumed;
  try {
    await Promise.race([first.entered.promise, started.then(() => assert.fail("first attempt settled before the gate"))]);
    const stop = await resumer.control({ runId, commandId: "stop-first", action: "stop" });
    assert.equal(stop.state, "accepted");
    // Let settlement consume the durable cancellation before the owner polls.
    first.release.resolve();
    assert.equal((await started).state, "cancelled");

    const polled = Promise.withResolvers();
    const readControlState = resumer.store.readControlState.bind(resumer.store);
    t.mock.method(resumer.store, "readControlState", async (id) => {
      const snapshot = await readControlState(id);
      // Let the poller process the snapshot before releasing the engine.
      setImmediate(polled.resolve);
      return snapshot;
    });
    resumed = resumer.resume({ runId, commandId: "resume-second" });
    await Promise.race([second.entered.promise, resumed.then(() => assert.fail("resumed attempt settled before the gate"))]);
    t.mock.timers.tick(resumer.pollIntervalMs);
    await polled.promise;
    second.release.resolve();

    const result = await resumed;
    assert.equal(result.state, "completed", JSON.stringify(result.error));
    assert.equal(result.attempt, 2);
    assert.deepEqual(launches, ["prefix", "suffix", "suffix"]);
    const oldStop = result.controls.find((command) => command.commandId === "stop-first");
    assert.equal(oldStop.state, "applied");
    assert.equal(oldStop.effect, "cancellation-requested");
    const journal = await resumer.store.readJournal(runId);
    assert.deepEqual(journal.events.filter((event) => event.commandId === "stop-first").map((event) => event.state), ["accepted", "applied"]);
  } finally {
    first.release.resolve();
    second.release.resolve();
    await Promise.allSettled([started, resumed]);
  }
});

test("a new stop still cancels a resumed attempt", { timeout: 30_000 }, async (t) => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let passes = 0;
  const engine = {
    ...fixtureEngine,
    async runScript({ signal }) {
      if (++passes === 1) throw new Error("first attempt failed");
      entered.resolve();
      await Promise.race([waitForAbort(signal), release.promise]);
    },
  };
  const f = await fixture(t, () => assert.fail("the workflow has no agents"), { runner: { engine } });
  const { runId, state } = await f.runner.start(f.spec([]));
  assert.equal(state, "partial");
  const resumed = f.runner.resume({ runId, commandId: "resume-second" });
  try {
    await Promise.race([entered.promise, resumed.then(() => assert.fail("resumed attempt settled before the gate"))]);
    const stop = await f.runner.control({ runId, commandId: "stop-second", action: "stop" });
    assert.equal(stop.state, "applied");
    const result = await resumed;
    assert.equal(result.attempt, 2);
    assert.equal(result.state, "cancelled");
    assert.equal(result.controls.find((command) => command.commandId === "stop-second").effect, "cancellation-requested");
  } finally {
    release.resolve();
    await Promise.allSettled([resumed]);
  }
});

function gateQueuedResume(t, runner) {
  const queued = Promise.withResolvers();
  const release = Promise.withResolvers();
  const transact = runner.store.transact.bind(runner.store);
  t.mock.method(runner.store, "transact", async (...args) => {
    const outcome = await transact(...args);
    if (outcome?.record?.attempt === 2 && outcome.record.state === "queued") {
      queued.resolve(outcome.record);
      await release.promise;
    }
    return outcome;
  });
  return { queued, release };
}

for (const controllerType of ["local", "separate"]) {
  test(`settlement rejects a ${controllerType} control accepted before application`, { timeout: 30_000 }, async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const entered = Promise.withResolvers();
    const finish = Promise.withResolvers();
    const accepted = Promise.withResolvers();
    const deliver = Promise.withResolvers();
    const commandId = "pause-before-settlement";
    const f = await fixture(t, () => assert.fail("the workflow has no agents"), {
      runner: { engine: { ...fixtureEngine, async runScript() {
        entered.resolve();
        await finish.promise;
        return "finished";
      } } },
    });
    const controller = controllerType === "local" ? f.runner : new DynamicWorkflowRunner({ companion: f.companion });
    const transact = controller.store.transact.bind(controller.store);
    t.mock.method(controller.store, "transact", async (...args) => {
      const outcome = await transact(...args);
      if (outcome?.journal.some((event) => event.commandId === commandId && event.state === "accepted")) {
        accepted.resolve();
        if (controllerType === "local") await deliver.promise;
      }
      return outcome;
    });

    const spec = f.spec([]);
    const runId = runIdFor(spec.requestId);
    const started = f.runner.start(spec);
    let controlled;
    try {
      await Promise.race([entered.promise, started.then(() => assert.fail("owner settled before the gate"))]);
      controlled = controller.control({ runId, commandId, action: "pause" });
      await Promise.race([accepted.promise, controlled.then(() => assert.fail("control was not accepted"))]);
      if (controllerType === "separate") assert.equal((await controlled).state, "accepted");
      finish.resolve();
      const result = await started;
      assert.equal(result.state, "completed");
      deliver.resolve();
      const finalControl = controllerType === "local"
        ? await controlled
        : result.controls.find((command) => command.commandId === commandId);
      assert.equal(finalControl.state, "rejected");
      assert.equal(finalControl.error?.details?.kind, "not-active");
      const { events } = await controller.store.readJournal(runId);
      assert.deepEqual(events.filter((event) => event.commandId === commandId).map((event) => event.state), ["accepted", "rejected"]);
    } finally {
      finish.resolve();
      deliver.resolve();
      await Promise.allSettled([started, controlled]);
    }
  });
}

for (const { name, resume, mismatchedFence } of [
  { name: "a matching steer acknowledgement resolves an uncertain control after settlement" },
  { name: "a matching steer acknowledgement resolves an old control without changing the resumed attempt", resume: true },
  { name: "a steer acknowledgement with a mismatched fence leaves the control uncertain", mismatchedFence: true },
]) {
  test(name, { timeout: 30_000 }, async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const childDispatched = Promise.withResolvers();
    const finishChild = Promise.withResolvers();
    const acknowledgementReady = Promise.withResolvers();
    const deliverAcknowledgement = Promise.withResolvers();
    const resumeEntered = Promise.withResolvers();
    const finishResume = Promise.withResolvers();
    const commandId = "late-steer";
    const child = call("first attempt child");
    const resumedSource = planOf([child]);
    const f = await fixture(t, async () => {
      await finishChild.promise;
      return { result: { finalText: "finished" } };
    }, {
      runner: { engine: { ...fixtureEngine, async runScript(input) {
        if (input.source === resumedSource) {
          resumeEntered.resolve();
          await finishResume.promise;
        }
        return fixtureEngine.runScript(input);
      } } },
    });
    const transact = f.runner.store.transact.bind(f.runner.store);
    t.mock.method(f.runner.store, "transact", async (...args) => {
      const outcome = await transact(...args);
      const event = outcome?.journal.find((entry) => entry.type === "dispatch" && entry.jobId);
      if (event) childDispatched.resolve(event.jobId);
      return outcome;
    });
    t.mock.method(f.companion, "message", async (jobId) => {
      acknowledgementReady.resolve(jobId);
      await deliverAcknowledgement.promise;
      return { commandId, state: "applied" };
    });

    const spec = f.spec([child, { type: "throw", message: "first attempt failed" }]);
    const runId = runIdFor(spec.requestId);
    const started = f.runner.start(spec);
    let controlled;
    let resumed;
    try {
      const jobId = await Promise.race([childDispatched.promise, started.then(() => assert.fail("run settled before dispatch"))]);
      controlled = f.runner.control({ runId, commandId, action: "steer", invocationId: "inv-0", message: "keep going" });
      const controlledJobId = await Promise.race([
        acknowledgementReady.promise,
        controlled.then(() => assert.fail("steer did not reach the acknowledgement gate")),
      ]);
      assert.equal(controlledJobId, jobId);
      const applying = await f.runner.store.readRun(runId);
      const pending = applying.controls.find((control) => control.commandId === commandId);
      assert.equal(pending.state, "accepted");
      assert.deepEqual(pending.application, { ownerId: applying.lease.ownerId, fence: applying.lease.fence, attempt: 1 });

      finishChild.resolve();
      const settled = await started;
      assert.equal(settled.state, "partial");
      const uncertain = settled.controls.find((control) => control.commandId === commandId);
      assert.equal(uncertain.state, "uncertain");
      assert.equal(uncertain.error?.details?.kind, "interrupted");

      if (resume) {
        resumed = f.runner.resume({ runId, commandId: "resume-second", source: resumedSource });
        await Promise.race([resumeEntered.promise, resumed.then(() => assert.fail("resumed run settled before the gate"))]);
      }
      if (mismatchedFence) {
        await transact(runId, (record) => {
          record.controls.find((control) => control.commandId === commandId).application.fence += 1;
          return { record };
        });
      }
      const before = await f.runner.store.readRun(runId);
      assert.equal(before.attempt, resume ? 2 : 1);
      assert.equal(before.state, resume ? "running" : "partial");
      assert.equal(before.controls.find((control) => control.commandId === commandId).state, "uncertain");

      deliverAcknowledgement.resolve();
      const finalControl = await controlled;
      const after = await f.runner.store.readRun(runId);
      if (mismatchedFence) {
        assert.deepEqual(finalControl, uncertain);
        assert.deepEqual(after, before);
      } else {
        assert.equal(finalControl.state, "applied");
        assert.equal(finalControl.effect, "next-agent-step");
        assert.equal(finalControl.error, null);
        assert.deepEqual(finalControl.acknowledgement, { commandId, state: "applied" });
        assert.equal(after.controls.find((control) => control.commandId === commandId).application, undefined);
        assert.deepEqual(after, {
          ...before, controls: after.controls, updatedAt: after.updatedAt,
          revision: before.revision + 1, journalSequence: before.journalSequence + 1,
        });
      }
      const { events } = await f.runner.store.readJournal(runId);
      const lifecycle = events.filter((event) => event.commandId === commandId || event.type === "settled"
        || event.type === "resume" || (event.type === "claimed" && event.attempt === 2));
      assert.deepEqual(lifecycle.map((event) => [event.type, event.state ?? event.attempt]), [
        ["control", "accepted"], ["control", "uncertain"], ["settled", "partial"],
        ...(resume ? [["resume", 2], ["claimed", 2]] : []),
        ...(mismatchedFence ? [] : [["control", "applied"]]),
      ]);
      if (resumed) {
        finishResume.resolve();
        assert.equal((await resumed).state, "completed");
      }
    } finally {
      finishChild.resolve();
      deliverAcknowledgement.resolve();
      finishResume.resolve();
      await Promise.allSettled([started, controlled, resumed]);
    }
  });
}

test("claim rejects an unstamped control on an already queued second attempt", { timeout: 30_000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const f = await fixture(t, () => assert.fail("the workflow has no agents"), {
    runner: { engine: { ...fixtureEngine, async runScript() { throw new Error("first attempt failed"); } } },
  });
  const entered = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const worker = new DynamicWorkflowRunner({
    companion: f.companion, clock: () => 1,
    engine: { ...fixtureEngine, async runScript() {
      entered.resolve();
      await finish.promise;
      return "finished";
    } },
  });
  const { runId, state } = await f.runner.start(f.spec([]));
  assert.equal(state, "partial");
  const queue = gateQueuedResume(t, f.runner);
  const resumed = f.runner.resume({ runId, commandId: "resume-second" });
  const commandId = "legacy-steer";
  let executed;
  try {
    const queued = await Promise.race([queue.queued.promise, resumed.then(() => assert.fail("resume bypassed the queue gate"))]);
    assert.equal(queued.lease, null);
    const accepted = await worker.control({ runId, commandId, action: "steer", invocationId: "inv-0", message: "keep going" });
    assert.equal(accepted.state, "accepted");
    await worker.store.transact(runId, (record) => {
      delete record.controls.find((command) => command.commandId === commandId).attempt;
      return { record };
    });

    executed = worker.execute(runId);
    await Promise.race([entered.promise, executed.then(() => assert.fail("worker settled before the gate"))]);
    const claimed = await worker.status({ runId });
    assert.equal(claimed.state, "running");
    assert.equal(claimed.attempt, 2);
    const control = claimed.controls.find((command) => command.commandId === commandId);
    assert.equal(control.state, "rejected");
    assert.equal(control.error?.details?.kind, "not-active");
    finish.resolve();
    assert.equal((await executed).state, "completed");
  } finally {
    finish.resolve();
    await Promise.allSettled([executed]);
    queue.release.resolve();
    await Promise.allSettled([resumed]);
  }
});

function gateControlCommit(t, runner, commandId) {
  const committed = Promise.withResolvers();
  const transact = runner.store.transact.bind(runner.store);
  t.mock.method(runner.store, "transact", async (...args) => {
    const outcome = await transact(...args);
    const command = outcome?.record?.controls.find((item) => item.commandId === commandId);
    if (command?.state === "applied") committed.resolve(command);
    return outcome;
  });
  return committed.promise;
}

for (const { staleAction, legacy, name } of [
  { staleAction: "pause", name: "an unpolled pause cannot close the resumed attempt's dispatch gate" },
  { staleAction: "continue", name: "a stale continue cannot reopen the gate after a fresh pause is queued" },
  { staleAction: "pause", legacy: true, name: "resume rejects an older pause with no stored attempt" },
]) {
  const freshPause = staleAction === "continue";
  test(name, { timeout: 30_000 }, async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const firstEntered = Promise.withResolvers();
    const firstRelease = Promise.withResolvers();
    const secondEntered = Promise.withResolvers();
    const secondRelease = Promise.withResolvers();
    const f = await fixture(t, () => assert.fail("the workflow has no agents"), {
      runner: { engine: { ...fixtureEngine, async runScript() {
        firstEntered.resolve();
        await firstRelease.promise;
        throw new Error("first attempt failed");
      } } },
    });
    const resumer = new DynamicWorkflowRunner({
      companion: f.companion, detachBackground: false, clock: () => 1,
      engine: { ...fixtureEngine, async runScript() {
        secondEntered.resolve();
        await secondRelease.promise;
        return "resumed";
      } },
    });
    const controller = new DynamicWorkflowRunner({ companion: f.companion });
    const spec = f.spec([]);
    const runId = runIdFor(spec.requestId);
    const started = f.runner.start(spec);
    let resumed;
    const staleId = `${staleAction}-first`;
    try {
      await Promise.race([firstEntered.promise, started.then(() => assert.fail("first attempt settled before the gate"))]);
      const stale = await controller.control({ runId, commandId: staleId, action: staleAction });
      assert.equal(stale.state, "accepted");
      const persisted = await controller.store.readRun(runId);
      const pendingControl = persisted.controls.find((command) => command.commandId === staleId);
      assert.equal(pendingControl.attempt, 1);
      if (legacy) {
        await controller.store.transact(runId, (record) => {
          delete record.controls.find((command) => command.commandId === staleId).attempt;
          return { record };
        });
      }
      firstRelease.resolve();
      assert.equal((await started).state, "partial");

      const { queued, release } = gateQueuedResume(t, resumer);
      try {
        resumed = resumer.resume({ runId, commandId: "resume-second" });
        const record = await Promise.race([queued.promise, resumed.then(() => assert.fail("resume bypassed the queue gate"))]);
        assert.equal(record.lease, null);
        if (freshPause) {
          const pause = await controller.control({ runId, commandId: "pause-second", action: "pause" });
          assert.equal(pause.state, "accepted");
          const current = await controller.store.readRun(runId);
          assert.equal(current.controls.find((command) => command.commandId === "pause-second").attempt, 2);
        }
      } finally { release.resolve(); }
      await Promise.race([secondEntered.promise, resumed.then(() => assert.fail("resumed attempt settled before the gate"))]);
      const active = resumer.running.get(runId);
      assert.equal(active.paused, freshPause, "the gate starts in the new attempt's requested state");
      const polled = Promise.withResolvers();
      const readControlState = resumer.store.readControlState.bind(resumer.store);
      t.mock.method(resumer.store, "readControlState", async (id) => {
        const snapshot = await readControlState(id);
        setImmediate(polled.resolve);
        return snapshot;
      });
      const pauseCommitted = freshPause ? gateControlCommit(t, resumer, "pause-second") : null;
      t.mock.timers.tick(resumer.pollIntervalMs);
      await polled.promise;
      if (freshPause) {
        assert.equal((await pauseCommitted).effect, "dispatch-gate-closed");
        const { events } = await resumer.store.readJournal(runId);
        assert.equal(events.some((event) => event.commandId === staleId && event.effect === "dispatch-gate-open"),
          false, "the old continue reopened the fresh pause's dispatch gate");
        const continued = await resumer.control({ runId, commandId: "continue-second", action: "continue" });
        assert.equal(continued.state, "applied");
      } else {
        assert.equal(active.paused, false, "the old pause closed the resumed attempt's dispatch gate");
      }

      secondRelease.resolve();
      const result = await resumed;
      assert.equal(result.state, "completed");
      assert.equal(result.attempt, 2);
      const oldControl = result.controls.find((command) => command.commandId === staleId);
      assert.equal(oldControl.state, "rejected");
      assert.equal(oldControl.error?.details?.kind, "not-active");
      const { events } = await resumer.store.readJournal(runId);
      assert.deepEqual(events.filter((event) => event.commandId === staleId).map((event) => event.state), ["accepted", "rejected"]);
    } finally {
      firstRelease.resolve();
      secondRelease.resolve();
      await Promise.allSettled([started, resumed]);
    }
  });
}

test("a stop accepted while resume is queued cancels attempt two", { timeout: 30_000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const entered = Promise.withResolvers();
  const aborted = Promise.withResolvers();
  const release = Promise.withResolvers();
  let passes = 0;
  const engine = {
    ...fixtureEngine,
    async runScript({ signal }) {
      if (++passes === 1) throw new Error("first attempt failed");
      signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      entered.resolve();
      await release.promise;
    },
  };
  const f = await fixture(t, () => assert.fail("the workflow has no agents"), { runner: { engine, clock: () => 1 } });
  const controller = new DynamicWorkflowRunner({ companion: f.companion });
  const { runId, state } = await f.runner.start(f.spec([]));
  assert.equal(state, "partial");
  const queue = gateQueuedResume(t, f.runner);
  const stopCommitted = gateControlCommit(t, f.runner, "stop-queued");
  const resumed = f.runner.resume({ runId, commandId: "resume-second" });
  try {
    const queued = await Promise.race([queue.queued.promise, resumed.then(() => assert.fail("resume bypassed the queue gate"))]);
    assert.equal(queued.lease, null);
    const stop = await controller.control({ runId, commandId: "stop-queued", action: "stop" });
    assert.equal(stop.state, "accepted");
    const persisted = await controller.store.readRun(runId);
    assert.equal(persisted.controls.find((command) => command.commandId === "stop-queued").attempt, 2);
    queue.release.resolve();
    await Promise.race([entered.promise, resumed.then(() => assert.fail("resumed attempt settled before the gate"))]);
    t.mock.timers.tick(f.runner.pollIntervalMs);
    await aborted.promise;
    assert.equal((await stopCommitted).effect, "cancellation-requested");
    release.resolve();
    const result = await resumed;
    assert.equal(result.attempt, 2);
    assert.equal(result.state, "cancelled");
    assert.equal(result.controls.find((command) => command.commandId === "stop-queued").state, "applied");
  } finally {
    queue.release.resolve();
    release.resolve();
    await Promise.allSettled([resumed]);
  }
});

test("unacknowledged child cancellation leaves phase elapsed time unknown", { timeout: 90_000 }, async (t) => {
  let entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const f = await fixture(t, async () => {
    entered();
    await held;
    return { result: { finalText: "late completion" } };
  });
  try {
    const { runId } = await f.runner.start(f.spec([
      { type: "phase", title: "Draft" },
      call("hold", { target: "pi" }),
    ], { execution: { background: true } }));
    await waitForCall(f.runner, runId, 0, ["running"]);
    await ready;
    const stopped = await f.runner.control({ runId, commandId: "stop-child", action: "stop-agent", invocationId: "inv-0" });
    assert.equal(stopped.state, "applied");
    const terminal = await waitTerminal(f.runner, runId);
    assert.equal(terminal.state, "partial");
    const [invocation] = terminal.invocations;
    assert.equal(invocation.state, "partial");
    assert.equal(invocation.error.details.kind, "cancel-unacknowledged");
    assert.ok(Number.isFinite(Date.parse(invocation.completedAt)));
    assert.deepEqual(terminal.phases[0].elapsed, { state: "unknown", ms: null });
    const record = await f.runner.store.readRun(runId);
    assert.equal(record.calls[0].attempts[0].uncertain, true);
    const result = await f.runner.result({ runId });
    const inspected = await inspectDynamicInvocation(f.runner, { runId, invocationId: invocation.id });
    assert.deepEqual(result.phases, terminal.phases);
    assert.deepEqual(inspected.phaseSummary, terminal.phases[0]);
  } finally {
    release();
  }
});

test("stop-agent cancels one invocation while its sibling completes", { timeout: 90_000 }, async (t) => {
  let releaseKeep;
  const keep = new Promise((resolve) => { releaseKeep = resolve; });
  const f = await fixture(t, async (request, { signal }) => {
    const fields = JSON.parse(request.task);
    if (fields.result.finalText === "keep") await keep;
    else await waitForAbort(signal);
    return { result: fields.result };
  });
  try {
    const started = await f.runner.start(f.spec([
      parallel([
        call(instruction({ delayMs: 500, result: { finalText: "keep" } })),
        call(instruction({ delayMs: 500, result: { finalText: "drop" } })),
      ]),
    ], { requestId: "stop-agent", execution: { background: true } }));
    await waitForCall(f.runner, started.runId, 0, ["running"]);
    await waitForCall(f.runner, started.runId, 1, ["running"]);
    const stopped = await f.runner.control({ runId: started.runId, commandId: "stop-agent-1", action: "stop-agent", invocationId: "inv-1" });
    assert.equal(stopped.state, "applied");
    releaseKeep();
    const terminal = await waitTerminal(f.runner, started.runId);
    assert.equal(terminal.state, "partial");
    assert.equal(terminal.invocations[0].state, "completed");
    assert.equal(terminal.invocations[1].state, "cancelled");
  } finally {
    releaseKeep();
  }
});

test("restart-agent invalidates the suffix and resume re-dispatches it", { timeout: 90_000 }, async (t) => {
  const launches = { A: 0, B: 0 };
  const f = await fixture(t, async (request, { signal }) => {
    const fields = JSON.parse(request.task);
    // Keep both original calls live until restart cancels them.
    if (++launches[fields.result.finalText] === 1) await waitForAbort(signal);
    return { result: fields.result };
  });
  const source = planOf([parallel([
    call(instruction({ result: { finalText: "A" } })),
    call(instruction({ result: { finalText: "B" } })),
  ])]);
  try {
    const started = await f.runner.start(f.spec(source, { requestId: "restart", execution: { background: true } }));
    const running = await until(
      () => f.runner.store.readRun(started.runId),
      (record) => record?.calls.length >= 2 && record.calls.every((call) => call.state === "running"),
      30_000, "both calls running",
    );
    const restarted = await f.runner.control({ runId: started.runId, commandId: "restart-1", action: "restart-agent", invocationId: "inv-0" });
    assert.equal(restarted.state, "applied");
    assert.equal(restarted.effect, "suffix-restarted");
    const first = await waitTerminal(f.runner, started.runId);
    assert.equal(first.state, "completed");
    assert.equal(first.attempt, 1, "restart replays inside the original attempt");
    assert.deepEqual(launches, { A: 2, B: 2 }, "an invalidated suffix must replay both calls");
    assert.equal(first.invocations.find((invocation) => invocation.id === "inv-0").attempts, 2);
    assert.equal(first.invocations.find((invocation) => invocation.id === "inv-1").attempts, 2);
    const settled = await f.runner.store.readRun(started.runId);
    assert.equal(settled.attemptWindows[0].deadlineAt, running.deadlineAt, "restart must not extend the deadline");
  } finally {
    await f.companion.close();
  }
});

test("a late restart acknowledgement cannot invalidate the replayed suffix", { timeout: 60_000 }, async (t) => {
  let releaseOriginal, releaseReplay;
  const original = new Promise((resolve) => { releaseOriginal = resolve; });
  const replay = new Promise((resolve) => { releaseReplay = resolve; });
  const launches = { A: 0, B: 0 };
  const f = await fixture(t, async (request) => {
    const name = request.task;
    const attempt = ++launches[name];
    if (attempt === 1) await original;
    else if (name === "B") await replay;
    return { result: { finalText: name } };
  }, { runner: { hooks: { afterRestartInvalidate: async () => {
    releaseOriginal();
    await until(() => launches.A === 2 && launches.B === 2, Boolean, 15_000, "replay dispatched before command acknowledgement");
  } } } });
  try {
    const started = await f.runner.start(f.spec([parallel([call("A", { target: "pi" }), call("B", { target: "pi" })])], { execution: { background: true } }));
    await until(() => launches.A === 1 && launches.B === 1, Boolean);
    const deadline = (await f.runner.store.readRun(started.runId)).deadlineAt;
    const ack = await f.runner.control({ runId: started.runId, commandId: "late-restart", action: "restart-agent", invocationId: "inv-0" });
    assert.equal(ack.state, "applied");
    releaseReplay();
    const completed = await waitTerminal(f.runner, started.runId);
    assert.equal(completed.state, "completed", JSON.stringify(completed.error));
    assert.deepEqual(launches, { A: 2, B: 2 });
    assert.ok(completed.invocations.every((invocation) => invocation.attempts === 2));
    const record = await f.runner.store.readRun(started.runId);
    assert.equal(record.attemptWindows[0].deadlineAt, deadline);
  } finally {
    releaseOriginal();
    releaseReplay();
  }
});

test("steer and reroute apply through the child adapter with idempotent commands", { timeout: 90_000 }, async (t) => {
  const controls = [];
  const controlAdapter = () => ({
    run: async (request) => {
      const fields = JSON.parse(request.task);
      await sleep(fields.delayMs ?? 0);
      return { result: fields.result };
    },
    control: async (command) => {
      controls.push(command.commandId);
      return { commandId: command.commandId, state: "applied" };
    },
  });
  const f = await fixture(t, async () => ({ result: { finalText: "unused" } }), { companion: { adapterFactory: controlAdapter } });
  const started = await f.runner.start(f.spec([
    call(instruction({ delayMs: 1200, result: { finalText: "slow" } })),
  ], { requestId: "steer", execution: { background: true } }));
  await waitForCall(f.runner, started.runId, 0, ["running"]);
  const steered = await f.runner.control({ runId: started.runId, commandId: "steer-1", action: "steer", invocationId: "inv-0", message: "prefer different options" });
  assert.equal(steered.state, "applied");
  const repeated = await f.runner.control({ runId: started.runId, commandId: "steer-1", action: "steer", invocationId: "inv-0", message: "prefer different options" });
  assert.deepEqual(repeated, steered, "an identical commandId repeats the recorded outcome");
  await assert.rejects(
    () => f.runner.control({ runId: started.runId, commandId: "steer-1", action: "steer", invocationId: "inv-0", message: "different" }),
    /different control/,
  );
  const rerouted = await f.runner.control({ runId: started.runId, commandId: "reroute-1", action: "reroute", invocationId: "inv-0", route: { provider: "fixture", model: "m2" } });
  assert.equal(rerouted.state, "applied");
  assert.deepEqual(controls, ["steer-1", "reroute-1"], "the repeated command must not re-deliver");
  await f.runner.control({ runId: started.runId, commandId: "stop-2", action: "stop" });
  await waitTerminal(f.runner, started.runId);
});

test("a phase-only edit replays the invocation and attributes usage to each attempt's phase", { timeout: 90_000 }, async (t) => {
  let launches = 0;
  const f = await fixture(t, async () => {
    launches += 1;
    return { result: { finalText: "done" }, usage: { input_tokens: launches * 7 } };
  });
  const original = planOf([
    { type: "phase", title: "Draft" },
    call("unchanged", { target: "codex" }),
    { type: "throw", message: "resume me" },
  ]);
  const first = await f.runner.start(f.spec(original));
  assert.equal(first.state, "partial");
  assert.equal(first.phases[0].usageTotals.inputTokens, 7);
  const replay = await f.runner.resume({ runId: first.runId, commandId: "rename-phase", source: original.replace("Draft", "Review") });
  assert.equal(replay.state, "partial");
  assert.equal(launches, 2, "a phase-only edit invalidates reuse");
  assert.equal(replay.invocations[0].phase, "Review");
  assert.equal(replay.invocations[0].attempts, 2);
  const [draft, review] = replay.phases;
  assert.equal(draft.title, "Draft");
  assert.equal(draft.counts.total, 0);
  assert.equal(draft.usageTotals.inputTokens, 7);
  assert.equal(draft.usageTotals.reportedAttempts, 1);
  assert.equal(draft.elapsed.state, "settled");
  assert.equal(review.title, "Review");
  assert.equal(review.counts.completed, 1);
  assert.equal(review.usageTotals.inputTokens, 14);
  assert.equal(review.usageTotals.reportedAttempts, 1);
  assert.equal(replay.usageTotals.inputTokens, 21);
  const status = await f.runner.status({ runId: first.runId });
  const inspected = await inspectDynamicInvocation(f.runner, { runId: first.runId, invocationId: replay.invocations[0].id });
  assert.deepEqual(status.phases, replay.phases);
  assert.deepEqual(inspected.phaseSummary, review);
});

test("legacy fingerprints reuse an unchanged phase and replay a removed phase", { timeout: 90_000 }, async (t) => {
  let launches = 0;
  const f = await fixture(t, async () => {
    launches += 1;
    return { result: { finalText: "done" } };
  });
  const agent = call("unchanged", { target: "pi" });
  const fail = { type: "throw", message: "resume me" };
  const input = f.spec([{ type: "phase", title: "Draft" }, agent, fail]);
  const first = await f.runner.start(input);
  assert.equal(first.state, "partial");
  const root = await normalizeDynamicSpec(input);
  const effective = await normalizeAgentOptions(agent.prompt, agent.options, { ordinal: 0, root });
  const legacyFingerprint = invocationFingerprint(effective);
  await f.runner.store.transact(first.runId, (record) => {
    assert.notEqual(record.calls[0].fingerprint, legacyFingerprint);
    record.calls[0].fingerprint = legacyFingerprint;
    return { record };
  });

  const unchanged = await f.runner.resume({ runId: first.runId, commandId: "same-phase" });
  assert.equal(unchanged.invocations[0].attempts, 1);
  assert.equal(launches, 1);
  const removed = await f.runner.resume({ runId: first.runId, commandId: "remove-phase", source: planOf([agent, fail]) });
  assert.equal(removed.invocations[0].attempts, 2);
  assert.equal(removed.invocations[0].phase, null);
  assert.equal(removed.phases[0].counts.total, 0);
  assert.equal(launches, 2);
});

test("write-capable replay requires approveWrites and preserves prior usage", { timeout: 90_000 }, async (t) => {
  const launches = [];
  const f = await fixture(t, async (request) => {
    const fields = JSON.parse(request.task);
    launches.push(fields.result.finalText);
    return { result: fields.result, usage: { total_cost_usd: 0.25 } };
  });
  const writePhase = { type: "phase", title: "Write" };
  const firstSource = planOf([writePhase, call(instruction({ result: { finalText: "W" } })), { type: "throw", message: "boom" }]);
  const first = await f.runner.start(f.spec(firstSource, { requestId: "writes", policy: { write: true } }));
  assert.equal(first.state, "partial");
  assert.equal(first.usageTotals.costUsd, 0.25);
  // The edited call invalidates the completed writer, so replay needs approval.
  const editedSource = planOf([writePhase, call(instruction({ result: { finalText: "W2" } }))]);
  await assert.rejects(
    () => f.runner.resume({ runId: first.runId, commandId: "resume-w1", source: editedSource }),
    (error) => error.details?.kind === "policy",
  );
  assert.deepEqual(launches, ["W"], "a rejected resume must not dispatch");
  const second = await f.runner.resume({ runId: first.runId, commandId: "resume-w1", source: editedSource, approveWrites: true });
  assert.equal(second.state, "completed");
  assert.deepEqual(launches, ["W", "W2"]);
  assert.equal(second.usageTotals.costUsd, 0.5, "prior spend is preserved and extended");
  assert.equal(second.invocations[0].attempts, 2);
  assert.equal(second.phases[0].counts.completed, 1);
  assert.equal(second.phases[0].usageTotals.costUsd, 0.5);
});

test("maxAgents produces an explicit limit error and stops dispatching", { timeout: 90_000 }, async (t) => {
  const f = await fixture(t, async () => { await sleep(30); return { result: { finalText: "ok" } }; });
  const plan = [parallel([call(instruction({})), call(instruction({})), call(instruction({}))])];
  const result = await f.runner.start(f.spec(plan, { requestId: "limit", execution: { maxAgents: 2, maxConcurrency: 2 } }));
  assert.equal(result.state, "partial");
  assert.equal(result.error.details.kind, "limit");
  const record = await f.runner.store.readRun(result.runId);
  assert.ok(record.dispatchCount <= 2, `dispatch count ${record.dispatchCount} must respect maxAgents`);
  assert.ok(result.invocations.some((invocation) => invocation.state !== "completed"));
});

test("parallel agent calls reserve the last launch slot before starting the child", async (t) => {
  const f = await fixture(t, async () => ({ result: { finalText: "ok" } }));
  const start = f.companion.start.bind(f.companion);
  const launchRequests = [];
  t.mock.method(f.companion, "start", async (request, options) => {
    launchRequests.push(request.requestId);
    if (launchRequests.length === 1) {
      const { runId } = request.context.dynamic;
      await until(() => f.runner.store.readRun(runId), (record) => launchRequests.length > 1
        || record.calls.some((item) => item.error?.details?.kind === "limit"));
    }
    return start(request, options);
  });
  const result = await f.runner.start(f.spec([parallel([call("one"), call("two")])], {
    execution: { maxAgents: 1, maxConcurrency: 2 },
  }));
  assert.equal(launchRequests.length, 1);
  assert.equal(result.state, "partial");
  assert.equal(result.error.details.kind, "limit");
  assert.equal((await f.runner.store.readRun(result.runId)).dispatchCount, 1);
});

test("overlapping writers serialize while the run still completes", { timeout: 90_000 }, async (t) => {
  let overlap = 0, peak = 0, release;
  const secondStarted = new Promise((resolve) => { release = resolve; });
  const f = await fixture(t, async () => {
    overlap += 1;
    peak = Math.max(peak, overlap);
    if (overlap >= 2) release();
    // Hold long enough that a scheduler without writer serialization would
    // let the sibling join and trip peak > 1.
    if (peak < 2) await Promise.race([secondStarted, sleep(600)]);
    overlap -= 1;
    return { result: { finalText: "ok" } };
  });
  const plan = [parallel([call("w1"), call("w2")])];
  const result = await f.runner.start(f.spec(plan, { requestId: "writers", policy: { write: true } }));
  assert.equal(result.state, "completed");
  assert.equal(peak, 1, "write calls sharing a cwd must not overlap");
});

test("history paginates compact summaries and unknown usage keeps totals partial", { timeout: 120_000 }, async (t) => {
  const f = await fixture(t, async (request) => {
    if (request.task === "nousage") return { result: { finalText: "n" } };
    return { result: { finalText: "u" }, usage: { total_cost_usd: 0.1 } };
  });
  const a = await f.runner.start(f.spec(planOf([call("nousage")]), { requestId: "hist-1" }));
  const b = await f.runner.start(f.spec(planOf([call("usage")]), { requestId: "hist-2" }));
  const page1 = await f.runner.history({ limit: 1 });
  assert.equal(page1.runs.length, 1);
  assert.ok(page1.nextCursor, "a partial page carries a cursor");
  assert.equal(page1.runs[0].runId, b.runId, "history is newest first");
  const page2 = await f.runner.history({ limit: 1, cursor: page1.nextCursor });
  assert.equal(page2.runs.length, 1);
  assert.equal(page2.runs[0].runId, a.runId);
  assert.equal(page2.nextCursor, null);
  const filtered = await f.runner.history({ state: "completed" });
  assert.deepEqual(filtered.runs.map((run) => run.runId), [b.runId, a.runId]);
  assert.equal(JSON.stringify([page1, page2]).includes("finalText"), false, "summaries exclude child output");
  assert.equal(page1.runs[0].counts.completed, 1);
  const unknown = await f.runner.status({ runId: a.runId });
  assert.equal(unknown.usageTotals.partial, true);
  assert.equal(unknown.usageTotals.unreportedAttempts, 1);
  assert.equal(unknown.invocations[0].usageSummary, null);
  const known = await f.runner.status({ runId: b.runId });
  assert.equal(known.usageTotals.costUsd, 0.1);
  assert.equal(known.usageTotals.reportedAttempts, 1);
});

test("two runner instances deduplicate a concurrent start", { timeout: 120_000 }, async (t) => {
  let launches = 0;
  const f = await fixture(t, async () => { launches += 1; await sleep(50); return { result: { finalText: "ok" } }; });
  const other = new DynamicWorkflowRunner({ companion: f.companion, engine: fixtureEngine, detachBackground: false, pollIntervalMs: 10, heartbeatIntervalMs: 250, leaseTimeoutMs: 10_000 });
  const spec = f.spec(planOf([call(instruction({}))]), { requestId: "dupe" });
  const [a, b] = await Promise.all([f.runner.start(spec), other.start(spec)]);
  assert.equal(a.runId, b.runId);
  assert.equal(a.state, "completed");
  assert.equal(b.state, "completed");
  assert.equal(launches, 1, "deterministic request ids and the request index deduplicate the launch");
});

test("a stale owner lease becomes partial interrupted and is never auto-retried", { timeout: 90_000 }, async (t) => {
  const f = await fixture(t, async () => ({ result: { finalText: "ok" } }));
  const result = await f.runner.start(f.spec(planOf([call(instruction({}))]), { requestId: "stale" }));
  assert.equal(result.state, "completed");
  const before = await f.runner.store.readRun(result.runId);
  const stale = {
    ...before,
    state: "running",
    error: null,
    completedAt: null,
    deadlineAt: Date.now() + 60_000,
    lease: { ownerId: "another-process", fence: 99, heartbeatAt: Date.now() - 60_000, timeoutMs: 1_000 },
  };
  stale.calls = stale.calls.map((call) => ({ ...call, state: "running", deliverySeq: null, completedAt: null }));
  await f.runner.store.transact(result.runId, () => ({ record: stale }));
  const status = await f.runner.status({ runId: result.runId });
  assert.equal(status.state, "partial");
  assert.equal(status.recoveryRequired, true);
  assert.equal(status.error.details.kind, "interrupted");
  assert.equal(status.invocations[0].state, "partial");
  const after = await f.runner.store.readRun(result.runId);
  assert.equal(after.dispatchCount, before.dispatchCount, "a lost owner must not trigger a retry");
  assert.equal(after.calls[0].uncertain, true, "the lost child stays explicitly unknown");
});

test("a paused run with an expired owner lease recovers without applying its pending stop", async (t) => {
  let launches = 0;
  const f = await fixture(t, async () => { launches++; return { result: { finalText: "ok" } }; });
  const started = await f.runner.start(f.spec([call("cached"), { type: "throw", message: "interrupt after the call" }]));
  const { runId } = started;
  await f.runner.store.transact(runId, (record) => {
    record.state = "paused";
    record.completedAt = null;
    record.pause = { requested: true, appliedAt: new Date().toISOString() };
    record.lease = { ownerId: "dead-worker", fence: 99, heartbeatAt: Date.now() - 60_000, timeoutMs: 1_000 };
    return { record };
  });
  const stop = await f.runner.control({ runId, commandId: "stop-lost-owner", action: "stop" });
  assert.equal(stop.state, "accepted");
  const status = await f.runner.status({ runId });
  assert.equal(status.state, "partial");
  assert.equal(status.error.details.kind, "interrupted");
  assert.equal(status.recoveryRequired, true);
  assert.equal(status.invocations[0].state, "completed");
  const resumed = await f.runner.resume({ runId, commandId: "resume-paused", source: planOf([call("cached"), call("new")]) });
  assert.equal(resumed.state, "completed");
  assert.equal(launches, 2, "the completed prefix was reused");
  const oldStop = resumed.controls.find((command) => command.commandId === "stop-lost-owner");
  assert.equal(oldStop.state, "rejected");
  assert.equal(oldStop.error.details.kind, "not-active");
  assert.equal(oldStop.appliedAt, null);
});

test("bounded output, phases and journal logs honor the contract", { timeout: 90_000 }, async (t) => {
  const f = await fixture(t, async () => ({ result: { finalText: "ok" } }));
  const huge = "x".repeat(250_000);
  const plan = [
    call(instruction({ result: { finalText: "ok" } })),
    { type: "phase", title: "one" },
    { type: "log", message: "hello" },
    { type: "value", value: huge },
  ];
  const result = await f.runner.start(f.spec(plan, { requestId: "bound" }));
  assert.equal(result.state, "completed");
  assert.deepEqual(result.phases.map((phase) => phase.title), ["one"]);
  assert.equal(result.output.truncated, true);
  assert.ok(result.output.bytes > 200_000);
  const journal = await f.runner.store.readJournal(result.runId, { limit: 500 });
  assert.ok(journal.events.some((event) => event.type === "phase"));
  assert.ok(journal.events.some((event) => event.type === "log"));
  assert.ok(journal.events.some((event) => event.type === "settled"));
  assert.ok(journal.events.some((event) => event.type === "dispatch"));
});

test("recovery relaunches a provably-never-dispatched intent once and refuses genuinely unknown state", { timeout: 120_000 }, async (t) => {
  const launches = { A: 0, B: 0 };
  const f = await fixture(t, async (request) => {
    const fields = JSON.parse(request.task);
    launches[fields.result.finalText] += 1;
    return { result: fields.result };
  });
  const instructionA = instruction({ result: { finalText: "A" } });
  const instructionB = instruction({ result: { finalText: "B" } });
  const source = planOf([call(instructionA), call(instructionB)]);
  const base = await f.runner.start(f.spec(planOf([call(instructionA)]), { requestId: "recover-base" }));
  assert.equal(base.state, "completed");
  const baseRecord = await f.runner.store.readRun(base.runId);
  const makeCall = (startedAt) => ({
    ...JSON.parse(JSON.stringify(baseRecord.calls[0])),
    id: "inv-1", ordinal: 1, label: "call 1", phase: null,
    requestId: `${base.runId}:1:1`, jobId: null, sessionId: null, value: null, deliverySeq: null,
    state: startedAt ? "running" : "prepared", error: null, invalidated: false, adopted: false, uncertain: false,
    attempts: [{ attempt: 1, requestId: `${base.runId}:1:1`, jobId: null, sessionId: null, state: "prepared", startedAt, completedAt: null }],
  });
  const markPartial = (record) => {
    record.state = "partial";
    record.recoveryRequired = true;
    record.error = { name: "Error", message: "interrupted", details: { kind: "interrupted" } };
    record.completedAt = new Date().toISOString();
    record.lease = null;
  };
  // A deterministic request id with no registered child proves the intent never
  // dispatched; relaunching it is deduplicated and must happen exactly once.
  await f.runner.store.transact(base.runId, (record) => {
    markPartial(record);
    record.calls.push(makeCall("2026-01-01T00:00:00.000Z"));
    return { record };
  });
  const recovered = await f.runner.resume({ runId: base.runId, commandId: "recover-1", source });
  assert.equal(recovered.state, "completed");
  assert.deepEqual(launches, { A: 1, B: 1 }, "a provably-never-dispatched intent launches exactly once");
  assert.equal(recovered.invocations.find((invocation) => invocation.id === "inv-1").attempts, 1);
  // Genuinely unknown state (unacknowledged cancellation) still fails closed.
  const unknown = await f.runner.start(f.spec(planOf([call(instructionA)]), { requestId: "recover-unknown" }));
  assert.equal(unknown.state, "completed");
  await f.runner.store.transact(unknown.runId, (record) => {
    markPartial(record);
    const call = record.calls.find((item) => item.ordinal === 0);
    call.state = "partial";
    call.uncertain = true;
    call.error = { name: "Error", message: "stop not acknowledged", details: { kind: "cancel-unacknowledged", uncertain: true } };
    return { record };
  });
  await assert.rejects(
    () => f.runner.resume({ runId: unknown.runId, commandId: "unknown-1", source: planOf([call(instructionA)]) }),
    (error) => error.details?.kind === "unsafe-resume",
  );
});

test("dynamic children default to session transport for interactive harnesses", { timeout: 90_000 }, async (t) => {
  const boundary = [];
  const f = await fixture(t, async (request) => ({ result: { finalText: request.task } }));
  const originalStart = f.companion.start.bind(f.companion);
  f.companion.start = async (request, options) => {
    boundary.push({ target: request.target, transport: request.execution?.transport ?? null });
    return originalStart(request, options);
  };
  const plan = [
    call("c", { target: "claude" }),
    call("x", { target: "codex" }),
    call("u", { target: "cursor" }),
    call("p", { target: "pi" }),
    call("o", { target: "claude", execution: { transport: "oneshot" } }),
  ];
  const result = await f.runner.start(f.spec(plan, { requestId: "transport" }));
  assert.equal(result.state, "completed");
  const count = (target, transport) => boundary.filter((entry) => entry.target === target && entry.transport === transport).length;
  assert.equal(count("claude", "session"), 1, "claude defaults to the session transport");
  assert.equal(count("codex", "session"), 1, "codex defaults to the session transport");
  assert.equal(count("cursor", "session"), 1, "cursor defaults to the session transport");
  assert.equal(count("claude", "oneshot"), 1, "an explicit oneshot pin is preserved");
  assert.equal(boundary.find((entry) => entry.target === "pi").transport, null, "non-interactive targets carry no transport");
  // Root execution.transport propagates to every child that does not override it.
  boundary.length = 0;
  const rooted = await f.runner.start(f.spec([call("rooted", { target: "claude" })], { requestId: "transport-root", execution: { transport: "oneshot" } }));
  assert.equal(rooted.state, "completed");
  assert.deepEqual(boundary, [{ target: "claude", transport: "oneshot" }]);
});

for (const [name, options, target] of [
  ["Cursor plan mode", { policy: { mode: "plan" } }, "cursor"],
  ["Cursor sandbox", { target: "cursor", policy: { sandbox: true } }, "cursor"],
  ["Claude tool filters", { target: "claude", policy: { tools: { allow: ["Read"], deny: ["Bash"] } } }, "claude"],
  ["automatically routed Claude tool filters", { target: "auto", policy: { tools: { allow: ["Read"] } } }, "claude"],
]) {
  test(`dynamic children use oneshot for ${name}`, async (t) => {
    const routed = [];
    const launched = [];
    const f = await fixture(t, async (request) => {
      launched.push({ target: request.target, transport: request.execution.transport, policy: request.policy });
      return { result: { finalText: "reviewed" } };
    }, {
      runner: { engine: realEngine },
      companion: { routeResolver: async (request) => {
        routed.push(request.execution.transport);
        return options.target === "auto" ? { ...request, target } : request;
      } },
    });
    const source = `return (await agent("Review this", ${JSON.stringify(options)})).finalText;`;
    const result = await f.runner.start(f.spec(source));

    assert.deepEqual(routed, ["oneshot"]);
    assert.equal(result.state, "completed");
    assert.equal(result.output, "reviewed");
    assert.deepEqual(launched, [{
      target, transport: "oneshot", policy: { write: false, tools: [], maxCostUsd: null, ...options.policy },
    }]);
  });
}

test("dynamic children reject explicit session transport for print-only policy before routing", async (t) => {
  const routed = [];
  const launched = [];
  const f = await fixture(t, async (request) => {
    launched.push(request.target);
    return { result: { finalText: "reviewed" } };
  }, { companion: { routeResolver: async (request) => {
    routed.push(request.target);
    return request;
  } } });
  const execution = { transport: "session" };
  const result = await f.runner.start(f.spec([
    call("cursor", { target: "cursor", policy: { mode: "plan" }, execution }),
    call("claude", { target: "claude", policy: { tools: { deny: [] } }, execution }),
  ]));

  assert.equal(result.state, "partial");
  assert.deepEqual(result.invocations.map(({ state }) => state), ["failed", "failed"]);
  assert.match(result.invocations[0].error.message, /policy\.mode.*Cursor print mode/);
  assert.match(result.invocations[1].error.message, /policy\.tools.*Claude print mode/);
  assert.deepEqual(routed, []);
  assert.deepEqual(launched, []);
});

test("restarting a write invocation requires approveWrites and then replays it", { timeout: 120_000 }, async (t) => {
  const launches = [];
  let released = false;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const f = await fixture(t, async (request) => {
    launches.push(request.task);
    if (!released) await Promise.race([gate, sleep(8_000)]);
    return { result: { finalText: "w" } };
  });
  const started = await f.runner.start(f.spec(planOf([call(instruction({ result: { finalText: "w" } }))]), { requestId: "restart-write", policy: { write: true }, execution: { background: true } }));
  await waitForCall(f.runner, started.runId, 0, ["running"]);
  const rejected = await f.runner.control({ runId: started.runId, commandId: "rw-1", action: "restart-agent", invocationId: "inv-0" });
  assert.equal(rejected.state, "rejected");
  assert.match(rejected.error.message, /approveWrites/);
  const applied = await f.runner.control({ runId: started.runId, commandId: "rw-2", action: "restart-agent", invocationId: "inv-0", approveWrites: true });
  assert.equal(applied.state, "applied");
  released = true;
  release();
  const first = await waitTerminal(f.runner, started.runId);
  assert.equal(first.state, "completed", JSON.stringify(first.error));
  assert.equal(first.attempt, 1, "restart replays under the original attempt");
  assert.equal(first.invocations[0].attempts, 2);
  assert.equal(launches.length, 2, "the writer relaunches exactly once after approval");
});

test("restart-agent survives a pass that settles while the command is being validated", { timeout: 120_000 }, async (t) => {
  // Deterministic reproduction of the scheduling bug: the command has already
  // invalidated the suffix when this seam runs, then the held writer is
  // released so the engine pass ends and the run settles before the command
  // records its replay intent in the pre-fix ordering. The owner must still
  // replay the invalidated writer instead of terminalizing partial.
  let released = false;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let hookRan = false;
  let runnerRef;
  const launches = [];
  const f = await fixture(t, async (request) => {
    launches.push(request.task);
    if (!released) await Promise.race([gate, sleep(8_000)]);
    return { result: { finalText: "w" } };
  }, {
    runner: {
      hooks: {
        afterRestartInvalidate: async () => {
          hookRan = true;
          released = true;
          release();
          await until(
            () => runnerRef.status({ runId: started.runId }),
            (status) => ["completed", "partial", "failed", "cancelled"].includes(status.state),
            20_000, "run settled during restart validation",
          );
        },
      },
    },
  });
  runnerRef = f.runner;
  const started = await f.runner.start(f.spec(planOf([call(instruction({ result: { finalText: "w" } }))]), { requestId: "restart-write-race", policy: { write: true }, execution: { background: true } }));
  await waitForCall(f.runner, started.runId, 0, ["running"]);
  const applied = await f.runner.control({ runId: started.runId, commandId: "rw-race-1", action: "restart-agent", invocationId: "inv-0", approveWrites: true });
  assert.equal(applied.state, "applied");
  assert.equal(hookRan, true, "the deterministic race seam ran");
  const terminal = await waitTerminal(f.runner, started.runId);
  assert.equal(terminal.state, "completed", JSON.stringify(terminal.error));
  assert.equal(terminal.attempt, 1, "the replay stays in the original attempt");
  assert.equal(terminal.invocations[0].attempts, 2, "the invalidated writer is replayed");
  assert.equal(launches.length, 2, "exactly one replay launch");
});

test("prefix warming releases on first meaningful response, never on process start", { timeout: 120_000 }, async (t) => {
  const order = [];
  const starts = {};
  let active = 0, peak = 0, release, both;
  const resetGate = () => { active = 0; peak = 0; both = new Promise((resolve) => { release = resolve; }); };
  resetGate();
  const f = await fixture(t, async (request, { onProgress } = {}) => {
    const fields = JSON.parse(request.task);
    const name = fields.result.finalText;
    order.push(name);
    starts[`${name}Start`] = Date.now();
    if (fields.preProgress && typeof onProgress === "function") await onProgress({ phase: "working", state: "working" });
    if (fields.gate) {
      active += 1;
      peak = Math.max(peak, active);
      if (active >= 2) release();
      if (peak < 2) await Promise.race([both, sleep(8_000)]);
      active -= 1;
    }
    await sleep(fields.delayMs ?? 0);
    starts[`${name}End`] = Date.now();
    return { result: fields.result };
  });
  // Same group: both candidates advertise progress, so whichever leads opens
  // the gate on a meaningful response, never on process start.
  const matched = await f.runner.start(f.spec([parallel([
    call(instruction({ gate: true, preProgress: true, result: { finalText: "leader" } })),
    call(instruction({ gate: true, preProgress: true, result: { finalText: "follower" } })),
  ])], { requestId: "warm-match", execution: { prefixStaggerMs: 5_000 } }));
  assert.equal(matched.state, "completed");
  const matchedRecord = await f.runner.store.readRun(matched.runId);
  assert.equal(matchedRecord.warming.length, 1, "one gate per fingerprint group");
  assert.equal(matchedRecord.warming[0].openedBy, "progress", "released by a meaningful response");
  // A follower must not be released by the leader merely starting: without any
  // meaningful response it waits for the leader to settle (cap is 5s).
  resetGate();
  order.length = 0;
  const quiet = await f.runner.start(f.spec([parallel([
    call(instruction({ delayMs: 250, result: { finalText: "quiet" } })),
    call(instruction({ delayMs: 250, result: { finalText: "behind" } })),
  ])], { requestId: "warm-quiet", execution: { prefixStaggerMs: 5_000 } }));
  assert.equal(quiet.state, "completed");
  const quietRecord = await f.runner.store.readRun(quiet.runId);
  assert.equal(quietRecord.warming.length, 1);
  assert.equal(quietRecord.warming[0].openedBy, "settled", "no release before a meaningful response or settle");
  const leaderOrdinal = quietRecord.warming[0].leaderOrdinal;
  if (leaderOrdinal === 0) assert.ok(starts.behindStart >= starts.quietEnd, "follower starts only after the leader settles");
  else assert.ok(starts.quietStart >= starts.behindEnd, "follower starts only after the leader settles");
  // Different route => different gate key: both dispatch without waiting.
  resetGate();
  order.length = 0;
  peak = 0;
  const mismatched = await f.runner.start(f.spec([parallel([
    call(instruction({ gate: true, result: { finalText: "r1" } }), { route: { model: "fixture/one" } }),
    call(instruction({ gate: true, result: { finalText: "r2" } }), { route: { model: "fixture/two" } }),
  ])], { requestId: "warm-mismatch", execution: { prefixStaggerMs: 5_000 } }));
  assert.equal(mismatched.state, "completed");
  assert.equal(peak, 2, "mismatched routes must not share a warming gate");
});

test("disabled prefix stagger never reads child traces", { timeout: 60_000 }, async (t) => {
  // The scale probe runs with prefixStaggerMs 0. Without this guard every
  // in-flight child re-read its trace on each poll tick looking for a first
  // meaningful response, even though no warming gate can open at stagger 0.
  let traceReads = 0;
  const f = await fixture(t, async (request) => ({ result: { finalText: request.task } }));
  const realReadTrace = f.companion.store.readTrace.bind(f.companion.store);
  f.companion.store.readTrace = (...args) => { traceReads += 1; return realReadTrace(...args); };
  const completed = await f.runner.start(f.spec([call("one"), call("two", { target: "pi" })]));
  assert.equal(completed.state, "completed");
  assert.equal(traceReads, 0, "stagger 0 must not read child traces for warming");
});

test("child waiting registers one completion subscriber and wakes on settlement", { timeout: 60_000 }, async (t) => {
  // The runner path: many poll ticks while a child is pending must not
  // accumulate reactions on the completion promise.
  let registrations = 0;
  const slow = await fixture(t, async (request) => { await sleep(400); return { result: { finalText: request.task } }; });
  const realOwnedCompletion = slow.companion.ownedCompletion.bind(slow.companion);
  slow.companion.ownedCompletion = (jobId) => {
    const promise = realOwnedCompletion(jobId);
    if (!promise) return promise;
    return { then: (onFulfilled, onRejected) => { registrations += 1; return promise.then(onFulfilled, onRejected); } };
  };
  const started = await slow.runner.start(slow.spec([call("slow", { target: "pi" })], { execution: { background: true } }));
  await until(async () => (await slow.runner.store.readRun(started.runId))?.calls?.[0]?.state === "running", Boolean, 15_000, "child running");
  await sleep(250); // ~25 poll ticks at the fixture's 10ms interval
  const pendingRegistrations = registrations;
  const completed = await waitTerminal(slow.runner, started.runId);
  assert.equal(completed.state, "completed");
  assert.ok(pendingRegistrations <= 2, `registrations must stay bounded across poll ticks, saw ${pendingRegistrations}`);
  assert.ok(registrations <= 2, `registrations must stay bounded for the whole wait, saw ${registrations}`);
});

test("completion wait registers once and wakes a long tick immediately", async () => {
  let registrations = 0;
  let settle;
  const completion = new Promise((resolve) => { settle = resolve; });
  const thenable = { then: (onFulfilled, onRejected) => { registrations += 1; return completion.then(onFulfilled, onRejected); } };
  const wait = completionWait(thenable);
  // Many ticks with the child still pending: still exactly one registration.
  for (let index = 0; index < 20; index += 1) await wait.waitTick(1);
  assert.equal(registrations, 1, "each tick must replace the waiter, not register another subscriber");
  assert.equal(wait.settled, false);
  // A long tick must resolve as soon as the child settles.
  const startedAt = Date.now();
  const pending = wait.waitTick(5_000);
  settle({ state: "completed" });
  await pending;
  const elapsed = Date.now() - startedAt;
  assert.equal(wait.settled, true);
  assert.equal(wait.receipt.state, "completed");
  assert.ok(elapsed < 500, `settlement must wake a long tick immediately (took ${elapsed}ms)`);
  assert.equal(registrations, 1);
  // A completion that already landed resolves the next tick without sleeping.
  const late = completionWait(Promise.resolve({ state: "completed" }));
  const lateStart = Date.now();
  await late.waitTick(5_000);
  assert.ok(Date.now() - lateStart < 500, "an already-settled completion must not sleep a tick");
  assert.equal(late.receipt.state, "completed");
});

test("reordered control flow fails non-replayable before any duplicate dispatch", { timeout: 90_000 }, async (t) => {
  const launches = { A: 0, B: 0 };
  const runId = runIdFor("reorder");
  let runnerRef;
  const f = await fixture(t, async (request) => {
    const fields = JSON.parse(request.task);
    launches[fields.result.finalText] += 1;
    if (fields.waitForB) {
      await until(async () => (await runnerRef.store.readRun(runId))?.calls, (calls) => calls?.find((call) => call.ordinal === 1)?.state === "completed", 30_000, "B persisted");
    }
    return { result: fields.result };
  });
  runnerRef = f.runner;
  const a = () => call(instruction({ waitForB: true, result: { finalText: "A" } }));
  const b = () => call(instruction({ result: { finalText: "B" } }));
  // Original flow settles B first and A second (delivery order 1 then 2).
  const first = await f.runner.start(f.spec(planOf([parallel([a(), b()]), call(instruction({ sync: true })), { type: "throw", message: "boom" }]), { requestId: "reorder" }));
  assert.equal(first.state, "partial");
  assert.deepEqual(launches, { A: 1, B: 1 });
  const record = await f.runner.store.readRun(first.runId);
  assert.equal(record.calls.find((call) => call.ordinal === 1).deliverySeq, 1);
  assert.equal(record.calls.find((call) => call.ordinal === 0).deliverySeq, 2);
  // Changed flow awaits A (recorded order 2) in its own turn, then requests B
  // (order 1): the replay cannot be deterministic, so refuse before dispatching
  // a duplicate.
  const refused = await f.runner.resume({ runId: first.runId, commandId: "reorder-1", source: planOf([a(), b()]) });
  assert.notEqual(refused.state, "completed", "the replay must fail closed");
  assert.match(String(refused.error?.message ?? ""), /cannot be reproduced deterministically/);
  assert.deepEqual(launches, { A: 1, B: 1 }, "no duplicate launches on refusal");
});

// --- provider usage-limit waiting (opt-in, off by default) ------------------

function providerFixture(t, { failCount = 1, resetOffsets = [], errorDetails = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "harnest-dyn-wait-"));
  const starts = [];
  const receipts = new Map();
  const companion = {
    routeResolver: async (request) => request,
    async start(request) {
      starts.push(request.requestId);
      const ordinal = starts.length - 1;
      const failed = ordinal < failCount;
      const details = errorDetails ?? { kind: "provider-limit", usageLimit: true, resetAt: resetOffsets[ordinal] ?? Date.now() + 120 };
      const state = failed ? "failed" : "completed";
      const receipt = {
        protocolVersion: "1.0", requestId: request.requestId, jobId: `job-${request.requestId}`, target: request.target,
        contextDigest: request.contextDigest, state, createdAt: new Date().toISOString(),
        startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), sessionId: null, workflowRunId: null,
        route: request.route, result: state === "completed" ? { finalText: "ok" } : null, usage: null,
        error: failed ? { name: "ProviderLimitError", message: "provider usage limit", details } : null,
        controls: [], trace: { ref: `job:${request.requestId}:events`, eventCount: 0, lastEventAt: null, lastActivity: null, progress: null },
        recovery: { lookupKey: request.requestId, canResume: state !== "completed", heartbeatAt: null },
      };
      receipts.set(receipt.jobId, receipt);
      return receipt;
    },
    async status(jobId) { return receipts.get(jobId) ?? null; },
    async cancel(jobId) { const current = receipts.get(jobId); if (current) receipts.set(jobId, { ...current, state: "cancelled", cancellation: { state: "acknowledged" } }); return receipts.get(jobId); },
  };
  const runner = new DynamicWorkflowRunner({
    companion, engine: fixtureEngine, detachBackground: false, stateDir: join(root, "dyn"),
    pollIntervalMs: 10, heartbeatIntervalMs: 250, leaseTimeoutMs: 10_000, cancelAckTimeoutMs: 60,
  });
  t.after(async () => {
    await Promise.allSettled([...runner.running.values()].map((active) => active.promise));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const spec = (options = {}) => ({
    requestId: options.requestId ?? "wait",
    cwd: root,
    source: planOf([call(instruction({ result: { finalText: "w" } }))]),
    policy: { write: options.write === true },
    route: { model: "fixture/model" },
    execution: { background: options.background === true, prefixStaggerMs: 0, timeoutMs: options.timeoutMs ?? 60_000 },
  });
  return { root, companion, runner, starts, spec };
}

test("provider waiting is off by default even with a classified limit and reset", { timeout: 60_000 }, async (t) => {
  const f = await providerFixture(t, { failCount: 1, resetOffsets: [Date.now() + 150] });
  const result = await f.runner.start(f.spec({ requestId: "wait-off" }));
  assert.equal(result.state, "partial");
  assert.equal(f.starts.length, 1, "no retry without opt-in");
  const record = await f.runner.store.readRun(result.runId);
  assert.equal(record.waitingFor, null);
  const journal = await f.runner.store.readJournal(result.runId, { limit: 500 });
  assert.equal(journal.events.some((event) => event.type === "waiting"), false);
});

test("provider waiting uses the explicit reset and retries within bounds", { timeout: 60_000 }, async (t) => {
  let clock = Date.now();
  const f = providerFixture(t, { failCount: 1, resetOffsets: [clock + 800] });
  f.runner.clock = () => clock;
  f.runner.providerWait = { maxRetries: 1 };
  const started = await f.runner.start(f.spec({ requestId: "wait-reset", background: true }));
  await until(() => f.runner.store.readRun(started.runId), (record) => Boolean(record?.waitingFor), 20_000, "provider reset persisted");
  assert.equal(f.starts.length, 1, "the retry waits for the explicit reset");
  clock += 800;
  const result = await waitTerminal(f.runner, started.runId);
  assert.equal(result.state, "completed", JSON.stringify({ error: result.error, invocations: result.invocations }));
  assert.equal(f.starts.length, 2, "one bounded retry after the reset");
  assert.equal(result.invocations[0].attempts, 2);
  const journal = await f.runner.store.readJournal(result.runId, { limit: 500 });
  assert.ok(journal.events.some((event) => event.type === "waiting"), "the wait is recorded durably");
  assert.ok(journal.events.some((event) => event.type === "resumed" && event.retry === true));
});

test("provider retry releases a single dispatch slot and honors the per-run retry cap", { timeout: 60_000 }, async (t) => {
  let clock = Date.now();
  const f = providerFixture(t, { failCount: 3, resetOffsets: [clock + 1000, clock + 2000] });
  f.runner.clock = () => clock;
  const spec = f.spec({ requestId: "wait-one-slot" });
  spec.execution.maxConcurrency = 1;
  spec.execution.background = true;
  spec.execution.providerWait = { maxRetries: 1 };
  const started = await f.runner.start(spec);
  await until(() => f.runner.store.readRun(started.runId), (record) => Boolean(record?.waitingFor), 20_000, "provider reset gate");
  clock += 1000;
  const result = await waitTerminal(f.runner, started.runId);
  assert.equal(result.state, "partial");
  assert.equal(f.starts.length, 2, "one initial attempt and exactly one retry");
});

test("classified SDK quota survives Companion persistence and enables a bounded reset wait", { timeout: 60_000 }, async (t) => {
  let clock = Date.now();
  let starts = 0;
  const f = await fixture(t, async () => {
    if (++starts === 1) throw Object.assign(new Error("session limit"), { details: { kind: "usage-limit", resetAt: new Date(clock + 1000).toISOString() } });
    return { result: { finalText: "after reset" } };
  }, { runner: { clock: () => clock } });
  const started = await f.runner.start(f.spec([call("read input")], { requestId: "sdk-reset", execution: { background: true, maxConcurrency: 1, providerWait: { maxRetries: 1 } } }));
  await until(() => f.runner.store.readRun(started.runId), (record) => Boolean(record?.waitingFor), 20_000, "persisted SDK reset");
  clock += 1000;
  const result = await waitTerminal(f.runner, started.runId);
  assert.equal(result.state, "completed", JSON.stringify(result.error));
  assert.equal(starts, 2);
  assert.equal(result.usageTotals.unreportedAttempts, 2, "both the limited and successful attempts remain accounted for");
});

test("provider waiting does not start when the reset is past the run deadline", { timeout: 60_000 }, async (t) => {
  const f = await providerFixture(t, { failCount: 1, resetOffsets: [Date.now() + 60_000] });
  f.runner.providerWait = { maxRetries: 3 };
  const result = await f.runner.start(f.spec({ requestId: "wait-expiry", timeoutMs: 1_000 }));
  assert.equal(result.state, "partial");
  assert.equal(f.starts.length, 1, "the original deadline governs");
  const journal = await f.runner.store.readJournal(result.runId, { limit: 500 });
  assert.equal(journal.events.some((event) => event.type === "waiting"), false);
});

test("provider waiting ignores unknown resets and auth failures", { timeout: 60_000 }, async (t) => {
  const unknown = await providerFixture(t, { failCount: 1, errorDetails: { kind: "provider-limit", usageLimit: true } });
  unknown.runner.providerWait = { maxRetries: 3 };
  const unknownResult = await unknown.runner.start(unknown.spec({ requestId: "wait-unknown" }));
  assert.equal(unknownResult.state, "partial");
  assert.equal(unknown.starts.length, 1, "no resetAt is not waitable");
  const auth = await providerFixture(t, { failCount: 1, errorDetails: { kind: "provider-auth", message: "401 unauthorized" } });
  auth.runner.providerWait = { maxRetries: 3 };
  const authResult = await auth.runner.start(auth.spec({ requestId: "wait-auth" }));
  assert.equal(authResult.state, "partial");
  assert.equal(auth.starts.length, 1, "auth failures are not usage limits");
});

test("provider waiting is skipped for unapproved writers", { timeout: 60_000 }, async (t) => {
  const f = await providerFixture(t, { failCount: 1, resetOffsets: [Date.now() + 150] });
  f.runner.providerWait = { maxRetries: 1 };
  const result = await f.runner.start(f.spec({ requestId: "wait-write", write: true }));
  assert.equal(result.state, "partial");
  assert.equal(f.starts.length, 1, "write retries need explicit approval");
  const journal = await f.runner.store.readJournal(result.runId, { limit: 500 });
  assert.equal(journal.events.some((event) => event.type === "waiting"), false);
});

test("stopping during a provider wait settles cancelled without retrying", { timeout: 60_000 }, async (t) => {
  const f = await providerFixture(t, { failCount: 1, resetOffsets: [Date.now() + 5_000] });
  f.runner.providerWait = { maxRetries: 2 };
  const started = await f.runner.start(f.spec({ requestId: "wait-stop", background: true }));
  await until(async () => f.runner.store.readRun(started.runId), (record) => Boolean(record?.waitingFor), 20_000, "run waiting");
  const stopped = await f.runner.control({ runId: started.runId, commandId: "stop-wait", action: "stop" });
  assert.equal(stopped.state, "applied", JSON.stringify(stopped));
  const terminal = await waitTerminal(f.runner, started.runId);
  assert.equal(terminal.state, "cancelled");
  assert.equal(f.starts.length, 1, "a cancelled wait must not retry");
  assert.equal((await f.runner.store.readRun(started.runId)).waitingFor, null);
});

// --- real QuickJS engine + real Companion integration -----------------------

for (const { name, passOn, maxRounds, rounds } of [
  { name: "passes in round 1", passOn: 1, rounds: 1 },
  { name: "passes in round 2 after feedback", passOn: 2, rounds: 2 },
  { name: "exhausts a supplied bound", maxRounds: 2, rounds: 2 },
  { name: "exhausts the default bound", rounds: 3 },
]) {
  test(`bounded verification loop ${name}`, { timeout: 60_000 }, async (t) => {
    const seen = [];
    const f = await fixture(t, async ({ context }) => {
      const { round, task, feedback, candidate } = context;
      seen.push({ round, task, feedback, candidate });
      const finalText = candidate === undefined
        ? `draft ${round}`
        : JSON.stringify({ passed: round === passOn, feedback: `fix ${round}` });
      return { result: { finalText } };
    }, { runner: { engine: realEngine } });
    const source = await readFile(new URL("../examples/dynamic-verify-loop.js", import.meta.url), "utf8");
    const task = "Draft a concise release note";
    const result = await f.runner.start(f.spec(source, { target: "pi", args: { task, maxRounds } }));
    assert.equal(result.state, "completed", JSON.stringify(result.error));
    assert.deepEqual(result.output, {
      verified: passOn !== undefined,
      rounds,
      result: `draft ${rounds}`,
      message: passOn !== undefined ? `verified after ${rounds} round${rounds === 1 ? "" : "s"}` : `not verified after ${rounds} rounds`,
    });
    assert.deepEqual(seen, Array.from({ length: rounds }, (_, index) => [
      { round: index + 1, task, feedback: index === 0 ? null : `fix ${index}`, candidate: undefined },
      { round: index + 1, task, feedback: undefined, candidate: `draft ${index + 1}` },
    ]).flat());
  });
}

test("real QuickJS engine runs branching, fan-out and phases through the runner", { timeout: 120_000 }, async (t) => {
  const seen = [];
  const f = await fixture(t, async (request) => {
    seen.push(request.task);
    return { result: { finalText: `ok:${request.task}` } };
  }, { runner: { engine: realEngine } });
  const source = `export const meta = { name: "real-fan", phases: ["fan", "reduce"] };
await phase("fan");
const values = await parallel([
  async () => (await agent("A", { label: "a" })).finalText,
  async () => (await agent("B", { label: "b" })).finalText
]);
await phase("reduce");
log("collected " + values.length);
return { values };`;
  const result = await f.runner.start(f.spec(source, { requestId: "real-fan" }));
  assert.equal(result.state, "completed");
  assert.deepEqual(result.output.values, ["ok:A", "ok:B"]);
  assert.deepEqual(result.phases.map((phase) => phase.title), ["fan", "reduce"]);
  assert.deepEqual(seen.sort(), ["A", "B"]);
  assert.equal(result.invocations.length, 2);
  assert.ok(result.invocations.every((invocation) => invocation.state === "completed"));
});

test("real QuickJS engine + real Companion preserve the Promise.race winner across replay", { timeout: 120_000 }, async (t) => {
  const launches = { A: 0, B: 0, sync: 0 };
  const runId = runIdFor("real-race");
  let runnerRef;
  const f = await fixture(t, async (request) => {
    const fields = JSON.parse(request.task);
    if (fields.sync) {
      launches.sync += 1;
      await until(
        async () => (await runnerRef.store.readRun(runId))?.calls,
        (calls) => calls?.find((call) => call.ordinal === 0)?.state === "completed"
          && calls?.find((call) => call.ordinal === 1)?.state === "completed",
        30_000, "both race calls persisted",
      );
      return { result: { finalText: "sync" } };
    }
    launches[fields.result.finalText] += 1;
    await sleep(fields.delayMs ?? 0);
    return { result: fields.result };
  }, { runner: { engine: realEngine } });
  runnerRef = f.runner;
  const race = `const winner = await Promise.race([
  agent(${JSON.stringify(instruction({ delayMs: 300, result: { finalText: "A" } }))}),
  agent(${JSON.stringify(instruction({ delayMs: 10, result: { finalText: "B" } }))})
]);`;
  const source1 = `export const meta = { name: "real-race" };\n${race}\nawait agent(${JSON.stringify(instruction({ sync: true }))});\nthrow new Error("boom");`;
  const source2 = `export const meta = { name: "real-race" };\n${race}\nreturn winner.finalText;`;
  const first = await f.runner.start(f.spec(source1, { requestId: "real-race" }));
  assert.equal(first.state, "partial", JSON.stringify(first.error));
  assert.deepEqual(launches, { A: 1, B: 1, sync: 1 }, JSON.stringify(first.error));
  const second = await f.runner.resume({ runId: first.runId, commandId: "real-race-1", source: source2 });
  assert.equal(second.state, "completed");
  assert.equal(second.output, "B", "the original race winner must replay deterministically");
  assert.deepEqual(launches, { A: 1, B: 1, sync: 1 }, "matching completed calls are reused, not relaunched");
  assert.equal(second.invocations[0].attempts, 1);
});


test("metadata-less scripts validate and run with a null meta envelope", { timeout: 120_000 }, async (t) => {
  const f = await fixture(t, async () => ({ result: { finalText: "ok" } }), { runner: { engine: realEngine } });
  const source = "return await agent('plain');";
  const validation = await f.runner.validate(f.spec(source, { requestId: "no-meta" }));
  assert.equal(validation.valid, true);
  assert.equal(validation.meta, null);
  const result = await f.runner.start(f.spec(source, { requestId: "no-meta" }));
  assert.equal(result.state, "completed", JSON.stringify(result.error));
  assert.equal(result.output.finalText, "ok");
});

test("status paginates 1000 invocations compactly with per-call timestamps", { timeout: 120_000 }, async (t) => {
  const f = await fixture(t, async () => ({ result: { finalText: "ok" } }));
  const base = await f.runner.start(f.spec(planOf([call(instruction({ result: { finalText: "one" } }))]), { requestId: "pagination", name: "fixture" }));
  assert.equal(base.state, "completed");
  await f.runner.store.transact(base.runId, (record) => {
    const template = structuredClone(record.calls[0]);
    while (record.calls.length < 1000) {
      const ordinal = record.calls.length;
      record.calls.push({
        ...structuredClone(template),
        id: `inv-${ordinal}`, ordinal, label: `call ${ordinal}`,
        requestId: `dyn-fill:${ordinal}:1`, jobId: `job-fill-${ordinal}`, value: { finalText: `v${ordinal}` },
        attempts: [{ attempt: 1, requestId: `dyn-fill:${ordinal}:1`, jobId: `job-fill-${ordinal}`, sessionId: null, state: "completed", startedAt: template.startedAt, completedAt: template.completedAt }],
      });
    }
    return { record };
  });
  const page1 = await f.runner.status({ runId: base.runId });
  assert.equal(page1.name, "fixture");
  assert.equal(page1.invocationsTotal, 1000);
  assert.equal(page1.invocations.length, 200, "default page is bounded");
  assert.ok(page1.invocationsNextCursor > 0);
  assert.ok(JSON.stringify(page1).length < 200_000, "status payload stays compact");
  assert.ok(page1.invocations.every((invocation) => invocation.startedAt && invocation.completedAt), "per-call timeline fields present");
  let cursor = page1.invocationsNextCursor;
  let seen = page1.invocations.length;
  while (cursor !== undefined) {
    const page = await f.runner.status({ runId: base.runId, invocationCursor: cursor });
    seen += page.invocations.length;
    cursor = page.invocationsNextCursor;
  }
  assert.equal(seen, 1000, "every invocation remains discoverable by paging");
});
