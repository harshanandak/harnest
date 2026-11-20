import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import test from "node:test";

import { normalizeRequest } from "../src/protocol.mjs";
import { OpenCodeAdapter, foldOpenCodeEvent } from "../src/adapters/opencode.mjs";
import { OpenCodeControl } from "../src/adapters/opencode-control.mjs";
import { harnessLaunch } from "../src/config.mjs";

class FakeChild extends EventEmitter {
  constructor(lines, { hang = false } = {}) {
    super();
    this.killed = false;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdin = { write() {}, end() {} };
    queueMicrotask(() => {
      for (const line of lines) this.stdout.emit("data", Buffer.from(`${line}\n`));
      if (!hang) this.emit("close", 0, null);
    });
  }

  kill() {
    if (this.killed) return false;
    this.killed = true;
    queueMicrotask(() => this.emit("close", null, "SIGTERM"));
    return true;
  }
}

class DelayedChild extends EventEmitter {
  constructor(lines, delay = 100) {
    super();
    this.killed = false;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    queueMicrotask(() => {
      for (const line of lines) this.stdout.emit("data", Buffer.from(`${line}\n`));
      this.timer = setTimeout(() => this.emit("close", 0, null), delay);
    });
  }

  kill() {
    if (this.killed) return false;
    this.killed = true;
    clearTimeout(this.timer);
    queueMicrotask(() => this.emit("close", null, "SIGTERM"));
    return true;
  }
}

class FailingFakeChild extends EventEmitter {
  constructor(lines, code = 1) {
    super();
    this.killed = false;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdin = { write() {}, end() {} };
    queueMicrotask(() => {
      for (const line of lines) this.stdout.emit("data", Buffer.from(`${line}\n`));
      this.emit("close", code, null);
    });
  }

  kill() {
    if (this.killed) return false;
    this.killed = true;
    queueMicrotask(() => this.emit("close", null, "SIGTERM"));
    return true;
  }
}

class SilentFailureChild extends EventEmitter {
  constructor(code = 1) {
    super();
    this.killed = false;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdin = { write() {}, end() {} };
    queueMicrotask(() => this.emit("close", code, null));
  }

  kill() {
    if (this.killed) return false;
    this.killed = true;
    queueMicrotask(() => this.emit("close", null, "SIGTERM"));
    return true;
  }
}

function request(overrides = {}) {
  return normalizeRequest({
    target: "opencode",
    requestId: "req-opencode-001",
    task: "Return the handoff result.",
    cwd: process.cwd(),
    context: { source: "deterministic-test", count: 2 },
    route: { provider: "openai", model: "gpt-test", agent: "reviewer", variant: "high" },
    policy: { write: true },
    ...overrides,
  });
}

function streamLines(session = "session-001", text = "final answer") {
  return [
    JSON.stringify({ type: "session.created", properties: { info: { id: session } } }),
    JSON.stringify({ type: "text", sessionID: session, part: { type: "text", text } }),
    JSON.stringify({
      type: "step_finish",
      sessionID: session,
      part: { type: "step-finish", reason: "stop", tokens: { input: 3, output: 5, reasoning: 1, total: 9, cache: { read: 2, write: 1 } }, cost: 0.01 },
    }),
  ];
}

test("OpenCode forwards a fork and both file input types through native argv", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harnest-opencode-controls-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "input.txt");
  const image = join(root, "input.png");
  await writeFile(file, "fixture file");
  await writeFile(image, "fixture image");
  const calls = [];
  const adapter = new OpenCodeAdapter({
    ...managedOptions(),
    command: "fake-opencode",
    spawnFn(_command, args) {
      calls.push(args);
      if (args.at(-1) === "--help") return new FakeChild(["  --session, -s string", "  --fork", "  --file, -f string"]);
      const [stagedFile, stagedImage] = [args.at(-3), args.at(-1)];
      assert.ok(isAbsolute(stagedFile) && isAbsolute(stagedImage));
      assert.deepEqual([basename(stagedFile), basename(stagedImage)], ["0-input.txt", "1-input.png"]);
      assert.equal(readFileSync(stagedFile, "utf8"), "fixture file");
      assert.equal(readFileSync(stagedImage, "utf8"), "fixture image");
      return new FakeChild(streamLines("opencode-new"));
    },
  });
  const result = await adapter.run(request({ execution: {
    sessionAction: "fork", sessionId: "opencode-old",
    attachments: [{ type: "file", path: file }, { type: "image", path: image }],
  } }));
  assert.equal(result.sessionId, "opencode-new");
  assert.deepEqual(calls[0], ["run", "--help"]);
  assert.deepEqual(calls[1].slice(-7), ["--session", "opencode-old", "--fork", "--file", calls[1].at(-3), "--file", calls[1].at(-1)]);
});

