import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { access, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { GeminiAdapter } from "../src/adapters/gemini.mjs";
import { normalizeRequest } from "../src/protocol.mjs";

class FakeStdin extends EventEmitter {
  constructor() {
    super();
    this.text = "";
    this.destroyed = false;
  }

  write(value) {
    this.text += String(value);
    return true;
  }

  end() {
    this.emit("close");
  }

  destroy() {
    this.destroyed = true;
  }
}

class FakeChild extends EventEmitter {
  constructor({ stdout = "", stderr = "", code = 0, hang = false } = {}) {
    super();
    this.killed = false;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdin = new FakeStdin();
    queueMicrotask(() => {
      if (stdout) this.stdout.emit("data", Buffer.from(stdout));
      if (stderr) this.stderr.emit("data", Buffer.from(stderr));
      if (!hang) this.emit("close", code, null);
    });
  }

  kill() {
    if (this.killed) return false;
    this.killed = true;
    queueMicrotask(() => this.emit("close", null, "SIGTERM"));
    return true;
  }
}

function jsonl(events) {
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

function successfulStream({ final = "final answer from Gemini", sessionId = "11111111-1111-4111-8111-111111111111", model = "gemini-2.5-pro" } = {}) {
  return jsonl([
    { type: "init", timestamp: "2026-10-03T00:00:00Z", session_id: sessionId, model },
    { type: "message", timestamp: "2026-10-03T00:00:01Z", role: "assistant", content: "final answer ", delta: true },
    { type: "tool_use", timestamp: "2026-10-03T00:00:02Z", tool_name: "read_file", tool_id: "tool-1", parameters: { path: "private.txt" } },
    { type: "tool_result", timestamp: "2026-10-03T00:00:03Z", tool_id: "tool-1", status: "success", output: "private tool output" },
    { type: "message", timestamp: "2026-10-03T00:00:04Z", role: "assistant", content: final.replace(/^final answer /, ""), delta: true },
    { type: "result", timestamp: "2026-10-03T00:00:05Z", status: "success", stats: { total_tokens: 19, input_tokens: 12, output_tokens: 7, cached: 3, duration_ms: 25, tool_calls: 1 } },
  ]);
}

function request(overrides = {}) {
  return normalizeRequest({
    target: "gemini",
    requestId: "req-gemini-001",
    task: "Return the handoff result.",
    cwd: process.cwd(),
    context: { source: "deterministic-test" },
    policy: { write: false, tools: [], maxCostUsd: null },
    ...overrides,
  });
}

function fakePolicy() {
  return {
    async prepare({ policy }) {
      return {
        args: ["--approval-mode", "default", "--policy", "C:/isolated/gemini-policy.toml"],
        env: { GEMINI_CLI_SYSTEM_SETTINGS_PATH: "C:/isolated/settings.json" },
        diagnostics: {
          effectivePolicy: { write: Boolean(policy?.write), mode: policy?.write ? "write-policy" : "read-only-policy" },
          launchFlags: ["--approval-mode", "default", "--policy", "<isolated-policy>"],
        },
        async cleanup() {},
      };
    },
  };
}

test("Gemini adds canonical directories under the read-only policy", async () => {
  const dirs = [await realpath(process.cwd()), await realpath("docs")];
  let argv;
  const adapter = new GeminiAdapter({
    command: "fake-gemini",
    policyPreparer: fakePolicy(),
    spawnFn(_command, args) {
      argv = args;
      return new FakeChild({ stdout: successfulStream() });
    },
  });
  const output = await adapter.run(request({ execution: { addDirs: dirs } }));
  assert.deepEqual(argv.slice(-4), ["--include-directories", dirs[0], "--include-directories", dirs[1]]);
  assert.equal(output.execution.effectivePolicy.write, false);
});

test("Gemini streams a native terminal result and sends the prompt through stdin", async () => {
  const calls = [];
  const progress = [];
  const adapter = new GeminiAdapter({
    command: "fake-gemini",
    policyPreparer: fakePolicy(),
    spawnFn(command, args, options) {
      const child = new FakeChild({ stdout: successfulStream() });
      calls.push({ command, args, options, child });
      return child;
    },
  });

  const output = await adapter.run(request(), { onProgress: async (event) => progress.push(event) });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "fake-gemini");
  assert.deepEqual(calls[0].args.slice(0, 4), ["--approval-mode", "default", "--policy", "C:/isolated/gemini-policy.toml"]);
  assert.ok(calls[0].args.includes("-p"));
  assert.equal(calls[0].args[calls[0].args.indexOf("-p") + 1], "", "-p selects native headless mode while stdin carries the prompt");
  assert.ok(calls[0].args.includes("--output-format") && calls[0].args.includes("stream-json"));
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.cwd, process.cwd());
  assert.match(calls[0].child.stdin.text, /req-gemini-001/);
  assert.match(calls[0].child.stdin.text, /Return the handoff result/);
  assert.equal(output.sessionId, "11111111-1111-4111-8111-111111111111");
  assert.equal(output.workflowRunId, "gemini:req-gemini-001");
  assert.equal(output.route.harness, "gemini");
  assert.equal(output.route.model, "gemini-2.5-pro");
  assert.equal(output.result.finalText, "final answer from Gemini");
  assert.deepEqual(output.usage, { totalTokens: 19, inputTokens: 12, outputTokens: 7, cacheReadTokens: 3, durationMs: 25, toolCalls: 1 });
  assert.deepEqual(output.execution, fakePolicy().prepare ? {
    effectivePolicy: { write: false, mode: "read-only-policy" },
    launchFlags: ["--approval-mode", "default", "--policy", "<isolated-policy>", "-p", "--output-format", "stream-json"],
  } : null);
  assert.ok(progress.some((event) => event.type === "gemini_delta"));
  assert.ok(progress.some((event) => event.type === "gemini_tool" && event.phase === "started" && event.tool === "read_file"));
  assert.ok(progress.some((event) => event.type === "gemini_tool" && event.phase === "completed"));
  assert.doesNotMatch(JSON.stringify(progress), /private\.txt|private tool output/);
});

