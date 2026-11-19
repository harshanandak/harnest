import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { CodexAdapter } from "../src/adapters/codex.mjs";
import { harnessLaunch } from "../src/config.mjs";
import { createAdapter } from "../src/adapters/index.mjs";
import { normalizeRequest } from "../src/protocol.mjs";

class FakeChild extends EventEmitter {
  constructor({ stdout = "", stderr = "", code = 0, hang = false } = {}) {
    super();
    this.killed = false;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.input = "";
    this.stdin = { write: (value) => { this.input += value; }, end: () => { this.stdinEnded = true; } };
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

function streamJsonResult(sessionId = "codex-session-1") {
  const lines = [
    JSON.stringify({ type: "thread.started", thread_id: sessionId }),
    JSON.stringify({ type: "item.completed", content: "working" }),
  ];
  return `${lines.join("\n")}\n`;
}

// codex exec writes the authoritative final message via -o; emulate that.
function fakeSpawn(calls, { finalText = "final answer from Codex", stdout = null, stderr = "", code = 0 } = {}) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    const outIndex = args.indexOf("-o");
    const child = new FakeChild({ stdout: stdout ?? streamJsonResult(), stderr, code });
    calls.at(-1).child = child;
    if (outIndex >= 0 && code === 0) {
      writeFileSync(args[outIndex + 1], `${finalText}\n`);
    }
    return child;
  };
}

const passGitCheck = async () => true;

function codexAdapter(options = {}) {
  return new CodexAdapter({
    gitCheckFn: passGitCheck,
    quotaProbeFn: async () => ({ status: "unknown", source: "test", observedAt: 0, reason: "fixture" }),
    ...options,
  });
}

function request(overrides = {}) {
  return normalizeRequest({
    target: "codex",
    requestId: "req-codex-001",
    task: "Return the handoff result.",
    cwd: process.cwd(),
    context: { source: "deterministic-test" },
    policy: { write: false, tools: [], maxCostUsd: null },
    ...overrides,
  });
}

test("createAdapter supports codex target", () => {
  const adapter = createAdapter("codex", { codex: { command: "fake-codex" } });
  assert.ok(adapter instanceof CodexAdapter);
});

test("Codex applies native fork, image input, and approved workspace roots", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harnest-codex-controls-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const imagePath = join(root, "input.png");
  writeFileSync(imagePath, "fixture image");
  const calls = [];
  const spawn = fakeSpawn(calls, { stdout: streamJsonResult("codex-new") });
  const adapter = codexAdapter({
    command: "fake-codex",
    spawnFn(command, args, options) {
      if (args.at(-1) === "--help") {
        calls.push({ args });
        const stdout = args.includes("fork")
          ? "Usage: codex exec fork [OPTIONS] <SESSION_ID> [PROMPT]\n  --json\n  -i, --image <FILE>\n"
          : "  --add-dir <DIR>\n";
        return new FakeChild({ stdout });
      }
      const staged = args[args.indexOf("-i") + 1];
      assert.equal(readFileSync(staged, "utf8"), "fixture image");
      assert.equal(staged, join(dirname(args[args.indexOf("-o") + 1]), "0-input.png"));
      return spawn(command, args, options);
    },
  });
  const output = await adapter.run(request({
    policy: { write: true },
    metadata: { harnest: { writeApproved: true } },
    execution: { addDirs: [root], attachments: [{ type: "image", path: imagePath }], sessionAction: "fork", sessionId: "codex-old" },
  }));
  assert.equal(output.sessionId, "codex-new");
  assert.deepEqual(calls.slice(0, 2).map(({ args }) => args), [["exec", "--help"], ["exec", "fork", "--help"]]);
  const args = calls[2].args;
  assert.equal(args[args.indexOf("-s") + 1], "workspace-write");
  const staged = join(dirname(args[args.indexOf("-o") + 1]), "0-input.png");
  assert.deepEqual(args.slice(-7), ["--add-dir", await realpath(root), "fork", "-i", staged, "codex-old", "-"]);
});

test("Codex rejects fork when installed help falls back to exec usage", async () => {
  const calls = [];
  const adapter = codexAdapter({
    command: "fake-codex",
    spawnFn(_command, args) {
      calls.push(args);
      return new FakeChild({ stdout: "Usage: codex exec [OPTIONS] [PROMPT]\n --json\n" });
    },
  });
  await assert.rejects(adapter.run(request({ execution: { sessionId: "codex-old", sessionAction: "fork" } })), /execution\.sessionAction is unsupported/);
  assert.deepEqual(calls, [["exec", "fork", "--help"]]);
});

