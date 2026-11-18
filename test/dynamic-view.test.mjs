import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Companion } from "../src/companion.mjs";
import { DynamicViewController, dynamicRows, renderDynamicView, watchDynamicView, invocationTimeline } from "../src/dynamic-view.mjs";
import { parseArgs } from "../scripts/dynamic-view.mjs";
import { graphForSession, graphWaterfallRows, graphTitle, workflowAction } from "../opencode-plugin/dynamic-ui.mjs";

const run = { runId: "run", requestId: "review", name: "Review sources", state: "running", revision: 1, invocations: [
  { id: "a", label: "Inspect source", ordinal: 0, state: "completed", target: "opencode", route: { model: "deepseek", thinking: "max" }, sessionId: "native", jobId: "job" },
  { id: "b", label: "Verify findings", ordinal: 1, state: "running", target: "claude", route: { model: "default" } },
] };

test("workflow view preserves selected invocation across updates and bounds the frame", async () => {
  const view = new DynamicViewController({ runner: { status: async () => structuredClone(run) } });
  await view.open("run");
  view.select(1);
  await view.refresh();
  assert.equal(view.selectedId, "b");
  const frame = renderDynamicView(view, { width: 100, height: 20 });
  assert.match(frame, /> Verify findings/);
  assert.match(frame, /deepseek \(max\)/);
  assert.match(frame, /unknown/);
  assert.ok(frame.split("\n").every((line) => line.length <= 100));
  assert.equal(dynamicRows(run)[0].sessionId, "native");
});

test("workflow view shows phase counts, observed usage and elapsed state", () => {
  const phases = [
    { title: "Draft", counts: { total: 3, completed: 2, failed: 1 }, usageTotals: { inputTokens: 14, outputTokens: 0, cacheReadTokens: 3, cacheWriteTokens: null, partial: true }, elapsed: { state: "settled", ms: 2500 } },
    { title: "Verify", counts: { total: 2, pending: 1, running: 1 }, usageTotals: { inputTokens: null }, elapsed: { state: "running", ms: null } },
  ];
  const frame = renderDynamicView({ run: { ...run, phases } }, { width: 110, height: 20 });
  assert.match(frame, /Draft .*3 agents \(2 completed, 1 failed\).*Elapsed 2s/);
  assert.match(frame, /Input 14 \| Output 0 \| Cache read 3 \| Cache write unknown \| partial totals/);
  assert.match(frame, /Verify .*2 agents \(1 pending, 1 running\).*Elapsed running/);
  assert.match(frame, /Input unknown \| Output unknown \| Cache read unknown \| Cache write unknown/);
});

test("readonly viewer blocks writes and writable viewer does not invent approval", async () => {
  let command;
  const runner = { status: async () => run, control: async (input) => { command = input; return { state: "accepted" }; } };
  const view = new DynamicViewController({ runner, readOnly: true });
  await view.open("run");
  await assert.rejects(view.control("stop"), /read-only/);
  view.readOnly = false;
  await view.control("restart-agent");
  assert.equal(command.invocationId, "a");
  assert.equal(command.approveWrites, undefined);
  assert.match(view.message, /accepted/);
});

test("OpenCode dynamic rows follow native sessions without invented dependency edges", () => {
  const workflow = { id: "run", kind: "dynamic", record: run };
  assert.equal(graphForSession([workflow], "native"), workflow);
  assert.equal(graphTitle(workflow), "Review sources");
  const rows = graphWaterfallRows(workflow);
  assert.match(JSON.stringify(rows), /observed order/);
  assert.match(JSON.stringify(rows), /Inspect source/);
  assert.doesNotMatch(JSON.stringify(rows), /dependsOn|deps/);
});

