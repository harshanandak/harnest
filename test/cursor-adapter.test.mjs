import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { CursorAdapter } from "../src/adapters/cursor.mjs";
import { harnessLaunch } from "../src/config.mjs";
import { createAdapter } from "../src/adapters/index.mjs";
import { normalizeRequest } from "../src/protocol.mjs";

class FakeChild extends EventEmitter {
  constructor({ stdout = "", stderr = "", code = 0, hang = false } = {}) {
    super();
    this.killed = false;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdin = { write() {}, end() {} };
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

function streamJsonResult(result, sessionId = "cursor-session-1", usage = { inputTokens: 10, outputTokens: 5 }) {
  const lines = [
    JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, model: "composer-2.5" }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "working" }] } }),
    JSON.stringify({ type: "result", subtype: "success", result, session_id: sessionId, usage }),
  ];
  return `${lines.join("\n")}\n`;
}

function request(overrides = {}) {
  return normalizeRequest({
    target: "cursor",
    requestId: "req-cursor-001",
    task: "Return the handoff result.",
    cwd: process.cwd(),
    context: { source: "deterministic-test" },
    policy: { write: false, tools: [], maxCostUsd: null },
    ...overrides,
  });
}

test("createAdapter supports cursor target", () => {
  const adapter = createAdapter("cursor", { cursor: { command: "fake-cursor" } });
  assert.ok(adapter instanceof CursorAdapter);
});

test("harnessLaunch supports cursor via env and default", () => {
  const launch = harnessLaunch("cursor", "fake-cursor");
  assert.equal(launch.command, "fake-cursor");
  const def = harnessLaunch("cursor");
  assert.ok(typeof def.command === "string" && def.command.length > 0);
});

test("Cursor adapter maps read-only to --mode ask with trust/print/stream-json", async () => {
  const calls = [];
  const adapter = new CursorAdapter({
    command: "fake-cursor",
    spawnFn(command, args, options) {
      calls.push({ command, args, options });
      return new FakeChild({ stdout: streamJsonResult("final answer from Cursor") });
    },
  });
  const output = await adapter.run(request());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "fake-cursor");
  const args = calls[0].args;
  assert.ok(args.includes("--trust"));
  assert.ok(args.includes("-p"));
  assert.ok(args.includes("stream-json"));
  assert.ok(args.includes("--stream-partial-output"));
  assert.ok(args.includes("--mode") && args.includes("ask"));
  assert.ok(!args.includes("--force"), "read-only must not pass --force");
  assert.ok(args.includes("--workspace"));
  const prompt = args.at(-1);
  assert.match(prompt, /req-cursor-001/);
  assert.match(prompt, /Return the handoff result/);
  assert.equal(output.sessionId, "cursor-session-1");
  assert.equal(output.workflowRunId, "cursor:req-cursor-001");
  assert.equal(output.route.harness, "cursor");
  assert.equal(output.result.finalText, "final answer from Cursor");
  assert.equal(output.usage.inputTokens, 10);
  assert.deepEqual(output.execution, {
    effectivePolicy: { write: false, mode: "ask" },
    launchFlags: ["--trust", "-p", "--output-format", "stream-json", "--stream-partial-output", "--mode", "ask", "--workspace"],
  });
  assert.doesNotMatch(JSON.stringify(output.execution), /req-cursor-001|Return the handoff result|deterministic-test/);
});

test("Cursor prompt orders the stable context before the task and identifiers", async () => {
  const calls = [];
  const adapter = new CursorAdapter({
    command: "fake-cursor",
    spawnFn(command, args, options) {
      calls.push({ command, args, options });
      return new FakeChild({ stdout: streamJsonResult("ordered") });
    },
  });
  await adapter.run(request());
  const prompt = calls[0].args.at(-1);
  const contextIndex = prompt.indexOf('"context"');
  const taskIndex = prompt.indexOf('"task"');
  const requestIdIndex = prompt.indexOf('"requestId"');
  const routeIndex = prompt.indexOf('"route"');
  assert.ok(contextIndex >= 0 && contextIndex < taskIndex, "context precedes the variable task");
  assert.ok(taskIndex < requestIdIndex, "requestId follows the task");
  assert.ok(requestIdIndex < routeIndex, "route stays at the tail");
  assert.ok(prompt.indexOf("req-cursor-001") > contextIndex, "no request id precedes the stable prefix");
});