test("Gemini keeps stable context before task and identifiers in the stdin envelope", async () => {
  const calls = [];
  const adapter = new GeminiAdapter({
    command: "fake-gemini",
    policyPreparer: fakePolicy(),
    spawnFn(command, args, options) {
      const child = new FakeChild({ stdout: successfulStream({ final: "ordered" }) });
      calls.push({ command, args, options, child });
      return child;
    },
  });

  await adapter.run(request());
  const prompt = calls[0].child.stdin.text;
  const context = prompt.indexOf('"context"');
  const task = prompt.indexOf("TASK\n");
  const requestId = prompt.indexOf('"requestId"');
  assert.ok(context >= 0 && context < requestId && requestId < task);
  assert.ok(prompt.indexOf("req-gemini-001") > context);
});

test("Gemini honors an explicit model and resumes only a UUID session", async () => {
  const calls = [];
  const prior = "22222222-2222-4222-8222-222222222222";
  const adapter = new GeminiAdapter({
    command: "fake-gemini",
    policyPreparer: fakePolicy(),
    spawnFn(command, args, options) {
      const child = new FakeChild({ stdout: successfulStream({ final: "resumed", sessionId: prior, model: "gemini-2.5-flash" }) });
      calls.push({ command, args, options, child });
      return child;
    },
  });

  const output = await adapter.run(request({ route: { provider: "google", model: "gemini-2.5-flash" }, execution: { sessionId: prior } }));
  assert.deepEqual(calls[0].args.slice(-4), ["--resume", prior, "--model", "gemini-2.5-flash"]);
  assert.equal(output.sessionId, prior);
  assert.equal(output.route.model, "gemini-2.5-flash");

  await assert.rejects(
    adapter.run(request({ requestId: "req-gemini-bad-session", execution: { sessionId: "latest" } })),
    (error) => error.details?.kind === "policy" && /UUID/.test(error.message),
  );
  assert.equal(calls.length, 1, "invalid resume is rejected before launch");
});

test("Gemini accepts both canonical Google provider aliases without provider argv", async () => {
  const calls = [];
  const adapter = new GeminiAdapter({
    command: "fake-gemini",
    policyPreparer: fakePolicy(),
    spawnFn(command, args, options) {
      const child = new FakeChild({ stdout: successfulStream() });
      calls.push({ command, args, options, child });
      return child;
    },
  });

  for (const provider of ["google", "google/gemini"]) {
    const output = await adapter.run(request({ requestId: `req-gemini-provider-${provider.replace("/", "-")}`, route: { provider, model: "gemini-2.5-pro" } }));
    assert.equal(output.route.provider, provider);
  }
  assert.equal(calls.length, 2);
  assert.equal(calls.every(({ args }) => !args.includes("--provider")), true);
});