test("viewer drill-in reads a real Companion job and its intermediate trace", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harnest-drill-in-"));
  const companion = new Companion({ stateDir: root, routeResolver: async (r) => r, adapterFactory: () => ({ async run(request, { onProgress }) {
    await onProgress({ type: "text", text: "Inspecting input" });
    await onProgress({ type: "cursor_tasklist", text: "Reviewing", tasklist: [{ content: "Inspect source", status: "in_progress" }] });
    return { result: { finalText: "Review complete" } };
  } }) });
  t.after(async () => { await companion.close(); await rm(root, { recursive: true, force: true }); });
  const receipt = await companion.start({ requestId: "drill", target: "pi", cwd: root, task: "Review input" });
  const view = new DynamicViewController({ companion, runner: {} });
  view.run = { runId: "run", invocations: [{ id: "call", jobId: receipt.jobId }], controls: [{ state: "uncertain" }] };
  view.selectedId = "call";
  const detail = await view.detail();
  assert.equal(detail.prompt, "Review input");
  assert.match(JSON.stringify(detail.result), /Review complete/);
  assert.match(JSON.stringify(detail.trace), /Inspecting input/);
  assert.equal(detail.controls[0].state, "uncertain");
  assert.deepEqual(detail.tasklist, [{ title: "Inspect source", status: "in_progress" }]);
});

test("viewer argument order preserves separate child and dynamic store roots", () => {
  assert.deepEqual(parseArgs(["--state-dir", "jobs", "run", "--dynamic-state-dir", "workflows", "--once"]), { stateDir: "jobs", selector: "run", dynamicStateDir: "workflows", once: true });
  assert.throws(() => parseArgs(["--state-dir"]), /requires/);
});

test("agent pages stay selected across refresh and allow returning to the previous page", async () => {
  const queries = [];
  const runner = { status: async (input) => {
    queries.push(input);
    if (input.afterRevision === 1) return { unchanged: true };
    return { runId: "paged", revision: 1, invocationsTotal: 2, invocations: [{ id: input.invocationCursor === 0 ? "second" : "first" }], ...(input.invocationCursor === 0 ? {} : { invocationsNextCursor: 0 }) };
  } };
  const view = new DynamicViewController({ runner });
  await view.open("paged");
  await view.refresh({ next: true });
  assert.equal(view.selectedId, "second");
  await view.refresh();
  assert.equal(queries.at(-1).invocationCursor, 0);
  assert.equal(view.selectedId, "second");
  await view.refresh({ previous: true });
  assert.equal(view.selectedId, "first");
  assert.match(renderDynamicView(view), /1\/2 agent rows \(paged\)/);
});

test("observed timeline shows overlaps without guessing missing start times", () => {
  const stamp = (ms) => new Date(100000 + ms).toISOString();
  const rows = invocationTimeline({ invocations: [
    { id: "first", state: "completed", startedAt: stamp(0), completedAt: stamp(1000) },
    { id: "second", state: "completed", startedAt: stamp(500), completedAt: stamp(1500) },
    { id: "pending", state: "pending" },
  ] });
  assert.equal(rows.get("first"), "========    ");
  assert.equal(rows.get("second"), "    ========");
  assert.equal(rows.get("pending"), "            ");
});

test("stopping a workflow watch drops an in-flight render", async () => {
  let release;
  let began;
  const started = new Promise((resolve) => { began = resolve; });
  let rendered = 0;
  const runner = { status: async () => { began(); return new Promise((resolve) => { release = resolve; }); } };
  const stop = watchDynamicView({ runner, runId: "run", render: () => { rendered++; } });
  await started;
  stop();
  release(run);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rendered, 0);
});

test("OpenCode agent controls retain selection and require explicit approval only on write retry", async () => {
  const sent = [];
  const ui = { dialog: { select: async () => "b", prompt: async () => "Review that finding", confirm: async () => true } };
  const workflow = { id: "run", record: run };
  await workflowAction(workflow, "steer", ui, async (...args) => { sent.push(args); });
  assert.deepEqual(sent[0], ["run", "steer", { invocationId: "b", message: "Review that finding" }]);
  await workflowAction(workflow, "restart-agent", ui, async (...args) => {
    sent.push(args);
    if (!args[2].approveWrites) throw new Error("write retry requires approval");
    return { state: "accepted" };
  });
  assert.equal(sent[1][2].approveWrites, undefined);
  assert.equal(sent[2][2].approveWrites, true);
});
