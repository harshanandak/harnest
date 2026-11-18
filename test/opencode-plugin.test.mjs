import assert from "node:assert/strict";
import test from "node:test";
import { validateHandoffWorkflowArgs } from "../opencode-plugin/validate-workflow.mjs";
import plugin, { HarnestPlugin, resultPayload } from "../opencode-plugin/harnest.mjs";

const TOOL = "harnest_handoff_workflow";

function validRequest(overrides = {}) {
  return {
    requestId: "req-1",
    target: "pi",
    task: "do the thing",
    cwd: "C:\\work\\proj",
    route: {},
    policy: { write: false },
    ...overrides,
  };
}

test("validateHandoffWorkflowArgs is exported and pure", () => {
  assert.equal(typeof validateHandoffWorkflowArgs, "function");
});

test("valid wrapped and bare requests pass through", () => {
  assert.equal(validateHandoffWorkflowArgs({ request: validRequest() }), null);
  assert.equal(validateHandoffWorkflowArgs(validRequest()), null);
  assert.equal(
    validateHandoffWorkflowArgs({
      request: validRequest({ target: "opencode", route: { model: "anthropic/claude-opus-4-6" } }),
    }),
    null,
  );
});

test("missing request is rejected with a naming message", () => {
  for (const args of [null, undefined, 42, "nope", [], {}, { request: null }, { request: [] }]) {
    const problem = validateHandoffWorkflowArgs(args);
    assert.match(String(problem), /request/, `must name request for ${JSON.stringify(args)}`);
  }
});

test("an invalid request wrapper cannot fall back to outer request fields", () => {
  for (const request of [null, undefined, [], 42]) {
    assert.match(validateHandoffWorkflowArgs({ ...validRequest(), request }), /request is required/);
  }
});

test("missing or blank requestId is rejected with a naming message", () => {
  for (const requestId of [undefined, null, "", "   ", 42]) {
    const problem = validateHandoffWorkflowArgs({ request: validRequest({ requestId }) });
    assert.match(String(problem), /requestId/, `must name requestId for ${JSON.stringify(requestId)}`);
  }
});

test("missing or relative cwd is rejected with a naming message", () => {
  for (const cwd of [undefined, null, "", "   ", "relative/path", "..\\up", 42]) {
    const problem = validateHandoffWorkflowArgs({ request: validRequest({ cwd }) });
    assert.match(String(problem), /cwd/, `must name cwd for ${JSON.stringify(cwd)}`);
  }
});

test("posix, drive-letter, and UNC cwd roots are accepted", () => {
  for (const cwd of ["/work/proj", "C:\\work\\proj", "C:/work/proj", "\\\\host\\share"]) {
    assert.equal(validateHandoffWorkflowArgs({ request: validRequest({ cwd }) }), null, cwd);
  }
});

test("opencode target without route.model passes pre-flight; policy resolves the model", () => {
  for (const route of [undefined, null, {}, { model: "" }, { model: "   " }]) {
    assert.equal(
      validateHandoffWorkflowArgs({ request: validRequest({ target: "opencode", route }) }),
      null,
      `pre-flight must defer to policy for ${JSON.stringify(route)}`,
    );
  }
  const problem = validateHandoffWorkflowArgs({ request: validRequest({ target: "opencode", route: { model: 42 } }) });
  assert.match(String(problem), /route\.model must be a string/);
});

test("non-opencode targets do not require route.model", () => {
  for (const target of ["pi", "cursor", "claude", "codex", undefined]) {
    assert.equal(
      validateHandoffWorkflowArgs({ request: validRequest({ target, route: {} }) }),
      null,
      String(target),
    );
  }
});

test("validator never throws on garbage", () => {
  const garbage = [null, undefined, 0, "", [], {}, { request: 42 }, { request: { cwd: {} } }];
  for (const args of garbage) {
    assert.doesNotThrow(() => validateHandoffWorkflowArgs(args));
    assert.equal(typeof validateHandoffWorkflowArgs(args), "string");
  }
});