test("Gemini rejects a native init session that conflicts with the requested resume identity", async () => {
  const requestedSessionId = "22222222-2222-4222-8222-222222222222";
  const observedSessionId = "33333333-3333-4333-8333-333333333333";
  const adapter = new GeminiAdapter({
    command: "fake-gemini",
    policyPreparer: fakePolicy(),
    spawnFn() {
      return new FakeChild({ stdout: successfulStream({ sessionId: observedSessionId, final: "wrong continuation" }) });
    },
  });

  await assert.rejects(
    adapter.run(request({ requestId: "req-gemini-session-mismatch", execution: { sessionId: requestedSessionId } })),
    (error) => error.details?.kind === "downstream"
      && error.details?.reason === "session-mismatch"
      && error.details?.sessionId === requestedSessionId
      && error.details?.requestedSessionId === requestedSessionId
      && error.details?.observedSessionId === observedSessionId,
  );
});

test("Gemini rejects unsupported workflow, route, tools, budget, thinking, and session transport before launch", async () => {
  let launches = 0;
  const adapter = new GeminiAdapter({
    command: "fake-gemini",
    policyPreparer: fakePolicy(),
    spawnFn() { launches += 1; return new FakeChild({ stdout: successfulStream() }); },
  });
  const rejected = [
    request({ requestId: "req-gemini-workflow", workflow: { spec: "x" } }),
    request({ requestId: "req-gemini-provider", route: { provider: "anthropic", model: "gemini-2.5-pro" } }),
    request({ requestId: "req-gemini-model", route: { model: "claude-opus" } }),
    request({ requestId: "req-gemini-tools", policy: { write: false, tools: ["read"] } }),
    request({ requestId: "req-gemini-unknown-deny", policy: { tools: { deny: ["unknown"] } } }),
    request({ requestId: "req-gemini-unknown-allow", policy: { tools: { allow: ["unknown"] } } }),
    request({ requestId: "req-gemini-budget", policy: { write: false, maxCostUsd: 1 } }),
    request({ requestId: "req-gemini-thinking", route: { model: "gemini-2.5-pro", thinking: "high" } }),
  ];
  for (const value of rejected) {
    await assert.rejects(adapter.run(value), (error) => error.details?.kind === "policy");
  }
  await assert.rejects(
    adapter.run({ ...request({ requestId: "req-gemini-session" }), execution: { timeoutMs: 1000, sessionId: null, transport: "session" } }),
    (error) => error.details?.kind === "policy" && /transport/.test(error.message),
  );
  assert.equal(launches, 0);
});

test("Gemini applies the same narrowed list to native settings and the admin policy", async (t) => {
  const systemPoliciesDir = await mkdtemp(join(tmpdir(), "harnest-gemini-filter-"));
  t.after(() => rm(systemPoliciesDir, { recursive: true, force: true }));
  const extraDir = await realpath("docs");
  const calls = [];
  const adapter = new GeminiAdapter({
    command: "fake-gemini",
    policyOptions: { systemPoliciesDir },
    spawnFn(_command, args, { env }) {
      calls.push(args);
      if (args[0] === "--version") return new FakeChild({ stdout: "0.62.0\n" });
      const root = dirname(env.GEMINI_CLI_SYSTEM_SETTINGS_PATH);
      const admin = join(root, "admin-policy");
      assert.deepEqual(args, [
        "--approval-mode", "default", "--admin-policy", admin, "--policy", join(root, "user-policy"),
        "--extensions", "none", "-p", "", "--output-format", "stream-json",
        "--include-directories", extraDir,
      ]);
      const settings = JSON.parse(readFileSync(env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, "utf8"));
      const rules = readFileSync(join(admin, "harnest.toml"), "utf8");
      assert.deepEqual(settings.tools.core, ["read_file"]);
      assert.match(rules, /toolName = \[\s*"read_file",\s*\][\s\S]*decision = "allow"/);
      assert.match(rules, /toolName = "\*"[\s\S]*decision = "deny"/);
      assert.doesNotMatch(rules, /"glob"|"run_shell_command"|"write_file"/);
      return new FakeChild({ stdout: successfulStream() });
    },
  });
  await adapter.run(request({
    execution: { addDirs: [extraDir] },
    policy: { write: false, tools: { allow: ["read_file", "glob", "run_shell_command", "write_file"], deny: ["glob"] } },
  }));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], ["--version"]);
});