test("harnessLaunch supports codex via env and default", () => {
  const launch = harnessLaunch("codex", "fake-codex");
  assert.equal(launch.command, "fake-codex");
  const def = harnessLaunch("codex");
  assert.ok(typeof def.command === "string" && def.command.length > 0);
  if (process.platform === "win32" && def.command !== "codex" && !process.env.HARNEST_CODEX) {
    // Direct node entrypoint; under bun the fallback runtime is bun itself,
    // same precedent as the pi/dsh shims.
    assert.match(def.command, /(node|bun)(\.exe)?$/i);
    assert.match(def.args[0], /codex\.js$/);
  }
});

test("Codex adapter maps read-only to exec with read-only sandbox and -o file", async () => {
  const calls = [];
  const adapter = codexAdapter({ command: "fake-codex", spawnFn: fakeSpawn(calls) });
  const output = await adapter.run(request());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "fake-codex");
  const args = calls[0].args;
  assert.equal(args[0], "exec");
  assert.ok(args.includes("-C") && args.includes(process.cwd()));
  assert.equal(args[args.indexOf("-s") + 1], "read-only");
  assert.ok(!args.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(args.includes("--json") && args.includes("-o"));
  const prompt = calls[0].child.input;
  assert.equal(args.at(-1), "-");
  assert.equal(calls[0].child.stdinEnded, true);
  assert.match(prompt, /req-codex-001/);
  assert.match(prompt, /Return the handoff result/);
  assert.equal(output.sessionId, "codex-session-1");
  assert.equal(output.workflowRunId, "codex:req-codex-001");
  assert.equal(output.route.harness, "codex");
  assert.equal(output.result.finalText, "final answer from Codex");
  assert.equal(output.usage, null);
  assert.equal(output.result.quota.status, "unknown");
});

test("Codex sends the profile and service tier as native exec options before resume", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "harnest-codex-profile-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "review.config.toml"), "# fixture profile\n");
  const calls = [];
  const launchExec = fakeSpawn(calls);
  const adapter = codexAdapter({
    command: "fake-codex",
    env: { CODEX_HOME: directory },
    spawnFn(command, args, options) {
      if (args[0] === "exec") return launchExec(command, args, options);
      calls.push({ args });
      const stdout = args[0] === "--version" ? "codex-cli 0.170.0\n" : "fast_mode stable true\n";
      return new FakeChild({ stdout });
    },
  });
  const output = await adapter.run(request({
    route: { profile: "review", serviceTier: "fast" }, execution: { sessionId: "native-thread" },
  }));
  assert.deepEqual(calls.map(({ args }) => args), [
    ["--version"],
    ["features", "--enable", "fast_mode", "list"],
    ["exec", "-C", process.cwd(), "-s", "read-only", "--profile", "review",
      "--strict-config", "-c", 'service_tier="fast"', "--enable", "fast_mode", "--json", "-o",
      calls[2].args[calls[2].args.indexOf("-o") + 1], "resume", "native-thread", "-"],
  ]);
  assert.equal(output.route.profile, "review");
  assert.equal(output.route.serviceTier, "fast");
});

test("Codex route controls reject an older CLI, missing profile, or disabled fast mode before exec", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "harnest-codex-no-profile-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cases = [
    [{ serviceTier: "flex" }, "codex-cli 0.20.0\n", /route\.serviceTier requires codex-cli 0\.170\.0/],
    [{ profile: "missing" }, "codex-cli 0.170.0\n", /route\.profile.*no native config file/],
    [{ serviceTier: "priority" }, "codex-cli 0.170.0\n", /route\.serviceTier.*fast_mode/],
  ];
  for (const [route, version, expected] of cases) {
    const calls = [];
    const adapter = codexAdapter({
      command: "fake-codex", env: { CODEX_HOME: directory },
      spawnFn(_command, args) {
        calls.push(args);
        return new FakeChild({ stdout: args[0] === "--version" ? version : "fast_mode stable false\n" });
      },
    });
    await assert.rejects(adapter.run(request({ route })), expected);
    assert.equal(calls.some(([subcommand]) => subcommand === "exec"), false);
  }
});

