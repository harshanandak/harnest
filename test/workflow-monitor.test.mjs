import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { monitorLines, parseArgs } from "../scripts/workflow-monitor.mjs";

const record = (state, nodes) => ({ record: { requestId: "market-scan", state, nodes } });
const node = (id, state) => ({ id, state, target: "opencode", route: { model: "deepseek-v4.1-flash" }, routingDecision: { thinking: "high" } });

test("a new active workflow announces itself, settled ones stay silent", () => {
  const running = monitorLines(new Map(), [record("running", [node("collect", "running")])]);
  assert.deepEqual(running.lines, ["▶ Market Scan started · 1 node"]);
  const settled = monitorLines(new Map(), [record("completed", [node("collect", "completed")])]);
  assert.deepEqual(settled.lines, []);
  assert.equal(settled.next.size, 1, "settled graphs still establish a baseline");
});

test("node transitions and completion emit one line each", () => {
  const first = monitorLines(new Map(), [record("running", [node("collect", "running")])]);
  const second = monitorLines(first.next, [record("running", [node("collect", "completed"), node("publish", "running")])]);
  assert.deepEqual(second.lines, [
    "✔ Market Scan · Collect (flash · high) completed",
    "● Market Scan · Publish (flash · high) running",
  ]);
  const third = monitorLines(second.next, [record("completed", [node("collect", "completed"), node("publish", "completed")])]);
  assert.deepEqual(third.lines, [
    "✔ Market Scan · Publish (flash · high) completed",
    "✔ Market Scan completed · 2/2",
  ]);
});

test("malformed graphs do not throw or suppress healthy ones", () => {
  const first = monitorLines(new Map(), [
    { record: { requestId: "bad", state: "running", nodes: null } },
    { record: { requestId: "good", state: "running", nodes: [{ id: "a", state: "running" }] } },
  ]);
  assert.deepEqual(first.lines, ["▶ Bad started · 0 nodes", "▶ Good started · 1 node"], "a nodes:null record must not throw");
  assert.deepEqual(monitorLines(first.next, [{ record: { requestId: "bad", state: "running", nodes: null } }]).lines, []);
  const transition = monitorLines(first.next, [
    { record: { requestId: "bad", state: "running", nodes: null } },
    { record: { requestId: "good", state: "running", nodes: [{ id: "a", state: "completed" }] } },
  ]);
  assert.deepEqual(transition.lines, ["✔ Good · A completed"], "a malformed sibling must not suppress a healthy graph");
});

test("unchanged polls emit nothing and wide changes are capped", () => {
  const nodes = [node("a", "running"), node("b", "running")];
  const first = monitorLines(new Map(), [record("running", nodes)]);
  assert.deepEqual(monitorLines(first.next, [record("running", nodes)]).lines, []);
  const many = Array.from({ length: 9 }, (_, index) => node(`lane-${index}`, "running"));
  const before = monitorLines(new Map(), [record("running", many.map((item) => ({ ...item, state: "pending" })))]);
  const after = monitorLines(before.next, [record("running", many)]);
  assert.equal(after.lines.filter((line) => line.startsWith("●")).length, 5);
  assert.ok(after.lines.includes("… 4 more changes in Market Scan"));
});

test("monitor interval stays finite, clamped, and never eats the next flag", () => {
  assert.equal(parseArgs(["--interval", "50"]).intervalMs, 200, "floor");
  assert.equal(parseArgs(["--interval", "90000"]).intervalMs, 60000, "ceiling");
  assert.equal(parseArgs(["--interval", "Infinity"]).intervalMs, 2000, "non-finite falls back");
  assert.equal(parseArgs(["--interval", "nope"]).intervalMs, 2000, "unparseable falls back");
  assert.equal(parseArgs([]).intervalMs, 2000, "default");
  assert.equal(parseArgs(["--interval"]).intervalMs, 2000, "missing value is ignored");
  const flagNext = parseArgs(["--interval", "--once"]);
  assert.equal(flagNext.intervalMs, 2000, "--interval must not consume --once");
  assert.equal(flagNext.once, true, "--once still applies after --interval");
  assert.equal(parseArgs(["--once"]).once, true);
});

