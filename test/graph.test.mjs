import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { Companion } from "../src/companion.mjs";
import { JobStore } from "../src/job-store.mjs";
import { GraphRunner } from "../src/graph.mjs";
import { GraphStore } from "../src/graph-store.mjs";
import { childIdFor } from "../src/graph-protocol.mjs";
import { createRouteResolver } from "../src/routing.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const node = (id, dependsOn = [], extra = {}) => ({ id, task: id, target: "pi", dependsOn, ...extra });
async function until(work, predicate = (v) => v, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) { const value = await work(); if (predicate(value)) return value; if (Date.now() > deadline) throw new Error("test wait expired"); await sleep(10); }
}
async function fixture(t, run, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "harnest-graph-test-"));
  const store = new JobStore(join(root, "jobs"));
  const companion = new Companion({ store, routeResolver: async (r) => r, adapterFactory: () => ({ run }), cancelAckTimeoutMs: 30, ...options });
  const runner = new GraphRunner({ companion, pollIntervalMs: 10, heartbeatIntervalMs: 20, leaseTimeoutMs: 2000 });
  t.after(async () => { await Promise.all([...runner.running.values()]); await Promise.all([...companion.running.values()].map((v) => v.promise)); await sleep(30); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  const graph = (nodes, extra = {}) => ({ requestId: "fixture", cwd: root, nodes, execution: { background: false }, ...extra });
  return { root, store, companion, runner, graph };
}

test("diamond mixes harnesses, joins only direct attributed dependencies and preserves completion contracts", { timeout: 30_000 }, async (t) => {
  const seen = [], events = [];
  // Causal concurrency proof: "left" cannot finish until "right" has started.
  // A serial scheduler deadlocks this gate and the test fails red; no sleep
  // window has to outrun machine load.
  let rightStarted;
  const rightGate = new Promise((resolve) => { rightStarted = resolve; });
  const f = await fixture(t, async (r) => {
    seen.push(r); events.push(`start:${r.task}`);
    if (r.task === "right") rightStarted();
    if (r.task === "left") await rightGate;
    events.push(`end:${r.task}`);
    return { sessionId: `session-${r.task}`, result: { finalText: `result:${r.task}`, evidence: ["ok"], tests: ["pass"] } };
  });
  const result = await f.runner.start(f.graph([node("root", [], { target: "claude" }), node("left", ["root"], { target: "codex" }), node("right", ["root"], { target: "cursor" }), node("join", ["left", "right"], { target: "opencode", route: { model: "fake/model" }, context: { requiredResultFields: ["tests"] } })], {
    context: { shared: "capsule", requiredResultFields: ["evidence"] }, metadata: { routing: { consent: "retained" } },
  }));
  assert.equal(result.state, "completed"); assert.equal(result.counts.completed, 4);
  assert.ok(events.indexOf("start:right") < events.indexOf("end:left"));
  const joinRequest = seen.find((r) => r.task === "join");
  assert.deepEqual(Object.keys(joinRequest.context.graph.upstream).sort(), ["left", "right"]);
  assert.deepEqual(joinRequest.context.requiredResultFields, ["evidence", "tests"]);
  assert.equal(joinRequest.metadata.routing.consent, "retained");
  for (const dep of ["left", "right"]) {
    const identity = result.nodes.find((n) => n.id === dep);
    assert.equal(joinRequest.context.graph.upstream[dep].jobId, identity.jobId);
    assert.equal(joinRequest.context.graph.upstream[dep].target, identity.target);
    assert.equal(joinRequest.context.graph.upstream[dep].result.finalText, `result:${dep}`);
  }
  assert.deepEqual(Object.keys(result.outputs), ["join"]);
  assert.equal(result.outputs.join.finalText, "result:join");
  assert.ok(!JSON.stringify(await f.runner.status(result.graphId)).includes("result:join"));
  assert.ok(result.elapsedMs >= 0);
});

test("automatic graph routing accepts a configured ACP agent without a model route", async (t) => {
  const seen = [];
  const f = await fixture(t, async (request) => {
    seen.push(request);
    return { result: { finalText: "generic ACP completed" } };
  }, {
    routeResolver: async (request) => ({ ...request, target: "acp", route: { agent: "fixture-agent" } }),
  });
  const result = await f.runner.start(f.graph([
    node("generic", [], { target: "auto", route: {}, policy: { write: true } }),
  ], { requestId: "auto-acp-graph", policy: { write: true } }));
  assert.equal(result.state, "completed", JSON.stringify(result.errors));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].target, "acp");
  assert.deepEqual(seen[0].route, { agent: "fixture-agent" });
});

test("automatic graph routing accepts a variant-only Amp route", async (t) => {
  const seen = [];
  const f = await fixture(t, async (request) => {
    seen.push(request.route);
    return { result: { finalText: "Amp completed" } };
  }, { routeResolver: async (request) => ({ ...request, target: "amp", route: { variant: "low" } }) });
  const result = await f.runner.start(f.graph([node("amp", [], { target: "auto" })], { policy: { write: true } }));
  assert.equal(result.state, "completed", JSON.stringify(result.errors));
  assert.deepEqual(seen, [{ variant: "low" }]);
});