test("Codex warns before inference at 95 percent and records safe quota metadata", async () => {
  const calls = [];
  const progress = [];
  const quota = {
    status: "available",
    source: "codex app-server account/rateLimits/read",
    observedAt: 10,
    ordinaryUsageAllowed: true,
    limitId: "codex",
    headroom: 0.05,
    usedPercent: 95,
    windowDurationMins: 300,
    resetsAt: 1_800_000_000,
    windows: [{ kind: "primary", usedPercent: 95, headroom: 0.05, windowDurationMins: 300, resetsAt: 1_800_000_000 }],
  };
  const adapter = codexAdapter({
    command: "fake-codex",
    spawnFn: fakeSpawn(calls),
    quotaProbeFn: async () => quota,
  });

  const output = await adapter.run(request({ route: { model: "gpt-6.1-sol", thinking: "xhigh" } }), {
    onProgress: (event) => progress.push(event),
  });

  assert.equal(calls.length, 1, "the warning precedes one inference launch");
  assert.equal(progress[0].type, "codex_quota");
  assert.equal(progress[0].status, "warning");
  assert.equal(progress[0].quota.headroom, 0.05);
  assert.deepEqual(output.result.quota, quota);
  assert.ok(output.result.eventSummary.types.includes("codex_quota"));
});

test("Codex warns on ordinary denial without claiming the selected model is exhausted", async () => {
  const calls = [];
  const progress = [];
  const adapter = codexAdapter({
    command: "fake-codex",
    spawnFn: fakeSpawn(calls),
    quotaProbeFn: async () => ({
      status: "available",
      source: "codex app-server account/rateLimits/read",
      observedAt: 10,
      ordinaryUsageAllowed: false,
      limitId: "codex",
      headroom: 0,
      usedPercent: 100,
      windowDurationMins: 10080,
      resetsAt: 1_800_000_000,
      windows: [],
    }),
  });

  const output = await adapter.run(
    request({ route: { model: "gpt-6.1-sol", thinking: "xhigh" } }),
    { onProgress: (event) => progress.push(event) },
  );
  assert.equal(calls.length, 1, "bucket/model applicability is unknown, so the pinned route is preserved");
  assert.equal(progress[0].type, "codex_quota");
  assert.equal(progress[0].status, "warning");
  assert.equal(progress[0].quota.ordinaryUsageAllowed, false);
  assert.equal(output.result.quota.ordinaryUsageAllowed, false);
});

test("Codex does not infer denial from 100 percent or from an ordinary denial on a Luna route", async () => {
  const scenarios = [
    { model: "gpt-6.1-sol", ordinaryUsageAllowed: null },
    { model: "gpt-5.6-luna", ordinaryUsageAllowed: false },
  ];
  for (const scenario of scenarios) {
    const calls = [];
    const adapter = codexAdapter({
      command: "fake-codex",
      spawnFn: fakeSpawn(calls),
      quotaProbeFn: async () => ({
        status: "available",
        source: "codex app-server account/rateLimits/read",
        observedAt: 10,
        ordinaryUsageAllowed: scenario.ordinaryUsageAllowed,
        limitId: "codex",
        headroom: 0,
        usedPercent: 100,
        windowDurationMins: 10080,
        resetsAt: 1_800_000_000,
        windows: [],
      }),
    });
    const output = await adapter.run(request({ route: { model: scenario.model, thinking: "xhigh" } }));
    assert.equal(calls.length, 1);
    assert.equal(output.route.model, scenario.model, "the explicit model pin is preserved");
  }
});

test("Codex quota probe failure remains unknown and does not become auth or quota evidence", async () => {
  const calls = [];
  const adapter = codexAdapter({
    command: "fake-codex",
    spawnFn: fakeSpawn(calls),
    quotaProbeFn: async () => { throw new Error("secret-bearing native failure"); },
  });
  const output = await adapter.run(request());
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(output.result.quota).sort(), ["observedAt", "reason", "source", "status"]);
  assert.equal(output.result.quota.status, "unknown");
  assert.equal(JSON.stringify(output.result.quota).includes("secret-bearing"), false);
});

