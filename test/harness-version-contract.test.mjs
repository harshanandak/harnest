import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { z } from "zod";
import { createServer } from "../src/mcp-server.mjs";
import { assertDynamicLeaf } from "../src/dynamic-protocol.mjs";
import { assertGraphLeaf, normalizeGraph } from "../src/graph-protocol.mjs";
import { createReceipt, normalizeRequest, terminalReceipt } from "../src/protocol.mjs";
import { createRouteResolver } from "../src/routing.mjs";

test("MCP handoff and reroute schemas publish the OpenCode V2 contract", () => {
  const server = createServer({ detachBackground: false });
  const workflowSchema = server._registeredTools.handoff_workflow.inputSchema;
  const workflowJson = z.toJSONSchema(workflowSchema);
  const routeJson = workflowJson.properties.request.properties.route;
  assert.deepEqual(routeJson.properties.harnessVersion, { type: "string", enum: ["v2"] });
  const baseRequest = { requestId: "mcp-harness-version", target: "opencode", task: "test", cwd: process.cwd() };
  for (const harnessVersion of [undefined, "v2"]) {
    const request = harnessVersion === undefined ? baseRequest : { ...baseRequest, route: { harnessVersion } };
    assert.equal(workflowSchema.safeParse({ request }).success, true);
  }
  assert.equal(workflowSchema.safeParse({ request: { ...baseRequest, route: { harnessVersion: "v1" } } }).success, false);

  const rerouteSchema = server._registeredTools.handoff_reroute.inputSchema;
  assert.deepEqual(z.toJSONSchema(rerouteSchema).properties.route.properties.harnessVersion, { type: "string", enum: ["v2"] });
  assert.equal(rerouteSchema.safeParse({ jobId: "job", commandId: "command", route: { provider: "openai", model: "gpt-test", harnessVersion: "v1" } }).success, false);
});

test("published handoff schema enumerates only V2", async () => {
  const schema = JSON.parse(await readFile(new URL("../schemas/handoff-request.schema.json", import.meta.url), "utf8"));
  assert.deepEqual(schema.properties.route.properties.harnessVersion.enum, ["v2"]);
});

test("stored OpenCode V1 routes are ineligible for new work while historical receipts remain readable", async () => {
  const request = normalizeRequest({
    requestId: "historical-opencode", target: "opencode", task: "Inspect", cwd: process.cwd(),
  });
  const oldRoute = { model: "openai/fixture", harnessVersion: "v1" };
  const resolve = createRouteResolver({
    env: {}, config: {},
    userPolicy: { candidates: [{ id: "old", target: "opencode", route: oldRoute }] },
    modelCatalog: async () => assert.fail("must not query models for a V1 route"),
  });
  await assert.rejects(resolve(request), /opencode-version/);
  const receipt = terminalReceipt(createReceipt({ ...request, route: oldRoute }), "completed", {
    result: { finalText: "historical answer" },
  });
  assert.deepEqual(receipt.route, oldRoute);
  assert.equal(receipt.result.finalText, "historical answer");
  await assert.rejects(resolve({ ...request, route: receipt.route }), /OpenCode V1 is unsupported/);
});

test("OpenCode single, graph, and dynamic leaves reject unenforceable tools before dispatch", async () => {
  const route = { model: "openai/fixture" };
  const policy = { tools: { deny: ["read"] } };
  const request = normalizeRequest({
    requestId: "open-code-tool-policy", target: "opencode", task: "Inspect", cwd: process.cwd(), route, policy,
  });
  const resolve = createRouteResolver({
    env: {}, config: {}, userPolicy: {},
    modelCatalog: async () => assert.fail("must not query models for a rejected policy"),
  });
  const check = (error) => error.details?.kind === "policy" && error.details.field === "policy.tools";
  await assert.rejects(resolve(request), check);
  assert.throws(() => assertGraphLeaf(request), check);
  assert.throws(() => assertDynamicLeaf(request), check);
  await assert.rejects(normalizeGraph({ requestId: "bad-version", cwd: process.cwd(), nodes: [{
    id: "leaf", target: "opencode", task: "Inspect", route: { ...route, harnessVersion: "v1" },
  }] }), /OpenCode V1 is unsupported/);
});

test("MCP comparison and review schemas reject Amp and ACP while preserving all six read-only targets", () => {
  const server = createServer({ detachBackground: false });
  const targets = ["opencode", "pi", "cursor", "claude", "codex", "gemini"];
  const inputFor = (collection, target) => ({
    request: { requestId: `readonly-${target}`, target, task: "inspect", cwd: process.cwd() },
    [collection]: [
      { name: "first", target, route: { model: target === "gemini" ? "gemini-fixture" : "fixture" } },
      { name: "second", target, route: { model: target === "gemini" ? "gemini-fixture" : "fixture" } },
    ],
  });
  for (const [toolName, collection] of [["handoff_compare", "candidates"], ["handoff_review", "reviewers"]]) {
    const schema = server._registeredTools[toolName].inputSchema;
    for (const target of targets) assert.equal(schema.safeParse(inputFor(collection, target)).success, true, `${toolName}:${target}`);
    assert.equal(schema.safeParse(inputFor(collection, "amp")).success, false, `${toolName}:Amp must fail at the MCP boundary`);
    assert.equal(schema.safeParse(inputFor(collection, "acp")).success, false, `${toolName}:ACP must fail at the MCP boundary`);
  }
});