test("Cursor reports cache metrics without collapsing unreported fields to zero", async () => {
  const adapter = new CursorAdapter({
    command: "fake-cursor",
    spawnFn() {
      return new FakeChild({
        stdout: streamJsonResult("cached", "cursor-cache-1", {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 2,
          cacheWriteTokens: 1,
        }),
      });
    },
  });
  const output = await adapter.run(request());
  assert.deepEqual(output.usage, {
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 2,
    cacheWriteTokens: 1,
  });
  assert.deepEqual(output.usageSummary, {
    inputTokens: null,
    uncachedInputTokens: null,
    inputSemantics: "unknown",
    outputTokens: 5,
    cacheReadTokens: 2,
    cacheWriteTokens: 1,
    costUsd: null,
  });
});

test("Cursor adapter maps write to default mode with --force and no ask", async () => {
  const calls = [];
  const adapter = new CursorAdapter({
    command: "fake-cursor",
    spawnFn(command, args) {
      calls.push({ command, args });
      return new FakeChild({ stdout: streamJsonResult("edited") });
    },
  });
  const output = await adapter.run(request({ policy: { write: true } }));
  assert.ok(calls[0].args.includes("--force"));
  assert.ok(!calls[0].args.includes("--mode"));
  assert.equal(output.result.finalText, "edited");
  assert.deepEqual(output.execution, {
    effectivePolicy: { write: true, mode: "agent" },
    launchFlags: ["--trust", "-p", "--output-format", "stream-json", "--stream-partial-output", "--force", "--workspace"],
  });
});

test("Cursor emits explicit plan and sandbox flags without force", async () => {
  const calls = [];
  const adapter = new CursorAdapter({
    command: "fake-cursor",
    spawnFn(_command, args) {
      calls.push(args);
      return new FakeChild({ stdout: streamJsonResult("planned") });
    },
  });
  for (const { policy, flags, mode, write } of [
    { policy: { write: true, mode: "plan" }, flags: ["--mode", "plan"], mode: "plan", write: false },
    { policy: { write: false, mode: "plan", sandbox: true }, flags: ["--mode", "plan", "--sandbox", "enabled"], mode: "plan", write: false },
    { policy: { write: false, sandbox: true }, flags: ["--mode", "ask", "--sandbox", "enabled"], mode: "ask", write: false },
    { policy: { write: true, sandbox: true }, flags: ["--sandbox", "enabled"], mode: "agent", write: true },
  ]) {
    const req = request({ route: {}, policy, metadata: { harnest: { writeApproved: policy.write } } });
    const result = await adapter.run(req);
    assert.deepEqual(calls.at(-1).slice(0, -1), [
      "--trust", "-p", "--output-format", "stream-json", "--stream-partial-output", ...flags, "--workspace", req.cwd,
    ]);
    assert.equal(result.execution.effectivePolicy.mode, mode);
    assert.equal(result.execution.effectivePolicy.write, write);
  }
  await assert.rejects(
    adapter.run(request({ policy: { write: true, sandbox: false } })),
    (error) => error.details?.kind === "policy" && /sandbox=false/.test(error.message),
  );
  await assert.rejects(
    adapter.run(request({ policy: { tools: { deny: ["Read"] } } })),
    (error) => error.details?.kind === "policy" && /policy.tools/.test(error.message),
  );
  assert.equal(calls.length, 4);
});