test("explicit and automatic graph nodes both apply session routing policy", async (t) => {
  const sessionId = "fixture-session";
  const routeResolver = createRouteResolver({
    config: { routing: {
      global: { defaults: { route: { model: "global-model" } } },
      sessions: { [sessionId]: { defaults: { route: { model: "session-model" } } } },
    } },
    env: {},
    userPolicy: {},
  });
  const seen = [];
  const f = await fixture(t, async (request) => {
    seen.push([request.task, [request.route.model, request.execution.sessionId]]);
    return { result: { finalText: "ok" } };
  }, { routeResolver });
  const result = await f.runner.start(f.graph([
    node("explicit", [], { target: "pi", execution: { sessionId } }),
    node("automatic", [], { target: "auto", execution: { sessionId } }),
  ]));
  assert.equal(result.state, "completed", JSON.stringify(result.errors));
  assert.equal(seen.length, 2);
  assert.deepEqual(Object.fromEntries(seen), {
    explicit: ["session-model", sessionId],
    automatic: ["session-model", sessionId],
  });
});

test("graph resume refuses an ACP child whose owned-process cleanup is unverified", async (t) => {
  let launches = 0;
  const f = await fixture(t, async () => {
    launches += 1;
    throw Object.assign(new Error("ACP process exit was not verified"), {
      details: { kind: "transport", unsafeResume: true, cleanupError: [{ component: "process", message: "exit unverified" }] },
    });
  });
  const first = await f.runner.start(f.graph([
    node("generic", [], { target: "acp", route: { agent: "fixture-agent" }, policy: { write: true } }),
  ], { requestId: "unsafe-acp-graph", policy: { write: true } }));
  assert.equal(first.state, "partial");
  await assert.rejects(
    () => f.runner.resume({ graphId: first.graphId, commandId: "unsafe-acp-retry", approveWrites: true, background: false }),
    (error) => error.details?.kind === "unsafe-resume",
  );
  assert.equal(launches, 1, "an unverified native process must not be launched again");
});

test("bounded throughput never exceeds requested concurrency", { timeout: 90_000 }, async (t) => {
  // Causal concurrency proof instead of an observation window: every adapter
  // started below the cap holds its slot until three are active together.
  // The cap invariant is checked separately; a scheduler that serializes
  // dispatch can never reach three held slots and goes red on peak (and the
  // bounded wait keeps a broken cap from hanging the suite).
  let active = 0, peak = 0, released = false, release;
  const threeActive = new Promise((resolve) => { release = resolve; });
  const f = await fixture(t, async () => {
    peak = Math.max(peak, ++active);
    if (active >= 3 && !released) { released = true; release(); }
    if (!released) {
      let timer;
      const grace = new Promise((resolve) => { timer = setTimeout(resolve, 10_000); });
      await Promise.race([threeActive, grace]).finally(() => clearTimeout(timer));
    }
    active--;
    return { result: { finalText: "ok" } };
  });
  const started = Date.now();
  const result = await f.runner.start(f.graph(Array.from({ length: 9 }, (_, i) => node(`n${i}`)), { execution: { background: false, maxConcurrency: 3 } }));
  assert.equal(result.state, "completed");
  assert.ok(peak <= 3, `peak concurrency ${peak} exceeded the requested cap`);
  assert.equal(peak, 3, "ready nodes must run concurrently up to the cap");
  t.diagnostic(`9 fake nodes / concurrency 3 completed in ${Date.now() - started}ms (45ms adapter delay)`);
});

test("failed root permits independent completion; resume retries only unsuccessful work with native lineage", { timeout: 30_000 }, async (t) => {
  const seen = [];
  const f = await fixture(t, async (r, { onProgress }) => {
    seen.push(r); await onProgress({ sessionId: `native-${r.task}` });
    if (r.task === "root" && seen.filter((x) => x.task === "root").length === 1) throw new Error("first attempt fails");
    return { result: { finalText: r.task } };
  });
  const initial = await f.runner.start(f.graph([node("join", ["root"]), node("root"), node("independent")]));
  assert.equal(initial.state, "partial"); assert.equal(initial.nodes.find((n) => n.id === "independent").state, "completed");
  const result = await f.runner.resume({ graphId: initial.graphId, commandId: "retry", nodeIds: ["root"], background: false });
  assert.equal(result.state, "completed"); assert.equal(seen.filter((r) => r.task === "independent").length, 1);
  const attempts = seen.filter((r) => r.task === "root");
  assert.notEqual(attempts[0].requestId, attempts[1].requestId); assert.equal(attempts[1].execution.sessionId, "native-root");
  assert.equal((await f.runner.resume({ graphId: initial.graphId, commandId: "retry", nodeIds: ["root"] })).generation, result.generation);
  assert.equal(seen.length, 4);
});

test("two runner instances deduplicate starts and resume commands", async (t) => {
  let launches = 0, fail = true;
  const f = await fixture(t, async () => { launches++; await sleep(50); if (fail) throw new Error("retry me"); return { result: { finalText: "ok" } }; });
  const other = new GraphRunner({ companion: f.companion, pollIntervalMs: 10 });
  const graph = f.graph([node("one")]);
  const [a, b] = await Promise.all([f.runner.start(graph), other.start(graph)]);
  assert.equal(a.graphId, b.graphId); assert.equal(launches, 1); fail = false;
  const request = { graphId: a.graphId, commandId: "retry", background: false };
  const [c, d] = await Promise.all([f.runner.resume(request), other.resume(request)]);
  assert.equal(c.generation, d.generation); assert.equal(launches, 2);
});

