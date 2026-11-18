import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createT3Bridge, T3_BRIDGE_OPERATIONS } from "../src/t3-bridge.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEMO = join(REPO_ROOT, "scripts", "demo-t3-workflow.mjs");
const ADAPTER = join(REPO_ROOT, "scripts", "fixtures", "dynamic-demo-adapter.mjs");
// A source-shaped payload used only to prove the bridge refuses it before any
// execution: it is never validated, parsed or run.
const WORKFLOW_SOURCE_PROXY = "export const meta = { name: \"bridge-source-probe\" };";

// Adapter seam used for every in-process resume below: the fake demo adapter
// never launches a harness, touches the network or spends money, and records
// every launch in launches.jsonl so the tests can prove no read-only
// operation dispatched it.
const withFakeAdapter = () => {
  process.env.HARNEST_WORKER_ADAPTER = ADAPTER;
};

test("t3 bridge rejects untrusted stateDir paths", async () => {
  for (const bad of [undefined, "", "relative/state", "C:\\tmp\\..\\escape", "/tmp/../escape"]) {
    await assert.rejects(createT3Bridge({ stateDir: bad }), (error) => error.details?.kind === "validation", JSON.stringify(bad));
  }
  await assert.rejects(createT3Bridge({ stateDir: mkdtempSync(join(tmpdir(), "t3-bridge-ok-")), adapterPath: "relative/adapter.mjs" }), (error) => {
    return error.details?.kind === "validation" && /adapterPath/.test(error.message);
  });
  await assert.rejects(createT3Bridge({ stateDir: mkdtempSync(join(tmpdir(), "t3-bridge-ok-")), adapterPath: "C:\\tmp\\..\\evil.mjs" }), (error) => {
    return error.details?.kind === "validation" && /adapterPath/.test(error.message);
  });
});

test("t3 bridge rejects unknown operations, unknown keys and traversal ids", async () => {
  const bridge = await createT3Bridge({ stateDir: mkdtempSync(join(tmpdir(), "t3-bridge-validation-")) });
  const dispatch = (operation, input) => bridge.dispatch({ operation, input });
  await assert.rejects(dispatch("start", { workflow: {} }), (error) => error.details?.kind === "validation");
  await assert.rejects(dispatch("nope", {}), (error) => error.details?.kind === "validation");
  await assert.rejects(bridge.dispatch({ operation: "history", extra: true }), (error) => error.details?.kind === "validation");
  await assert.rejects(dispatch("status", { runId: "../etc/passwd" }), (error) => {
    return error.details?.kind === "validation" && /runId/.test(error.message);
  });
  await assert.rejects(dispatch("status", { runId: "dyn-zzz" }), (error) => error.details?.kind === "validation");
  await assert.rejects(dispatch("trace", { jobId: "a..b" }), (error) => error.details?.kind === "validation");
  await assert.rejects(dispatch("inspect", { runId: `${"dyn-0".padEnd(68, "0")}`, invocationId: "../../x" }), (error) => {
    return error.details?.kind === "validation" && /invocationId/.test(error.message);
  });
  // unknown input keys fail through the existing dynamic tool schemas
  await assert.rejects(dispatch("status", { runId: `${"dyn-0".padEnd(68, "0")}`, nope: 1 }), (error) => error.details?.kind === "validation");
  await assert.rejects(dispatch("resume", { runId: `${"dyn-0".padEnd(68, "0")}`, commandId: "c", approveWrites: "yes" }), (error) => error.details?.kind === "validation");
  // write-capable operations are the only writes; result is terminal-gated read
  assert.deepEqual(Object.keys(T3_BRIDGE_OPERATIONS).sort(), ["control", "history", "inspect", "result", "resume", "status", "trace"]);
  assert.deepEqual([...new Set(Object.values(T3_BRIDGE_OPERATIONS))].sort(), ["read", "write"]);
});

