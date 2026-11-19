import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, copyFile, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ClaudeAdapter } from "../src/adapters/claude.mjs";
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

function streamJsonResult(result, sessionId = "claude-session-1", extra = {}) {
  const lines = [
    JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, model: "sonnet", cwd: process.cwd() }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "working" }] } }),
    JSON.stringify({
      type: "result", subtype: "success", is_error: false, result, session_id: sessionId,
      total_cost_usd: 0.01, num_turns: 2,
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 },
      ...extra,
    }),
  ];
  return `${lines.join("\n")}\n`;
}

function request(overrides = {}) {
  return normalizeRequest({
    target: "claude",
    requestId: "req-claude-001",
    task: "Return the handoff result.",
    cwd: process.cwd(),
    context: { source: "deterministic-test" },
    policy: { write: false, tools: [], maxCostUsd: null },
    ...overrides,
  });
}

async function fakeCliOnPath(t, { includeInstall = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "harnest-native-path-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cwd = join(dir, "handoff");
  const install = join(dir, "trusted install");
  await mkdir(cwd);
  await mkdir(install);
  const command = "harnest-claude-fixture";
  const windows = process.platform === "win32";
  const name = windows ? `${command}.exe` : command;
  const trusted = join(install, name);
  for (const file of [trusted, join(cwd, name)]) {
    await copyFile(process.execPath, file);
    if (!windows) await chmod(file, 0o755);
  }
  const PATH = ["", ".", join("..", "handoff"), ...(includeInstall ? [install] : [])].join(delimiter);
  const fixture = fileURLToPath(new URL("./fixtures/process-child.mjs", import.meta.url));
  const adapter = new ClaudeAdapter({ launch: { command, args: [fixture, "claude-exec-path"] }, env: { PATH } });
  return { adapter, command, cwd, trusted };
}

test("Claude runs the trusted PATH executable instead of the handoff directory decoy", async (t) => {
  const { adapter, cwd, trusted } = await fakeCliOnPath(t);
  const { result } = await adapter.run(request({ cwd }));
  assert.equal(await realpath(result.finalText), await realpath(trusted));
});

test("Claude reports an actionable launch failure when only the handoff decoy exists", async (t) => {
  const { adapter, command, cwd } = await fakeCliOnPath(t, { includeInstall: false });
  await assert.rejects(adapter.run(request({ cwd })), (error) => {
    assert.ok(error.message.includes(command));
    assert.match(error.message, /install.*absolute path/i);
    assert.equal(error.details.kind, "downstream");
    assert.equal(error.details.phase, "launch");
    return true;
  });
});

test("createAdapter supports claude target", () => {
  const adapter = createAdapter("claude", { claude: { command: "fake-claude" } });
  assert.ok(adapter instanceof ClaudeAdapter);
});

test("Claude adapter maps route.thinking to --effort and drops levels Claude lacks", async () => {
  const calls = [];
  const adapter = new ClaudeAdapter({
    command: "fake-claude",
    spawnFn(command, args) {
      calls.push({ command, args });
      return new FakeChild({ stdout: streamJsonResult("ok") });
    },
  });
  await adapter.run(request({ route: { model: "sonnet", thinking: "xhigh" } }));
  assert.equal(calls[0].args[calls[0].args.indexOf("--effort") + 1], "xhigh");
  await adapter.run(request({ requestId: "req-claude-002", route: { model: "sonnet", thinking: "minimal" } }));
  assert.equal(calls[1].args.includes("--effort"), false, "minimal has no Claude equivalent and must be dropped");
  await adapter.run(request({ requestId: "req-claude-003", route: { model: "sonnet", thinking: "HIGH" } }));
  assert.equal(calls[2].args[calls[2].args.indexOf("--effort") + 1], "high", "levels are case-insensitive");
});

test("harnessLaunch supports claude via env and default", () => {
  const launch = harnessLaunch("claude", "fake-claude");
  assert.equal(launch.command, "fake-claude");
  assert.equal(harnessLaunch("claude").command, "claude");
});

test("Claude adapter maps read-only to plan mode with print/stream-json", async () => {
  const calls = [];
  const adapter = new ClaudeAdapter({
    command: "fake-claude",
    spawnFn(command, args, options) {
      calls.push({ command, args, options });
      return new FakeChild({ stdout: streamJsonResult("final answer from Claude") });
    },
  });
  const output = await adapter.run(request());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "fake-claude");
  const args = calls[0].args;
  assert.ok(args.includes("-p"));
  assert.ok(args.includes("stream-json"));
  assert.ok(args.includes("--verbose"));
  assert.ok(args.includes("--permission-prompts") && args.includes("none"));
  const modeIndex = args.indexOf("--permission-mode");
  assert.equal(args[modeIndex + 1], "plan");
  assert.ok(!args.includes("--max-budget-usd"));
  const prompt = args[args.indexOf("-p") + 1];
  assert.match(prompt, /req-claude-001/);
  assert.match(prompt, /Return the handoff result/);
  assert.equal(output.sessionId, "claude-session-1");
  assert.equal(output.workflowRunId, "claude:req-claude-001");
  assert.equal(output.route.harness, "claude");
  assert.equal(output.result.finalText, "final answer from Claude");
  assert.equal(output.usage.inputTokens, 100);
  assert.equal(output.usage.totalCostUsd, 0.01);
  assert.equal(output.usage.numTurns, 2);
  assert.deepEqual(output.usageSummary, {
    inputTokens: 115,
    uncachedInputTokens: 100,
    inputSemantics: "exclusive",
    outputTokens: 20,
    cacheReadTokens: 10,
    cacheWriteTokens: 5,
    costUsd: 0.01,
  });
});