test("Cursor rejects a successful envelope that explicitly says every tool call was blocked", async () => {
  const blocked = "Every tool call was blocked before it ran. No report file was created.";
  const adapter = new CursorAdapter({
    command: "fake-cursor",
    spawnFn() { return new FakeChild({ stdout: streamJsonResult(blocked) }); },
  });
  await assert.rejects(adapter.run(request({ requestId: "req-cursor-blocked" })), (error) => {
    assert.equal(error.details?.kind, "downstream");
    assert.equal(error.details?.completionBlocked, true);
    assert.equal(error.details?.finalText, blocked);
    assert.deepEqual(error.details?.execution, {
      effectivePolicy: { write: false, mode: "ask" },
      launchFlags: ["--trust", "-p", "--output-format", "stream-json", "--stream-partial-output", "--mode", "ask", "--workspace"],
    });
    return true;
  });
});

test("Cursor rejects an explicit Blocked status when every tool call was rejected", async () => {
  const blocked = "Blocked: Every tool call was rejected before brief could be read. No report file was created.";
  const adapter = new CursorAdapter({
    command: "fake-cursor",
    spawnFn() { return new FakeChild({ stdout: streamJsonResult(blocked) }); },
  });
  await assert.rejects(adapter.run(request({ requestId: "req-cursor-blocked-status" })), (error) => {
    assert.equal(error.details?.kind, "downstream");
    assert.equal(error.details?.completionBlocked, true);
    assert.equal(error.details?.finalText, blocked);
    return true;
  });
});

test("Cursor preserves successful discussion of blocked or rejected tool calls", async () => {
  const finalText = "I reviewed why another run said every tool call was blocked or rejected, and the requested analysis is complete.";
  const adapter = new CursorAdapter({
    command: "fake-cursor",
    spawnFn() { return new FakeChild({ stdout: streamJsonResult(finalText) }); },
  });
  const output = await adapter.run(request({ requestId: "req-cursor-blocked-discussion" }));
  assert.equal(output.result.finalText, finalText);
});

test("Cursor preserves a successful report that begins by discussing a previous all-tools blockage", async () => {
  const finalText = "Every tool call was blocked in the previous run; this report explains the repaired configuration and completed verification.";
  const adapter = new CursorAdapter({
    command: "fake-cursor",
    spawnFn() { return new FakeChild({ stdout: streamJsonResult(finalText) }); },
  });
  const output = await adapter.run(request({ requestId: "req-cursor-previous-blockage" }));
  assert.equal(output.result.finalText, finalText);
});

test("Cursor treats structured permission denials as downstream failure even with a success subtype", async () => {
  const terminal = {
    type: "result",
    subtype: "success",
    result: "The task was not carried out.",
    session_id: "cursor-denied",
    permission_denials: [{ tool_name: "Shell", tool_use_id: "tool-1" }],
  };
  const adapter = new CursorAdapter({
    command: "fake-cursor",
    spawnFn() { return new FakeChild({ stdout: `${JSON.stringify(terminal)}\n` }); },
  });
  await assert.rejects(adapter.run(request({ requestId: "req-cursor-denied" })), (error) => {
    assert.equal(error.details?.kind, "downstream");
    assert.deepEqual(error.details?.permissionDenials, [{ toolName: "Shell", toolUseId: "tool-1" }]);
    return true;
  });
});

test("Cursor adapter passes explicit model verbatim and resumes sessions", async () => {
  const calls = [];
  const adapter = new CursorAdapter({
    command: "fake-cursor",
    spawnFn(command, args) {
      calls.push({ command, args });
      return new FakeChild({ stdout: streamJsonResult("resumed") });
    },
  });
  const output = await adapter.run(request({
    route: { model: "gpt-5" },
    execution: { sessionId: "prior-session" },
  }));
  assert.ok(calls[0].args.includes("--model") && calls[0].args.includes("gpt-5"));
  assert.ok(calls[0].args.includes("--resume") && calls[0].args.includes("prior-session"));
  assert.equal(output.result.finalText, "resumed");
  assert.deepEqual(output.execution.launchFlags, [
    "--resume", "--trust", "-p", "--output-format", "stream-json", "--stream-partial-output",
    "--mode", "ask", "--model", "--workspace",
  ]);
  assert.doesNotMatch(JSON.stringify(output.execution), /prior-session|gpt-5/);
});

