import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { graphForSession, graphListRows, graphTitle, graphWaterfallRows, latestGraph, levelsOf, listGraphs, prettyName, shortModel, shortThinking, truncate } from "../opencode-plugin/graph-render.mjs";

const diamond = () => ({
  requestId: "widget-demo",
  state: "completed",
  nodes: [
    { id: "seed", state: "completed", dependsOn: [], target: "opencode", route: { provider: "opencode-go", model: "deepseek-v4.1-flash" }, routingDecision: { thinking: "max" } },
    { id: "lane-a", state: "completed", dependsOn: ["seed"], target: "codex", route: { model: "gpt-6.1-sol", thinking: "high" } },
    { id: "lane-b", state: "running", dependsOn: ["seed"], target: "opencode", route: { model: "deepseek-v4.1-flash", thinking: "high" } },
    { id: "join", state: "pending", dependsOn: ["lane-a", "lane-b"], target: "codex", route: { model: "gpt-6.1-sol" } },
  ],
});

const textOf = (row) => row.filter((cell) => !cell.spacer).map((cell) => cell.text).join("");
const findRow = (rows, value) => rows.find((row) => row.some((cell) => cell.text === value || String(cell.text).includes(value)));

test("waterfall rows are structured flex lines with names, levels and merge notes", () => {
  const rows = graphWaterfallRows(diamond());
  const header = rows[0];
  assert.equal(header[0].text, "Widget Demo");
  assert.equal(header[1].spacer, true, "the header splits title and stats");
  assert.equal(header[2].text, "2/4  ●1  completed");
  const seed = findRow(rows, "Seed");
  assert.deepEqual(seed.filter((cell) => !cell.spacer).map((cell) => cell.text), ["  ", "✔ ", "Seed", "flash · max"]);
  assert.equal(seed[1].color, "#22c55e");
  const laneB = findRow(rows, "Lane B");
  assert.equal(laneB[4].text, "flash · high");
  assert.equal(laneB[1].color, "#eab308");
  const join = findRow(rows, "Join");
  assert.equal(join[3].text, "  ⟵ Lane A, Lane B", "the merge names both parents");
  assert.equal(join[4].spacer, true);
  assert.equal(join[5].text, "sol", "nodes without a level show the model alone");
  assert.equal(join[1].color, "#6b7280");
  assert.ok(rows.every((row, index) => index === 0 || row.every((cell) => typeof cell.text !== "string" || cell.text.length < 40)), "no fixed-width padding remains");
});

test("waterfall renders every lane of a wide wave and shortens big merges", () => {
  const workers = Array.from({ length: 30 }, (_, index) => ({
    id: `lane-${String(index + 1).padStart(2, "0")}`,
    state: "running",
    dependsOn: ["extract"],
    target: "opencode",
    route: { model: "deepseek-v4.1-flash" },
  }));
  const rows = graphWaterfallRows({ requestId: "big-fan", state: "running", nodes: [
    { id: "extract", state: "completed", dependsOn: [], target: "opencode", route: {} },
    ...workers,
    { id: "join", state: "pending", dependsOn: workers.map((worker) => worker.id), target: "opencode", route: {} },
  ] });
  const lanes = rows.filter((row) => row.some((cell) => /^Lane \d\d$/.test(cell.text ?? "")));
  assert.equal(lanes.length, 30, "all thirty lanes render");
  const join = findRow(rows, "Join");
  assert.ok(join.some((cell) => cell.text === "  ⟵ 30 deps"), "a wide merge collapses to a count");
});

test("graphTitle prefers the task and falls back to a prettified requestId", () => {
  assert.equal(graphTitle({ record: { requestId: "market-scan-20260913" }, spec: { task: "Market scan" } }), "Market scan");
  assert.equal(graphTitle({ requestId: "widget-tree-demo-20260912" }), "Widget Tree Demo");
  assert.equal(prettyName("multi-cluster-a-20260913"), "Multi Cluster A");
  assert.equal(prettyName("lane-01"), "Lane 01");
});

test("graphListRows marks the selected graph and right-aligns progress", () => {
  const rows = graphListRows([
    { id: "graph-1", record: { requestId: "active-one", state: "running", nodes: [
      { id: "a", state: "completed", dependsOn: [] },
      { id: "b", state: "running", dependsOn: ["a"] },
    ] } },
    { id: "graph-2", record: { requestId: "done-two", state: "completed", nodes: [{ id: "a", state: "completed", dependsOn: [] }] } },
  ], { selectedId: "graph-2" });
  assert.equal(rows[0][0].text, "workflows  2  ●1 active");
  assert.equal(rows[1][0].text, "  ● Active One");
  assert.equal(rows[1][1].spacer, true);
  assert.equal(rows[1][2].text, "1/2 ●1");
  assert.equal(rows[2][0].text, "▸ ✔ Done Two");
  assert.equal(rows[2][2].text, "1/1");
});