test("graph starts an explicit fork and resumes the observed child on retry", { timeout: 30_000 }, async (t) => {
  const seen = [];
  const f = await fixture(t, async (request, { onProgress }) => {
    seen.push(request);
    await onProgress({ sessionId: "forked-session" });
    if (seen.length === 1) throw new Error("retry after the fork");
    return { result: { finalText: "recovered" } };
  });
  const first = await f.runner.start(f.graph([node("fork", [], {
    target: "claude",
    route: { agent: "reviewer" },
    execution: { sessionId: "source-session", sessionAction: "fork", maxTurns: 3 },
  })]));
  assert.equal(first.state, "partial");
  const retried = await f.runner.resume({ graphId: first.graphId, commandId: "retry-fork", background: false });
  assert.equal(retried.state, "completed");
  assert.deepEqual(seen.map(({ route, execution }) => [route.agent, execution.sessionId, execution.sessionAction, execution.maxTurns]), [
    ["reviewer", "source-session", "fork", 3],
    ["reviewer", "forked-session", "resume", 3],
  ]);
});

test("graph child polling reuses one job snapshot per status observation", { timeout: 30_000 }, async (t) => {
  // Regression for the measured duplicate read: every Companion.status poll
  // used to read the job file, then have traceSummary read it again. A graph
  // run must now never let a status trace summary fall back to a second read.
  const f = await fixture(t, async (r) => ({ sessionId: `session-${r.task}`, result: { finalText: r.task } }));
  const realSummary = f.store.traceSummary.bind(f.store);
  let summaries = 0, snapshotSummaries = 0;
  f.store.traceSummary = (jobId, options = {}) => {
    summaries += 1;
    if (options.snapshot) snapshotSummaries += 1;
    return realSummary(jobId, options);
  };
  const result = await f.runner.start(f.graph([node("one"), node("two", ["one"]), node("three", ["two"])]));
  assert.equal(result.state, "completed");
  assert.ok(summaries > 0, "the graph must have polled child status");
  assert.equal(snapshotSummaries, summaries, "every status trace summary must reuse the already-read snapshot");
});

test("stale graph reconciles a completed child and fences the previous executor", async (t) => {
  const seen = [];
  const f = await fixture(t, async (r) => { seen.push(r.task); await sleep(60); return { sessionId: "saved", result: { finalText: r.task } }; });
  const initial = await f.runner.start(f.graph([node("root"), node("join", ["root"])], { execution: { background: true } }));
  await until(() => f.runner.store.read(initial.graphId), (r) => r.nodes[0].jobId);
  await f.runner.store.transact(initial.graphId, async (r, save) => { r.lease.fence++; r.generation++; r.lease.heartbeatAt = 0; await save(r); });
  const partial = await f.runner.status(initial.graphId);
  assert.equal(partial.state, "partial"); assert.equal(partial.recoveryRequired, true);
  await until(() => f.companion.statusByRequestId(childIdFor(initial.graphId, "root", 1)), (r) => r.state === "completed");
  const result = await f.runner.resume({ graphId: initial.graphId, commandId: "recover", background: false });
  assert.equal(result.state, "completed"); assert.deepEqual(seen, ["root", "join"]);
});

test("recovery adopts still-active child without restarting it", async (t) => {
  let launches = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const f = await fixture(t, async () => { launches++; await gate; return { result: { finalText: "ok" } }; });
  const initial = await f.runner.start(f.graph([node("one")], { execution: { background: true } }));
  try {
    await until(() => f.runner.store.read(initial.graphId), (r) => r.nodes[0].jobId);
    // A dispatch-time persistence error can mark the node uncertain while the
    // child still exists; adoption of the active child must clear that flag.
    await f.runner.store.transact(initial.graphId, async (r, save) => { r.lease.fence++; r.lease.heartbeatAt = 0; r.nodes[0].uncertain = true; await save(r); });
    const interrupted = await f.runner.result(initial.graphId);
    assert.equal(interrupted.state, "partial");
    assert.equal(interrupted.counts.running, 0, "a terminal graph must have no running nodes");
    await f.runner.resume({ graphId: initial.graphId, commandId: "adopt" });
  } finally { release(); }
  const result = await until(() => f.runner.status(initial.graphId), (s) => s.state === "completed");
  assert.equal(result.state, "completed"); assert.equal(launches, 1);
});

test("overlapping and symlink writers serialize while isolated writers overlap", { timeout: 30_000 }, async (t) => {
  const active = [], overlaps = [];
  const f = await fixture(t, async (r) => { overlaps.push([r.task, ...active]); active.push(r.task); await sleep(70); active.splice(active.indexOf(r.task), 1); return { result: { finalText: "ok" } }; });
  const parent = join(f.root, "work"), child = join(parent, "child"), separate = join(f.root, "isolated"), alias = join(f.root, "alias");
  const extraRootUser = join(f.root, "extra-root-user");
  await mkdir(child, { recursive: true }); await mkdir(separate); await symlink(parent, alias, process.platform === "win32" ? "junction" : "dir");
  await mkdir(extraRootUser);
  const result = await f.runner.start(f.graph([
    node("parent", [], { cwd: parent }), node("child", [], { cwd: child }),
    node("alias", [], { cwd: alias }), node("isolated", [], { cwd: separate }),
    node("extra-root", [], { cwd: extraRootUser, target: "claude", execution: { addDirs: [alias] } }),
  ], { policy: { write: true }, metadata: { harnest: { writeApproved: true } } }));
  assert.equal(result.state, "completed");
  assert.ok(overlaps.some((x) => x.includes("parent") && x.includes("isolated")));
  assert.ok(!overlaps.some((x) => ["parent", "child", "alias"].filter((id) => x.includes(id)).length > 1));
  assert.ok(!overlaps.some((x) => x.includes("extra-root") && ["parent", "child", "alias"].some((id) => x.includes(id))));
});

