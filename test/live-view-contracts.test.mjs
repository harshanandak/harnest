import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { asciiSafe, controlsSafe, loadView, parseArgs, renderList, renderRow } from "../scripts/graph-view.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const run = promisify(execFile);

test("every host hint exposes the real viewer flags", async () => {
  // --state stays internal/testing-only and is intentionally absent from hints.
  const files = ["commands/workflows.md", ".cursor/commands/workflows.md", "skills/workflow-view/SKILL.md"];
  const required = ["--workflow", "--list", "--watch", "--once", "--interval", "--width", "--ascii"];
  for (const file of files) {
    const text = await readFile(join(root, file), "utf8");
    const hint = text.match(/argument-hint:\s*"([^"]+)"/)?.[1] ?? "";
    for (const flag of required) assert.ok(hint.includes(flag), `${file} hint is missing ${flag}: ${hint}`);
  }
});

test("watch wins over once regardless of flag order", () => {
  assert.equal(parseArgs(["--watch", "--once"]).once, false);
  assert.equal(parseArgs(["--once", "--watch"]).once, false);
  assert.equal(parseArgs(["--once"]).once, true);
});

test("ascii rendering is pure ASCII for rows with branches and merges", () => {
  const rows = [
    [{ text: "  ", color: "#6b7280" }, { text: "✔ ", color: "#22c55e" }, { text: "Seed", color: "#22c55e" }, { spacer: true }, { text: "flash · high", color: "#9ca3af" }],
    [{ text: "├─ ", color: "#6b7280" }, { text: "● ", color: "#eab308" }, { text: "Lane A", color: "#eab308" }, { text: "  ⟵ Seed", color: "#6b7280" }, { spacer: true }, { text: "sol · high", color: "#9ca3af" }],
    [{ text: "╰─ ", color: "#6b7280" }, { text: "○ ", color: "#6b7280" }, { text: "Join", color: "#6b7280" }, { spacer: true }, { text: "haiku", color: "#9ca3af" }],
  ];
  const graphs = [{ id: "graph-1", record: { requestId: "row-check", state: "running", nodes: [] } }];
  const lines = [...rows.map((cells) => renderRow(cells, 44, { ascii: true })), ...renderList(graphs, { width: 44, ascii: true, selectedId: "graph-1" })];
  for (const line of lines) assert.ok(!/[^\x00-\x7F]/.test(line), `non-ASCII leaked in ascii mode: ${JSON.stringify(line)}`);
});

test("asciiSafe replaces every unmapped non-ASCII code point", () => {
  assert.equal(asciiSafe("Tëst 東京 ● ├"), "T?st ?? * +");
});

test("control characters are replaced with ? in plain and ascii modes", () => {
  const hostile = "wipe \u001b[2J and \u0007bell\u007f";
  assert.equal(asciiSafe(hostile), "wipe ?[2J and ?bell?");
  assert.equal(controlsSafe(hostile), "wipe ?[2J and ?bell?");
  assert.equal(controlsSafe("line\nnext"), "line\nnext", "frame newlines survive");
  assert.equal(controlsSafe("tab\there"), "tab?here");
  const cells = [{ text: hostile }, { spacer: true }, { text: "right" }];
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f]/.test(renderRow(cells, 44, { ascii: false })), "plain rows strip controls");
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f]/.test(renderRow(cells, 44, { ascii: true })), "ascii rows strip controls");
});

test("the once-frame sanitizes hostile record text in plain and ascii modes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "harnest-view-controls-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const graphs = join(directory, "graphs");
  await mkdir(graphs, { recursive: true });
  const id = `graph-${"f".repeat(64)}`;
  const digest = "a".repeat(64);
  const now = new Date(0).toISOString();
  await writeFile(join(graphs, `${id}.json`), JSON.stringify({
    graphId: id, digest, requestId: "hostile-view", state: "completed", revision: 1,
    createdAt: now, updatedAt: now, completedAt: now,
    nodes: [{ id: "plan", state: "completed", dependsOn: [], target: "pi", route: { model: "fake" } }],
  }));
  await writeFile(join(graphs, `${id}.json.spec`), JSON.stringify({ digest, spec: { task: "wipe \u001b[2J now", nodes: [{ id: "plan", request: { task: "wipe \u001b[2J now" } }] } }));
  for (const extra of [[], ["--ascii"]]) {
    const { stdout } = await run(process.execPath, [join(root, "scripts", "graph-view.mjs"), id, "--state", directory, "--once", ...extra], { cwd: root });
    assert.ok(!stdout.includes("\u001b"), `no terminal escape may leak (${extra[0] ?? "plain"})`);
    assert.ok(stdout.includes("wipe ?[2J now"), `hostile text renders inert (${extra[0] ?? "plain"})`);
  }
});

