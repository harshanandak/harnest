import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import { dynamicToolDefinitions, registerDynamicTools } from "../src/dynamic-tools.mjs";

test("dynamic start always returns durable background work at the MCP boundary", async () => {
  let actual;
  const runner = { start: async (input) => { actual = input; return { runId: "run" }; } };
  const tool = dynamicToolDefinitions(runner).find((item) => item.name === "handoff_dynamic_start");
  await tool.run(tool.inputSchema.parse({ workflow: { requestId: "request", cwd: process.cwd(), source: "return 1", execution: { background: false } } }));
  assert.equal(actual.execution.background, true);
  assert.equal(actual.source, "return 1");
});

test("dynamic tool schemas admit Gemini and explicit write-capable Amp and ACP roots", () => {
  const tool = dynamicToolDefinitions({}).find((item) => item.name === "handoff_dynamic_start");
  const base = { requestId: "request", cwd: process.cwd(), source: "return 1" };
  assert.equal(tool.inputSchema.safeParse({ workflow: { ...base, target: "gemini", policy: { write: false } } }).success, true);
  assert.equal(tool.inputSchema.safeParse({ workflow: { ...base, target: "amp", route: { variant: "medium" }, policy: { write: true } } }).success, true);
  assert.equal(tool.inputSchema.safeParse({ workflow: { ...base, target: "acp", route: { agent: "fixture" }, policy: { write: true } } }).success, true);
});

test("saved invocation pins source revision and preserves scope in provenance", async () => {
  let actual;
  const revision = "a".repeat(64);
  const runner = { start: async (input) => { actual = input; return input; } };
  const registry = { get: async (input) => { assert.equal(input.revision, revision); return { name: "review", scope: "project", source: "return args" }; } };
  const tool = dynamicToolDefinitions(runner, registry).find((item) => item.name === "handoff_dynamic_invoke");
  await tool.run(tool.inputSchema.parse({ name: "review", revision, cwd: process.cwd(), requestId: "request", args: { file: "test.js" } }));
  assert.equal(actual.source, "return args");
  assert.equal(actual.metadata.savedWorkflow.revision, revision);
  assert.equal(actual.args.file, "test.js");
  assert.equal(actual.scope, undefined);
});

test("every dynamic operation registers and failures cross the standard boundary", async () => {
  const tools = new Map();
  const server = { registerTool: (name, config, run) => tools.set(name, { config, run }) };
  registerDynamicTools(server, { result: async () => { throw new Error("corrupt snapshot"); } }, { dataResponse: (key, value) => ({ [key]: value }), failure: (error) => ({ error: error.message }) });
  assert.deepEqual([...tools.keys()].sort(), ["control", "delete", "get", "history", "inspect", "invoke", "list", "result", "resume", "revisions", "save", "start", "status", "validate"].map((suffix) => `handoff_dynamic_${suffix}`).sort());
  assert.deepEqual(await tools.get("handoff_dynamic_result").run({ runId: "run" }), { error: "corrupt snapshot" });
  assert.equal(tools.get("handoff_dynamic_save").config.annotations.readOnlyHint, false);
  assert.throws(() => tools.get("handoff_dynamic_control").config.inputSchema.parse({ runId: "run", commandId: "command", action: "restart-agent", executable: "bad" }));
});

test("published schema bundle resolves nested JSON argument references for every operation", async () => {
  const schema = JSON.parse(await readFile(new URL("../schemas/dynamic-tools.schema.json", import.meta.url), "utf8"));
  const ajv = new Ajv2020({ strict: true });
  ajv.addSchema(schema, "tools");
  for (const tool of dynamicToolDefinitions({})) assert.equal(typeof ajv.compile({ $ref: `tools#/$defs/${tool.name}` }), "function");
  const validate = ajv.compile({ $ref: "tools#/$defs/handoff_dynamic_start" });
  assert.equal(validate({ workflow: { requestId: "args", cwd: process.cwd(), source: "return args", args: [null, { nested: [true, 42] }] } }), true, JSON.stringify(validate.errors));
  assert.equal(validate({ workflow: { requestId: "args", cwd: process.cwd(), source: "return args", execution: { transport: "bad" } } }), false);
  for (const operation of ["status", "result"]) {
    const validatePage = ajv.compile({ $ref: `tools#/$defs/handoff_dynamic_${operation}` });
    assert.equal(validatePage({ runId: "run", phaseLimit: 20, phaseCursor: 19 }), true, JSON.stringify(validatePage.errors));
    assert.equal(validatePage({ runId: "run", phaseLimit: 101 }), false);
    assert.equal(validatePage({ runId: "run", phaseCursor: -1 }), false);
  }
});
