// Model-free graph demo: use the real coordinator and store with fake leaf adapters.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Companion } from "../src/companion.mjs";
import { GraphRunner } from "../src/graph.mjs";

const directory = await mkdtemp(join(tmpdir(), "harnest-graph-demo-"));
const workspace = join(directory, "workspace");
await mkdir(workspace);
const calls = [];
let active = 0;
let peak = 0;
const adapterFactory = target => ({ async run(request, { onProgress }) {
  const nodeId = request.context.graph.nodeId;
  const upstream = Object.keys(request.context.graph.upstream || {});
  calls.push({ nodeId, target, requestId: request.requestId, upstream, at: Date.now() });
  active++;
  peak = Math.max(peak, active);
  try {
    await onProgress({ type: "text", text: `${nodeId} working`, sessionId: `demo-${nodeId}` });
    await new Promise(resolve => setTimeout(resolve, 100));
    if (nodeId === "deep-review" && calls.filter(call => call.nodeId === nodeId).length === 1) throw new Error("synthetic first-attempt failure");
    return { sessionId: `demo-${nodeId}`, result: { finalText: `${nodeId} DONE; used ${upstream.join(",") || "no prerequisites"}` }, usage: { input: 0, output: 0 } };
  } finally { active--; }
} });
const companion = new Companion({ stateDir: join(directory, "jobs"), routeResolver: async request => request, adapterFactory });
let runner = new GraphRunner({ companion });
const spec = {
  requestId: "demo-five-agent-graph", cwd: workspace, task: "Model-free five-agent graph demo", policy: { write: true },
  metadata: { harnest: { writeApproved: true } },
  execution: { background: false, maxConcurrency: 2, timeoutMs: 30000 },
  nodes: [
    { id: "plan", target: "claude", task: "plan", policy: { write: false } },
    { id: "cheap-check", target: "cursor", task: "check", dependsOn: ["plan"], policy: { write: false } },
    { id: "deep-review", target: "codex", task: "review", dependsOn: ["plan"], policy: { write: false } },
    { id: "combine", target: "pi", task: "combine", dependsOn: ["cheap-check", "deep-review"], policy: { write: false } },
    { id: "final", target: "opencode", task: "final", route: { provider: "fixture", model: "fake", harnessVersion: "v2" }, dependsOn: ["combine"] },
  ], outputs: ["final"],
};
const started = performance.now();
const initial = await runner.start(spec);
assert.equal(initial.state, "partial");
runner = new GraphRunner({ companion });
await runner.resume({ graphId: initial.graphId, commandId: "demo-retry", nodeIds: ["deep-review"], background: false });
const result = await runner.result(initial.graphId);
assert.equal(result.state, "completed");
assert.equal(calls.length, 6);
assert.equal(peak, 2);
for (const node of result.nodes) assert.equal(node.state, "completed", node.id);
const proof = {
  evidence: "real coordinator and persistence; fake adapters, no inference",
  graphId: result.graphId, elapsedMs: Math.round(performance.now() - started), peakConcurrency: peak,
  totalDispatches: calls.length, successfulNodesReexecuted: 0, modelCalls: 0,
  nodes: result.nodes, outputs: result.outputs, dispatches: calls,
};
await writeFile(join(directory, "demo.json"), JSON.stringify(proof, null, 2));
console.log(JSON.stringify({ graphId: proof.graphId, nodes: result.nodes.map(node => ({ id: node.id, target: node.target, state: node.state })), elapsedMs: proof.elapsedMs, peakConcurrency: peak, totalDispatches: calls.length, modelCalls: 0, evidencePath: join(directory, "demo.json") }, null, 2));
