import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { Companion } from "../src/companion.mjs";
import { GraphRunner } from "../src/graph.mjs";
import { GraphStore } from "../src/graph-store.mjs";
import { detailEvents, formatMs, formatTokens, latestGraphId, loadView, nodeDetail, parseArgs, renderList, renderView, viewport } from "../scripts/graph-view.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "..");

async function completedFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "harnest-graph-view-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const stateDir = join(root, "state");
  const companion = new Companion({
    stateDir,
    routeResolver: async (request) => request,
    adapterFactory: () => ({
      async run(request, { onProgress }) {
        await onProgress({ type: "tool_use", tool: "read" });
        await onProgress({ type: "text", finalText: `${request.task} noted` });
        return { sessionId: `session-${request.task}`, result: { finalText: `${request.task} DONE` }, usage: { input: 1200, output: 340, cost: 0.0042 } };
      },
    }),
  });
  const runner = new GraphRunner({ companion });
  const result = await runner.start({
    requestId: "view-fixture",
    cwd: root,
    nodes: [
      { id: "plan", target: "claude", task: "Plan the work", route: { model: "opus" } },
      { id: "check", target: "codex", task: "Check the plan", route: { model: "gpt-6.1-sol" }, dependsOn: ["plan"] },
    ],
    execution: { background: false },
  });
  assert.equal(result.state, "completed");
  return { root, stateDir, companion, graphId: result.graphId };
}

test("graph view renders the shared waterfall with prompts, routes, tokens and tool counts", { timeout: 30_000 }, async (t) => {
  const { stateDir, companion, graphId } = await completedFixture(t);
  const view = await loadView({ stateDir, graphId });
  assert.equal(view.requestId, "view-fixture");
  assert.equal(view.state, "completed");
  assert.equal(view.counts.completed, 2);
  assert.deepEqual(view.order, ["plan", "check"], "waterfall order follows dependency depth");
  assert.equal(view.graphs[0].id, graphId);
  const plan = view.nodes.find((node) => node.id === "plan");
  assert.equal(plan.task, "Plan the work");
  assert.equal(plan.usage.input, 1200);
  assert.equal(plan.sessionId, "session-Plan the work");
  assert.ok(plan.tools >= 1, "tool activity must be counted from the trace");

  const rendered = renderView(view, { width: 140, color: false });
  assert.match(rendered, /View Fixture/, "the waterfall title is the prettified requestId");
  assert.match(rendered, /Plan/);
  assert.match(rendered, /Check/);
  assert.match(rendered, /opus/);
  assert.match(rendered, /sol/);
  assert.match(rendered, /completed/);

  const detail = (await nodeDetail(plan, { width: 100, color: false, events: [] })).join("\n");
  assert.match(detail, /Plan the work/);
  assert.match(detail, /Attempts/);
  assert.match(detail, /session-Plan the work/);

  assert.equal(await latestGraphId(new GraphStore(join(companion.store.root, "graphs"))), graphId);
  assert.equal(formatTokens({ input: 999, output: 1_500 }), "999 in / 1.5k out");
  assert.equal(formatMs(65_000), "1m05s");

  const byRequest = await loadView({ stateDir, graphId: "view-fixture" });
  assert.equal(byRequest.graphId, graphId, "a requestId selector resolves to the run");
});

test("graph-view accepts the documented workflow-view flags", () => {
  assert.equal(parseArgs(["--watch"]).watch, true);
  assert.equal(parseArgs(["--watch"]).intervalMs, 2000, "--watch defaults to a 2s loop");
  assert.equal(parseArgs(["--watch", "--interval", "500"]).intervalMs, 500, "--interval overrides --watch");
  assert.equal(parseArgs(["--once"]).intervalMs, 1000);
  assert.equal(parseArgs(["--workflow", "graph-abc"]).graphId, "graph-abc");
  assert.equal(parseArgs(["--width", "90"]).width, 90);
  assert.equal(parseArgs(["--width", "5"]).width, null, "an unusably narrow width is ignored");
  assert.equal(parseArgs(["--list", "--plain"]).list, true);
  assert.equal(parseArgs(["--list", "--plain"]).once, true);
});

