import assert from "node:assert/strict";
import test from "node:test";
import { graphListRows, graphWaterfallRows, levelsOf } from "../opencode-plugin/graph-render.mjs";
import { paint, renderList, renderRow, renderView } from "../scripts/graph-view.mjs";

// Declaration order (join first) differs from dependency order (a, b, join), so
// this catches a viewer that fell back to raw record order or its own layout.
const diamondRecord = () => ({
  requestId: "parity-demo",
  state: "completed",
  nodes: [
    { id: "join", state: "pending", dependsOn: ["a", "b"], target: "codex", route: { model: "gpt-6.1-sol" } },
    { id: "a", state: "completed", dependsOn: [], target: "opencode", route: { model: "deepseek-v4.1-flash" }, routingDecision: { thinking: "high" } },
    { id: "b", state: "running", dependsOn: [], target: "pi", route: { model: "deepseek-v4-flash-0731" } },
  ],
});

const countsOf = (nodes) => nodes.reduce((counts, node) => {
  counts[node.state] = (counts[node.state] ?? 0) + 1;
  return counts;
}, { total: nodes.length });

const viewOf = (record) => ({
  graphId: `graph-${"a".repeat(64)}`,
  requestId: record.requestId,
  state: record.state,
  revision: 1,
  recoveryRequired: false,
  cancellation: null,
  elapsedMs: 1000,
  counts: countsOf(record.nodes),
  order: levelsOf(record.nodes).flat().map((node) => node.id),
  nodes: record.nodes,
  graphs: [],
  record,
});

const nonSpacerText = (cells) => cells.filter((cell) => !cell.spacer).map((cell) => String(cell.text ?? ""));

test("renderRow lays out shared cells to the terminal width and keeps the ascii fallback", () => {
  assert.equal(renderRow([{ text: "a" }, { spacer: true }, { text: "b" }], 10), `a${" ".repeat(8)}b`);
  assert.equal(renderRow([{ text: "a" }, { spacer: true }, { text: "b" }], 2), "a b", "the spacer never collapses");
  assert.equal(renderRow([{ text: "left" }, { spacer: true }, { text: "right" }], 20, { color: false }).length, 20);

  const running = graphWaterfallRows(diamondRecord()).find((cells) => nonSpacerText(cells).some((text) => text.includes("●")));
  const ascii = renderRow(running, 40, { ascii: true });
  assert.match(ascii, /\*/);
  assert.doesNotMatch(ascii, /[✔●○✖◌⛔⊘]/, "ascii mode replaces every shared glyph");
});

test("paint maps shared hex colors to ANSI truecolor and passes unknown values through", () => {
  assert.equal(paint("x", "#22c55e", true), "\u001b[38;2;34;197;94mx\u001b[0m");
  assert.equal(paint("x", "#22c55e", false), "x");
  assert.equal(paint("x", "not-a-color", true), "x");
});

test("the terminal frame carries every shared waterfall cell, in dependency order", () => {
  const record = diamondRecord();
  const view = viewOf(record);
  assert.deepEqual(view.order, ["a", "b", "join"], "waterfall order follows dependency depth, not declaration order");

  const frame = renderView(view, { width: 120, color: false });
  for (const cells of graphWaterfallRows({ record, spec: null })) {
    for (const text of nonSpacerText(cells).map((value) => value.trim()).filter(Boolean)) {
      assert.ok(frame.includes(text), `frame must carry shared cell ${JSON.stringify(text)}`);
    }
  }
  assert.match(frame, /⟵ A, B/, "the shared merge annotation survives the terminal");
});

test("terminal selection tracks the shared waterfall order", () => {
  const view = viewOf(diamondRecord());
  const first = renderView(view, { width: 120, color: false, selected: 0 });
  assert.ok(first.split("\n").some((line) => line.startsWith("> ") && /\bA\b/.test(line)), "first shared row is A");
  const last = renderView(view, { width: 120, color: false, selected: 2 });
  assert.ok(last.split("\n").some((line) => line.startsWith("> ") && /Join/.test(line)), "last shared row is Join");
});

test("the terminal switcher reuses graphListRows", () => {
  const graphs = [
    { id: "g1", record: { requestId: "alpha-run", state: "running", nodes: [{ id: "x", state: "completed", dependsOn: [] }] } },
    { id: "g2", record: { requestId: "beta-run", state: "completed", nodes: [{ id: "y", state: "completed", dependsOn: [] }] } },
  ];
  const lines = renderList(graphs, { width: 60, selectedId: "g2" });
  const shared = graphListRows(graphs, { selectedId: "g2" });
  assert.equal(lines.length, shared.length);
  shared.forEach((cells, index) => {
    for (const text of nonSpacerText(cells).filter((value) => value.trim())) {
      assert.ok(lines[index].includes(text), `switcher line ${index} must carry shared cell ${JSON.stringify(text)}`);
    }
  });
  assert.match(lines[0], /workflows\s+2\s+●1 active/);
  assert.match(lines[2], /▸ ✔ Beta Run/);
});

test("the terminal frame renders a torn record instead of throwing", () => {
  const record = { requestId: "torn-record", state: "running", nodes: [null, { id: "a", state: "running", dependsOn: "b", target: "pi", route: {} }] };
  const view = {
    graphId: `graph-${"b".repeat(64)}`,
    requestId: "torn-record",
    state: "running",
    revision: 1,
    recoveryRequired: false,
    cancellation: null,
    elapsedMs: 0,
    counts: { total: 1, completed: 0, running: 1, pending: 0, failed: 0, partial: 0, blocked: 0, cancelled: 0 },
    order: levelsOf(record.nodes).flat().map((node) => node.id),
    nodes: record.nodes,
    graphs: [],
    record,
  };
  const frame = renderView(view, { width: 100, color: false });
  assert.match(frame, /Torn Record/);
  assert.match(frame, /A/);
});