test("Gemini requires a successful native terminal and nonempty assistant final text", async () => {
  const streams = [
    jsonl([{ type: "init", session_id: "11111111-1111-4111-8111-111111111111", model: "gemini-2.5-pro" }, { type: "message", role: "assistant", content: "partial", delta: true }]),
    jsonl([{ type: "init", session_id: "11111111-1111-4111-8111-111111111111", model: "gemini-2.5-pro" }, { type: "result", status: "success", stats: {} }]),
    jsonl([{ type: "init", session_id: "11111111-1111-4111-8111-111111111111", model: "gemini-2.5-pro" }, { type: "message", role: "assistant", content: "partial", delta: true }, { type: "result", status: "error", stats: { input_tokens: 2 } }]),
  ];
  const adapter = new GeminiAdapter({
    command: "fake-gemini",
    policyPreparer: fakePolicy(),
    spawnFn() { return new FakeChild({ stdout: streams.shift() }); },
  });
  await assert.rejects(adapter.run(request({ requestId: "req-gemini-missing-terminal" })), (error) => error.details?.kind === "downstream" && /result event/.test(error.message));
  await assert.rejects(adapter.run(request({ requestId: "req-gemini-empty" })), (error) => error.details?.kind === "downstream" && /empty/.test(error.message));
  await assert.rejects(adapter.run(request({ requestId: "req-gemini-error-result" })), (error) => error.details?.kind === "downstream" && error.details?.usage?.inputTokens === 2);
});

test("Gemini requires exactly one complete native init event", async () => {
  const streams = [
    jsonl([
      { type: "message", role: "assistant", content: "answer", delta: true },
      { type: "result", status: "success", stats: {} },
    ]),
    jsonl([
      { type: "init", session_id: "11111111-1111-4111-8111-111111111111", model: "gemini-2.5-pro" },
      { type: "init", session_id: "22222222-2222-4222-8222-222222222222", model: "gemini-2.5-flash" },
      { type: "message", role: "assistant", content: "answer", delta: true },
      { type: "result", status: "success", stats: {} },
    ]),
    jsonl([
      { type: "init", session_id: "11111111-1111-4111-8111-111111111111" },
      { type: "message", role: "assistant", content: "answer", delta: true },
      { type: "result", status: "success", stats: {} },
    ]),
  ];
  const adapter = new GeminiAdapter({ command: "fake-gemini", policyPreparer: fakePolicy(), spawnFn() { return new FakeChild({ stdout: streams.shift() }); } });
  await assert.rejects(adapter.run(request({ requestId: "req-gemini-no-init" })), (error) => error.details?.kind === "downstream" && /init/.test(error.message));
  await assert.rejects(adapter.run(request({ requestId: "req-gemini-duplicate-init" })), (error) => {
    assert.equal(error.details?.kind, "downstream");
    assert.match(error.message, /duplicate init/);
    assert.equal(error.details?.sessionId, "11111111-1111-4111-8111-111111111111", "the first observed identity survives");
    assert.equal(error.details?.model, "gemini-2.5-pro");
    return true;
  });
  await assert.rejects(adapter.run(request({ requestId: "req-gemini-incomplete-init" })), (error) => error.details?.kind === "downstream" && /incomplete init/.test(error.message));
});

test("Gemini treats null, boolean, and numeric-string stats as unreported", async () => {
  const adapter = new GeminiAdapter({
    command: "fake-gemini",
    policyPreparer: fakePolicy(),
    spawnFn() {
      return new FakeChild({ stdout: jsonl([
        { type: "init", session_id: "11111111-1111-4111-8111-111111111111", model: "gemini-2.5-pro" },
        { type: "message", role: "assistant", content: "answer", delta: true },
        { type: "result", status: "success", stats: { total_tokens: null, input_tokens: "12", output_tokens: false, cached: 0 } },
      ]) });
    },
  });
  const output = await adapter.run(request({ requestId: "req-gemini-usage-types" }));
  assert.deepEqual(output.usage, {
    totalTokens: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: 0,
    durationMs: null,
    toolCalls: null,
  });
});

test("Gemini redacts assistant credentials before progress persistence", async () => {
  const progress = [];
  const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz";
  const adapter = new GeminiAdapter({
    command: "fake-gemini",
    policyPreparer: fakePolicy(),
    spawnFn() { return new FakeChild({ stdout: successfulStream({ final: secret }) }); },
  });
  await adapter.run(request({ requestId: "req-gemini-redacted-progress" }), { onProgress: (event) => progress.push(event) });
  assert.doesNotMatch(JSON.stringify(progress), new RegExp(secret));
  assert.match(JSON.stringify(progress), /\[REDACTED\]/);
});