const SERVER_URL = "http://127.0.0.1:43991";
// Matches a real OpenCode 2.2.1 server: health lives at /global/health and an
// authenticated /api/health returns 404.
function healthyFetch(url) {
  if (String(url).endsWith("/global/health")) return Promise.resolve({ ok: true, status: 200 });
  return Promise.resolve({ ok: false, status: 404 });
}

function managedOptions(overrides = {}) {
  return { serverUrl: SERVER_URL, fetchFn: healthyFetch, ...overrides };
}

test("Windows OpenCode V2 launch uses a shell-free PowerShell shim", { skip: process.platform !== "win32" }, async (t) => {
  const bin = await mkdtemp(join(tmpdir(), "harnest-opencode-shim-"));
  t.after(() => rm(bin, { recursive: true, force: true }));
  await writeFile(join(bin, "opencode2.ps1"), "# npm shim");
  const savedPath = process.env.PATH;
  const savedPin = process.env.HARNEST_OPENCODE_V2;
  process.env.PATH = bin;
  delete process.env.HARNEST_OPENCODE_V2;
  try {
    const launch = harnessLaunch("opencode");
    assert.equal(launch.command, join(process.env.SystemRoot || process.env.windir, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
    assert.deepEqual(launch.args.slice(0, 2), ["-NoProfile", "-File"]);
    assert.match(launch.args[2], /opencode2\.ps1$/i);
  } finally {
    process.env.PATH = savedPath;
    if (savedPin !== undefined) process.env.HARNEST_OPENCODE_V2 = savedPin;
  }
});

test("managed OpenCode server reports the original spawn error", async () => {
  class SpawnErrorChild extends EventEmitter {
    constructor() {
      super();
      this.stdout = new EventEmitter();
      this.stderr = new EventEmitter();
      queueMicrotask(() => {
        const error = Object.assign(new Error("spawn opencode2 ENOENT"), { code: "ENOENT" });
        this.emit("error", error);
        this.emit("close", -4058, null);
      });
    }
    kill() { return true; }
  }
  const control = new OpenCodeControl({
    spawnFn: () => new SpawnErrorChild(),
    fetchFn: async () => { throw new Error("not listening"); },
    timeoutMs: 100,
    pollMs: 1,
  });
  await assert.rejects(
    control.start({ request: request(), launch: { command: "opencode2", args: [] } }),
    (error) => /ENOENT/.test(error.message) && error.details?.code === "ENOENT",
  );
});

test("an unversioned OpenCode handoff uses V2 argv and extracts identifiers, output, and usage", async () => {
  const calls = [];
  const adapter = new OpenCodeAdapter({
    ...managedOptions(),
    command: "fake-opencode",
    spawnFn(command, args, options) {
      calls.push({ command, args, options });
      return new FakeChild(streamLines());
    },
  });
  const output = await adapter.run(request());

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "fake-opencode");
  assert.deepEqual(calls[0].args.slice(0, 3), ["run", calls[0].args[1], "--format"]);
  assert.deepEqual(calls[0].args.slice(2), ["--format", "json", "--server", SERVER_URL, "--model", "openai/gpt-test#high", "--agent", "reviewer"]);
  assert.ok(!calls[0].args.includes("--auto"));
  assert.equal(calls[0].options.cwd, process.cwd());
  assert.equal(output.route.harnessVersion, "v2");
  assert.match(calls[0].args[1], /req-opencode-001/);
  assert.match(calls[0].args[1], /"model":"gpt-test"/);
  assert.equal(output.sessionId, "session-001");
  assert.equal(output.workflowRunId, null);
  assert.equal(output.result.finalText, "final answer");
  assert.deepEqual(output.usage, { input: 3, output: 6, cacheRead: 2, cacheWrite: 1, cost: 0.01, contextTokens: 9, turns: 1 });
  assert.deepEqual(output.usageSummary, {
    inputTokens: 6,
    uncachedInputTokens: 3,
    inputSemantics: "exclusive",
    outputTokens: 6,
    cacheReadTokens: 2,
    cacheWriteTokens: 1,
    costUsd: 0.01,
  });
});

test("OpenCode rejects granular policies before probing CLI or server", async () => {
  let probes = 0;
  const adapter = new OpenCodeAdapter({
    ...managedOptions({ fetchFn() { probes += 1; throw new Error("must not fetch"); } }),
    command: "fake-opencode",
    spawnFn() { probes += 1; throw new Error("must not spawn"); },
  });
  for (const tools of [["read"], { allow: ["read"] }, { allow: [] }, { deny: ["read"] }]) {
    for (const overrides of [
      {},
      { route: { model: "openai/gpt-test", harnessVersion: "v2" } },
      { execution: { sessionId: "previous", sessionAction: "fork" } },
      { context: { graph: { graphId: "fixture", nodeId: "inspect" } } },
      { context: { dynamic: { runId: "fixture" } } },
    ]) {
      await assert.rejects(adapter.run(request({ policy: { tools }, ...overrides })),
        (error) => error.details?.kind === "policy" && error.details.field === "policy.tools");
    }
  }
  assert.equal(probes, 0);
});

test("OpenCode rejects a missing resume flag before contacting its server", async () => {
  const calls = [];
  const adapter = new OpenCodeAdapter({
    ...managedOptions({ fetchFn() { assert.fail("must not fetch"); } }),
    command: "fake-opencode",
    spawnFn(_command, args) {
      calls.push(args);
      return new FakeChild(["  --fork"]);
    },
  });
  await assert.rejects(adapter.run(request({ execution: { sessionId: "previous" } })), /requires --session support/);
  assert.deepEqual(calls, [["run", "--help"]]);
});

test("foldOpenCodeEvent reports only the usage keys an event actually supplied", () => {
  const state = {
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    finalText: "",
    lastActivity: "",
    terminalSeen: false,
  };
  foldOpenCodeEvent(state, { type: "text", part: { type: "text", text: "hello" } });
  assert.equal(state.usageReported, undefined, "a text event supplies no usage keys");
  const folded = foldOpenCodeEvent(state, {
    type: "step_finish",
    part: { type: "step-finish", reason: "stop", tokens: { input: 3, output: 6, reasoning: 1, total: 9 } },
  });
  assert.deepEqual(folded.usageReported, { input: true, output: true });
});

test("OpenCode keeps unreported cache counters null and explicit zeros as zero", async () => {
  const lines = [
    JSON.stringify({ type: "session.created", properties: { info: { id: "session-nocache" } } }),
    JSON.stringify({ type: "text", sessionID: "session-nocache", part: { type: "text", text: "final answer" } }),
    JSON.stringify({
      type: "step_finish",
      sessionID: "session-nocache",
      part: { type: "step-finish", reason: "stop", tokens: { input: 3, output: 5, reasoning: 1, total: 9 }, cost: 0.01 },
    }),
  ];
  const adapter = new OpenCodeAdapter({
    ...managedOptions(),
    command: "fake-opencode",
    spawnFn: () => new FakeChild(lines),
  });
  const output = await adapter.run(request());

  assert.deepEqual(output.usageReported, { input: true, output: true, cost: true });
  assert.deepEqual(output.usageSummary, {
    inputTokens: null,
    uncachedInputTokens: 3,
    inputSemantics: "exclusive",
    outputTokens: 6,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    costUsd: 0.01,
  });
});

test("passes write policy and launch prefixes without weakening the command contract", async () => {
  const calls = [];
  const config = {
    providers: { test: { package: "@opencode/ai/providers/openai-compatible" } },
    permissions: [{ action: "shell", resource: "*", effect: "deny" }],
  };
  const adapter = new OpenCodeAdapter({
    ...managedOptions(),
    launch: { command: "fake-opencode", args: ["--shim"] },
    env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(config) },
    spawnFn(command, args, options) {
      calls.push({ command, args, options });
      return new FakeChild(streamLines("write-session", "wrote result"));
    },
  });
  const output = await adapter.run(request({ policy: { write: true }, route: { model: "openai/gpt-test" } }));
  assert.equal(calls[0].command, "fake-opencode");
  assert.deepEqual(calls[0].args, ["--shim", "run", calls[0].args[2], "--format", "json", "--server", SERVER_URL, "--model", "openai/gpt-test"]);
  assert.equal(calls[0].options.shell, false);
  assert.match(calls[0].args[2], /"write":true/);
  assert.deepEqual(JSON.parse(calls[0].options.env.OPENCODE_CONFIG_CONTENT), config);
  assert.equal(output.result.finalText, "wrote result");
});