test("write retry requires approval; completed write nodes never rerun", async (t) => {
  let launches = 0;
  const f = await fixture(t, async () => { if (++launches === 1) throw new Error("failure"); return { result: { finalText: "ok" } }; });
  const initial = await f.runner.start(f.graph([node("write")], { policy: { write: true } }));
  await assert.rejects(f.runner.resume({ graphId: initial.graphId, commandId: "retry" }), /approveWrites/);
  const result = await f.runner.resume({ graphId: initial.graphId, commandId: "retry", approveWrites: true, background: false });
  assert.equal(result.state, "completed"); assert.equal(launches, 2);
});

test("malformed DAGs, policy escalation and later invalid routes are rejected before spawn", async (t) => {
  let launches = 0;
  const f = await fixture(t, async () => { launches++; return { result: { finalText: "unexpected" } }; }, { routeResolver: async (r) => { if (r.route.model === "bad") throw new Error("invalid model route"); return r; } });
  const inputs = [
    f.graph([node("a", ["b"]), node("b", ["a"])]), f.graph([node("a"), node("a")]), f.graph([node("a", ["missing"])]),
    f.graph([node("a", [], { policy: { write: true } })]), f.graph([node("a", [], { workflow: { spec: {} } })]),
    f.graph([node("a", [], { cwd: "relative" })]), f.graph([node("a")], { execution: { maxConcurrency: 7 } }),
    f.graph([node("a"), node("b", [], { route: { model: "bad" } })]),
    f.graph([node("a", [], { policy: { tools: ["write"] } })], { policy: { tools: ["read"] } }),
    f.graph([node("a", [], { context: { blob: "x".repeat(400_001) } })]),
    f.graph([node("a"), node("b", [], { target: "codex", policy: { tools: ["read"] } })]),
    f.graph([node("a"), node("b", [], { target: "cursor", policy: { maxCostUsd: 1 } })]),
    f.graph([node("a"), node("b", [], { target: "claude", policy: { tools: ["read"] } })]),
    f.graph([node("a"), node("b", [], { target: "opencode" })]),
    f.graph([node("a"), node("b", [], { route: { model: "sonnet" } })]),
    f.graph([node("a"), node("amp-readonly", [], { target: "amp", route: { variant: "medium" } })]),
  ];
  for (const graph of inputs) await assert.rejects(f.runner.start(graph));
  assert.equal(launches, 0);
});

test("preflight requires explicit targets, bounds ids and routes, and validates node timeouts", async (t) => {
  let launches = 0;
  const f = await fixture(t, async () => { launches++; return { result: { finalText: "ok" } }; });
  const bad = [
    f.graph([{ id: "a", task: "a" }]),
    f.graph([{ id: "a", task: "a", target: "nope" }]),
    f.graph([{ id: "a".repeat(65), task: "a", target: "pi" }]),
    f.graph([node("a", [], { route: { unknown: "x" } })]),
    f.graph([node("a", [], { route: { thinking: 3 } })]),
    f.graph([node("a", [], { execution: { timeoutMs: 0 } })]),
    f.graph([node("a", [], { execution: { timeoutMs: 86_400_001 } })]),
    { ...f.graph([node("a")]), requestId: "r".repeat(201) },
  ];
  for (const graph of bad) await assert.rejects(f.runner.start(graph));
  assert.equal(launches, 0);
  const accepted = await f.runner.start(f.graph([
    { id: "a".repeat(64), task: "a", target: "pi", route: { thinking: true }, policy: { write: false } },
    node("b", [], { route: { variant: "high", provider: "openrouter", model: "provider/model" }, policy: { write: false } }),
    node("amp-write", [], { target: "amp", route: { variant: "high" }, policy: { write: true } }),
  ], { policy: { write: true } }));
  assert.equal(accepted.state, "completed");
});