test("Gemini redacts credentials across structured and long plaintext completed results", async () => {
  const structuredSecret = "sk-proj-structured-result-secret";
  const plaintextSecret = "ghp_plaintextresultsecret1234567890";
  const structured = JSON.stringify({
    finalText: `normal final ${structuredSecret}`,
    summary: `normal summary ${structuredSecret}`,
    evidence: [`normal evidence ${structuredSecret}`],
    tests: [`normal test ${structuredSecret}`],
    risks: [`normal risk ${structuredSecret}`],
  });
  const plaintext = `${"x".repeat(5_000)} ${plaintextSecret} normal tail`;
  const streams = [structured, plaintext].map((content) => jsonl([
    { type: "init", session_id: "11111111-1111-4111-8111-111111111111", model: "gemini-2.5-pro" },
    { type: "message", role: "assistant", content, delta: true },
    { type: "result", status: "success", stats: {} },
  ]));
  const adapter = new GeminiAdapter({
    command: "fake-gemini",
    policyPreparer: fakePolicy(),
    spawnFn() { return new FakeChild({ stdout: streams.shift() }); },
  });

  const structuredOutput = await adapter.run(request({ requestId: "req-gemini-redacted-structured-result" }));
  assert.doesNotMatch(JSON.stringify(structuredOutput.result), new RegExp(structuredSecret));
  assert.deepEqual(structuredOutput.result, {
    eventSummary: { count: 3, types: ["init", "message", "result"] },
    finalText: "normal final [REDACTED]",
    summary: "normal summary [REDACTED]",
    evidence: ["normal evidence [REDACTED]"],
    tests: ["normal test [REDACTED]"],
    risks: ["normal risk [REDACTED]"],
  });

  const plaintextOutput = await adapter.run(request({ requestId: "req-gemini-redacted-plaintext-result" }));
  assert.doesNotMatch(JSON.stringify(plaintextOutput.result), new RegExp(plaintextSecret));
  assert.match(plaintextOutput.result.finalText, /\[REDACTED\] normal tail$/);
  assert.ok(plaintextOutput.result.finalText.length > 4_000, "completed result redaction does not apply the 4,000-character diagnostic bound");
});

test("Gemini redacts retained process diagnostics on failure", async () => {
  const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz";
  const adapter = new GeminiAdapter({
    command: "fake-gemini",
    policyPreparer: fakePolicy(),
    spawnFn() {
      return new FakeChild({
        stdout: jsonl([{ type: "init", session_id: "11111111-1111-4111-8111-111111111111", model: "gemini-2.5-pro" }]),
        stderr: `unexpected child diagnostic carried ${secret}\n`,
        code: 1,
      });
    },
  });
  await assert.rejects(adapter.run(request({ requestId: "req-gemini-diagnostic-redaction" })), (error) => {
    const serialized = JSON.stringify({ message: error.message, details: error.details });
    assert.doesNotMatch(serialized, new RegExp(secret));
    assert.match(serialized, /\[REDACTED\]/);
    return true;
  });
});

test("Gemini classifies provider failures and preserves observed identity and usage", async () => {
  const adapter = new GeminiAdapter({
    command: "fake-gemini",
    policyPreparer: fakePolicy(),
    spawnFn() {
      return new FakeChild({
        stdout: jsonl([
          { type: "init", session_id: "33333333-3333-4333-8333-333333333333", model: "gemini-void" },
          { type: "error", severity: "error", message: "model gemini-void not found" },
          { type: "result", status: "error", stats: { input_tokens: 4, output_tokens: 0 } },
        ]),
        code: 1,
      });
    },
  });
  await assert.rejects(adapter.run(request({ requestId: "req-gemini-unavailable", route: { model: "gemini-void" } })), (error) => {
    assert.equal(error.details?.kind, "unavailable");
    assert.equal(error.details?.sessionId, "33333333-3333-4333-8333-333333333333");
    assert.equal(error.details?.model, "gemini-void");
    assert.equal(error.details?.usage?.inputTokens, 4);
    return true;
  });
});