test("Claude prompt puts the stable context first and the task after the identifiers", async () => {
  const calls = [];
  const adapter = new ClaudeAdapter({
    command: "fake-claude",
    spawnFn(command, args, options) {
      calls.push({ command, args, options });
      return new FakeChild({ stdout: streamJsonResult("ordered") });
    },
  });
  await adapter.run(request());
  const prompt = calls[0].args[calls[0].args.indexOf("-p") + 1];
  const jsonStart = prompt.indexOf("COORDINATOR DATA (JSON)");
  const taskStart = prompt.indexOf("\nTASK\n");
  assert.ok(jsonStart > 0, "coordinator JSON is present");
  assert.ok(taskStart > jsonStart, "the variable task follows the JSON data");
  assert.ok(prompt.indexOf("req-claude-001") > jsonStart, "no request id precedes the stable prefix");
  assert.ok(prompt.indexOf('"context"') < prompt.indexOf('"requestId"'), "context precedes requestId");
  assert.ok(prompt.indexOf('"requestId"') < prompt.indexOf('"route"'), "route stays at the tail");
  assert.ok(prompt.indexOf('"route"') < taskStart, "only the task follows the identifier tail");
});

test("Claude adapter maps write to acceptEdits and budget to --max-budget-usd", async () => {
  const calls = [];
  const adapter = new ClaudeAdapter({
    command: "fake-claude",
    spawnFn(command, args) {
      calls.push({ command, args });
      return new FakeChild({ stdout: streamJsonResult("edited") });
    },
  });
  const output = await adapter.run(request({ policy: { write: true, maxCostUsd: 2.5 } }));
  const args = calls[0].args;
  assert.equal(args[args.indexOf("--permission-mode") + 1], "acceptEdits");
  assert.equal(args[args.indexOf("--max-budget-usd") + 1], "2.5");
  assert.equal(output.result.finalText, "edited");
});

