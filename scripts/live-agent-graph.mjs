// Explicit opt-in, two-model graph acceptance probe. Never part of npm test.
// `--resume <graphId> --state <jobsDir>` recovers an interrupted run in place.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Companion } from "../src/companion.mjs";
import { GraphRunner } from "../src/graph.mjs";
import { runProcess } from "../src/process.mjs";

const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
};

async function report(result, directory) {
  const summary = { graphId: result.graphId, state: result.state, nodes: result.nodes.map(node => ({ id: node.id, target: node.target, state: node.state, jobId: node.jobId })), outputs: result.outputs, stateDir: directory };
  await writeFile(join(directory, "evidence.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ ...summary, evidencePath: join(directory, "evidence.json") }, null, 2));
  assert.equal(result.state, "completed");
  assert.equal(result.nodes.length, 2);
  for (const node of result.nodes) assert.equal(node.state, "completed", node.id);
  assert.match(JSON.stringify(result.outputs.verify), /GRAPH_VERIFIED_271/);
}

if (process.argv.includes("--resume")) {
  const graphId = argument("--resume"), stateDir = argument("--state");
  if (!graphId || !stateDir) throw new Error("usage: --resume <graphId> --state <jobsDir>");
  const companion = new Companion({ stateDir });
  const runner = new GraphRunner({ companion });
  await runner.resume({ graphId, commandId: `resume-${graphId.slice(-12)}`, background: false });
  await report(await runner.result(graphId), stateDir);
} else if (!process.argv.includes("--live")) {
  console.log("Usage: node scripts/live-agent-graph.mjs --live\n   or: node scripts/live-agent-graph.mjs --resume <graphId> --state <jobsDir>\nRuns two bounded read-only model calls in a disposable workspace: Codex Sol then OpenCode DeepSeek V4.1 Flash.");
} else {
  const directory = await mkdtemp(join(tmpdir(), "harnest-live-graph-"));
  const workspace = join(directory, "workspace");
  await mkdir(workspace);
  await runProcess("git", ["-C", workspace, "init", "--quiet"], { stdinLines: [], timeoutMs: 5000 });
  const stateDir = join(directory, "jobs");
  const companion = new Companion({ stateDir });
  const runner = new GraphRunner({ companion });
  const graph = {
    requestId: "live-two-agent-graph", cwd: workspace, task: "Bounded graph handoff acceptance probe", policy: { write: false },
    execution: { background: false, maxConcurrency: 2, timeoutMs: 180000 },
    nodes: [
      { id: "source", target: "codex", route: { model: "gpt-6.1-terra", thinking: "high" }, metadata: { routing: { modelVersion: "pin" } }, execution: { timeoutMs: 90000 }, context: { requiredResultFields: ["finalText"], requiredText: ["GRAPH_SOURCE_271"] }, task: "Reply with exactly GRAPH_SOURCE_271. Do not use tools." },
      { id: "verify", target: "opencode", route: { provider: "opencode-go", model: "deepseek-v4.1-flash", harnessVersion: "v2", thinking: "high" }, execution: { timeoutMs: 90000 }, dependsOn: ["source"], context: { requiredResultFields: ["finalText"], requiredText: ["GRAPH_VERIFIED_271"] }, task: "Check context.graph.upstream.source.result.finalText. If it contains GRAPH_SOURCE_271, reply with exactly GRAPH_VERIFIED_271. Otherwise reply MISSING_SOURCE. Do not use tools." },
    ], outputs: ["verify"],
  };
  const initial = await runner.start(graph);
  const fresh = new GraphRunner({ companion: new Companion({ stateDir }) });
  await report(await fresh.result(initial.graphId), stateDir);
}