test("resolver cannot rewrite pins, identity, cwd, context, timeout or policy; auto may resolve route", async (t) => {
  const cases = [
    ["explicit target", (r) => ({ ...r, target: "claude" }), node("pinned", [], { target: "pi", route: { model: "explicit" } })],
    ["explicit model", (r) => ({ ...r, route: { ...r.route, model: "changed" } }), node("pinned", [], { target: "pi", route: { model: "explicit" } })],
    ["cwd", (r) => ({ ...r, cwd: `${r.cwd}-elsewhere` }), node("pinned", [], { target: "pi" })],
    ["task", (r) => ({ ...r, task: "changed" }), node("pinned", [], { target: "pi" })],
    ["requestId", (r) => ({ ...r, requestId: "changed" }), node("pinned", [], { target: "pi" })],
    ["context", (r) => ({ ...r, context: { ...r.context, injected: true }, contextDigest: undefined }), node("pinned", [], { target: "pi" })],
    ["timeout", (r) => ({ ...r, execution: { ...r.execution, timeoutMs: 1234 } }), node("pinned", [], { target: "pi", execution: { timeoutMs: 5000 } })],
    ["write", (r) => ({ ...r, policy: { ...r.policy, write: true } }), node("pinned", [], { target: "pi" })],
    ["tools", (r) => ({ ...r, policy: { ...r.policy, tools: ["extra"] } }), node("pinned", [], { target: "pi" })],
    ["workflow", (r) => ({ ...r, workflow: { spec: {} } }), node("pinned", [], { target: "pi" })],
    ["route thinking", (r) => ({ ...r, route: { ...r.route, thinking: "low" } }), node("pinned", [], { target: "pi", route: { model: "explicit", thinking: "high" } })],
    ["route variant", (r) => ({ ...r, route: { ...r.route, variant: "other" } }), node("pinned", [], { target: "pi", route: { model: "explicit", variant: "orig" } })],
    ["route agent", (r) => ({ ...r, route: { ...r.route, agent: "other" } }), node("pinned", [], { target: "opencode", route: { model: "m", agent: "orig" } })],
    ["route serverUrl", (r) => ({ ...r, route: { ...r.route, serverUrl: "http://evil.invalid" } }), node("pinned", [], { target: "opencode", route: { model: "m", serverUrl: "http://local.invalid" } })],
    ["auto route pin", (r) => ({ ...r, route: { ...r.route, thinking: "low" } }), node("auto-pin", [], { target: "auto", route: { thinking: "high" } })],
  ];
  for (const [name, mutate, graphNode] of cases) {
    let launches = 0;
    const f = await fixture(t, async () => { launches++; return { result: { finalText: "ok" } }; }, { routeResolver: async (r) => mutate(r) });
    await assert.rejects(f.runner.start(f.graph([graphNode])), (error) => { assert.ok(error instanceof Error, `${name} must reject`); return true; });
    assert.equal(launches, 0, `${name} must be rejected before dispatch`);
  }
  const resolved = [];
  const auto = await fixture(t, async (r) => { resolved.push(r); return { result: { finalText: "ok" } }; }, { routeResolver: async (r) => ({ ...r, target: "claude", route: { ...r.route, model: "claude-fake" } }) });
  const result = await auto.runner.start(auto.graph([node("auto", [], { target: "auto" })]));
  assert.equal(result.state, "completed");
  assert.equal(resolved[0].target, "claude");
  assert.equal(resolved[0].route.model, "claude-fake");
  const withControls = await auto.runner.start(auto.graph([
    node("auto", [], { target: "auto", execution: { maxTurns: 3 } }),
  ], { requestId: "auto-controls" }));
  assert.equal(withControls.state, "completed");
  assert.equal(resolved[1].execution.maxTurns, 3);
});

test("failed optional lease sidecar refresh does not terminate a live graph", { timeout: 90_000 }, async (t) => {
  let launches = 0, leaseFailures = 0;
  // The adapter must outlive the lease timeout on purpose: without the
  // authoritative fallback rewrite a live but I/O-blocked owner is falsely
  // expired. A 4s lease keeps that margin meaningful under a loaded machine.
  const f = await fixture(t, async () => { launches++; await sleep(5500); return { result: { finalText: "ok" } }; });
  f.runner = new GraphRunner({ companion: f.companion, pollIntervalMs: 10, heartbeatIntervalMs: 20, leaseTimeoutMs: 4000 });
  f.runner.store = new GraphStore(join(f.root, "jobs", "graphs"), {
    rename: async (from, to) => {
      if (to.endsWith(".lease")) { leaseFailures++; throw Object.assign(new Error("injected lease rename failure"), { code: "EIO" }); }
      return rename(from, to);
    },
  });
  const result = await f.runner.start(f.graph([node("one")]));
  assert.equal(result.state, "completed");
  assert.equal(launches, 1);
  assert.ok(leaseFailures >= 1, "the optional sidecar refresh must have been attempted");
});

test("transient Windows rename contention is retried instead of failing the write", { timeout: 90_000 }, async (t) => {
  let failures = 0;
  const f = await fixture(t, async () => ({ result: { finalText: "ok" } }));
  f.runner = new GraphRunner({ companion: f.companion, pollIntervalMs: 10, heartbeatIntervalMs: 20, leaseTimeoutMs: 4000 });
  f.runner.store = new GraphStore(join(f.root, "jobs", "graphs"), {
    platform: "win32",
    rename: async (from, to) => {
      if (failures < 5) { failures++; throw Object.assign(new Error("injected transient rename failure"), { code: "EPERM" }); }
      return rename(from, to);
    },
  });
  const result = await f.runner.start(f.graph([node("one")]));
  assert.equal(result.state, "completed");
  assert.equal(failures, 5, "the store must have retried past the transient failures");
});

test("automatic routes resolve once per node using task hints and explicit pins survive", { timeout: 90_000 }, async (t) => {
  const calls = [];
  const f = await fixture(t, async (r) => { calls.push(r); return { result: { finalText: "ok" } }; }, { routeResolver: async (r) => {
    if (r.route.model) return r;
    const target = r.metadata.routing.tier === "hard" ? "claude" : "pi";
    return { ...r, target, route: { model: `${target}-fake` }, metadata: { ...r.metadata, harnest: { routingDecision: { selected: target } } } };
  } });
  const result = await f.runner.start(f.graph([node("simple", [], { target: "auto" }), node("hard", [], { target: "auto", metadata: { routing: { tier: "hard" } } }), node("pinned", [], { target: "codex", route: { model: "explicit" } })]));
  assert.equal(result.state, "completed");
  assert.deepEqual(Object.fromEntries(calls.map((r) => [r.task, r.target])), { simple: "pi", hard: "claude", pinned: "codex" });
  assert.equal(calls.find((r) => r.task === "pinned").route.model, "explicit");
  f.companion.routeResolver = async (r) => r;
  await assert.rejects(f.runner.validate(f.graph([node("auto", [], { target: "auto" })])), /no usable model/);
});