test("graph-view clamps numeric flags, refuses to eat the next flag, and rejects empty selectors", () => {
  assert.equal(parseArgs(["--interval", "50"]).intervalMs, 200, "too-fast intervals clamp up");
  assert.equal(parseArgs(["--interval", "1e9"]).intervalMs, 60_000, "huge intervals clamp down");
  assert.equal(parseArgs(["--interval", "Infinity"]).intervalMs, 1000, "non-finite intervals fall back to a finite delay");
  assert.equal(parseArgs(["--interval", "10"]).intervalMs, 200);

  assert.equal(parseArgs(["--width", "1e21"]).width, 4096, "huge widths clamp before repeat()");
  assert.equal(parseArgs(["--width", "90.9"]).width, 90);
  assert.equal(parseArgs(["--width", "5"]).width, null);

  assert.equal(parseArgs(["--state", "--watch"]).stateDir, null, "--state must not eat --watch");
  assert.equal(parseArgs(["--state", "--watch"]).watch, true);
  assert.equal(parseArgs(["--workflow", "--watch"]).graphId, null, "--workflow must not eat --watch");
  assert.equal(parseArgs(["--workflow", "--watch"]).watch, true);
  assert.equal(parseArgs(["--interval", "--watch"]).watch, true);
  assert.equal(parseArgs(["--interval", "--watch"]).intervalMs, 2000, "a valueless --interval leaves the --watch default");
  assert.throws(() => parseArgs([""]), /no selector provided/);
});

test("an empty selector is an error instead of the newest graph", async () => {
  await assert.rejects(loadView({ graphId: "" }), /no selector provided/);
});