test("Cursor adapter falls back to single-JSON envelope", async () => {
  const adapter = new CursorAdapter({
    command: "fake-cursor",
    spawnFn() {
      return new FakeChild({ stdout: `${JSON.stringify({ type: "result", result: "single envelope", session_id: "s-9" })}\n` });
    },
  });
  const output = await adapter.run(request());
  assert.equal(output.result.finalText, "single envelope");
  assert.equal(output.sessionId, "s-9");
});

test("Cursor keeps hostile task text in one argument without a command shell", async () => {
  const calls = [];
  const hostile = `review & whoami | echo "quoted" <input >output ^ caret`;
  const adapter = new CursorAdapter({
    command: "fake-cursor",
    spawnFn(command, args, options) {
      calls.push({ command, args, options });
      return new FakeChild({ stdout: streamJsonResult("safe") });
    },
  });
  await adapter.run(request({ task: hostile }));
  assert.equal(calls[0].options.shell, false);
  assert.match(calls[0].args.at(-1), /review & whoami \| echo/);
});

test("Cursor adapter fails when stdout empty", async () => {
  const adapter = new CursorAdapter({
    command: "fake-cursor",
    spawnFn() { return new FakeChild({ stdout: "   \n\n" }); },
  });
  await assert.rejects(adapter.run(request()), (e) => e.details?.kind === "downstream" && /without final output/.test(e.message));
});

test("Cursor policy rejects granular tools and budgets", async () => {
  const adapter = new CursorAdapter({ command: "fake-cursor", spawnFn() { return new FakeChild({ stdout: "x" }); } });
  await assert.rejects(
    adapter.run(request({ policy: { write: false, tools: ["read"] } })),
    (e) => e.details?.kind === "policy" && /tools/.test(e.message),
  );
  await assert.rejects(
    adapter.run(request({ policy: { write: true, maxCostUsd: 5 } })),
    (e) => e.details?.kind === "policy" && /maxCostUsd/.test(e.message),
  );
});

test("Cursor rejects route.thinking instead of silently discarding it", async () => {
  let spawned = 0;
  const adapter = new CursorAdapter({
    command: "fake-cursor",
    spawnFn() {
      spawned += 1;
      return new FakeChild({ stdout: streamJsonResult("should not run") });
    },
  });
  await assert.rejects(
    adapter.run(request({ route: { model: "gpt-5", thinking: "high" } })),
    (e) => e.details?.kind === "policy" && /route\.thinking/.test(e.message) && /route\.model/.test(e.message),
  );
  assert.equal(spawned, 0, "route.thinking must be rejected before the harness launches");
});

test("Cursor control fails closed as unsupported-control", async () => {
  const adapter = new CursorAdapter({ command: "fake-cursor" });
  await assert.rejects(
    adapter.control({ commandId: "c1", kind: "message", delivery: "steer", message: "x" }),
    (e) => e.details?.kind === "unsupported-control",
  );
});

test("Cursor classifies a print-mode authentication error as provider-auth", async () => {
  const adapter = new CursorAdapter({
    command: "fake-cursor",
    spawnFn() {
      return new FakeChild({
        stderr: "Error: Authentication required. Run 'agent login' first, or set CURSOR_API_KEY.\n",
        code: 1,
      });
    },
  });
  await assert.rejects(adapter.run(request({ requestId: "req-cursor-auth" })), (error) => {
    assert.equal(error.details?.kind, "provider-auth");
    assert.equal(error.details?.category, "auth");
    assert.equal(error.details?.provider, "cursor");
    assert.match(error.message, /Cursor provider authorization failure for cursor/);
    assert.match(error.message, /Authentication required/);
    return true;
  });
});

test("Cursor does not mistake print-mode authentication text for final output", async () => {
  const adapter = new CursorAdapter({
    command: "fake-cursor",
    spawnFn() { return new FakeChild({ stdout: "Error: Authentication required. Run 'agent login' to authenticate.\n" }); },
  });
  await assert.rejects(adapter.run(request({ requestId: "req-cursor-auth-stdout" })), (error) => {
    assert.equal(error.details?.kind, "provider-auth");
    assert.match(error.message, /Authentication required/);
    return true;
  });
});