async function host(storage = new Map()) {
  const hooks = {}, tools = {};
  await plugin.setup({
    tool: {
      transform: async fn => fn({ add: tool => { tools[tool.name] = tool; } }),
      hook: async (name, fn) => { hooks[name] = fn; },
    },
    session: { hook: async (name, fn) => { hooks[name] = fn; } },
    storage: {
      get: async key => storage.get(key),
      set: async (key, value) => { storage.set(key, structuredClone(value)); },
      scan: async ({ prefix, after }) => {
        // Deliberately paginate at two entries to exercise compaction recovery.
        const keys = [...storage.keys()].sort().filter(key => key.startsWith(prefix) && (!after || key > after));
        const page = keys.slice(0, 2);
        return { entries: page.map(key => ({ key, value: storage.get(key) })), next: keys.length > 2 ? page.at(-1) : undefined };
      },
    },
  });
  return { hooks, tools, storage };
}

test("V2 default export registers host_info with JSON Schema and structured output", async () => {
  assert.equal(plugin.id, "harnest");
  const { tools } = await host();
  const info = tools.handoff_host_info;
  assert.deepEqual(info.input, { type: "object", properties: {}, additionalProperties: false });
  const result = JSON.parse((await info.execute({}, { sessionID: "ses-test" })).content);
  assert.equal(result.sessionID, "ses-test");
  assert.equal(result.leadHost, "opencode");
  assert.equal(result.workers.length, 8);
  assert.ok(result.workers.some((worker) => worker.agent === "acp-worker" && worker.target === "acp"));
});

test("V2 before hook ignores other tools", async () => {
  const { hooks } = await host();
  const before = hooks["execute.before"];
  await before({ tool: "read", input: {} });
  await before({ tool: "harnest_handoff_status", input: {} });
  await before({});
});

test("V2 before hook validates event.input, never guessed args", async () => {
  const { hooks } = await host();
  const before = hooks["execute.before"];
  await before({ tool: TOOL, input: { request: validRequest() }, args: {} });
  await assert.rejects(before({ tool: TOOL, input: {}, args: { request: validRequest() } }), /request/);
});

test("V2 before hook denies invalid launches", async () => {
  const { hooks } = await host();
  const before = hooks["execute.before"];
  await assert.rejects(before({ tool: TOOL, input: { request: validRequest({ cwd: "rel" }) } }), /cwd/);
  await assert.rejects(before({ tool: TOOL, input: {} }), /request/);
  await before({ tool: TOOL, input: { request: validRequest({ target: "opencode", route: {} }) } });
  await assert.rejects(
    before({ tool: TOOL, input: { request: validRequest({ target: "opencode", route: { model: 42 } }) } }),
    /route\.model must be a string/,
  );
});

test("V2 before hook handles unknown events but missing launch input is denied", async () => {
  const { hooks } = await host();
  const before = hooks["execute.before"];
  await before(null);
  await before(undefined);
  await before("not-an-object");
  await assert.rejects(before({ tool: TOOL }), /request/);
  await assert.rejects(before({ tool: TOOL, input: null }), /request/);
});

test("all terminal states are extracted from actual MCP text and structured receipts", async () => {
  const { hooks } = await host();
  for (const state of ["completed", "failed", "partial", "cancelled"]) {
    const receipt = { state, jobId: `job-${state}`, requestId: "req", contextDigest: "digest", trace: { eventCount: 3 } };
    for (const result of [
      { content: JSON.stringify(receipt) },
      { content: [{ type: "text", text: JSON.stringify(receipt) }] },
      { structuredContent: { receipt }, content: [{ type: "text", text: JSON.stringify(receipt) }] },
    ]) {
      const content = structuredClone(result.content);
      await hooks["execute.after"]({ tool: "harnest_handoff_result", sessionID: "ses-a", status: "completed", result });
      assert.equal(result.metadata.harnest.state, state);
      assert.deepEqual(result.content, content);
    }
  }
  assert.equal(resultPayload({ content: "not JSON" }), null);
  await hooks["execute.after"]({ tool: TOOL, status: "error", error: { message: "transport failure" } });
  const running = { content: JSON.stringify({ state: "running", jobId: "running" }) };
  await hooks["execute.after"]({ tool: TOOL, status: "completed", result: running });
  assert.equal(running.metadata, undefined);
});

