import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobObserver, JobStore } from "../src/job-store.mjs";
import { eventText, followJob, formatEventLine, isNoisy, parseArgs } from "../scripts/handoff-view.mjs";

const root = join(import.meta.dirname, "..");

function runView(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/handoff-view.mjs", ...args], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("handoff-view timed out after 30s"));
    }, 30_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

const traceEvent = (sequence, text) => ({
  sequence,
  activity: "progress",
  at: "2026-09-13T14:06:42.178Z",
  event: { type: "progress", data: { type: "codex_delta", text } },
});

test("handoff-view formats deltas and hides noisy activity", () => {
  const delta = { sequence: 3, activity: "progress", at: "2026-09-13T14:06:42.178Z", event: { type: "progress", data: { type: "codex_delta", text: "Found   two risks" } } };
  assert.equal(eventText(delta), "Found   two risks");
  assert.equal(formatEventLine(delta), "[14:06:42] Found two risks");
  assert.equal(isNoisy({ activity: "tool_execution_update" }), true);
  assert.equal(isNoisy({ activity: "progress" }), false);
  assert.equal(isNoisy({ activity: "control codex-thinking-probe-1 rejected" }), false);
  assert.equal(formatEventLine({ sequence: 4, activity: "running", at: "2026-09-13T14:05:58.505Z" }), "[14:05:58] (running)");
  const fallback = formatEventLine({ sequence: 9, activity: "control \u001b[2J accepted", at: "2026-09-13T14:06:42.178Z" });
  assert.equal(fallback, "[14:06:42] (control ?[2J accepted)", "the activity fallback is caller-supplied and must be neutralized too");
  const stamp = formatEventLine({ sequence: 10, activity: "progress", at: "xxxxxxxxxxx\u001b", event: { data: {} } });
  assert.ok(!/\u001b/.test(stamp), "a control character in the timestamp must not leak");
});

test("handoff-view strips control characters from untrusted agent text", () => {
  const line = formatEventLine(traceEvent(1, "safe\u001b[2Jpwned\u0007"));
  assert.equal(line, "[14:06:42] safe?[2Jpwned?");
  assert.ok(!line.includes("\u001b"), "ESC must not reach the terminal");
  assert.ok(!line.includes("\u0007"), "BEL must not reach the terminal");
});

test("handoff-view flags parse with watch precedence and interval floor", () => {
  const options = parseArgs(["live-view-review-sol", "--watch", "--once", "--interval", "50"]);
  assert.equal(options.selector, "live-view-review-sol");
  assert.equal(options.watch, true);
  assert.equal(options.once, false);
  assert.equal(options.intervalMs, 200);
});

test("handoff-view interval flags stay finite, clamped, and never eat the next flag", () => {
  assert.equal(parseArgs(["--interval", "50"]).intervalMs, 200, "floor");
  assert.equal(parseArgs(["--interval", "90000"]).intervalMs, 60000, "ceiling");
  assert.equal(parseArgs(["--interval", "Infinity"]).intervalMs, 1000, "non-finite falls back");
  assert.equal(parseArgs(["--interval", "abc"]).intervalMs, 1000, "unparseable falls back");
  assert.equal(parseArgs(["job-x", "--interval"]).intervalMs, 1000, "missing value does not consume");
  const flagNext = parseArgs(["job-x", "--interval", "--watch"]);
  assert.equal(flagNext.intervalMs, 1000, "--interval must not consume --watch");
  assert.equal(flagNext.watch, true, "--watch still applies after --interval");
  const stateFlagNext = parseArgs(["job-x", "--state", "--watch"]);
  assert.equal(stateFlagNext.stateDir, null, "--state must not consume --watch");
  assert.equal(stateFlagNext.watch, true);
  assert.equal(parseArgs(["job-x", "--state"]).stateDir, null, "missing --state value is ignored");
  assert.equal(parseArgs(["job-x", "--state", "C:/tmp/state"]).stateDir, "C:/tmp/state");
});