test("Codex prompt orders the stable context before the task and identifiers", async () => {
  const calls = [];
  const adapter = codexAdapter({ command: "fake-codex", spawnFn: fakeSpawn(calls) });
  await adapter.run(request());
  const prompt = calls[0].child.input;
  const contextIndex = prompt.indexOf('"context"');
  const taskIndex = prompt.indexOf('"task"');
  const requestIdIndex = prompt.indexOf('"requestId"');
  const routeIndex = prompt.indexOf('"route"');
  assert.ok(contextIndex >= 0 && contextIndex < taskIndex, "context precedes the variable task");
  assert.ok(taskIndex < requestIdIndex, "requestId follows the task");
  assert.ok(requestIdIndex < routeIndex, "route stays at the tail");
  assert.ok(prompt.indexOf("req-codex-001") > contextIndex, "no request id precedes the stable prefix");
});

test("Codex adapter maps write to workspace-write, never danger-full-access", async () => {
  const calls = [];
  const adapter = codexAdapter({ command: "fake-codex", spawnFn: fakeSpawn(calls, { finalText: "edited" }) });
  const output = await adapter.run(request({ policy: { write: true } }));
  assert.equal(calls[0].args[calls[0].args.indexOf("-s") + 1], "workspace-write");
  assert.ok(!calls[0].args.includes("danger-full-access"));
  assert.equal(output.result.finalText, "edited");
});

test("Codex adapter passes explicit model and resumes via subcommand", async () => {
  const calls = [];
  const adapter = codexAdapter({ command: "fake-codex", spawnFn: fakeSpawn(calls, { finalText: "resumed" }) });
  const output = await adapter.run(request({
    route: { model: "gpt-5.6-luna", thinking: "high" },
    execution: { sessionId: "prior-session" },
  }));
  const args = calls[0].args;
  const resume = args.indexOf("resume");
  assert.ok(args.indexOf("-C") < resume);
  assert.ok(args.indexOf("-s") < resume);
  assert.deepEqual(args.slice(resume), ["resume", "prior-session", "-"]);
  assert.ok(args.includes("-m") && args.includes("gpt-5.6-luna"));
  assert.ok(args.includes("-c") && args.includes('model_reasoning_effort="high"'));
  assert.equal(output.result.finalText, "resumed");
});

test("Codex adapter omits the effort override when thinking is unset", async () => {
  const calls = [];
  const adapter = codexAdapter({ command: "fake-codex", spawnFn: fakeSpawn(calls, { finalText: "ok" }) });
  await adapter.run(request({ route: { model: "gpt-5.6-luna" } }));
  assert.ok(!calls[0].args.includes("-c"));
});

test("Codex normalizes thinking once for the effort override and receipt", async () => {
  const calls = [];
  const adapter = codexAdapter({ command: "fake-codex", spawnFn: fakeSpawn(calls, { finalText: "ok" }) });
  const output = await adapter.run(request({ route: { model: "gpt-5.6-luna", thinking: " HIGH " } }));
  assert.ok(calls[0].args.includes("-c"));
  assert.ok(calls[0].args.includes('model_reasoning_effort="high"'), "Codex matches lowercase ReasoningEffort");
  assert.equal(output.route.thinking, "high", "receipt echoes the same normalized value");
});

test("Codex adapter fails when the last-message file is empty", async () => {
  const adapter = codexAdapter({
    command: "fake-codex",
    spawnFn(command, args) {
      // No -o write emulated: file stays missing.
      return new FakeChild({ stdout: streamJsonResult() });
    },
  });
  await assert.rejects(adapter.run(request()), (e) => e.details?.kind === "downstream" && /without final output/.test(e.message));
});

test("Codex sends hostile task text through stdin without a command shell", async () => {
  const calls = [];
  const hostile = `review & whoami | echo "quoted" <input >output ^ caret`;
  const adapter = codexAdapter({ command: "fake-codex", spawnFn: fakeSpawn(calls, { finalText: "safe" }) });
  await adapter.run(request({ task: hostile }));
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].args.at(-1), "-");
  assert.match(calls[0].child.input, /review & whoami \| echo/);
  assert.equal(calls[0].child.stdinEnded, true);
});