test("nodeDetail skips torn attempts and invalid event timestamps", async () => {
  const node = {
    id: "lane-x", state: "running", target: "pi", route: { model: "fake" }, routingDecision: null,
    dependsOn: [], attempts: [null, { attempt: 1, state: "running", requestId: "req-1" }, "junk"],
    jobId: null, usage: null, error: null, sessionId: null, outcome: null, task: "do the thing",
    context: null, policy: null, cwd: null,
  };
  const events = [
    { sequence: 1, at: "not-a-timestamp", event: { type: "state", state: "running" } },
    { sequence: 2, at: "2026-09-13T10:11:12.000Z", event: { type: "state", state: "completed" } },
  ];
  const text = (await nodeDetail(node, { width: 80, color: false, events })).join("\n");
  assert.match(text, /#1/);
  assert.doesNotMatch(text, /junk/, "non-object attempts are skipped");
  assert.match(text, /--:--:--/, "an invalid timestamp falls back instead of throwing");
  assert.match(text, /10:11:12/);

  const bare = { id: "b", state: "pending", target: "pi", attempts: null, task: "t" };
  await assert.doesNotReject(nodeDetail(bare, { width: 60 }), "a missing dependsOn/attempts list must not throw");
});

test("viewport shows the true last line at maximum scroll", () => {
  const lines = Array.from({ length: 10 }, (_, index) => `line-${index}`);
  const window = viewport(lines, 4, 999);
  assert.equal(window.length, 4, "height - 1 real lines plus the status line");
  assert.ok(window.some((line) => line.includes("line-9")), "the final line must be reachable");
  assert.match(window.at(-1), /\[10\/10 lines/);
  assert.deepEqual(viewport(lines.slice(0, 3), 4, 0), lines.slice(0, 3), "short content is not windowed");
});

test("detailEvents reads the newest trace tail and survives a bad jobId", async () => {
  const calls = [];
  const view = {
    companion: {
      store: {
        readTrace: async (jobId, options) => {
          calls.push({ jobId, options });
          return { events: [{ sequence: 205, at: null, event: { type: "state", state: "completed" } }], hasMore: true };
        },
      },
    },
  };
  const events = await detailEvents(view, { jobId: "job-1" });
  assert.deepEqual(calls, [{ jobId: "job-1", options: { limit: 200 } }], "no afterSequence: the store returns the tail");
  assert.equal(events.at(-1).sequence, 205);

  const failing = { companion: { store: { readTrace: async () => { throw new TypeError("invalid job id"); } } } };
  assert.deepEqual(await detailEvents(failing, { jobId: "../oops" }), [], "a bad jobId degrades to no activity");
  assert.deepEqual(await detailEvents(failing, {}), [], "no jobId means no trace read");
});

test("detailEvents returns the newest 200 events from a long trace", { timeout: 30_000 }, async (t) => {
  const { stateDir, companion, graphId } = await completedFixture(t);
  const view = await loadView({ stateDir, graphId });
  const node = view.nodes.find((entry) => entry.id === "plan");
  const trace = Array.from({ length: 250 }, (_, index) => JSON.stringify({ sequence: index + 1, at: new Date(0).toISOString(), activity: `event-${index + 1}` }));
  await writeFile(companion.store.tracePath(node.jobId), trace.join("\n") + "\n");
  const events = await detailEvents(view, node);
  assert.equal(events.length, 200);
  assert.equal(events[0].sequence, 51, "the first 50 events are paged out");
  assert.equal(events.at(-1).sequence, 250, "the newest event is last");
});

test("graph view windows large node lists around the selection", () => {
  const nodes = Array.from({ length: 150 }, (_, index) => ({
    id: `worker-${String(index).padStart(3, "0")}`, target: "pi", route: { model: "fake" }, routingDecision: null,
    state: "completed", dependsOn: [], attempts: [], jobId: null, requestId: null, progress: null, error: null,
    sessionId: null, usage: null, outcome: null, task: "t", context: null, policy: null, cwd: null, execution: null,
    requestedTarget: "pi", tools: 0,
  }));
  const record = { requestId: "big-graph", state: "completed", nodes };
  const view = {
    graphId: `graph-${"f".repeat(64)}`, requestId: "big-graph", state: "completed", revision: 1,
    recoveryRequired: false, cancellation: null, errors: [], createdAt: new Date(0).toISOString(),
    completedAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), elapsedMs: 0,
    counts: { total: 150, completed: 150, running: 0, pending: 0, failed: 0, partial: 0, blocked: 0, cancelled: 0 },
    order: nodes.map((node) => node.id), nodes, graphs: [], outputs: [], companion: null, record,
  };
  const rendered = renderView(view, { width: 120, height: 20, selected: 75 });
  assert.match(rendered, /Worker 075/);
  assert.match(rendered, /earlier rows/);
  assert.match(rendered, /later rows/);
  assert.doesNotMatch(rendered, /Worker 000/, "far rows must be windowed out");
});

test("graph-view --once prints the shared waterfall frame without a TTY", { timeout: 30_000 }, async (t) => {
  const { stateDir, graphId } = await completedFixture(t);
  const script = join(repoRoot, "scripts", "graph-view.mjs");
  const { stdout } = await execFileAsync(process.execPath, [script, graphId, "--state", stateDir, "--once", "--ascii"], { cwd: repoRoot });
  assert.match(stdout, /View Fixture/);
  assert.match(stdout, /view-fixture/);
  assert.match(stdout, /Plan/);
  assert.match(stdout, /completed/);
  assert.match(stdout, /\+/, "ascii frame must use ascii glyphs");
  assert.doesNotMatch(stdout, /[✔●○✖◌⛔⊘]/, "ascii frame must not leak the unicode glyphs");

  const { stdout: byRequest } = await execFileAsync(process.execPath, [script, "--workflow", "view-fixture", "--state", stateDir, "--once", "--ascii", "--width", "90"], { cwd: repoRoot });
  assert.match(byRequest, /View Fixture/, "--workflow accepts a requestId");
  assert.match(byRequest, /Plan/);
});

test("graph-view --list prints the shared workflow switcher against the store", { timeout: 30_000 }, async (t) => {
  const { stateDir, graphId } = await completedFixture(t);
  const script = join(repoRoot, "scripts", "graph-view.mjs");
  const { stdout } = await execFileAsync(process.execPath, [script, "--list", "--state", stateDir, "--ascii"], { cwd: repoRoot });
  assert.match(stdout, /workflows\s+1/);
  assert.match(stdout, /\+ View Fixture/);
  assert.match(stdout, /2\/2/);

  const view = await loadView({ stateDir, graphId });
  const direct = renderList(view.graphs, { width: 80, color: false, ascii: false, selectedId: graphId });
  assert.equal(direct.length, 2, "one header row plus one workflow row");
  assert.match(direct[0], /workflows\s+1/);
  assert.match(direct[1], /View Fixture/);
});