test("Gemini awaits progress backpressure and maps abort and timeout distinctly", async () => {
  const order = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const backpressure = new GeminiAdapter({
    command: "fake-gemini",
    policyPreparer: fakePolicy(),
    spawnFn() { return new FakeChild({ stdout: successfulStream({ final: "backpressured" }) }); },
  });
  const pending = backpressure.run(request({ requestId: "req-gemini-backpressure" }), {
    onProgress: async (event) => {
      if (event.type !== "gemini_delta") return;
      order.push("start");
      await gate;
      order.push("done");
    },
  }).then(() => order.push("resolved"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["start", "start"], "the bounded callback batch starts before stdout resumes");
  release();
  await pending;
  assert.deepEqual(order, ["start", "start", "done", "done", "resolved"]);

  const aborting = new GeminiAdapter({ command: "fake-gemini", policyPreparer: fakePolicy(), spawnFn() { return new FakeChild({ hang: true }); } });
  const controller = new AbortController();
  const aborted = aborting.run(request({ requestId: "req-gemini-abort", execution: { timeoutMs: 1000 } }), { signal: controller.signal });
  controller.abort();
  await assert.rejects(aborted, (error) => error.details?.kind === "abort" && error.details?.aborted === true);

  const timingOut = new GeminiAdapter({ command: "fake-gemini", policyPreparer: fakePolicy(), spawnFn() { return new FakeChild({ hang: true }); } });
  await assert.rejects(
    timingOut.run(request({ requestId: "req-gemini-timeout", execution: { timeoutMs: 5 } })),
    (error) => error.details?.kind === "timeout" && error.details?.timedOut === true,
  );
});

test("Gemini cleans isolated policy state and fails closed when policy preparation fails", async () => {
  let cleaned = 0;
  let launches = 0;
  const adapter = new GeminiAdapter({
    command: "fake-gemini",
    policyPreparer: {
      async prepare() {
        return { args: [], env: {}, diagnostics: { effectivePolicy: { write: false, mode: "fixture" }, launchFlags: [] }, async cleanup() { cleaned += 1; } };
      },
    },
    spawnFn() { launches += 1; return new FakeChild({ stdout: successfulStream() }); },
  });
  await adapter.run(request({ requestId: "req-gemini-cleanup" }));
  assert.equal(cleaned, 1);

  const closed = new GeminiAdapter({
    command: "fake-gemini",
    policyPreparer: { async prepare() { throw Object.assign(new Error("native policy cannot be enforced"), { details: { kind: "policy" } }); } },
    spawnFn() { launches += 1; return new FakeChild({ stdout: successfulStream() }); },
  });
  await assert.rejects(closed.run(request({ requestId: "req-gemini-policy-fail" })), (error) => error.details?.kind === "policy");
  assert.equal(launches, 1, "failed policy preparation prevents inference");
});

test("Gemini default policy integration isolates settings, preserves auth home, and removes IDE workspace injection", async (t) => {
  const systemPoliciesDir = await mkdtemp(join(tmpdir(), "gemini-adapter-system-policy-"));
  t.after(() => rm(systemPoliciesDir, { recursive: true, force: true }));
  const calls = [];
  const key = "GEMINI_CLI_IDE_WORKSPACE_PATH";
  const saved = process.env[key];
  process.env[key] = "C:/outside-workspace";
  try {
    const adapter = new GeminiAdapter({
      command: "fake-gemini",
      policyOptions: {
        systemPoliciesDir,
        versionProbe: async () => "0.62.0",
      },
      spawnFn(command, args, options) {
        const child = new FakeChild({ stdout: successfulStream({ final: "isolated" }) });
        calls.push({ command, args, options, child });
        return child;
      },
    });
    const output = await adapter.run(request({ requestId: "req-gemini-default-policy" }));
    assert.equal(output.result.finalText, "final answer isolated");
  } finally {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }

  assert.equal(calls.length, 1);
  assert.ok(calls[0].args.includes("--admin-policy"));
  assert.ok(calls[0].args.includes("--extensions") && calls[0].args.includes("none"));
  assert.equal(calls[0].options.env[key], undefined, "IDE workspace injection is absent from the child environment");
  for (const homeKey of ["HOME", "USERPROFILE"]) {
    if (process.env[homeKey] !== undefined) assert.equal(calls[0].options.env[homeKey], process.env[homeKey], `${homeKey} remains available for native auth`);
  }
  const settingsPath = calls[0].options.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
  const defaultsPath = calls[0].options.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH;
  await assert.rejects(access(settingsPath), (error) => error.code === "ENOENT");
  await assert.rejects(access(defaultsPath), (error) => error.code === "ENOENT");
});

test("Gemini bounds accumulated assistant output and failure event metadata", async () => {
  const oversized = "x".repeat(1024 * 1024 + 1);
  const adapter = new GeminiAdapter({
    command: "fake-gemini",
    policyPreparer: fakePolicy(),
    spawnFn() {
      return new FakeChild({
        stdout: jsonl([
          { type: "init", session_id: "11111111-1111-4111-8111-111111111111", model: "gemini-2.5-pro" },
          { type: "message", role: "assistant", content: oversized, delta: true },
          { type: "result", status: "success", stats: { input_tokens: 1, output_tokens: 1 } },
        ]),
      });
    },
  });
  await assert.rejects(adapter.run(request({ requestId: "req-gemini-oversized" })), (error) => {
    assert.equal(error.details?.kind, "output-limit");
    assert.equal(error.details?.maxAssistantChars, 1024 * 1024);
    assert.deepEqual(error.details?.eventSummary.types, ["init", "message", "result"]);
    assert.equal(error.details?.usage?.inputTokens, 1);
    return true;
  });
});

test("Gemini preserves typed preflight failures and does no work for an already-aborted request", async () => {
  let prepares = 0;
  const unavailable = new GeminiAdapter({
    command: "fake-gemini",
    policyPreparer: {
      async prepare() {
        prepares += 1;
        throw Object.assign(new Error("unsupported native version"), { details: { kind: "unavailable", reason: "unsupported-version" } });
      },
    },
  });
  await assert.rejects(unavailable.run(request({ requestId: "req-gemini-version" })), (error) => error.details?.kind === "unavailable");

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    unavailable.run(request({ requestId: "req-gemini-already-aborted" }), { signal: controller.signal }),
    (error) => error.details?.kind === "abort" && error.details?.aborted === true,
  );
  assert.equal(prepares, 1, "the already-aborted request never starts policy/version preflight");
});