test("long-poll unchanged snapshots are compact and heartbeats do not rewrite semantic snapshot", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const f = await fixture(t, async () => { await gate; return { result: { finalText: "private result" } }; });
  const initial = await f.runner.start(f.graph([node("one")], { execution: { background: true } }));
  let before;
  try {
    await until(() => f.runner.store.read(initial.graphId), (r) => r.nodes[0].attempts[0]?.state === "running");
    before = await f.runner.status(initial.graphId);
    const info = await stat(f.runner.store.path(initial.graphId));
    const unchanged = await f.runner.status(initial.graphId, { afterRevision: before.revision, waitMs: 80 });
    assert.equal(unchanged.unchanged, true); assert.ok(JSON.stringify(unchanged).length < 250);
    assert.equal((await stat(f.runner.store.path(initial.graphId))).mtimeMs, info.mtimeMs);
  } finally { release(); }
  const changed = await f.runner.status(initial.graphId, { afterRevision: before.revision, waitMs: 10_000 });
  assert.ok(changed.revision > before.revision);
  await until(() => f.runner.status(initial.graphId), (s) => s.state === "completed");
});

test("local cancellation waits for adapter stop and prevents queued dispatch", async (t) => {
  const seen = [];
  const f = await fixture(t, async (r, { signal }) => { seen.push(r.task); await new Promise((resolve) => signal.addEventListener("abort", () => setTimeout(resolve, 10), { once: true })); throw Object.assign(new Error("stopped"), { details: { aborted: true } }); });
  const initial = await f.runner.start(f.graph([node("one"), node("two", ["one"])], { execution: { background: true } }));
  await until(() => seen.length);
  await f.runner.cancel(initial.graphId);
  const result = await until(() => f.runner.status(initial.graphId), (s) => s.state === "cancelled");
  assert.deepEqual(seen, ["one"]); assert.equal(result.cancellation.state, "acknowledged");
});

test("a stale uncertainty flag on a completed node does not wedge resume", { timeout: 30_000 }, async (t) => {
  const attempts = new Map();
  const f = await fixture(t, async (r) => {
    const count = (attempts.get(r.task) ?? 0) + 1;
    attempts.set(r.task, count);
    if (r.task === "bad" && count === 1) throw new Error("first attempt fails");
    return { result: { finalText: "ok" } };
  });
  const initial = await f.runner.start(f.graph([node("good"), node("bad")]));
  assert.equal(initial.state, "partial");
  // Simulate a completed receipt observed with stale cancellation metadata
  // (requested while the child was already finishing).
  await f.runner.store.transact(initial.graphId, async (record, save) => {
    record.nodes.find((n) => n.id === "good").uncertain = true;
    await save(record);
  });
  const result = await f.runner.resume({ graphId: initial.graphId, commandId: "retry-past-stale", background: false });
  assert.equal(result.state, "completed");
  assert.equal(attempts.get("good"), 1, "completed work must not rerun");
});

test("large fan-outs validate up to 256 nodes without dispatching", { timeout: 30_000 }, async (t) => {
  let launches = 0;
  const f = await fixture(t, async () => { launches++; return { result: { finalText: "ok" } }; });
  const many = Array.from({ length: 150 }, (_, i) => node(`worker-${String(i).padStart(3, "0")}`, [], { target: "pi", route: { model: "fixture" } }));
  const resolved = await f.runner.validate(f.graph(many));
  assert.equal(resolved.valid, true);
  assert.equal(resolved.nodes.length, 150);
  assert.equal(launches, 0, "validation must not dispatch");
  await assert.rejects(f.runner.validate(f.graph([...many, ...Array.from({ length: 107 }, (_, i) => node(`extra-${i}`))])), /256 nodes/);
  assert.equal(launches, 0);
});

test("a timed-out child stays retryable instead of dead-ending the graph", async (t) => {
  let launches = 0;
  const f = await fixture(t, async (r, { signal }) => {
    launches++;
    if (launches === 1) {
      await new Promise((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener("abort", resolve, { once: true }); });
      throw Object.assign(new Error("child timed out"), { details: { aborted: true } });
    }
    return { result: { finalText: "recovered" } };
  });
  const initial = await f.runner.start(f.graph([node("slow", [], { execution: { timeoutMs: 60 } })]));
  assert.equal(initial.state, "partial");
  assert.equal(initial.nodes[0].error.details.kind, "timeout");
  const result = await f.runner.resume({ graphId: initial.graphId, commandId: "retry-timeout", background: false });
  assert.equal(result.state, "completed");
  assert.equal(launches, 2);
});

test("unacknowledged stop fails closed on resume", async (t) => {
  let release;
  const f = await fixture(t, async () => new Promise((resolve) => { release = () => resolve({ result: { finalText: "late" } }); }));
  const initial = await f.runner.start(f.graph([node("one")], { execution: { background: true } }));
  await until(() => release);
  await f.runner.cancel(initial.graphId);
  const result = await until(() => f.runner.status(initial.graphId), (s) => s.state === "partial");
  await assert.rejects(f.runner.resume({ graphId: result.graphId, commandId: "unsafe" }), /may still be executing/);
  release();
});

test("whole-graph timeout stops future dispatch with truthful child acknowledgement", async (t) => {
  const seen = [];
  const f = await fixture(t, async (r, { signal }) => {
    seen.push(r.task);
    await new Promise((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener("abort", resolve, { once: true }); });
    throw Object.assign(new Error("stopped"), { details: { aborted: true } });
  });
  const initial = await f.runner.start(f.graph([node("active"), node("join", ["active"])], { execution: { background: true, timeoutMs: 10_000 } }));
  await until(() => seen.length);
  await f.runner.store.transact(initial.graphId, async (record, save) => { record.deadlineAt = Date.now() - 1; await save(record); });
  const result = await until(() => f.runner.status(initial.graphId), (s) => s.state === "partial");
  assert.equal(result.state, "partial"); assert.deepEqual(seen, ["active"]);
  assert.equal(result.cancellation.reason, "timeout"); assert.equal(result.cancellation.state, "acknowledged");
});