test("handoff-view reads the newest page first and drains every page before a terminal exit", async () => {
  const pages = [
    { events: [traceEvent(1, "old-1"), traceEvent(2, "old-2")], hasMore: false },
    { events: [traceEvent(3, "mid-3"), traceEvent(4, "mid-4")], hasMore: true },
    { events: [traceEvent(5, "final-answer")], hasMore: false },
  ];
  const states = ["running", "completed"];
  const calls = [];
  let gets = 0;
  let pageIndex = 0;
  const store = {
    jobIdForRequest: async () => "job-live",
    get: async () => ({
      receipt: {
        requestId: "req-live",
        target: "opencode",
        route: { model: "flash" },
        state: states[Math.min(gets++, states.length - 1)],
        trace: { eventCount: 5 },
      },
    }),
    readTrace: async (jobId, options) => {
      calls.push({ jobId, ...options });
      return pages[pageIndex++];
    },
  };
  const lines = [];
  await followJob({ store, selector: "req-live", watch: true, intervalMs: 200, write: (line) => lines.push(line) });
  assert.equal("afterSequence" in calls[0], false, "the first read must take the tail, not the oldest page");
  assert.equal(calls[0].limit, 200);
  assert.equal(calls[1].afterSequence, 2, "later reads page forward from the last seen sequence");
  assert.equal(calls[2].afterSequence, 4, "a page with hasMore must be drained before exiting");
  assert.match(lines.at(-1), /final-answer/, "the final answer must be printed even behind multiple pages");
  assert.equal(lines.filter((line) => line.startsWith("handoff-view")).length, 1, "header prints once");
});

test("handoff-view prints the newest events for a settled job with more than 200 trace events", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "handoff-view-tail-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const store = new JobStore(stateDir);
  const jobId = "tail-fixture";
  const job = {
    receipt: {
      jobId,
      requestId: "tail-fixture-request",
      target: "opencode",
      state: "completed",
      createdAt: "2026-09-13T00:00:00.000Z",
      route: { model: "deepseek-v4.1-flash" },
      trace: {},
    },
  };
  await store.put(job);
  const events = Array.from({ length: 250 }, (_, index) => traceEvent(index + 1, `event-${index + 1}`));
  await store.commitBatch(job, events);
  const result = await runView([jobId, "--state", stateDir]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /event-250/, "the newest event must survive a >200-event trace");
  assert.doesNotMatch(result.stdout, /event-1\b/, "the oldest page must not crowd out the newest events");
});

test("handoff-view reports state and control acknowledgements without trace events or heartbeat noise", async () => {
  const base = {
    requestId: "hostile\u001b[2J\nname", target: "codex", route: { model: "fixture", thinking: "high" },
    state: "running", trace: { progress: { phase: "review", current: "checking", lastMeaningfulAt: "2026-09-21T01:00:00Z" } },
    controls: [{ commandId: "steer-1", state: "accepted" }],
  };
  const snapshots = [
    base,
    { ...base, trace: { ...base.trace, heartbeatAt: "2026-09-21T01:01:00Z" } },
    { ...base, controls: [{ commandId: "steer-1", state: "applied" }] },
    { ...base, state: "failed", error: { name: "Error", details: { kind: "timeout" }, message: "deadline expired" } },
  ];
  let index = 0;
  const lines = [];
  await followJob({
    store: {
      jobIdForRequest: async () => "fixture-job",
      get: async () => ({ receipt: snapshots[index++] }),
      readTrace: async () => ({ events: [], hasMore: false }),
    }, selector: "fixture-job", watch: true, intervalMs: 1,
    write: async (line) => { await Promise.resolve(); lines.push(line); },
  });
  assert.equal(lines.filter((line) => line.startsWith("state ")).length, 3, "heartbeats alone must not emit progress");
  assert.match(lines.join("\n"), /control steer-1 accepted/);
  assert.match(lines.join("\n"), /control steer-1 applied/);
  assert.match(lines.join("\n"), /thinking high.*phase review.*activity checking/);
  assert.match(lines.at(-1), /state failed.*error timeout deadline expired/);
  assert.ok(lines.every((line) => !/[\u0000-\u001f\u007f-\u009f]/.test(line)), "untrusted headers cannot forge terminal lines");
  assert.ok(formatEventLine(traceEvent(1, "x".repeat(20_000))).length < 4200, "individual preview lines stay bounded");
});