test("Cursor classifies an HTTP 401 status line as provider-auth", async () => {
  const adapter = new CursorAdapter({
    command: "fake-cursor",
    spawnFn() { return new FakeChild({ stderr: "HTTP 401: invalid API key\n", code: 1 }); },
  });
  await assert.rejects(adapter.run(request({ requestId: "req-cursor-401" })), (error) => {
    assert.equal(error.details?.kind, "provider-auth");
    assert.equal(error.details?.status, 401);
    assert.match(error.message, /\(HTTP 401\)/);
    return true;
  });
});

test("Cursor classifies an unknown model as unavailable", async () => {
  const adapter = new CursorAdapter({
    command: "fake-cursor",
    spawnFn() {
      return new FakeChild({ stderr: "Error: Model 'composer-9-ultra' not found. Run cursor-agent --list-models.\n", code: 1 });
    },
  });
  await assert.rejects(adapter.run(request({ requestId: "req-cursor-model" })), (error) => {
    assert.equal(error.details?.kind, "unavailable");
    assert.equal(error.details?.category, "not-found");
    assert.match(error.message, /Cursor model availability failure for cursor/);
    return true;
  });
});

test("Cursor provider classification never fires on a healthy run's text", async () => {
  const text = "the unauthorized billing and unknown model notes were reviewed; the run succeeded";
  const adapter = new CursorAdapter({
    command: "fake-cursor",
    spawnFn() { return new FakeChild({ stdout: streamJsonResult(text) }); },
  });
  const output = await adapter.run(request({ requestId: "req-cursor-healthy" }));
  assert.equal(output.result.finalText, text);
});

test("Cursor spawns with the parent environment under read-only and write policies", async () => {
  const calls = [];
  const sentinelKey = "HARNEST_TEST_CURSOR_ENV";
  const overrideKey = "HARNEST_TEST_CURSOR_OVERRIDE";
  const saved = process.env[sentinelKey];
  process.env[sentinelKey] = "inherited";
  try {
    const adapter = new CursorAdapter({
      command: "fake-cursor",
      env: { [overrideKey]: "override" },
      spawnFn(command, args, options) {
        calls.push({ command, args, options });
        return new FakeChild({ stdout: streamJsonResult("ok") });
      },
    });
    await adapter.run(request({ requestId: "req-cursor-env-read" }));
    await adapter.run(request({ requestId: "req-cursor-env-write", policy: { write: true } }));
  } finally {
    if (saved === undefined) delete process.env[sentinelKey];
    else process.env[sentinelKey] = saved;
  }

  assert.equal(calls.length, 2, "both policies spawn the harness");
  const [readOnlyEnv, writeEnv] = calls.map((call) => call.options.env);
  assert.ok(process.env.HOME !== undefined || process.env.USERPROFILE !== undefined, "test host exposes a home variable");
  for (const env of [readOnlyEnv, writeEnv]) {
    assert.ok(env, "spawn receives an environment");
    assert.equal(env[sentinelKey], "inherited", "the parent environment reaches the harness");
    assert.equal(env[overrideKey], "override", "adapter overrides merge over the parent environment");
    // Windows keeps the original casing ("Path") inside a plain env object while
    // process.env reads case-insensitively; compare per-key case-insensitively.
    const envKeys = new Map(Object.keys(env).map((key) => [key.toLowerCase(), key]));
    for (const key of ["HOME", "USERPROFILE", "APPDATA", "PATH", "CURSOR_API_KEY"]) {
      if (process.env[key] === undefined) continue;
      const actualKey = envKeys.get(key.toLowerCase());
      assert.ok(actualKey, `spawned env inherits ${key}`);
      assert.equal(env[actualKey], process.env[key], `spawned env inherits ${key}`);
    }
  }
  assert.deepEqual(readOnlyEnv, writeEnv, "read-only and write policies spawn with identical authorization environments");
});