test("loadView falls back to the snapshot when the spec sidecar is missing or torn", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "harnest-view-spec-"));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const graphs = join(directory, "graphs");
  await mkdir(graphs, { recursive: true });

  const missingId = `graph-${"a".repeat(64)}`;
  await writeFile(join(graphs, `${missingId}.json`), JSON.stringify({ graphId: missingId, digest: "d".repeat(64), requestId: "no-spec", state: "completed", nodes: [{ id: "plan", state: "completed" }] }));
  const missing = await loadView({ stateDir: directory, graphId: "no-spec" });
  assert.equal(missing.record.spec, null, "a missing sidecar renders with spec:null");
  assert.deepEqual(missing.nodes.map((node) => node.id), ["plan"]);

  const tornId = `graph-${"b".repeat(64)}`;
  await writeFile(join(graphs, `${tornId}.json`), JSON.stringify({ graphId: tornId, digest: "e".repeat(64), requestId: "torn-spec", state: "running", nodes: [{ id: "plan", state: "running" }] }));
  await writeFile(join(graphs, `${tornId}.json.spec`), '{"digest": "e');
  const torn = await loadView({ stateDir: directory, graphId: "torn-spec" });
  assert.equal(torn.record.spec, null, "a truncated sidecar renders with spec:null");
  assert.equal(torn.state, "running");
});

test("loadView survives a malformed record and reports unknown selectors precisely", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "harnest-view-contract-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const graphs = join(directory, "graphs");
  await mkdir(graphs, { recursive: true });
  const digest = "d".repeat(64);
  const id = `graph-${"a".repeat(64)}`;
  await writeFile(join(graphs, `${id}.json`), JSON.stringify({ graphId: id, digest, requestId: "malformed-doc", state: "running", nodes: null }));
  await writeFile(join(graphs, `${id}.json.spec`), JSON.stringify({ digest, spec: { nodes: [] } }));
  const view = await loadView({ stateDir: directory, graphId: "malformed-doc" });
  assert.deepEqual(view.nodes, [], "a nodes:null record renders as an empty workflow instead of throwing");
  const digestB = "e".repeat(64);
  const idB = `graph-${"c".repeat(64)}`;
  await writeFile(join(graphs, `${idB}.json`), JSON.stringify({ graphId: idB, digest: digestB, requestId: "sparse-doc", state: "running", nodes: [null, { id: "a", state: "running" }] }));
  await writeFile(join(graphs, `${idB}.json.spec`), JSON.stringify({ digest: digestB, spec: { nodes: "not-an-array" } }));
  const sparse = await loadView({ stateDir: directory, graphId: "sparse-doc" });
  assert.equal(sparse.nodes.length, 1, "null node entries are dropped, not dereferenced");
  assert.deepEqual(sparse.nodes[0].dependsOn, []);
  assert.deepEqual(sparse.nodes[0].attempts, []);
  await assert.rejects(loadView({ stateDir: directory, graphId: `graph-${"b".repeat(64)}` }), /graph not found/);
});

test("session-start hook finds a running graph behind many settled ones", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "harnest-hook-depth-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const graphs = join(directory, "graphs");
  await mkdir(graphs, { recursive: true });
  for (let index = 0; index < 30; index++) {
    const id = `graph-${randomBytes(32).toString("hex")}`;
    await writeFile(join(graphs, `${id}.json`), JSON.stringify({ graphId: id, requestId: `settled-${index}`, state: "completed", nodes: [{ id: "a", state: "completed" }] }));
  }
  const runningId = `graph-${randomBytes(32).toString("hex")}`;
  await writeFile(join(graphs, `${runningId}.json`), JSON.stringify({ graphId: runningId, requestId: "still-running", state: "running", nodes: [{ id: "a", state: "completed" }, { id: "b", state: "running" }] }));
  const { stdout } = await run(process.execPath, [join(root, "scripts", "hook-session-start.mjs")], {
    env: { ...process.env, HARNEST_STATE_DIR: directory },
  });
  const context = JSON.parse(stdout.trim()).hookSpecificOutput.additionalContext;
  assert.match(context, /1 workflow graph\(s\) running/);
  assert.match(context, new RegExp(runningId.slice(6, 14)));
});