test("Codex closes real piped stdin and folds documented item/usage events", { timeout: 10000 }, async () => {
  const script = `
    import { writeFileSync } from 'node:fs';
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', value => input += value);
    process.stdin.on('end', () => {
      if (!input.includes('large-input-canary')) process.exit(3);
      const args = process.argv;
      writeFileSync(args[args.indexOf('-o') + 1], 'DONE');
      console.log(JSON.stringify({type:'thread.started',thread_id:'stdin-session'}));
      console.log(JSON.stringify({type:'item.completed',item:{id:'item_1',type:'agent_message',text:'documented progress'}}));
      console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:12,cached_input_tokens:8,output_tokens:4,reasoning_output_tokens:1}}));
    });
  `;
  const progress = [];
  const adapter = codexAdapter({ launch: { command: process.execPath, args: ["--input-type=module", "-e", script, "--"] } });
  const result = await adapter.run(request({ task: `large-input-canary ${"x".repeat(40000)}`, execution: { timeoutMs: 5000 } }), { onProgress: (event) => progress.push(event) });
  assert.equal(result.result.finalText, "DONE");
  assert.equal(result.sessionId, "stdin-session");
  assert.ok(progress.some((event) => event.text === "documented progress"));
  assert.deepEqual(result.usage, { input_tokens: 12, cached_input_tokens: 8, output_tokens: 4, reasoning_output_tokens: 1 });
  assert.deepEqual(result.usageSummary, {
    inputTokens: 12,
    uncachedInputTokens: 4,
    inputSemantics: "inclusive",
    outputTokens: 4,
    cacheReadTokens: 8,
    cacheWriteTokens: null,
    costUsd: null,
  });
});

test("Codex emits bounded semantic tool lifecycle progress without arguments or results", async () => {
  const calls = [];
  const progress = [];
  const stdout = [
    { type: "thread.started", thread_id: "tool-session" },
    { type: "item.started", item: { id: "mcp-1", type: "mcp_tool_call", server: "repo", tool: "read_file", status: "in_progress", arguments: { api_key: "private-argument" } } },
    { type: "item.completed", item: { id: "mcp-1", type: "mcp_tool_call", server: "repo", tool: "read_file", status: "completed", result: "private-tool-result" } },
    { type: "item.started", item: { id: "cmd-1", type: "command_execution", command: "secret command text", status: "in_progress" } },
    { type: "item.completed", item: { id: "cmd-1", type: "command_execution", command: "secret command text", aggregated_output: "private-command-output", status: "completed" } },
    { type: "item.completed", item: { id: "msg-1", type: "agent_message", text: "documented progress" } },
    { type: "turn.completed", usage: { input_tokens: 2, output_tokens: 1 } },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n";
  const adapter = codexAdapter({ command: "fake-codex", spawnFn: fakeSpawn(calls, { stdout }) });

  const output = await adapter.run(request(), { onProgress: (event) => progress.push(event) });
  const tools = progress.filter((event) => event.type === "codex_tool");
  assert.deepEqual(tools, [
    { type: "codex_tool", phase: "started", tool: "repo/read_file", callId: "mcp-1", status: "in_progress", text: "started repo/read_file" },
    { type: "codex_tool", phase: "completed", tool: "repo/read_file", callId: "mcp-1", status: "completed", text: "completed repo/read_file" },
    { type: "codex_tool", phase: "started", tool: "command_execution", callId: "cmd-1", status: "in_progress", text: "started command_execution" },
    { type: "codex_tool", phase: "completed", tool: "command_execution", callId: "cmd-1", status: "completed", text: "completed command_execution" },
  ]);
  const serialized = JSON.stringify(progress);
  for (const secret of ["private-argument", "private-tool-result", "secret command text", "private-command-output"]) {
    assert.ok(!serialized.includes(secret), `${secret} is excluded from progress`);
  }
  assert.equal(output.result.eventSummary.count, 6);
  assert.deepEqual(output.result.eventSummary.types, ["codex_stdout", "codex_delta", "codex_tool"]);
});

test("Codex does not emit progress for empty, updated, or unrecognized events", async () => {
  const progress = [];
  const stdout = [
    {},
    { type: "item.updated", item: { id: "cmd-1", type: "command_execution", status: "in_progress", aggregated_output: "partial output" } },
    { type: "future.event", data: { value: 1 } },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n";
  const adapter = codexAdapter({ command: "fake-codex", spawnFn: fakeSpawn([], { stdout }) });

  await adapter.run(request(), { onProgress: (event) => progress.push(event) });
  assert.deepEqual(progress.map((event) => event.type), ["codex_stdout"]);
});

test("Codex rejects a non-Git cwd before launching the harness", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "harnest-codex-non-git-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const adapter = new CodexAdapter({ command: "codex-must-not-launch-for-non-git-cwd" });

  await assert.rejects(adapter.run(request({ cwd })), (error) => {
    assert.equal(error.name, "CodexAdapterError");
    assert.equal(error.details?.kind, "validation");
    assert.match(error.message, /requires cwd inside a Git worktree/);
    return true;
  });
});

test("Codex custom spawn cannot bypass the non-Git cwd preflight", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "harnest-codex-custom-spawn-non-git-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const calls = [];
  const adapter = new CodexAdapter({ command: "fake-codex", spawnFn: fakeSpawn(calls) });

  await assert.rejects(adapter.run(request({ cwd })), (error) => error.details?.kind === "validation");
  assert.equal(calls.length, 0, "the custom Codex spawn is not called");
});