test("graphForSession maps an OpenCode tab to its workflow through node receipts", () => {
  const graphs = [
    { id: "graph-a", record: { nodes: [{ id: "x", receipt: { sessionId: "ses_other" } }] } },
    { id: "graph-b", record: { nodes: [{ id: "y", receipt: { sessionId: "ses_match" } }, { id: "z", receipt: null }] } },
  ];
  assert.equal(graphForSession(graphs, "ses_match")?.id, "graph-b");
  assert.equal(graphForSession(graphs, "ses_none"), null);
  assert.equal(graphForSession(graphs, null), null);
});

test("shortThinking prefers the resolved decision over the raw route", () => {
  assert.equal(shortThinking({ routingDecision: { thinking: "max" }, route: { thinking: "high" } }), "max");
  assert.equal(shortThinking({ route: { thinking: "high" } }), "high");
  assert.equal(shortThinking({ route: {} }), "");
});

test("shortModel collapses provider and version noise", () => {
  assert.equal(shortModel({ target: "opencode", route: { model: "opencode-go/deepseek-v4.1-flash" } }), "flash");
  assert.equal(shortModel({ target: "pi", route: { model: "deepseek/deepseek-v4-flash-0731" } }), "flash");
  assert.equal(shortModel({ target: "codex", route: { model: "gpt-6.1-sol" } }), "sol");
  assert.equal(shortModel({ target: "claude", route: { model: "haiku" } }), "haiku");
  assert.equal(shortModel({ target: "opencode", route: { model: "muse-spark-1.3-contributor" } }), "muse");
  assert.equal(shortModel({ target: "cursor", route: {} }), "cursor");
});

test("listGraphs reads titles from the spec sidecar and sorts active first", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "harnest-widget-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const oldId = `graph-${"a".repeat(64)}`;
  const newId = `graph-${"b".repeat(64)}`;
  await writeFile(join(directory, `${oldId}.json`), JSON.stringify({ requestId: "old", state: "completed", nodes: [] }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  await writeFile(join(directory, `${newId}.json`), JSON.stringify({ requestId: "new", state: "running", nodes: [] }));
  await writeFile(join(directory, `${newId}.json.spec`), JSON.stringify({ digest: "d".repeat(64), spec: { task: "New run" } }));
  await writeFile(join(directory, "notes.txt"), "ignored");
  const picked = await latestGraph(directory);
  assert.equal(picked.id, newId);
  assert.equal(picked.record.requestId, "new");
  assert.equal(await latestGraph(join(directory, "missing")), null);
  const listed = await listGraphs(directory, 5);
  assert.deepEqual(listed.map((graph) => graph.record.requestId), ["new", "old"], "active graphs sort before settled ones");
  assert.equal(graphTitle(listed[0]), "New run");
  assert.equal(listed[1].spec, null, "a missing sidecar falls back to the prettified requestId");
  assert.equal(graphTitle(listed[1]), "Old");
  assert.equal((await listGraphs(directory, 1)).length, 1, "the limit caps the window");
});

test("renderers survive torn records instead of dereferencing malformed fields", () => {
  const torn = {
    requestId: "torn-record",
    state: "running",
    nodes: [null, "not-a-node", { id: "a", state: "running", dependsOn: "b" }, { id: "b", state: "completed", dependsOn: [] }],
  };
  assert.doesNotThrow(() => levelsOf(torn.nodes));
  assert.doesNotThrow(() => graphWaterfallRows(torn));
  assert.doesNotThrow(() => graphListRows([{ id: "graph-torn", record: torn }]));
  assert.doesNotThrow(() => graphWaterfallRows({ requestId: "torn", state: "running", nodes: "x" }));
  assert.doesNotThrow(() => graphListRows([{ id: "graph-torn", record: { requestId: "torn", state: "running", nodes: "x" } }]));
  assert.deepEqual(levelsOf(null), []);
  assert.deepEqual(levelsOf(undefined), []);

  const rows = graphWaterfallRows(torn);
  assert.equal(rows[0][2].text, "1/2  ●1  running", "non-object nodes are dropped from the stats");
  assert.ok(findRow(rows, "A"), "the intact nodes still render");
  assert.equal(graphForSession([{ id: "graph-torn", record: torn }], "ses_x"), null);
  assert.equal(graphForSession([{ id: "graph-torn", record: { nodes: "x" } }], "ses_match"), null);
});

test("truncate is code-point aware and never emits a lone surrogate", () => {
  assert.equal(truncate("😀", 1), "😀", "one code point fits in a width of one");
  assert.equal(truncate("😀😀😀", 2), "😀…");
  assert.equal(truncate("a😀b", 2), "a…");
  assert.equal(truncate("plain", 10), "plain");
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  assert.ok(!lone.test(truncate("😀", 1)), "the cut must not leave half an emoji");
});