test("Gemini owned timeout includes asynchronous policy and version preflight", async () => {
  let cleaned = 0;
  let spawned = 0;
  let receivedSignal = null;
  let resolvePreparation;
  let markPreparationStarted;
  let markCleaned;
  const preparationStarted = new Promise((resolve) => { markPreparationStarted = resolve; });
  const cleanupComplete = new Promise((resolve) => { markCleaned = resolve; });
  const adapter = new GeminiAdapter({
    command: "fake-gemini",
    policyPreparer: {
      async prepare({ signal }) {
        receivedSignal = signal;
        markPreparationStarted();
        return new Promise((resolve) => { resolvePreparation = () => resolve({
          args: [],
          env: {},
          diagnostics: { effectivePolicy: { write: false, mode: "fixture" }, launchFlags: [] },
          async cleanup() { cleaned += 1; markCleaned(); },
        }); });
      },
    },
    spawnFn() { spawned += 1; return new FakeChild({ stdout: successfulStream() }); },
  });
  const running = adapter.run(request({ requestId: "req-gemini-preflight-timeout", execution: { timeoutMs: 5 } }));
  await preparationStarted;
  await assert.rejects(
    running,
    (error) => error.details?.kind === "timeout" && error.details?.timedOut === true,
  );
  assert.ok(receivedSignal instanceof AbortSignal);
  assert.equal(receivedSignal.aborted, true);
  assert.equal(spawned, 0, "inference never starts after the owned deadline expires during preflight");
  resolvePreparation();
  await cleanupComplete;
  assert.equal(cleaned, 1);
});

test("Gemini owns timeout and abort when policy preparation never settles", async () => {
  const outcomes = [];
  for (const mode of ["timeout", "abort"]) {
    let seenSignal = null;
    let markStarted;
    const started = new Promise((resolve) => { markStarted = resolve; });
    let spawns = 0;
    const adapter = new GeminiAdapter({
      command: "fake-gemini",
      policyPreparer: ({ signal }) => {
        seenSignal = signal;
        markStarted();
        return new Promise(() => {});
      },
      spawnFn() { spawns += 1; return new FakeChild({ stdout: successfulStream() }); },
    });
    const controller = new AbortController();
    const running = adapter.run(
      request({ requestId: `req-gemini-pending-preparation-${mode}`, execution: { timeoutMs: mode === "timeout" ? 10 : 1_000 } }),
      { signal: controller.signal },
    ).then(
      () => "resolved",
      (error) => error.details?.kind || "unknown-error",
    );
    await started;
    if (mode === "abort") controller.abort();
    outcomes.push(await Promise.race([
      running,
      new Promise((resolve) => setTimeout(() => resolve("pending"), 80)),
    ]));
    assert.ok(seenSignal instanceof AbortSignal);
    assert.equal(seenSignal.aborted, true);
    assert.equal(spawns, 0);
  }
  assert.deepEqual(outcomes, ["timeout", "abort"]);
});