test("OpenCode rejects read-only before probing either a local or attached server", async () => {
  for (const serverUrl of [undefined, SERVER_URL]) {
    const adapter = new OpenCodeAdapter({
      command: "fake-opencode", serverUrl,
      spawnFn() { assert.fail("read-only request reached the CLI"); },
      fetchFn() { assert.fail("read-only request reached the server"); },
    });
    for (const overrides of [
      { policy: undefined },
      { policy: { write: false }, context: { graph: { graphId: "fixture" } } },
      { policy: { write: false }, execution: { sessionId: "previous" } },
      { policy: { write: false }, execution: { sessionId: "previous", sessionAction: "fork" } },
      { policy: { write: false } },
    ]) {
      await assert.rejects(adapter.run(request(overrides)),
        (error) => error.details?.kind === "policy" && error.details.field === "policy.write");
    }
  }
});

test("rejects a missing model before launching OpenCode", async () => {
  let launched = false;
  const adapter = new OpenCodeAdapter({
    ...managedOptions(),
    command: "fake-opencode",
    spawnFn() {
      launched = true;
      return new FakeChild(streamLines());
    },
  });

  await assert.rejects(
    adapter.run(request({ route: {} })),
    /requires an explicit route\.model/,
  );
  assert.equal(launched, false);
});