test("t3 bridge resume rejects source replacement before execution; same-source resume passes schema", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "t3-bridge-resume-schema-"));
  const stateDir = join(fixture, "state");
  process.env.HARNEST_WORKER_ADAPTER = ADAPTER;
  process.env.HARNEST_DEMO_DIR = stateDir;
  const bridge = await createT3Bridge({ stateDir, adapterPath: ADAPTER });
  const runId = "dyn-0".padEnd(68, "0");
  const probeLedger = join(stateDir, "launches.jsonl");

  // Source replacement is refused with an explicit policy message before the
  // runner is touched — no run lookup, no dispatch, no adapter import.
  await assert.rejects(
    bridge.dispatch({ operation: "resume", input: { runId, commandId: "c", source: WORKFLOW_SOURCE_PROXY } }),
    (error) => error.details?.kind === "validation" && /source replacement/.test(error.message),
  );
  // Any other unknown resume key is still rejected by the narrowed schema.
  await assert.rejects(
    bridge.dispatch({ operation: "resume", input: { runId, commandId: "c", args: {} } }),
    (error) => error.details?.kind === "validation",
  );
  // A same-source resume (no source field) passes the narrowed schema and
  // reaches the runner, which reports not-found for an unknown runId — no
  // adapter ran (the probe ledger was never written).
  await assert.rejects(
    bridge.dispatch({ operation: "resume", input: { runId, commandId: "c" } }),
    (error) => error.details?.kind === "not-found",
  );
  assert.equal(existsSync(probeLedger), false, "schema-level resume failures must never dispatch the adapter");

  // The 128 KiB body bound fires before schema parsing.
  await assert.rejects(
    bridge.dispatch({ operation: "control", input: { runId, commandId: "c", message: "x".repeat(140_000) } }),
    (error) => error.details?.kind === "limit",
  );
  // A normal-size control body clears the byte bound, passes the schema and
  // fails with the runner's not-found instead — the cap is not over-restrictive.
  await assert.rejects(
    bridge.dispatch({ operation: "control", input: { runId, commandId: "c", action: "pause", message: "pause now" } }),
    (error) => error.details?.kind === "not-found",
  );
  rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("t3 bridge read-only operations never dispatch the adapter or mutate runs", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "t3-bridge-readonly-"));
  // Adapter canary: if any read operation ever loaded or ran the fake
  // adapter, a launch would be appended to this probe ledger.
  process.env.HARNEST_DEMO_DIR = join(fixture, "adapter-probe");
  process.env.HARNEST_WORKER_ADAPTER = ADAPTER;
  const probeLedger = join(process.env.HARNEST_DEMO_DIR, "launches.jsonl");

  // Park one run through the demo script so reads have real data to serve,
  // then settle it: a live parked run is mutated by its own detached worker
  // (lease heartbeats), which would confound a read-only assertion.
  const started = spawnSync(process.execPath, [DEMO, "--fixture", fixture, "--timeout-ms", "60000"], {
    encoding: "utf8", timeout: 90_000, windowsHide: true, env: process.env,
  });
  assert.equal(started.status, 0, started.stderr);
  const parked = JSON.parse((started.stdout ?? "").trim());
  assert.match(parked.runId, /^dyn-[a-f0-9]{64}$/);
  const stateDirAbs = parked.stateDir;
  const bridge = await createT3Bridge({ stateDir: stateDirAbs });
  await bridge.dispatch({ operation: "control", input: { runId: parked.runId, commandId: `settle-${Date.now()}`, action: "stop" } }).catch(() => undefined);
  let status = null;
  for (let index = 0; index < 100; index += 1) {
    status = await bridge.dispatch({ operation: "status", input: { runId: parked.runId, invocationLimit: 10 } }).catch(() => null);
    if (status && ["completed", "failed", "cancelled", "partial"].includes(status.state)) break;
    await new Promise((resolve_) => setTimeout(resolve_, 200));
  }
  assert.ok(status && ["failed", "cancelled", "partial", "completed"].includes(status.state), JSON.stringify(status?.state ?? null));
  const settledRevision = status.revision;
  const beforeJobs = readdirSync(stateDirAbs).filter((name) => /^[0-9a-f-]{36}\.json$/i.test(name)).sort();
  const journalPath = join(stateDirAbs, "dynamic", `${parked.runId}.journal.jsonl`);
  const beforeJournal = readFileSync(journalPath, "utf8");

  const history = await bridge.dispatch({ operation: "history", input: { limit: 10 } });
  assert.ok(history.runs.some((run) => run.runId === parked.runId));
  const review = status.invocations.find((call) => call.label === "review");
  const inspect = await bridge.dispatch({ operation: "inspect", input: { runId: parked.runId, invocationId: review.id } });
  assert.equal(inspect.attempts[0].state, "failed");
  await bridge.dispatch({ operation: "trace", input: { jobId: status.invocations[0].jobId, limit: 5 } });
  const unchanged = await bridge.dispatch({ operation: "status", input: { runId: parked.runId, afterRevision: settledRevision } });
  assert.equal(unchanged.unchanged, true, "status must honor afterRevision without rewriting");
  const terminalResult = await bridge.dispatch({ operation: "result", input: { runId: parked.runId } });
  assert.equal(terminalResult.state, status.state, "result serves the settled run read-only");
  assert.equal(terminalResult.output, null, "a stopped run has no engine output");
  const after = await bridge.dispatch({ operation: "status", input: { runId: parked.runId, invocationLimit: 10 } });
  assert.equal(after.revision, settledRevision, "read-only operations must not mutate the settled run record");
  const afterJobs = readdirSync(stateDirAbs).filter((name) => /^[0-9a-f-]{36}\.json$/i.test(name)).sort();
  assert.deepEqual(afterJobs, beforeJobs, "read-only operations must not create job receipts");
  assert.equal(existsSync(probeLedger), false, "fake adapter must never load during read operations");
  assert.equal(readFileSync(journalPath, "utf8"), beforeJournal, "read-only operations must not append journal events");

  rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("t3 bridge serves pause accepted->applied, resume prefix reuse and history through the demo", { timeout: 240_000 }, async (t) => {
  const fixture = mkdtempSync(join(tmpdir(), "t3-bridge-flow-"));
  t.after(() => { rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  withFakeAdapter();
  process.env.HARNEST_DEMO_DIR = join(fixture, "state");

  const started = spawnSync(process.execPath, [DEMO, "--fixture", fixture, "--timeout-ms", "60000"], {
    encoding: "utf8", timeout: 90_000, windowsHide: true, env: process.env,
  });
  assert.equal(started.status, 0, started.stderr);
  const parked = JSON.parse((started.stdout ?? "").trim().split("\n").at(-1));
  const stateDir = parked.stateDir;
  const runId = parked.runId;
  const bridge = await createT3Bridge({ stateDir, adapterPath: ADAPTER });

  // --- parked proof: three phases, plan completed, review failed once ------
  const parkedStatus = await bridge.dispatch({ operation: "status", input: { runId, invocationLimit: 10 } });
  assert.equal(parkedStatus.state, "running");
  assert.deepEqual(parkedStatus.phases.map((phase) => phase.title), ["plan", "review", "finish"]);
  const labels = parkedStatus.invocations.map((call) => call.label);
  assert.deepEqual(labels, ["plan", "review", "finish"]);
  const review = parkedStatus.invocations.find((call) => call.label === "review");
  assert.equal(review.state, "failed");
  const reviewInspect = await bridge.dispatch({ operation: "inspect", input: { runId, invocationId: review.id } });
  assert.equal(reviewInspect.totalAttempts, 1);
  assert.equal(reviewInspect.attempts[0].state, "failed");
  assert.equal(reviewInspect.attempts[0].error?.kind, "downstream");
  assert.ok(reviewInspect.attempts[0].jobId, "failed attempt keeps its child job id");

  // --- pause: accepted while the finish agent holds, never shown applied ---
  await bridge.dispatch({ operation: "control", input: { runId, commandId: "t3-pause-1", action: "pause" } });
  const preRelease = await bridge.dispatch({ operation: "status", input: { runId } });
  const preReleasePause = preRelease.controls.find((command) => command.commandId === "t3-pause-1");
  assert.ok(["accepted", "applied"].includes(preReleasePause?.state), JSON.stringify(preReleasePause));
  if (preReleasePause.state === "accepted") {
    assert.equal(preReleasePause.effect, null, "accepted must not carry an applied effect");
  }

  const released = spawnSync(process.execPath, [DEMO, "--release", "--state", stateDir], {
    encoding: "utf8", timeout: 30_000, windowsHide: true, env: process.env,
  });
  assert.equal(released.status, 0, released.stderr);
  assert.deepEqual(JSON.parse(released.stdout.trim()), { runId: null, stateDir, released: join(stateDir, "finish-gate") });

  let settled = preRelease;
  for (let index = 0; index < 150; index += 1) {
    settled = await bridge.dispatch({ operation: "status", input: { runId } });
    const command = (settled.controls ?? []).find((item) => item.commandId === "t3-pause-1");
    if (command?.state === "applied" && command?.appliedAt) break;
    await new Promise((resolve_) => setTimeout(resolve_, 200));
  }
  const appliedPause = (settled.controls ?? []).find((item) => item.commandId === "t3-pause-1");
  assert.equal(appliedPause.state, "applied", JSON.stringify(appliedPause));
  assert.equal(appliedPause.effect, "dispatch-gate-closed");
  assert.equal(appliedPause.invocationId, null);

  // --- stop for a clean partial, then resume through the bridge ------------
  // The bridge's resume op keeps normal policy semantics. The T3 server
  // process constructs its bridge with the trusted adapter seam (here: the
  // zero-paid fake adapter via adapterPath / HARNEST_WORKER_ADAPTER),
  // so the resumed attempt executes in-process without launching a harness.
  await bridge.dispatch({ operation: "control", input: { runId, commandId: "t3-stop-1", action: "stop" } }).catch(() => undefined);
  let stopped = settled;
  for (let index = 0; index < 150; index += 1) {
    stopped = await bridge.dispatch({ operation: "status", input: { runId } });
    if (["failed", "cancelled", "partial"].includes(stopped.state)) break;
    await new Promise((resolve_) => setTimeout(resolve_, 200));
  }
  assert.ok(["failed", "cancelled", "partial"].includes(stopped.state), stopped.state);

  // Same-source resume (no source field): the stored spec revision replays.
  const resumed = await bridge.dispatch({ operation: "resume", input: { runId, commandId: "t3-resume-1" } });
  assert.equal(resumed.runId, runId);
  assert.equal(resumed.state, "queued");
  assert.equal(resumed.attempt, 2);
  let final = resumed;
  for (let index = 0; index < 400; index += 1) {
    final = await bridge.dispatch({ operation: "status", input: { runId, invocationLimit: 10 } });
    if (["completed", "failed", "cancelled", "partial"].includes(final.state)) break;
    await new Promise((resolve_) => setTimeout(resolve_, 200));
  }
  assert.equal(final.state, "completed", JSON.stringify(final.error ?? null));
  assert.equal(final.attempt, 2);
  assert.deepEqual(final.invocations.map((call) => call.attempts), [1, 2, 2]);

  // --- attempt details and prefix reuse through the bridge -----------------
  const planInspect = await bridge.dispatch({ operation: "inspect", input: { runId, invocationId: final.invocations[0].id } });
  assert.equal(planInspect.reused, true, "completed prefix call is reused on resume");
  assert.equal(planInspect.totalAttempts, 1);
  const finalReview = await bridge.dispatch({ operation: "inspect", input: { runId, invocationId: final.invocations[1].id } });
  assert.deepEqual(finalReview.attempts.map((attempt) => attempt.state), ["failed", "completed"]);
  assert.equal(finalReview.invalidated, false, "resume clears the failed-call suffix once replayed");

  // --- reopen history ------------------------------------------------------
  const history = await bridge.dispatch({ operation: "history", input: { limit: 20 } });
  const row = history.runs.find((item) => item.runId === runId);
  assert.ok(row, JSON.stringify(history.runs));
  assert.equal(row.state, final.state);
  assert.equal(row.attempt, 2);
  assert.equal(row.counts.completed, 3);
  assert.ok(row.usageTotals, "history keeps compact usage totals");

  // --- trace of a real child, bounded and sequence-addressable --------------
  const finishRow = final.invocations.find((call) => call.label === "finish");
  const trace = await bridge.dispatch({ operation: "trace", input: { jobId: finishRow.jobId, limit: 3 } });
  assert.ok(trace.receipt, "trace returns the child receipt");
  assert.ok(trace.events.length <= 3);
  assert.ok(trace.nextSequence ?? trace.events.length === 0, JSON.stringify(trace.nextSequence));

  // --- workflow final output through the terminal-gated result op ----------
  // status never carries the engine's return value; result does, exactly
  // once, with the stored spec revision's computed output.
  assert.equal(final.output, undefined, "status must not duplicate workflow output");
  const workflowResult = await bridge.dispatch({ operation: "result", input: { runId } });
  assert.equal(workflowResult.state, "completed");
  assert.deepEqual(workflowResult.output, {
    branch: "proceed",
    itemCount: 3,
    plan: "plan",
    review: "review",
    finish: "finish",
  });

  // --- completed runs refuse resume; the refusal must not dispatch children --
  const launchesBefore = existsSync(join(stateDir, "launches.jsonl"))
    ? readFileSync(join(stateDir, "launches.jsonl"), "utf8").trim().split("\n").filter(Boolean).length
    : 0;
  await assert.rejects(
    bridge.dispatch({ operation: "resume", input: { runId, commandId: "t3-resume-after-completed" } }),
    (error) => error.details?.kind === "resume-conflict",
  );
  const launchesAfter = existsSync(join(stateDir, "launches.jsonl"))
    ? readFileSync(join(stateDir, "launches.jsonl"), "utf8").trim().split("\n").filter(Boolean).length
    : 0;
  assert.equal(launchesAfter, launchesBefore, "refused resume must not launch any child");
});

test("demo-t3-workflow argument surface stays strict and documented", async () => {
  const demo = await import("../scripts/demo-t3-workflow.mjs");
  assert.throws(() => demo.parseArgs(["--unknown"]), (error) => /unknown argument/.test(error.message));
  assert.throws(() => demo.parseArgs(["--resume", "not-a-run-id"]), (error) => /--resume requires/.test(error.message));
  assert.throws(() => demo.parseArgs(["--resume"]), (error) => /--resume requires a value/.test(error.message));
  assert.throws(() => demo.parseArgs(["--release"]), (error) => /requires --state/.test(error.message));
  const runId = "dyn-0".padEnd(68, "a");
  const state = join(tmpdir(), "t3-state");
  assert.deepEqual(demo.parseArgs(["--resume", runId, "--state", state]), {
    mode: "resume", runId, state, timeoutMs: 120_000,
  });
  assert.equal(demo.parseArgs([]).mode, "start");
});