test("Gemini cleans a policy candidate that resolves after preparation cancellation", async () => {
  const earlyOutcomes = [];
  for (const mode of ["timeout", "abort"]) {
    let resolvePreparation;
    let markStarted;
    const started = new Promise((resolve) => { markStarted = resolve; });
    let cleaned = 0;
    const candidate = {
      args: [],
      env: {},
      diagnostics: { effectivePolicy: { write: false, mode: "late-fixture" }, launchFlags: [] },
      async cleanup() { cleaned += 1; },
    };
    const adapter = new GeminiAdapter({
      command: "fake-gemini",
      policyPreparer: () => {
        markStarted();
        return new Promise((resolve) => { resolvePreparation = () => resolve(candidate); });
      },
      spawnFn() { throw new Error("inference must not start after preparation cancellation"); },
    });
    const controller = new AbortController();
    const running = adapter.run(
      request({ requestId: `req-gemini-late-preparation-${mode}`, execution: { timeoutMs: mode === "timeout" ? 10 : 1_000 } }),
      { signal: controller.signal },
    ).then(
      () => "resolved",
      (error) => error.details?.kind || "unknown-error",
    );
    await started;
    if (mode === "abort") controller.abort();
    const early = await Promise.race([
      running,
      new Promise((resolve) => setTimeout(() => resolve("pending"), 80)),
    ]);
    earlyOutcomes.push(early);
    resolvePreparation();
    assert.equal(await running, mode);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cleaned, 1, "late policy preparation is cleaned exactly once");
  }
  assert.deepEqual(earlyOutcomes, ["timeout", "abort"]);
});

test("Gemini maps an owned deadline that aborts the native version process to timeout and cleans isolation", async () => {
  const systemPoliciesDir = "C:\\virtual\\gemini-system-policies";
  const policyRoot = "C:\\virtual\\gemini-version-timeout";
  const files = new Map();
  const removedRoots = [];
  const fsApi = {
    async readdir(path) {
      assert.equal(path, systemPoliciesDir);
      return [];
    },
    async mkdtemp() {
      return policyRoot;
    },
    async mkdir() {},
    async writeFile(path, value) {
      files.set(path, String(value));
    },
    async rm(path) {
      removedRoots.push(path);
      for (const file of files.keys()) {
        if (file.startsWith(path)) files.delete(file);
      }
    },
  };
  let settingsPath;
  let spawns = 0;
  let versionChild;
  let markVersionStarted;
  const versionStarted = new Promise((resolve) => { markVersionStarted = resolve; });
  const adapter = new GeminiAdapter({
    command: "fake-gemini",
    policyOptions: { systemPoliciesDir, fsApi },
    spawnFn(_command, args, options) {
      spawns += 1;
      assert.deepEqual(args, ["--version"]);
      settingsPath = options.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
      assert.equal(files.has(settingsPath), true, "isolated settings exist before the version subprocess starts");
      versionChild = new FakeChild({ hang: true });
      markVersionStarted();
      return versionChild;
    },
  });
  const running = adapter.run(request({ requestId: "req-gemini-native-version-timeout", execution: { timeoutMs: 100 } }));
  await Promise.race([
    versionStarted,
    new Promise((_, reject) => setTimeout(() => reject(new Error("version subprocess did not start before the test barrier")), 50)),
  ]);
  await assert.rejects(
    running,
    (error) => error.details?.kind === "timeout" && error.details?.timedOut === true,
  );
  assert.equal(spawns, 1);
  assert.equal(versionChild.killed, true, "the owned deadline terminates the in-flight version subprocess");
  assert.ok(settingsPath);
  assert.deepEqual(removedRoots, [policyRoot]);
  assert.equal(files.size, 0, "isolated policy files are removed after the timed-out version probe");
});

test("Gemini control fails closed as unsupported-control", async () => {
  const adapter = new GeminiAdapter({ command: "fake-gemini", policyPreparer: fakePolicy() });
  await assert.rejects(adapter.control({ kind: "message", message: "continue" }), (error) => error.details?.kind === "unsupported-control");
});
