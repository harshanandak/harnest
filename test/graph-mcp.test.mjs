import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { PAGE_RESPONSE_BYTES, STATUS_RESPONSE_BYTES } from "../src/mcp-output.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
async function connect(directory, modern) {
  const client = new Client({ name: "agent-graph-regression", version: "1" }, modern ? { versionNegotiation: { mode: "auto" } } : {});
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, "scripts", "fixtures", "mcp-agent-graph.mjs"), directory], cwd: root }));
  return client;
}
async function call(client, name, args, error = false) {
  const budget = name === "handoff_graph_status" ? STATUS_RESPONSE_BYTES : PAGE_RESPONSE_BYTES;
  const request = async (tool, input) => {
    const result = await client.callTool({ name: tool, arguments: input });
    assert.equal(Boolean(result.isError), error, result.content?.[0]?.text);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= budget);
    return JSON.parse(result.content[0].text);
  };
  const result = await request(name, args);
  if (result.page?.continuation?.tool !== "handoff_page") return result;
  let page = result.page;
  const chunks = [page.chunk];
  while (page.continuation) {
    const { tool, arguments: next } = page.continuation;
    assert.equal(tool, "handoff_page");
    const continued = await request(tool, next);
    assert.equal(continued.tool, name);
    assert.equal(continued.key, "graph");
    chunks.push(continued.page.chunk);
    page = continued.page;
  }
  return JSON.parse(chunks.join(""));
}

for (const modern of [false, true]) {
  test(`six-harness graph resumes only failed work through MCP after restart (${modern ? "modern" : "legacy"})`, { timeout: 60000 }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "harnest-graph-mcp-"));
    const phases = [];
    const measure = async (name, run) => {
      const startedAt = new Date().toISOString();
      const started = performance.now();
      try { return await run(); }
      finally { phases.push({ name, startedAt, elapsedMs: performance.now() - started }); }
    };
    let client;
    try {
      client = await measure("connect", () => connect(directory, modern));
      const graph = {
        requestId: "six-agent-dag", cwd: directory, task: "private-graph-task-must-not-be-echoed-by-status", context: { shared: "private-shared-context-marker" }, policy: { write: true },
        execution: { background: false, maxConcurrency: 2, timeoutMs: 10000 },
        nodes: [
          { id: "pi-plan", target: "pi", task: "plan", policy: { write: false } },
          { id: "claude-review", target: "claude", task: "review", dependsOn: ["pi-plan"], policy: { write: false } },
          { id: "codex-review", target: "codex", task: "review", dependsOn: ["pi-plan"], policy: { write: false } },
          { id: "amp-review", target: "amp", route: { variant: "medium" }, task: "review", dependsOn: ["pi-plan"], policy: { write: true } },
          { id: "cursor-join", target: "cursor", task: "join", dependsOn: ["claude-review", "codex-review", "amp-review"], policy: { write: false } },
          { id: "opencode-final", target: "opencode", route: { provider: "fixture", model: "synthetic", harnessVersion: "v2" }, task: "final", dependsOn: ["cursor-join"], policy: { write: true } },
        ], outputs: ["opencode-final"],
      };
      const validated = await measure("validate", () => call(client, "handoff_graph_validate", { graph }));
      assert.equal(validated.valid, true);
      await assert.rejects(readFile(join(directory, "launches.jsonl")), { code: "ENOENT" });
      const partial = await measure("start", () => call(client, "handoff_graph_start", { graph }));
      assert.equal(partial.state, "partial", JSON.stringify(partial));
      assert.equal(partial.nodes.length, graph.nodes.length);
      const firstNodes = Object.fromEntries(partial.nodes.map(node => [node.id, node]));
      assert.equal(firstNodes["pi-plan"].state, "completed");
      assert.equal(firstNodes["claude-review"].state, "failed");
      assert.equal(firstNodes["codex-review"].state, "completed");
      assert.equal(firstNodes["amp-review"].state, "completed");
      assert.equal(firstNodes["cursor-join"].state, "blocked");
      assert.equal(firstNodes["opencode-final"].state, "blocked");
      await measure("close", () => client.close());
      client = await measure("reconnect", () => connect(directory, modern));
      const again = await measure("restart", () => call(client, "handoff_graph_start", { graph }));
      assert.equal(again.graphId, partial.graphId);
      const resumed = await measure("resume", () => call(client, "handoff_graph_resume", { graphId: partial.graphId, commandId: "retry-review-once", nodeIds: ["claude-review"], background: false }));
      assert.equal(resumed.state, "completed", JSON.stringify(resumed));
      const repeated = await call(client, "handoff_graph_resume", { graphId: partial.graphId, commandId: "retry-review-once", nodeIds: ["claude-review"], background: false });
      assert.equal(repeated.graphId, partial.graphId);
      const status = await call(client, "handoff_graph_status", { graphId: partial.graphId });
      assert.equal(status.nodes.length, graph.nodes.length);
      assert.doesNotMatch(JSON.stringify(status), /private-graph-task-must-not-be-echoed-by-status|private-shared-context-marker/);
      assert.equal(status.outputs, undefined, "full outputs belong to result, not routine status");
      for (const node of status.nodes) {
        assert.equal(node.state, "completed", node.id);
        const receipt = await call(client, "handoff_result", { jobId: node.jobId });
        assert.equal(receipt.state, "completed");
        assert.equal(receipt.target, graph.nodes.find(input => input.id === node.id).target);
        assert.match(receipt.result.finalText, /DONE/);
        const trace = await call(client, "handoff_trace", { jobId: node.jobId });
        assert.ok(trace.events.length > 0);
      }
      const result = await call(client, "handoff_graph_result", { graphId: partial.graphId });
      assert.equal(result.state, "completed");
      assert.deepEqual(Object.keys(result.outputs), ["opencode-final"]);
      assert.match(JSON.stringify(result.outputs), /opencode-final DONE/);
      const launches = (await readFile(join(directory, "launches.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
      assert.equal(launches.length, graph.nodes.length + 1, "six nodes plus one failed-node retry; no completed work repeated");
      assert.equal(launches.filter(item => item.nodeId === "pi-plan").length, 1);
      assert.equal(launches.filter(item => item.nodeId === "codex-review").length, 1);
      assert.equal(launches.filter(item => item.nodeId === "amp-review").length, 1);
      assert.deepEqual(launches.find(item => item.nodeId === "cursor-join").upstream, ["amp-review", "claude-review", "codex-review"]);
      assert.deepEqual(launches.find(item => item.nodeId === "opencode-final").upstream, ["cursor-join"]);
    } catch (error) {
      t.diagnostic(JSON.stringify({ phases }));
      throw error;
    } finally {
      await client?.close();
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
}
