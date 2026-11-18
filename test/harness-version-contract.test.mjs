import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { z } from "zod";
import { createServer } from "../src/mcp-server.mjs";

test("MCP handoff and reroute schemas publish the v1/v2 harness contract", () => {
  const server = createServer({ detachBackground: false });
  const workflowSchema = server._registeredTools.handoff_workflow.inputSchema;
  const workflowJson = z.toJSONSchema(workflowSchema);
  const routeJson = workflowJson.properties.request.properties.route;
  assert.deepEqual(routeJson.properties.harnessVersion, { type: "string", enum: ["v1", "v2"] });
  const baseRequest = { requestId: "mcp-harness-version", target: "opencode", task: "test", cwd: process.cwd() };
  for (const harnessVersion of [undefined, "v1", "v2"]) {
    const request = harnessVersion === undefined ? baseRequest : { ...baseRequest, route: { harnessVersion } };
    assert.equal(workflowSchema.safeParse({ request }).success, true);
  }
  assert.equal(workflowSchema.safeParse({ request: { ...baseRequest, route: { harnessVersion: "v3" } } }).success, false);

  const rerouteSchema = server._registeredTools.handoff_reroute.inputSchema;
  assert.deepEqual(z.toJSONSchema(rerouteSchema).properties.route.properties.harnessVersion, { type: "string", enum: ["v1", "v2"] });
  assert.equal(rerouteSchema.safeParse({ jobId: "job", commandId: "command", route: { provider: "openai", model: "gpt-test", harnessVersion: "v3" } }).success, false);
});

test("published handoff schema enumerates only v1 and v2", async () => {
  const schema = JSON.parse(await readFile(new URL("../schemas/handoff-request.schema.json", import.meta.url), "utf8"));
  assert.deepEqual(schema.properties.route.properties.harnessVersion.enum, ["v1", "v2"]);
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