test("a graph interrupted during timeout cancellation publishes no running nodes", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const f = await fixture(t, async () => { await gate; return { result: { finalText: "late" } }; });
  const stopError = new Error("injected stop failure");
  f.companion.cancel = async () => { throw stopError; };
  const initial = await f.runner.start(f.graph([node("active"), node("tail", ["active"])], { execution: { background: true } }));
  try {
    await until(() => f.runner.store.read(initial.graphId), (r) => r.nodes[0].jobId);
    await f.runner.store.transact(initial.graphId, async (record, save) => { record.deadlineAt = Date.now() - 1; await save(record); });
    await f.runner.running.get(initial.graphId);
    const result = await f.runner.result(initial.graphId);
    assert.equal(result.state, "partial");
    assert.equal(result.recoveryRequired, true);
    assert.equal(result.cancellation.reason, "timeout");
    assert.ok(result.errors.some((error) => error.message === stopError.message));
    assert.equal(result.counts.running, 0, "a terminal graph must have no running nodes");
  } finally { release(); }
});

test("status does not fence its live timeout coordinator on a stale heartbeat", async (t) => {
  let releaseAdapter, releaseStatus, enteredStatus;
  const adapterGate = new Promise((resolve) => { releaseAdapter = resolve; });
  const statusGate = new Promise((resolve) => { releaseStatus = resolve; });
  const observingChild = new Promise((resolve) => { enteredStatus = resolve; });
  const f = await fixture(t, async () => { await adapterGate; return { result: { finalText: "done" } }; });
  const initial = await f.runner.start(f.graph([node("active")], { execution: { background: true } }));
  try {
    await until(() => f.runner.store.read(initial.graphId), (r) => r.nodes[0].jobId);
    const childStatus = f.companion.status.bind(f.companion);
    t.mock.method(f.companion, "status", async (id) => {
      enteredStatus();
      await statusGate;
      return childStatus(id);
    });
    await observingChild;
    await f.runner.store.transact(initial.graphId, async (record, save) => { record.deadlineAt = Date.now() - 1; await save(record); });
    const read = f.runner.store.read.bind(f.runner.store);
    const staleRead = t.mock.method(f.runner.store, "read", async (id) => {
      const record = await read(id);
      if (record?.lease) record.lease.heartbeatAt = 0;
      return record;
    });
    try {
      assert.equal((await f.runner.status(initial.graphId)).state, "running");
    } finally { staleRead.mock.restore(); }
  } finally {
    releaseStatus();
    releaseAdapter();
  }
});

test("selective resume restores pre-dispatch nodes cancelled by a whole-graph timeout", { timeout: 30_000 }, async (t) => {
  // The inside-budget partial: a whole-graph timeout cancels nodes that were
  // only blocked, then resume clears the cancellation but used to leave those
  // never-dispatched nodes cancelled, so dependents never ran and the graph
  // settled partial with no cancellation even though the retry succeeded.
  let badAttempts = 0;
  let activeAborted = false;
  const f = await fixture(t, async (r, { signal }) => {
    if (r.task === "bad") {
      badAttempts += 1;
      if (badAttempts === 1) throw new Error("first attempt fails");
      return { result: { finalText: "bad-ok" } };
    }
    if (r.task === "active" && !activeAborted) {
      await new Promise((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener("abort", resolve, { once: true }); });
      activeAborted = true;
      throw Object.assign(new Error("stopped"), { details: { aborted: true } });
    }
    return { result: { finalText: r.task } };
  });
  const initial = await f.runner.start(f.graph(
    [node("good"), node("bad"), node("tail", ["bad"]), node("active")],
    { execution: { background: true, timeoutMs: 60_000 } },
  ));
  const stateOf = (status, id) => status.nodes.find((n) => n.id === id).state;
  const wanted = { good: "completed", bad: "failed", tail: "blocked", active: "running" };
  const before = await until(() => f.runner.status(initial.graphId), (s) => Object.entries(wanted).every(([id, state]) => stateOf(s, id) === state));
  assert.equal(before.nodes.find((n) => n.id === "tail").attempts.length, 0, "tail must never have been dispatched");
  // Deterministic barrier instead of waiting out the 60s budget.
  await f.runner.store.transact(initial.graphId, async (record, save) => { record.deadlineAt = Date.now() - 1; await save(record); });
  const timedOut = await until(() => f.runner.status(initial.graphId), (s) => s.state === "partial");
  assert.equal(timedOut.cancellation.reason, "timeout");
  assert.equal(stateOf(timedOut, "tail"), "cancelled");
  assert.equal(stateOf(timedOut, "active"), "cancelled");
  const selective = await f.runner.resume({ graphId: initial.graphId, commandId: "retry-bad", nodeIds: ["bad"], background: false });
  assert.equal(selective.state, "partial");
  assert.equal(stateOf(selective, "tail"), "completed", "never-dispatched work must be restored");
  assert.equal(stateOf(selective, "active"), "cancelled", "a stopped execution still needs an explicit retry");
  assert.equal(selective.nodes.find((n) => n.id === "active").attempts.length, 1);
  const resumed = await f.runner.resume({ graphId: initial.graphId, commandId: "retry-active", nodeIds: ["active"], background: false });
  assert.equal(resumed.state, "completed", JSON.stringify(resumed));
  assert.equal(stateOf(resumed, "tail"), "completed");
  assert.equal(badAttempts, 2);
});