test("Codex rejects a failed injected Git trust check before harness launch", async () => {
  const calls = [];
  const adapter = new CodexAdapter({
    command: "fake-codex",
    spawnFn: fakeSpawn(calls),
    gitCheckFn: async () => false,
  });

  await assert.rejects(adapter.run(request()), (error) => {
    assert.equal(error.details?.kind, "validation");
    assert.match(error.message, /requires cwd inside a Git worktree/);
    return true;
  });
  assert.equal(calls.length, 0);
});

test("Codex reports an unavailable Git executable as a typed transport failure", async () => {
  const calls = [];
  const adapter = new CodexAdapter({
    command: "fake-codex",
    spawnFn: fakeSpawn(calls),
    gitSpawnFn() {
      const child = new FakeChild({ hang: true });
      queueMicrotask(() => child.emit("error", Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" })));
      return child;
    },
  });

  await assert.rejects(adapter.run(request()), (error) => {
    assert.equal(error.name, "CodexAdapterError");
    assert.equal(error.details?.kind, "transport");
    assert.match(error.message, /Git executable is unavailable/);
    return true;
  });
  assert.equal(calls.length, 0, "Codex is not launched when Git cannot start");
});

test("Codex returns known startup warnings separately on success", async () => {
  const warnings = [
    "features.rmcp_client is ignored because rmcp_client is always enabled",
    "OAuth tokens for server openrouter cannot be refreshed",
  ];
  const adapter = codexAdapter({ command: "fake-codex", spawnFn: fakeSpawn([], { stderr: `${warnings.join("\n")}\n` }) });

  const output = await adapter.run(request());
  assert.deepEqual(output.result.warnings, warnings);
  assert.equal(output.result.finalText, "final answer from Codex");
});

test("Codex warning noise cannot hide an earlier provider failure", async () => {
  const adapter = codexAdapter({
    command: "fake-codex",
    spawnFn: fakeSpawn([], {
      code: 1,
      stderr: [
        "HTTP 402 Payment Required: insufficient credits",
        "features.rmcp_client is ignored because rmcp_client is always enabled",
        "OAuth tokens for server openrouter cannot be refreshed",
      ].join("\n"),
    }),
  });

  await assert.rejects(adapter.run(request()), (error) => {
    assert.equal(error.details?.kind, "provider-auth");
    assert.equal(error.details?.category, "billing");
    assert.equal(error.details?.status, 402);
    return true;
  });
});

test("Codex preserves unknown stderr while separating known warnings", async () => {
  const adapter = codexAdapter({
    command: "fake-codex",
    spawnFn: fakeSpawn([], {
      finalText: "",
      stderr: [
        "features.rmcp_client is ignored because rmcp_client is always enabled",
        "unexpected downstream diagnostic",
      ].join("\n"),
    }),
  });

  await assert.rejects(adapter.run(request()), (error) => {
    assert.equal(error.details?.kind, "downstream");
    assert.match(error.details?.stderr, /unexpected downstream diagnostic/);
    assert.doesNotMatch(error.details?.stderr, /rmcp_client/);
    assert.deepEqual(error.details?.warnings, ["features.rmcp_client is ignored because rmcp_client is always enabled"]);
    return true;
  });
});

test("Codex policy rejects granular tools and budgets", async () => {
  const adapter = codexAdapter({ command: "fake-codex", spawnFn: fakeSpawn([], { finalText: "x" }) });
  await assert.rejects(
    adapter.run(request({ policy: { write: false, tools: ["read"] } })),
    (e) => e.details?.kind === "policy" && /tools/.test(e.message),
  );
  await assert.rejects(
    adapter.run(request({ policy: { write: true, maxCostUsd: 5 } })),
    (e) => e.details?.kind === "policy" && /maxCostUsd/.test(e.message),
  );
});

test("Codex control fails closed as unsupported-control", async () => {
  const adapter = new CodexAdapter({ command: "fake-codex" });
  await assert.rejects(
    adapter.control({ commandId: "c1", kind: "message", delivery: "steer", message: "x" }),
    (e) => e.details?.kind === "unsupported-control",
  );
});

test("Codex classifies a JSONL not-logged-in error as provider-auth", async () => {
  const adapter = codexAdapter({
    command: "fake-codex",
    spawnFn() {
      return new FakeChild({
        stdout: `${JSON.stringify({ type: "error", message: "Not logged in. Run 'codex login' to continue." })}\n`,
        code: 1,
      });
    },
  });
  await assert.rejects(adapter.run(request({ requestId: "req-codex-auth" })), (error) => {
    assert.equal(error.details?.kind, "provider-auth");
    assert.equal(error.details?.category, "auth");
    assert.equal(error.details?.provider, "openai/codex");
    assert.match(error.message, /Codex provider authorization failure for openai\/codex/);
    assert.match(error.message, /Not logged in/);
    return true;
  });
});

test("Codex classifies a stderr billing failure as provider-auth and redacts the key", async () => {
  const adapter = codexAdapter({
    command: "fake-codex",
    spawnFn() {
      return new FakeChild({
        stderr: "HTTP 402 Payment Required: insufficient credits; API key sk-proj-abcdefghijklmnopqrstuvwxyz is unpaid\n",
        code: 1,
      });
    },
  });
  await assert.rejects(adapter.run(request({ requestId: "req-codex-billing" })), (error) => {
    assert.equal(error.details?.kind, "provider-auth");
    assert.equal(error.details?.category, "billing");
    assert.equal(error.details?.status, 402);
    assert.match(error.message, /\(HTTP 402\)/);
    assert.ok(!error.message.includes("sk-proj-abcdefghijklmnopqrstuvwxyz"), "the credential-looking token is redacted from the message");
    assert.ok(!JSON.stringify(error.details).includes("sk-proj-abcdefghijklmnopqrstuvwxyz"), "the credential-looking token is redacted from the details");
    return true;
  });
});

test("Codex classifies a turn.failed unknown-model event as unavailable", async () => {
  const adapter = codexAdapter({
    command: "fake-codex",
    spawnFn() {
      return new FakeChild({
        stdout: `${JSON.stringify({ type: "turn.failed", error: { message: "model 'gpt-9.9-void' not found in this account" } })}\n`,
        code: 1,
      });
    },
  });
  await assert.rejects(adapter.run(request({ requestId: "req-codex-model" })), (error) => {
    assert.equal(error.details?.kind, "unavailable");
    assert.equal(error.details?.category, "not-found");
    assert.match(error.message, /Codex model availability failure for openai\/codex/);
    return true;
  });
});

test("Codex provider classification never fires on a healthy run", async () => {
  const calls = [];
  const text = "not logged in, unauthorized, and unknown model were only reviewed; the run succeeded";
  const adapter = codexAdapter({
    command: "fake-codex",
    spawnFn: fakeSpawn(calls, {
      finalText: text,
      stdout: `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } })}\n`,
    }),
  });
  const output = await adapter.run(request({ requestId: "req-codex-healthy" }));
  assert.equal(output.result.finalText, text);
});

test("Codex spawns with the parent environment under read-only and write policies", async () => {
  const calls = [];
  const sentinelKey = "HARNEST_TEST_CODEX_ENV";
  const overrideKey = "HARNEST_TEST_CODEX_OVERRIDE";
  const saved = process.env[sentinelKey];
  process.env[sentinelKey] = "inherited";
  try {
    const adapter = codexAdapter({
      command: "fake-codex",
      env: { [overrideKey]: "override" },
      spawnFn: fakeSpawn(calls),
    });
    await adapter.run(request({ requestId: "req-codex-env-read" }));
    await adapter.run(request({ requestId: "req-codex-env-write", policy: { write: true } }));
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
    for (const key of ["HOME", "USERPROFILE", "APPDATA", "PATH", "OPENAI_API_KEY"]) {
      if (process.env[key] === undefined) continue;
      const actualKey = envKeys.get(key.toLowerCase());
      assert.ok(actualKey, `spawned env inherits ${key}`);
      assert.equal(env[actualKey], process.env[key], `spawned env inherits ${key}`);
    }
  }
  assert.deepEqual(readOnlyEnv, writeEnv, "read-only and write policies spawn with identical authorization environments");
});