test("Claude surfaces bounded modelUsage keys for actual-model verification", async () => {
  const modelUsage = Object.fromEntries([
    ["claude-sonnet-4-6", { inputTokens: 10 }],
    ["claude-opus-4-6", { inputTokens: 2 }],
    ["claude-haiku-4-5", { inputTokens: 1 }],
    ["extra-1", {}], ["extra-2", {}], ["extra-3", {}], ["extra-4", {}], ["extra-5", {}], ["extra-6", {}], ["extra-7", {}],
  ]);
  const adapter = new ClaudeAdapter({
    command: "fake-claude",
    spawnFn() {
      return new FakeChild({ stdout: streamJsonResult("verified", "s-model", { modelUsage }) });
    },
  });
  const output = await adapter.run(request({ route: { model: "sonnet" } }));
  assert.deepEqual(output.usage.models, Object.keys(modelUsage).slice(0, 8));
  assert.equal(output.usage.models.length, 8, "the model list is bounded to 8 keys");
  assert.equal(output.usage.totalCostUsd, 0.01);
  assert.equal(output.usage.numTurns, 2);
});

test("Claude adapter passes explicit model and resumes sessions", async () => {
  const calls = [];
  const adapter = new ClaudeAdapter({
    command: "fake-claude",
    spawnFn(command, args) {
      calls.push({ command, args });
      return new FakeChild({ stdout: streamJsonResult("resumed") });
    },
  });
  const output = await adapter.run(request({
    route: { model: "opus" },
    execution: { sessionId: "prior-session" },
  }));
  assert.ok(calls[0].args.includes("--model") && calls[0].args.includes("opus"));
  assert.ok(calls[0].args.includes("--resume") && calls[0].args.includes("prior-session"));
  assert.equal(output.result.finalText, "resumed");
});

test("Claude adapter rejects error subtypes and budget exhaustion distinctly", async () => {
  const budget = new ClaudeAdapter({
    command: "fake-claude",
    spawnFn() { return new FakeChild({ stdout: streamJsonResult("too much", "s-1", { subtype: "error_max_budget_usd", is_error: true }) }); },
  });
  await assert.rejects(adapterRun(budget), (e) => e.details?.kind === "budget" && /error_max_budget_usd/.test(e.message));
  const turns = new ClaudeAdapter({
    command: "fake-claude",
    spawnFn() { return new FakeChild({ stdout: streamJsonResult("cut off", "s-2", { subtype: "error_max_turns", is_error: true }) }); },
  });
  await assert.rejects(adapterRun(turns), (e) => e.details?.kind === "downstream" && /error_max_turns/.test(e.message));

  async function adapterRun(a) { return a.run(request()); }
});

test("Claude classifies error subtypes before the empty-result guard", async () => {
  const budget = new ClaudeAdapter({
    command: "fake-claude",
    spawnFn() {
      return new FakeChild({
        stdout: streamJsonResult("", "s-budget-empty", {
          subtype: "error_max_budget_usd",
          is_error: true,
          stop_reason: "max_budget",
          permission_denials: [{ tool_name: "Bash", tool_use_id: "t1" }],
          errors: ["max budget exceeded"],
        }),
      });
    },
  });
  await assert.rejects(budget.run(request({ requestId: "req-claude-budget-empty" })), (e) =>
    e.details?.kind === "budget"
    && !/empty result/.test(e.message)
    && /error_max_budget_usd/.test(e.message)
    && e.details?.permissionDenials?.length === 1
    && e.details?.errors?.[0] === "max budget exceeded");

  const turns = new ClaudeAdapter({
    command: "fake-claude",
    spawnFn() {
      return new FakeChild({
        stdout: streamJsonResult("", "s-turns-empty", {
          subtype: "error_max_turns",
          is_error: true,
          errors: ["turn limit reached"],
        }),
      });
    },
  });
  await assert.rejects(turns.run(request({ requestId: "req-claude-turns-empty" })), (e) =>
    e.details?.kind === "downstream"
    && !/empty result/.test(e.message)
    && /error_max_turns/.test(e.message)
    && e.details?.errors?.[0] === "turn limit reached");
});