test("pre-launch deadline cancel drops the prepared attempt so selective resume can restore it", { timeout: 30_000 }, async (t) => {
  // Variant of the timeout partial: the deadline crosses after the dispatch
  // intent is saved but before companion.start, leaving a node cancelled with
  // a prepared attempt that never ran. If that attempt survives as if it were
  // dispatched, selective resume leaves the node and its dependents stopped
  // and settles partial with no cancellation.
  let launches = 0;
  const f = await fixture(t, async () => { launches += 1; return { result: { finalText: "ok" } }; });
  const realTransact = f.runner.store.transact.bind(f.runner.store);
  let barred = false;
  f.runner.store.transact = (id, work) => realTransact(id, async (record, save) => work(record, async (next) => {
    if (!barred && next.nodes.some((n) => n.state === "running" && n.attempts.at(-1) && n.attempts.at(-1).startedAt == null)) {
      barred = true;
      next.deadlineAt = Date.now() - 1;
    }
    return save(next);
  }));
  const initial = await f.runner.start(f.graph([node("retry"), node("victim")], { execution: { background: true, maxConcurrency: 2 } }));
  const partial = await until(() => f.runner.status(initial.graphId), (s) => s.state === "partial");
  assert.equal(barred, true, "the dispatch save must have armed the deadline barrier");
  assert.equal(launches, 0, "the deadline must cancel before any adapter launch");
  assert.equal(partial.cancellation, null);
  const victim = partial.nodes.find((n) => n.id === "victim");
  assert.equal(victim.state, "cancelled");
  assert.equal(victim.attempts.length, 0, "a never-launched attempt must not be retained");
  const resumed = await f.runner.resume({ graphId: initial.graphId, commandId: "retry-one", nodeIds: ["retry"], background: false });
  assert.equal(resumed.state, "completed", JSON.stringify(resumed));
  assert.equal(resumed.nodes.find((n) => n.id === "victim").state, "completed");
  assert.equal(launches, 2);
});

test("oversized completed output remains bounded and cannot trigger model re-execution", { timeout: 30_000 }, async (t) => {
  let launches = 0;
  const f = await fixture(t, async () => { launches++; return { result: { finalText: "x".repeat(400_001) } }; });
  const result = await f.runner.start(f.graph([node("large")]));
  assert.equal(result.state, "partial"); assert.ok(JSON.stringify(result).length < 20_000);
  await assert.rejects(f.runner.resume({ graphId: result.graphId, commandId: "retry" }), /already completed/);
  assert.equal(launches, 1);
});

test("idempotent starts use persisted routes and active attempts reject a different resume command", async (t) => {
  let routes = 0, fail = true, release;
  const gate = new Promise((resolve) => { release = resolve; });
  const f = await fixture(t, async () => { if (fail) throw new Error("retry"); await gate; return { result: { finalText: "ok" } }; }, { routeResolver: async (r) => { routes++; return r; } });
  const graph = f.graph([node("one")]);
  const first = await f.runner.start(graph);
  await f.runner.start(graph); assert.equal(routes, 1);
  fail = false;
  let settled = false;
  try {
    await f.runner.resume({ graphId: first.graphId, commandId: "first" });
    const completion = f.runner.running.get(first.graphId);
    assert.ok(completion, "the resumed attempt must have a local owner");
    void completion.then(() => { settled = true; });
    await assert.rejects(f.runner.resume({ graphId: first.graphId, commandId: "different" }), /active attempt/);
  } finally { release(); }
  // Wait for the owner without repeatedly opening the snapshot it must replace.
  await until(() => settled);
  const result = await f.runner.result(first.graphId);
  assert.equal(result.state, "completed", JSON.stringify(result.errors));
});

function worker(root, action) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(import.meta.dirname, "fixtures", "graph-worker.mjs"), root, action], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "", error = ""; child.stdout.on("data", (data) => { output += data; }); child.stderr.on("data", (data) => { error += data; });
    child.on("error", reject); child.on("close", (code) => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(error)));
  });
}

test("cross-process repeated starts and cancellation share durable intents", { timeout: 90_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harnest-graph-process-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  await writeFile(join(root, "input.json"), JSON.stringify({ requestId: "cross-process", cwd: root, nodes: [node("slow")], context: { hold: "release" }, execution: { background: false } }));
  const a = worker(root, "start"), b = worker(root, "start");
  // Child node processes can start slowly on a loaded machine; the gate is the
  // launch file itself, so wait generously instead of racing process startup.
  await until(() => readFile(join(root, "launches.txt"), "utf8").catch(() => ""), (v) => v.length > 0, 60_000);
  await worker(root, "cancel");
  const [left, right] = await Promise.all([a, b]);
  assert.equal(left.state, "cancelled"); assert.equal(right.graphId, left.graphId);
  assert.equal((await readFile(join(root, "launches.txt"), "utf8")).trim().split("\n").length, 1);
});

test("cross-process repeated resume command launches exactly one fresh attempt", { timeout: 90_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harnest-graph-process-resume-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  await writeFile(join(root, "input.json"), JSON.stringify({ requestId: "cross-process-resume", cwd: root, nodes: [node("retry")], context: { failOnce: true }, execution: { background: false } }));
  const first = await worker(root, "start"); assert.equal(first.state, "partial");
  const [left, right] = await Promise.all([worker(root, "resume"), worker(root, "resume")]);
  assert.equal(left.state, "completed"); assert.equal(right.generation, left.generation);
  assert.equal((await readFile(join(root, "launches.txt"), "utf8")).trim().split("\n").length, 2);
});