test("a piped observer streams before completion, can detach and reattach, and never changes the job store", { timeout: 20_000 }, async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "handoff-view-pipe-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const store = new JobStore(stateDir);
  const jobId = "piped-observer";
  const job = { receipt: { jobId, requestId: "piped-request", target: "codex", state: "running", route: { model: "fixture" }, trace: {} } };
  await store.put(job);
  const snapshot = async () => {
    const files = await readdir(stateDir, { recursive: true, withFileTypes: true });
    return Object.fromEntries(await Promise.all(files.filter((entry) => entry.isFile()).map(async (entry) => {
      const path = join(entry.parentPath, entry.name);
      return [path, (await readFile(path)).toString("base64")];
    })));
  };
  const before = await snapshot();
  const child = spawn(process.execPath, ["scripts/handoff-view.mjs", jobId, "--watch", "--interval", "200", "--state", stateDir], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  const closed = once(child, "close");
  t.after(async () => { child.kill(); await closed; });
  await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("observer did not stream running state")), 10_000);
    const finish = (error) => { clearTimeout(timer); error ? reject(error) : resolve(); };
    child.once("error", finish);
    child.once("close", () => finish(new Error("observer exited before the running job settled")));
    child.stdout.on("data", (chunk) => { output += chunk; if (output.includes("state running")) finish(); });
    child.stderr.resume();
  });
  assert.equal(child.exitCode, null, "the task emits while the job is still running");
  child.kill();
  await closed;
  assert.deepEqual(await snapshot(), before, "detaching the viewer must not mutate or cancel the job");
  job.receipt.state = "completed";
  await store.put(job);
  const settled = await snapshot();
  const resumedView = await runView([jobId, "--watch", "--state", stateDir]);
  assert.equal(resumedView.code, 0, resumedView.stderr);
  assert.match(resumedView.stdout, /state completed/);
  assert.deepEqual(await snapshot(), settled, "reattaching observes the existing job without writes");
});

test("job observation never repairs missing indexes or creates a missing store", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "handoff-observer-index-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const missing = new JobObserver(join(root, "absent"));
  await assert.rejects(missing.get("not-there"), (error) => error.details?.kind === "not-found");
  assert.deepEqual(await readdir(root), []);
  const store = new JobStore(root);
  const observer = new JobObserver(root);
  const job = { request: { requestId: "observer-request" }, receipt: { jobId: "observer-job", requestId: "observer-request", state: "running" } };
  await store.put(job);
  assert.equal(await observer.jobIdForRequest("observer-request"), "observer-job");
  await rm(join(root, "requests"), { recursive: true });
  const before = await readFile(store.path("observer-job"));
  await assert.rejects(observer.jobIdForRequest("observer-request"), (error) => error.details?.kind === "not-found");
  assert.equal((await observer.get("observer-job")).receipt.state, "running");
  assert.deepEqual(await readdir(root), ["observer-job.json"]);
  assert.deepEqual(await readFile(store.path("observer-job")), before);
});

test("job observation refuses locked snapshots without deleting stale locks", { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "handoff-observer-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new JobStore(root);
  await store.put({ receipt: { jobId: "locked-job", state: "running" } });
  const lock = `${store.path("locked-job")}.lock`;
  await writeFile(lock, "writer-owned");
  const old = new Date(Date.now() - 300_000);
  await utimes(lock, old, old);
  const observer = new JobObserver(root);
  await assert.rejects(observer.get("locked-job"), (error) => error.details?.kind === "persistence");
  assert.equal(await readFile(lock, "utf8"), "writer-owned");
  await rm(lock);
  assert.equal((await observer.get("locked-job")).receipt.state, "running");
});

test("observer trace pages retain bounds and redaction and corrupt indexes fail visibly", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "handoff-observer-trace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new JobStore(root);
  const observer = new JobObserver(root);
  const job = { request: { requestId: "trace-request" }, receipt: { jobId: "trace-job", state: "running" } };
  await store.put(job);
  await store.appendEvent("trace-job", { ...traceEvent(1, "visible"), event: { data: { password: "fixture-only", text: "visible" } } });
  const before = await readFile(store.tracePath("trace-job"));
  const page = await observer.readTrace("trace-job", { limit: 1 });
  assert.equal(page.events.length, 1);
  assert.equal(page.events[0].event.data.password, "[REDACTED]");
  await assert.rejects(observer.readTrace("trace-job", { limit: 201 }), (error) => error.details?.kind === "validation");
  await assert.rejects(observer.get("../escape"), /invalid job id/);
  await writeFile(store.requestPath("trace-request"), "{broken");
  await assert.rejects(followJob({ store: observer, selector: "trace-request", write: () => {} }), SyntaxError);
  assert.deepEqual(await readFile(store.tracePath("trace-job")), before);
});
