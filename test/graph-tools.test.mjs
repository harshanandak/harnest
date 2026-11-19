import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { z } from "zod";
import { graphInputSchema, registerGraphTools } from "../src/graph-tools.mjs";
import { normalizeGraph } from "../src/graph-protocol.mjs";

test("published graph schema matches MCP input and accepts task-aware automatic routing", async () => {
  const generated = z.toJSONSchema(graphInputSchema);
  generated.$id = "https://local.harnest/schemas/agent-graph.schema.json";
  generated.title = "Harnest mixed-harness DAG";
  assert.deepEqual(JSON.parse(await readFile(new URL("../schemas/agent-graph.schema.json", import.meta.url), "utf8")), generated);
  const graph = { requestId: "graph-schema", cwd: process.cwd(), nodes: [{ id: "cheap-step", target: "auto", task: "extract names", metadata: { routing: { difficulty: "trivial", tier: "quick" } } }] };
  assert.equal(graphInputSchema.parse(graph).nodes[0].target, "auto");
  assert.equal(graphInputSchema.safeParse({ ...graph, nodes: [{ ...graph.nodes[0], workflow: { spec: {} } }] }).success, false);
  assert.equal(graphInputSchema.safeParse({ ...graph, execution: { maxConcurrency: 7 } }).success, false);
  const schema = z.toJSONSchema(graphInputSchema);
  assert.deepEqual(Object.keys(schema.properties.policy.properties), ["write", "readOnly", "allowWrites", "tools", "maxCostUsd"]);
  assert.equal(schema.properties.policy.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.properties.nodes.items.properties.route.properties), ["provider", "model", "agent", "variant", "thinking", "harnessVersion", "serverUrl", "serviceTier", "profile", "options"]);
  assert.equal(schema.properties.nodes.items.properties.route.additionalProperties, false);
  assert.deepEqual(schema.properties.nodes.items.properties.route.properties.harnessVersion, { type: "string", enum: ["v1", "v2"] });
  const execution = schema.properties.nodes.items.properties.execution;
  assert.deepEqual(Object.keys(execution.properties), ["timeoutMs", "sessionId", "addDirs", "attachments", "instructions", "sessionAction", "maxTurns"]);
  assert.equal(execution.additionalProperties, false);
  assert.equal(graphInputSchema.safeParse({ ...graph, nodes: [{ ...graph.nodes[0], route: { harnessVersion: "v3" } }] }).success, false);
  assert.equal(graphInputSchema.safeParse({ ...graph, policy: { permissions: "write" } }).success, false);
  assert.equal(graphInputSchema.safeParse({ ...graph, nodes: [{ ...graph.nodes[0], route: { reasoningEffort: "xhigh" } }] }).success, false);
  assert.equal(graphInputSchema.safeParse({ ...graph, policy: { write: true }, nodes: [
    { id: "gemini", target: "gemini", task: "review", policy: { write: false } },
    { id: "amp", target: "amp", task: "edit", route: { variant: "medium" }, policy: { write: true } },
  ] }).success, true);
});

test("graph runtime errors list accepted policy and route fields", async () => {
  const graph = { requestId: "graph-runtime-fields", cwd: process.cwd(), nodes: [{ id: "step", target: "pi", task: "test" }] };
  await assert.rejects(
    normalizeGraph({ ...graph, policy: { permission: "write" } }),
    /policy\.permission is unsupported; expected one of write, readOnly, allowWrites, tools, maxCostUsd/,
  );
  await assert.rejects(
    normalizeGraph({ ...graph, nodes: [{ ...graph.nodes[0], route: { reasoningEffort: "xhigh" } }] }),
    /node\.route\.reasoningEffort is unsupported; expected one of provider, model, agent, variant, thinking, harnessVersion, serverUrl, serviceTier, profile, options$/,
  );
});

test("graph status is a flat strict-host schema and forwards bounded long-poll options", async () => {
  const tools = new Map();
  let called;
  registerGraphTools({ registerTool: (name, definition, execute) => tools.set(name, { ...definition, execute }) }, {
    status: async (graphId, options) => { called = { graphId, options }; return { graphId, revision: 8, unchanged: true }; },
  }, { dataResponse: (_key, value) => value, failure: error => { throw error; } });
  assert.equal(tools.size, 6);
  const status = tools.get("handoff_graph_status");
  const schema = z.toJSONSchema(status.inputSchema);
  assert.equal(schema.type, "object");
  assert.equal(schema.allOf, undefined);
  assert.deepEqual(Object.keys(schema.properties), ["graphId", "afterRevision", "waitMs"]);
  assert.equal(status.inputSchema.safeParse({ graphId: "graph-fixture", waitMs: 25001 }).success, false);
  const result = await status.execute({ graphId: "graph-fixture", afterRevision: 8, waitMs: 25000 });
  assert.deepEqual(called, { graphId: "graph-fixture", options: { afterRevision: 8, waitMs: 25000 } });
  assert.equal(result.unchanged, true);
});