test("Claude adapter fails on missing envelope and empty results", async () => {
  const missing = new ClaudeAdapter({
    command: "fake-claude",
    spawnFn() { return new FakeChild({ stdout: "not json at all\n" }); },
  });
  await assert.rejects(missing.run(request()), (e) => e.details?.kind === "downstream" && /without a result envelope/.test(e.message));
  const empty = new ClaudeAdapter({
    command: "fake-claude",
    spawnFn() { return new FakeChild({ stdout: streamJsonResult("   ") }); },
  });
  await assert.rejects(empty.run(request()), (e) => e.details?.kind === "downstream" && /empty result/.test(e.message));
});

test("Claude keeps hostile task text in one argument without a command shell", async () => {
  const calls = [];
  const hostile = `review & whoami | echo "quoted" <input >output ^ caret`;
  const adapter = new ClaudeAdapter({
    command: "fake-claude",
    spawnFn(command, args, options) {
      calls.push({ command, args, options });
      return new FakeChild({ stdout: streamJsonResult("safe") });
    },
  });
  await adapter.run(request({ task: hostile }));
  assert.equal(calls[0].options.shell, false);
  assert.match(calls[0].args[calls[0].args.indexOf("-p") + 1], /review & whoami \| echo/);
});

test("Claude policy still rejects legacy tool arrays", async () => {
  const adapter = new ClaudeAdapter({ command: "fake-claude", spawnFn() { return new FakeChild({ stdout: "x" }); } });
  await assert.rejects(
    adapter.run(request({ policy: { write: false, tools: ["Read"] } })),
    (e) => e.details?.kind === "policy" && /tools/.test(e.message),
  );
});

test("Claude restricts available tools and keeps permission mode independent of tool lists", async () => {
  const calls = [];
  const adapter = new ClaudeAdapter({
    command: "fake-claude",
    spawnFn(_command, args) {
      calls.push(args);
      return new FakeChild({ stdout: streamJsonResult("reviewed") });
    },
  });
  await adapter.run(request({ route: {}, policy: { write: false, tools: { allow: ["Read", "Glob"], deny: ["Glob", "Edit"] } } }));
  assert.deepEqual(calls[0].slice(2), [
    "--output-format", "stream-json", "--verbose", "--permission-prompts", "none", "--permission-mode", "plan",
    "--safe-mode", "--tools", "Read", "--allowedTools", "Read", "--disallowedTools", "Glob,Edit",
  ]);

  await adapter.run(request({ route: {}, policy: { write: true, tools: { deny: ["Bash"] } } }));
  assert.deepEqual(calls[1].slice(2), [
    "--output-format", "stream-json", "--verbose", "--permission-prompts", "none", "--permission-mode", "acceptEdits",
    "--disallowedTools", "Bash",
  ]);

  await adapter.run(request({ route: {}, policy: { tools: { allow: [] } } }));
  assert.deepEqual(calls[2].slice(-3), ["--safe-mode", "--tools", ""]);
  assert.ok(!calls[2].includes("--allowedTools"));
  for (const write of [false, true]) {
    await assert.rejects(
      adapter.run(request({ policy: { write, tools: { allow: ["Bash"] } } })),
      (error) => error.details?.kind === "policy" && /preapproves/.test(error.message),
    );
  }
  assert.equal(calls.length, 3);
});

test("Claude control fails closed as unsupported-control", async () => {
  const adapter = new ClaudeAdapter({ command: "fake-claude" });
  await assert.rejects(
    adapter.control({ commandId: "c1", kind: "message", delivery: "steer", message: "x" }),
    (e) => e.details?.kind === "unsupported-control",
  );
});