test("direct OpenCode adapter calls reject unsupported harness versions before launch", async () => {
  let launches = 0;
  const adapter = new OpenCodeAdapter({
    spawnFn() {
      launches += 1;
      throw new Error("spawn must not be reached");
    },
  });
  await assert.rejects(
    adapter.run({
      target: "opencode",
      requestId: "direct-harness-version",
      task: "test",
      cwd: process.cwd(),
      route: { model: "openai/gpt-test", harnessVersion: "v1" },
      execution: { timeoutMs: 5_000 },
    }),
    (error) => error.details?.kind === "validation" && /route\.harnessVersion must be v2 or omitted/.test(error.message),
  );
  assert.equal(launches, 0);
});

test("propagates an external abort and kills the fake process", async () => {
  let child;
  const adapter = new OpenCodeAdapter({
    ...managedOptions(),
    command: "fake-opencode",
    spawnFn() {
      child = new FakeChild([], { hang: true });
      return child;
    },
  });
  const controller = new AbortController();
  const run = adapter.run(request(), { signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  await assert.rejects(run, (error) => error?.details?.kind === "abort");
  assert.equal(child.killed, true);
});

test("V2 uses --server and model#variant, then steers through the Promise client", async () => {
  const calls = [];
  const clientCalls = [];
  const clientFactory = () => ({ session: {
    async prompt(input) { clientCalls.push(["prompt", input]); },
    async switchModel(input) { clientCalls.push(["switchModel", input]); },
  } });
  const adapter = new OpenCodeAdapter({
    ...managedOptions(),
    clientFactory,
    command: "fake-opencode-v2",
    spawnFn(command, args, options) { calls.push({ command, args, options }); return new DelayedChild(streamLines("v2-control-session"), 100); },
  });
  const run = adapter.run(request({ route: { provider: "openai", model: "gpt-test", variant: "max", harnessVersion: "v2" } }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  const ack = await adapter.control({ commandId: "v2-message-1", kind: "message", delivery: "follow_up", message: "continue with the fallback", route: null });
  assert.equal(ack.harnessVersion, "v2");
  assert.equal(clientCalls[0][0], "prompt");
  assert.equal(clientCalls[0][1].sessionID, "v2-control-session");
  assert.match(clientCalls[0][1].id, /^msg_[a-f0-9]{32}$/);
  assert.equal(clientCalls[0][1].text, "continue with the fallback");
  assert.equal(clientCalls[0][1].delivery, "queue");
  await run;
  const runCall = calls.find((call) => call.args.includes("run"));
  assert.ok(runCall.args.includes("--server"));
  assert.ok(runCall.args.includes("--model") && runCall.args.includes("openai/gpt-test#max"));
  assert.ok(!runCall.args.includes("--attach"));
});

test("graph nodes attach to the OpenCode background service as native sidebar sessions", async () => {
  const calls = [];
  const adapter = new OpenCodeAdapter({
    command: "fake-opencode-v2",
    spawnFn(command, args, options) { calls.push({ command, args, options }); return new DelayedChild(streamLines("v2-graph-session"), 100); },
  });
  const run = adapter.run(request({
    context: { graph: { graphId: "graph-fixture", nodeId: "reader" } },
    route: { provider: "opencode-go", model: "deepseek-v4.1-flash", thinking: "high" },
  }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  await assert.rejects(
    adapter.control({ commandId: "graph-message-1", kind: "message", delivery: "follow_up", message: "continue", route: null }),
    (error) => error?.details?.kind === "unsupported-control",
  );
  await run;
  assert.equal(calls.filter((call) => call.args.includes("serve")).length, 0, "graph nodes must not spawn a private server");
  const runCall = calls.find((call) => call.args.includes("run"));
  assert.ok(!runCall.args.includes("--server") && !runCall.args.includes("--standalone") && !runCall.args.includes("--attach"));
});

test("V2 reroute switches model and can omit a message", async () => {
  const calls = [];
  const adapter = new OpenCodeAdapter({
    ...managedOptions(),
    clientFactory: () => ({ session: {
      async prompt(input) { calls.push(["prompt", input]); },
      async switchModel(input) { calls.push(["switchModel", input]); },
    } }),
    command: "fake-opencode-v2",
    spawnFn() { return new DelayedChild(streamLines("v2-reroute-session"), 100); },
  });
  const run = adapter.run(request({ route: { provider: "openai", model: "gpt-test", harnessVersion: "v2" } }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  const ack = await adapter.control({ commandId: "v2-reroute-1", kind: "reroute", delivery: "steer", message: null, route: { provider: "deepseek", model: "deepseek-v4-flash" } });
  assert.equal(ack.model.model, "deepseek-v4-flash");
  assert.deepEqual(calls, [["switchModel", { sessionID: "v2-reroute-session", model: { providerID: "deepseek", id: "deepseek-v4-flash" } }]]);
  await run;
});

test("a control sent during preflight waits for the control server", async () => {
  const clientCalls = [];
  let releaseHelp;
  const helpGate = new Promise((resolve) => { releaseHelp = resolve; });
  const adapter = new OpenCodeAdapter({
    ...managedOptions(),
    clientFactory: () => ({ session: {
      async prompt(input) { clientCalls.push(["prompt", input]); },
      async switchModel(input) { clientCalls.push(["switchModel", input]); },
    } }),
    command: "fake-opencode-v2",
    spawnFn(_command, args) {
      if (args.at(-1) === "--help") {
        const child = new FakeChild(["  --session, -s string"], { hang: true });
        helpGate.then(() => child.emit("close", 0, null));
        return child;
      }
      return new DelayedChild(streamLines("v2-preflight-session"), 100);
    },
  });
  const run = adapter.run(request({ execution: { sessionId: "v2-preflight-session" } }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  const ack = adapter.control({ commandId: "v2-preflight-1", kind: "message", delivery: "steer", message: "sent during preflight", route: null });
  releaseHelp();
  const delivered = await ack;
  assert.equal(delivered.sessionId, "v2-preflight-session");
  assert.equal(clientCalls[0][0], "prompt");
  assert.equal(clientCalls[0][1].text, "sent during preflight");
  assert.equal(clientCalls[0][1].delivery, "steer");
  await run;
});

test("OpenCode reports lost prompt acknowledgements and preserves an applied model switch", async () => {
  const calls = [];
  const control = new OpenCodeControl({ fetchFn: healthyFetch, clientFactory: () => ({ session: {
    async switchModel(input) { calls.push(["switch", input]); },
    async prompt(input) { calls.push(["prompt", input]); throw new Error("connection closed before acknowledgement"); },
  } }) });
  await control.start({ serverUrl: SERVER_URL });
  control.setSessionId("ack-session");
  await assert.rejects(control.control({ kind: "message", message: "first" }), (error) => {
    assert.equal(error.details.uncertain, true);
    assert.equal(error.details.modelSwitchApplied, undefined);
    return true;
  });
  await assert.rejects(control.control({ kind: "reroute", route: { provider: "fixture", model: "new-model" }, message: "second" }), (error) => {
    assert.equal(error.details.uncertain, true);
    assert.equal(error.details.modelSwitchApplied, true);
    assert.deepEqual(error.details.model, { provider: "fixture", model: "new-model", variant: undefined });
    return true;
  });
  assert.deepEqual(calls.map(([kind]) => kind), ["prompt", "switch", "prompt"]);
  assert.ok(calls.every(([, input]) => input.sessionID === "ack-session"));
});

test("OpenCode skips the prompt when the run stops during a model switch", async () => {
  const calls = [];
  let finishSwitch;
  const switching = new Promise((resolve) => { finishSwitch = resolve; });
  const control = new OpenCodeControl({ fetchFn: healthyFetch, clientFactory: () => ({ session: {
    async switchModel(input) { calls.push(["switch", input]); await switching; },
    async prompt(input) { calls.push(["prompt", input]); },
  } }) });
  await control.start({ serverUrl: SERVER_URL });
  control.setSessionId("stop-session");
  const pending = control.control({ kind: "reroute", route: { provider: "fixture", model: "new-model" }, message: "late" });
  await new Promise((resolve) => setImmediate(resolve));
  await control.stop();
  finishSwitch();
  await assert.rejects(pending, (error) => {
    assert.equal(error.details.kind, "not-ready");
    assert.equal(error.details.modelSwitchApplied, true);
    return true;
  });
  assert.deepEqual(calls.map(([kind]) => kind), ["switch"]);
});

test("default V2 handoff starts and cleans up a private server", async () => {
  let serverChild;
  const calls = [];
  const adapter = new OpenCodeAdapter({
    command: "fake-opencode",
    serverPort: 43992,
    fetchFn: healthyFetch,
    spawnFn(command, args) {
      calls.push(args);
      if (args.includes("serve")) {
        serverChild = new DelayedChild([], 10_000);
        return serverChild;
      }
      return new FakeChild(streamLines("managed-session"));
    },
  });
  const output = await adapter.run(request());
  assert.deepEqual(calls[0], ["serve", "--hostname", "127.0.0.1", "--port", "43992"]);
  assert.equal(calls[1][calls[1].indexOf("--server") + 1], "http://127.0.0.1:43992");
  assert.equal(output.route.harnessVersion, "v2");
  assert.equal(serverChild.killed, true);
});

test("attached server readiness uses /global/health, where OpenCode V2 serves health", async () => {
  const probed = [];
  const control = new OpenCodeControl({
    fetchFn(url) { probed.push(new URL(url).pathname); return healthyFetch(url); },
    clientFactory: () => ({ session: {} }),
  });
  await control.start({ serverUrl: SERVER_URL });
  assert.deepEqual(probed, ["/global/health"]);
  await control.stop();
});

test("a stalled OpenCode health probe stops at the readiness deadline", async (t) => {
  const timeoutMs = 60;
  const caller = new AbortController();
  const watchdog = setTimeout(() => caller.abort(), 1_000);
  t.after(() => clearTimeout(watchdog));
  const probes = [];
  const control = new OpenCodeControl({
    timeoutMs,
    fetchFn(_url, { signal }) {
      const probe = { signal, abortedAt: null };
      probes.push(probe);
      return new Promise((_resolve, reject) => {
        const abort = () => { probe.abortedAt = performance.now(); reject(signal.reason); };
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
    },
  });
  control.serverUrl = SERVER_URL;

  const start = performance.now();
  await assert.rejects(control.waitReady(caller.signal), (error) => error.details?.kind === "not-ready");
  const rejectedAt = performance.now();
  const elapsed = rejectedAt - start;
  assert.ok(elapsed >= timeoutMs - 10 && elapsed < timeoutMs + 400, `readiness rejected after ${elapsed}ms`);
  // The deadline must cancel the stalled request itself, not just stop waiting for it.
  assert.equal(caller.signal.aborted, false, "the caller's watchdog must not be what ended the wait");
  assert.ok(probes.length > 0, "at least one health probe ran");
  for (const probe of probes) {
    assert.ok(probe.signal, "each health probe receives an AbortSignal");
    assert.ok(probe.abortedAt !== null && probe.abortedAt <= rejectedAt, "each stalled probe is aborted before waitReady rejects");
  }
});

test("caller cancellation aborts the in-flight OpenCode readiness probe", { timeout: 5_000 }, async () => {
  const caller = new AbortController();
  const reason = new Error("cancel readiness");
  let probeSignal;
  let probeAbortReason;
  const control = new OpenCodeControl({
    fetchFn(_url, { signal }) {
      probeSignal = signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          probeAbortReason = signal.reason;
          reject(signal.reason);
        }, { once: true });
      });
    },
  });
  control.serverUrl = SERVER_URL;

  const readiness = assert.rejects(control.waitReady(caller.signal), (error) => error.details?.kind === "aborted");
  assert.equal(probeSignal?.aborted, false, "a probe must be in flight before cancellation");
  caller.abort(reason);
  await readiness;
  assert.equal(probeAbortReason, reason);
});

test("control rejects cleanly before the managed server is ready", async () => {
  const control = new OpenCodeControl({ serverUrl: SERVER_URL });
  await assert.rejects(control.control({ commandId: "not-ready", kind: "message", delivery: "steer", message: "x" }), (error) => error?.details?.kind === "not-ready");
});

test("managed server authenticates with OPENCODE_SERVER_PASSWORD from the spawn environment", async () => {
  const probes = [];
  const control = new OpenCodeControl({
    spawnFn(command, args, options) {
      assert.deepEqual(options.env, { OPENCODE_SERVER_PASSWORD: "hunter2" });
      return new FakeChild(["opencode server listening on http://127.0.0.1:43993"], { hang: true });
    },
    fetchFn(url, init) {
      probes.push({ url: String(url), headers: init?.headers });
      return Promise.resolve({ ok: true, status: 200 });
    },
    timeoutMs: 500,
    pollMs: 1,
  });
  await control.start({
    request: request(),
    launch: { command: "fake-opencode-v2", args: [] },
    env: { OPENCODE_SERVER_PASSWORD: "hunter2" },
  });

  assert.ok(probes.length > 0, "readiness probes ran");
  assert.equal(
    probes[0].headers?.authorization,
    `Basic ${Buffer.from("opencode:hunter2").toString("base64")}`,
    "probe authenticates with the spawn environment password",
  );
  await control.stop();
});

test("classifies OpenCode SQLite project_id error with actionable non-destructive recovery", async () => {
  const originalStderr = "sqlite error: no such column: project_id - SELECT * FROM sessions";
  class FailingChild extends EventEmitter {
    constructor() {
      super();
      this.stdout = new EventEmitter();
      this.stderr = new EventEmitter();
      this.killed = false;
      queueMicrotask(() => {
        this.stderr.emit("data", Buffer.from(originalStderr));
        this.emit("close", 1, null);
      });
    }
    kill() { this.killed = true; return true; }
  }
  const adapter = new OpenCodeAdapter({
    ...managedOptions(),
    command: "fake-opencode",
    spawnFn() {
      return new FailingChild();
    },
  });

  await assert.rejects(
    adapter.run(request()),
    (error) => {
      assert.match(error.message, /no such column: project_id/i, "original cause preserved in message");
      assert.match(error.message, /back\s*up/i, "recovery says backup");
      assert.match(error.message, /update/i, "recovery says update");
      assert.match(error.message, /restart/i, "recovery says restart");
      assert.match(error.message, /retry/i, "recovery says retry");
      // must not hide original stderr/cause
      const stderr = String(error.details?.stderr || "");
      const combined = `${stderr} ${error.message}`;
      assert.match(combined, /project_id/i);
      // recovery must not suggest destructive auto-healing; if mentions delete/migrate/overwrite it must be negated
      const msgLower = error.message.toLowerCase();
      if (/delete|migrate|overwrite/.test(msgLower)) {
        assert.ok(msgLower.includes("do not") || msgLower.includes("don't"), "destructive ops must be negated");
      }
      return true;
    },
  );
});

test("classifies an OpenCode provider.auth billing envelope as provider-auth", async () => {
  const adapter = new OpenCodeAdapter({
    ...managedOptions(),
    command: "fake-opencode",
    spawnFn() {
      return new FailingFakeChild([JSON.stringify({
        type: "error",
        error: {
          type: "provider.auth",
          message: "Insufficient balance for sk-live-1234567890abcdef; top up the billing account",
          status: 401,
        },
      })]);
    },
  });

  await assert.rejects(
    adapter.run(request({ route: { provider: "opencode", model: "gpt-6-astra" } })),
    (error) => {
      assert.equal(error.details?.kind, "provider-auth");
      assert.equal(error.details?.category, "billing");
      assert.equal(error.details?.status, 401);
      assert.match(error.message, /OpenCode provider authorization failure \(HTTP 401\)/);
      assert.match(error.message, /Insufficient balance/);
      assert.match(error.details?.providerError?.message || "", /Insufficient balance/);
      assert.ok(error.details.providerError.message.length <= 400, "provider reason is bounded");
      assert.ok(
        !JSON.stringify(error.details).includes("sk-live-1234567890abcdef"),
        "credential-looking provider text is redacted",
      );
      return true;
    },
  );
});

test("classifies a 403 region/opt-in rejection as provider-auth", async () => {
  const adapter = new OpenCodeAdapter({
    ...managedOptions(),
    command: "fake-opencode",
    spawnFn() {
      return new FailingFakeChild([JSON.stringify({
        type: "error",
        error: {
          type: "provider.auth",
          message: "HTTP 403: regional opt-in required for this provider in your region",
          status: 403,
        },
      })]);
    },
  });

  await assert.rejects(
    adapter.run(request({ route: { provider: "deepseek", model: "deepseek-v4-flash" } })),
    (error) => {
      assert.equal(error.details?.kind, "provider-auth");
      assert.equal(error.details?.category, "region");
      assert.equal(error.details?.status, 403);
      assert.match(error.message, /regional opt-in required/);
      return true;
    },
  );
});

test("classifies a model-not-found envelope as unavailable", async () => {
  const adapter = new OpenCodeAdapter({
    ...managedOptions(),
    command: "fake-opencode",
    spawnFn() {
      return new FailingFakeChild([JSON.stringify({
        type: "error",
        error: {
          type: "model.not_found",
          message: "model 'opencode/gpt-6-astra' not found in the provider catalog",
          status: 404,
        },
      })]);
    },
  });

  await assert.rejects(
    adapter.run(request({ route: { provider: "opencode", model: "gpt-6-astra" } })),
    (error) => {
      assert.equal(error.details?.kind, "unavailable");
      assert.equal(error.details?.category, "not-found");
      assert.equal(error.details?.status, 404);
      assert.match(error.message, /OpenCode model availability failure \(HTTP 404\)/);
      return true;
    },
  );
});

test("provider classification never fires on healthy run text", async () => {
  const text = "the unauthorized region billing credentials_not_configured review is complete";
  const adapter = new OpenCodeAdapter({
    ...managedOptions(),
    command: "fake-opencode",
    spawnFn() {
      return new FakeChild(streamLines("healthy-classification-session", text));
    },
  });

  const output = await adapter.run(request());
  assert.equal(output.result.finalText, text);
});

test("spawned OpenCode inherits the parent environment for provider authorization", async () => {
  const calls = [];
  const sentinelKey = "HARNEST_TEST_PROVIDER_ENV";
  const saved = process.env[sentinelKey];
  process.env[sentinelKey] = "inherited";
  try {
    const adapter = new OpenCodeAdapter({
      ...managedOptions(),
      command: "fake-opencode",
      spawnFn(command, args, options) {
        calls.push({ command, args, options });
        return new FakeChild(streamLines("env-session"));
      },
    });
    await adapter.run(request());
  } finally {
    if (saved === undefined) delete process.env[sentinelKey];
    else process.env[sentinelKey] = saved;
  }

  assert.equal(calls.length, 1);
  const env = calls[0].options.env;
  assert.equal(env[sentinelKey], "inherited");
  assert.ok(process.env.HOME !== undefined || process.env.USERPROFILE !== undefined, "test host exposes a home variable");
  // Windows keeps the original casing ("Path") inside a plain env object while
  // process.env reads case-insensitively; compare per-key case-insensitively.
  const envKeys = new Map(Object.keys(env).map((key) => [key.toLowerCase(), key]));
  for (const key of ["HOME", "USERPROFILE", "APPDATA", "PATH", "OPENCODE_API_KEY", "OPENCODE_GO_API_KEY"]) {
    if (process.env[key] === undefined) continue;
    const actualKey = envKeys.get(key.toLowerCase());
    assert.ok(actualKey, `spawned env inherits ${key}`);
    assert.equal(env[actualKey], process.env[key], `spawned env inherits ${key}`);
  }
});

test("private OpenCode V2 server failures name the missing provider authorization", async () => {
  const adapter = new OpenCodeAdapter({
    ...managedOptions(),
    command: "fake-opencode-v2",
    spawnFn() {
      return new SilentFailureChild(1);
    },
  });

  await assert.rejects(
    adapter.run(request({ route: { provider: "opencode", model: "gpt-6-astra", harnessVersion: "v2" } })),
    (error) => {
      assert.equal(error.details?.kind, "unavailable");
      assert.equal(error.details?.privateServer, true);
      const combined = `${error.message} ${error.details?.hint || ""}`;
      assert.match(combined, /private OpenCode V2 server/i);
      assert.match(combined, /may lack the caller's provider authorization/i);
      return true;
    },
  );
});