test("compaction recovers persisted identifiers and trace cursor after plugin reload, scoped to session", async () => {
  const first = await host();
  await first.hooks["execute.before"]({ tool: TOOL, sessionID: "ses-a", input: { request: validRequest() } });
  for (let i = 0; i < 4; i++) {
    const receipt = { state: "partial", jobId: `job-${i}`, requestId: `request-${i}`, contextDigest: `digest-${i}`, sessionId: `downstream-${i}`, workflowRunId: `flow-${i}`, trace: { eventCount: 3 } };
    await first.hooks["execute.after"]({ tool: TOOL, sessionID: "ses-a", status: "completed", result: { content: JSON.stringify(receipt) } });
  }
  for (const nextSequence of [37, 12]) await first.hooks["execute.after"]({ tool: "harnest_handoff_trace", sessionID: "ses-a", input: { jobId: "job-0" }, status: "completed", result: { content: JSON.stringify({ jobId: "job-0", nextSequence }) } });
  const second = await host(first.storage);
  const event = { sessionID: "ses-a", system: [] };
  await second.hooks.compaction(event);
  const text = event.system.map(part => part.text).join("\n");
  for (let i = 0; i < 4; i++) for (const value of [`job-${i}`, `request-${i}`, `digest-${i}`, `downstream-${i}`, `flow-${i}`]) assert.ok(text.includes(value), value);
  assert.match(text, /"nextSequence":37/);
  const other = { sessionID: "ses-b", system: [] };
  await second.hooks.compaction(other);
  assert.equal(other.system.length, 1);
});

test("V1 server is separate and validates output.args", async () => {
  assert.equal(plugin.server, HarnestPlugin);
  const legacy = await plugin.server();
  await legacy["tool.execute.before"]({ tool: TOOL }, { args: { request: validRequest() } });
  await assert.rejects(legacy["tool.execute.before"]({ tool: TOOL, args: validRequest() }, { args: {} }), /request/);
  assert.equal(JSON.parse(await legacy.tool.handoff_host_info.execute({}, { sessionID: "v1" })).sessionID, "v1");
});

test("graph identity and every dispatched child survive host compaction", async () => {
  const first = await host();
  const graph = { graphId: "graph-main", requestId: "graph-request", state: "partial", nodes: Array.from({ length: 6 }, (_, index) => ({ id: `step-${index}`, jobId: `graph-child-${index}`, requestId: `child-request-${index}`, state: index === 5 ? "failed" : "completed" })) };
  await first.hooks["execute.after"]({ tool: "harnest_handoff_graph_status", sessionID: "ses-graph", status: "completed", result: { structuredContent: { graph } } });
  const second = await host(first.storage);
  const event = { sessionID: "ses-graph", system: [] };
  await second.hooks.compaction(event);
  const records = event.system.slice(1).map(part => JSON.parse(part.text));
  assert.ok(records.some(record => record.graphId === "graph-main" && record.requestId === "graph-request"));
  for (const node of graph.nodes) assert.ok(records.some(record => record.jobId === node.jobId && record.nodeId === node.id && record.state === node.state));
});

test("concurrent receipt and trace writes cannot erase identity or move the recovery cursor backwards", async () => {
  const { hooks } = await host();
  await Promise.all([
    { tool: TOOL, content: { state: "partial", jobId: "job-race", requestId: "req-race", contextDigest: "digest-race" } },
    { tool: "harnest_handoff_trace", content: { jobId: "job-race", nextSequence: 42 } },
    { tool: "harnest_handoff_trace", content: { jobId: "job-race", nextSequence: 7 } },
  ].map(({ tool, content }) => hooks["execute.after"]({ tool, sessionID: "ses-race", status: "completed", result: { content: JSON.stringify(content) } })));
  const event = { sessionID: "ses-race", system: [] };
  await hooks.compaction(event);
  const saved = JSON.parse(event.system[1].text);
  assert.equal(saved.nextSequence, 42);
  assert.equal(saved.contextDigest, "digest-race");
  assert.equal(saved.requestId, "req-race");
});