test("Claude classifies a terminal authentication failure as provider-auth with a bounded reason", async () => {
  const adapter = new ClaudeAdapter({
    command: "fake-claude",
    spawnFn() {
      return new FakeChild({
        stdout: streamJsonResult("Invalid API key provided: sk-ant-abcdefghijklmnop. Please run /login", "s-claude-auth", {
          subtype: "error_during_execution",
          is_error: true,
        }),
      });
    },
  });
  await assert.rejects(adapter.run(request({ requestId: "req-claude-auth" })), (error) => {
    assert.equal(error.details?.kind, "provider-auth");
    assert.equal(error.details?.category, "auth");
    assert.equal(error.details?.provider, "anthropic");
    assert.match(error.message, /Claude provider authorization failure for anthropic/);
    assert.match(error.message, /Invalid API key/);
    assert.ok(error.details.providerError.message.length <= 400, "provider reason is bounded");
    assert.equal(error.details?.subtype, "error_during_execution", "terminal subtype evidence survives classification");
    assert.ok(!error.message.includes("sk-ant-abcdefghijklmnop"), "the credential-looking token is redacted from the message");
    assert.ok(!JSON.stringify(error.details).includes("sk-ant-abcdefghijklmnop"), "the credential-looking token is redacted from the details");
    return true;
  });
});

test("Claude classifies a stream error event and keeps its HTTP status", async () => {
  const adapter = new ClaudeAdapter({
    command: "fake-claude",
    spawnFn() {
      return new FakeChild({
        stdout: `${JSON.stringify({ type: "error", error: { type: "authentication_error", message: "401 Unauthorized: no Anthropic credential", status: 401 } })}\n`,
        code: 1,
      });
    },
  });
  await assert.rejects(adapter.run(request({ requestId: "req-claude-stream-auth" })), (error) => {
    assert.equal(error.details?.kind, "provider-auth");
    assert.equal(error.details?.status, 401);
    assert.match(error.message, /\(HTTP 401\)/);
    assert.match(error.message, /no Anthropic credential/);
    return true;
  });
});

test("Claude classifies an unknown model as unavailable", async () => {
  const adapter = new ClaudeAdapter({
    command: "fake-claude",
    spawnFn() {
      return new FakeChild({
        stdout: streamJsonResult("Unknown model: claude-hyperion-9. Select a supported model.", "s-claude-model", {
          subtype: "error_during_execution",
          is_error: true,
        }),
      });
    },
  });
  await assert.rejects(adapter.run(request({ requestId: "req-claude-model" })), (error) => {
    assert.equal(error.details?.kind, "unavailable");
    assert.equal(error.details?.category, "not-found");
    assert.match(error.message, /Claude model availability failure for anthropic/);
    return true;
  });
});

test("Claude provider classification never fires on a healthy run's text", async () => {
  const text = "invalid API key, unauthorized billing, and unknown model were only reviewed; the run succeeded";
  const adapter = new ClaudeAdapter({
    command: "fake-claude",
    spawnFn() { return new FakeChild({ stdout: streamJsonResult(text) }); },
  });
  const output = await adapter.run(request({ requestId: "req-claude-healthy" }));
  assert.equal(output.result.finalText, text);
});

test("Claude spawns with the parent environment under read-only and write policies", async () => {
  const calls = [];
  const sentinelKey = "HARNEST_TEST_CLAUDE_ENV";
  const overrideKey = "HARNEST_TEST_CLAUDE_OVERRIDE";
  const saved = process.env[sentinelKey];
  process.env[sentinelKey] = "inherited";
  try {
    const adapter = new ClaudeAdapter({
      command: "fake-claude",
      env: { [overrideKey]: "override" },
      spawnFn(command, args, options) {
        calls.push({ command, args, options });
        return new FakeChild({ stdout: streamJsonResult("ok") });
      },
    });
    await adapter.run(request({ requestId: "req-claude-env-read" }));
    await adapter.run(request({ requestId: "req-claude-env-write", policy: { write: true } }));
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
    for (const key of ["HOME", "USERPROFILE", "APPDATA", "PATH", "ANTHROPIC_API_KEY"]) {
      if (process.env[key] === undefined) continue;
      const actualKey = envKeys.get(key.toLowerCase());
      assert.ok(actualKey, `spawned env inherits ${key}`);
      assert.equal(env[actualKey], process.env[key], `spawned env inherits ${key}`);
    }
  }
  assert.deepEqual(readOnlyEnv, writeEnv, "read-only and write policies spawn with identical authorization environments");
});