test("dynamic workflows expose phase, retry, activity and control changes while staying in one state", () => {
  const graph = { id: `dyn-${"a".repeat(64)}`, record: { name: "Release review", state: "running", attempt: 1, phases: [{ title: "review" }], calls: [{ id: "inv-0", label: "Security", target: "pi", state: "running", route: { model: "deepseek-v4.1-flash", thinking: "max" }, attempts: [{}], progress: { current: "Checking permissions" } }] } };
  const baseline = monitorLines(new Map(), [graph], { announce: true });
  assert.ok(baseline.lines.some((line) => line.includes("phase review")));
  assert.ok(baseline.lines.some((line) => line.includes("Security (flash · max) running · Checking permissions")));
  graph.record.calls[0].progress.current = "Checking sandbox boundaries";
  graph.record.calls[0].attempts.push({});
  graph.record.attempt = 2;
  graph.record.controls = [{ commandId: "stop-one", action: "stop-agent", state: "uncertain" }];
  const changed = monitorLines(baseline.next, [graph]);
  assert.ok(changed.lines.some((line) => line.includes("workflow attempt 2")));
  assert.ok(changed.lines.some((line) => line.includes("attempt 2 running · Checking sandbox boundaries")));
  assert.ok(changed.lines.some((line) => line.includes("stop-agent: uncertain")));
  assert.deepEqual(monitorLines(changed.next, [graph]).lines, []);
  graph.record.state = "paused";
  assert.ok(monitorLines(changed.next, [graph]).lines.some((line) => line.includes("paused · 0/1")));
});

test("observer lines keep hostile names and activity inside a single inert line", () => {
  const graph = { id: "test", record: { name: "review\nspoof\u001b[2J", state: "running", calls: [{ id: "inv-0", label: "agent\rspoof", state: "running", progress: { current: "task\nforged" } }] } };
  const { lines } = monitorLines(new Map(), [graph], { announce: true });
  assert.ok(lines.length > 1);
  for (const line of lines) assert.doesNotMatch(line, /[\x00-\x1f\x7f-\x9f]/);
});

test("a named observer streams changes through pipes before exit and leaves workflow state untouched", { timeout: 15000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harnest-workflow-observer-"));
  const dynamic = join(root, "dynamic");
  await mkdir(dynamic);
  const id = `dyn-${"b".repeat(64)}`;
  const path = join(dynamic, `${id}.json`);
  const record = { name: "Piped workflow", runId: id, state: "running", phases: [{ title: "review" }], calls: [{ id: "inv-0", label: "Review", state: "running", target: "pi", route: { model: "fake", thinking: "max" }, progress: { current: "Started review" } }] };
  const publish = async () => { await writeFile(path + ".tmp", JSON.stringify(record)); await rename(path + ".tmp", path); };
  await publish();
  const child = spawn(process.execPath, ["scripts/workflow-monitor.mjs", "--workflow", id, "--state", root, "--interval", "200"], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(async () => { if (child.exitCode === null) child.kill(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  let output = "";
  let errors = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { errors += chunk; });
  const exited = once(child, "exit");
  const untilOutput = async (text) => {
    while (!output.includes(text)) {
      if (child.exitCode !== null) assert.fail(`Observer exited before ${text}: ${errors}`);
      await Promise.race([once(child.stdout, "data"), exited.then(() => { throw new Error(`Observer exited before ${text}`); })]);
    }
  };
  await untilOutput("Started review");
  assert.equal(child.exitCode, null, "piped mode must remain attached while the run is active");
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), record);
  record.calls[0].progress.current = "Reviewing second file";
  await publish();
  await untilOutput("Reviewing second file");
  record.state = "completed";
  record.calls[0].state = "completed";
  await publish();
  assert.equal((await exited)[0], 0, errors);
  assert.match(output, /Piped workflow completed · 1\/1/);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), record);
  assert.equal(errors, "");
});

test("observer selectors reject paths and incomplete flags", () => {
  assert.throws(() => parseArgs(["--workflow", "../../outside"]), /run ID/);
  assert.throws(() => parseArgs(["--state", "--once"]), /requires a value/);
  assert.throws(() => parseArgs(["--unknown"]), /Unknown monitor argument/);
  assert.equal(parseArgs(["--workflow", `dyn-${"a".repeat(64)}`, "--once"]).once, true);
});
