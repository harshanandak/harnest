import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { PiAdapter, PiAdapterError, isClaudeRoute, resolveTaskflowExtensionPath } from "../src/adapters/pi.mjs";

class FakeChild extends EventEmitter {
  constructor(onCommand) {
    super();
    this.commands = [];
    this.killed = false;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdin = {
      write: (line) => {
        const command = JSON.parse(line);
        this.commands.push(command);
        onCommand(command, this);
        return true;
      },
    };
  }

  emitJson(value) {
    this.stdout.emit("data", Buffer.from(`${JSON.stringify(value)}\n`));
  }

  kill() {
    this.killed = true;
    queueMicrotask(() => this.emit("close", null, "SIGTERM"));
    return true;
  }
}

function request(cwd, overrides = {}) {
  return {
    protocolVersion: "1.0",
    requestId: "req-pi-001",
    target: "pi",
    task: "Inspect the repository and report the result.",
    cwd,
    context: { source: "test", files: ["README.md"] },
    contextDigest: "a".repeat(64),
    workflow: null,
    route: {},
    execution: { background: false, timeoutMs: 5_000, sessionId: null },
    policy: { write: false, tools: [] },
    metadata: {},
    ...overrides,
  };
}

function state() {
  return {
    sessionId: "session-pi-001",
    model: { provider: "openai", id: "gpt-test" },
    thinkingLevel: "high",
  };
}

test("Pi checks the active default before sending any prompt", async () => {
  for (const model of [{ provider: "anthropic", id: "claude-opus" }, { provider: "gateway", id: "anthropic/opus" }, null]) {
    const child = new FakeChild((command, instance) => {
      if (command.type === "get_state") instance.emitJson({ type: "response", id: command.id, command: "get_state", success: true, data: { model } });
    });
    const adapter = new PiAdapter({ command: "fake-pi", spawnFn: () => child });
    await assert.rejects(adapter.run(request(process.cwd())), (error) => error.details?.kind === "policy");
    assert.equal(child.commands.some((command) => command.type === "prompt"), false);
    assert.equal(child.killed, true);
  }
});

function terminalChildFactory({ finalText = "workflow output", withTaskflow = false, taskflowState = true, assistantError = null, stats = null } = {}) {
  let child;
  let launch;
  const spawnFn = (command, args, _options) => {
    launch = { command, args };
    child = new FakeChild((command, instance) => {
      if (command.type === "get_state") {
        instance.emitJson({ type: "response", id: command.id, command: "get_state", success: true, data: state() });
      } else if (command.type === "prompt") {
        instance.emitJson({ type: "response", id: command.id, command: "prompt", success: true });
        if (withTaskflow) {
          instance.emitJson({
            type: "message_end",
            message: {
              role: "toolResult",
              toolName: "taskflow",
              isError: false,
              content: [{ type: "text", text: finalText }],
              details: {
                action: "run",
                finalOutput: finalText,
                ...(taskflowState
                  ? { state: { runId: "run-pi-001", flowName: "review", status: "completed", totalUsage: { totalTokens: 7 } } }
                  : {}),
              },
            },
          });
        }
        instance.emitJson({
          type: "message_end",
          message: assistantError
            ? { role: "assistant", stopReason: "error", errorMessage: assistantError, content: [] }
            : { role: "assistant", content: [{ type: "text", text: finalText }] },
        });
        instance.emitJson({ type: "agent_settled" });
      } else if (command.type === "get_last_assistant_text") {
        instance.emitJson({ type: "response", id: command.id, command: "get_last_assistant_text", success: true, data: { text: finalText } });
      } else if (command.type === "get_session_stats") {
        instance.emitJson({
          type: "response",
          id: command.id,
          command: "get_session_stats",
          success: true,
          data: stats ?? { sessionId: "session-pi-001", tokens: { total: 7 }, cost: 0 },
        });
      } else if (command.type === "abort") {
        instance.kill();
      }
    });
    return child;
  };
  return { spawnFn, get child() { return child; }, get launch() { return launch; } };
}

test("surfaces the provider error instead of a missing taskflow result", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "harnest-pi-provider-error-"));
  const providerError = "404: no endpoints satisfy the configured routing policy";
  const fake = terminalChildFactory({ assistantError: providerError });
  const adapter = new PiAdapter({ command: "fake-pi", taskflowExtensionPath: "C:\\pinned\\pi-taskflow\\dist\\index.js", spawnFn: fake.spawnFn });

  await assert.rejects(
    adapter.run(request(cwd, {
      workflow: {
        engine: "taskflow",
        spec: { name: "review", phases: [{ id: "final", task: "Review.", final: true }] },
      },
    })),
    (error) => error?.message === providerError && error?.details?.kind === "downstream",
  );
});

test("Pi prompt orders the stable context before the variable tail", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "harnest-pi-prefix-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const fake = terminalChildFactory({ finalText: "plain answer", withTaskflow: false });
  const adapter = new PiAdapter({ command: "fake-pi", spawnFn: fake.spawnFn });
  const output = await adapter.run(request(cwd, { workflow: null }));
  assert.equal(output.result.finalText, "plain answer");
  const prompt = fake.child.commands.find((command) => command.type === "prompt").message;
  assert.ok(prompt.indexOf('"context"') < prompt.indexOf('"task"'), "context precedes the variable task");
  assert.ok(prompt.indexOf('"task"') < prompt.indexOf('"requestId"'), "requestId follows the task");
  assert.ok(prompt.indexOf("req-pi-001") > prompt.indexOf('"context"'), "no request id precedes the stable prefix");
});

test("Pi normalizes the installed get_session_stats shape and never invents a cache value", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "harnest-pi-usage-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const stats = {
    sessionId: "session-pi-001",
    tokens: { input: 12, output: 4, cacheRead: 8, cacheWrite: 2, total: 26 },
    cost: 0.03,
  };
  const fake = terminalChildFactory({ finalText: "usage answer", stats });
  const adapter = new PiAdapter({ command: "fake-pi", spawnFn: fake.spawnFn });
  const output = await adapter.run(request(cwd, { workflow: null }));
  assert.deepEqual(output.usage, stats);
  assert.deepEqual(output.usageSummary, {
    inputTokens: 22,
    uncachedInputTokens: 12,
    inputSemantics: "exclusive",
    outputTokens: 4,
    cacheReadTokens: 8,
    cacheWriteTokens: 2,
    costUsd: 0.03,
  });
});

test("runs a FlowSpec through Pi's /tf path and returns taskflow identity", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "harnest-pi-"));
  const fake = terminalChildFactory({ finalText: "saved flow result", withTaskflow: true });
  const adapter = new PiAdapter({
    command: "fake-pi",
    taskflowExtensionPath: "C:\\pinned\\pi-taskflow\\dist\\index.js",
    spawnFn: fake.spawnFn,
  });
  try {
    const output = await adapter.run(request(cwd, {
      route: { provider: "openai", model: "gpt-test", thinking: "high" },
      policy: { write: false, tools: ["write"] },
      execution: { timeoutMs: 5_000, sessionId: "session-pi-001" },
      workflow: {
        engine: "taskflow",
        name: "review",
        spec: { name: "review", phases: [{ id: "final", task: "Review the repository.", final: true }] },
        args: { branch: "main" },
      },
    }));
    assert.equal(output.sessionId, "session-pi-001");
    assert.equal(output.workflowRunId, "run-pi-001");
    assert.equal(output.result.finalText, "saved flow result");
    assert.deepEqual(output.usage.tokens, { total: 7 });
    assert.equal(output.route.provider, "openai");
    assert.equal(output.route.model, "gpt-test");
    assert.equal(output.route.thinking, "high");
    assert.deepEqual(fake.launch.args.slice(0, 8), [
      "--mode",
      "rpc",
      "--extension",
      "C:\\pinned\\pi-taskflow\\dist\\index.js",
      "--provider",
      "openai",
      "--model",
      "gpt-test",
    ]);
    assert.equal(fake.launch.args[8], "--thinking");
    assert.equal(fake.launch.args[9], "high");
    const toolList = fake.launch.args[fake.launch.args.indexOf("--tools") + 1].split(",");
    assert.ok(toolList.includes("read"));
    assert.ok(toolList.includes("taskflow"));
    assert.ok(!toolList.includes("write"));
    const prompt = fake.child.commands.find((command) => command.type === "prompt");
    assert.match(prompt.message, /^\/tf:review--req-pi-001-/);
    assert.match(prompt.message, /req-pi-001/);
    assert.match(prompt.message, /branch=main/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("steers, queues, and reroutes through the active Pi RPC channel", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "harnest-pi-control-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  let child;
  let finish;
  const spawnFn = () => {
    child = new FakeChild((command, instance) => {
      if (command.type === "get_state") {
        instance.emitJson({ type: "response", id: command.id, command: "get_state", success: true, data: state() });
      } else if (command.type === "prompt") {
        instance.emitJson({ type: "response", id: command.id, command: "prompt", success: true });
        finish = () => {
          instance.emitJson({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "controlled result" }] } });
          instance.emitJson({ type: "agent_settled" });
        };
      } else if (["steer", "follow_up", "set_model"].includes(command.type)) {
        instance.emitJson({ type: "response", id: command.id, command: command.type, success: true, data: command.type === "set_model" ? { provider: command.provider, id: command.modelId } : undefined });
      } else if (command.type === "get_last_assistant_text") {
        instance.emitJson({ type: "response", id: command.id, command: command.type, success: true, data: { text: "controlled result" } });
      } else if (command.type === "get_session_stats") {
        instance.emitJson({ type: "response", id: command.id, command: command.type, success: true, data: { tokens: { total: 3 } } });
      }
    });
    return child;
  };
  const adapter = new PiAdapter({ command: "fake-pi", spawnFn });
  const run = adapter.run(request(cwd));
  for (let attempt = 0; attempt < 20 && !finish; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  const steer = await adapter.control({
    kind: "message",
    commandId: "pi-steer-1",
    message: "Review the timeout path.",
    delivery: "steer",
  });
  assert.equal(steer.command, "steer");
  const reroute = await adapter.control({
    kind: "reroute",
    commandId: "pi-route-1",
    route: { provider: "openrouter", model: "deepseek/deepseek-v4-flash-0731" },
    message: "Continue after switching.",
    delivery: "follow_up",
  });
  assert.equal(reroute.command, "set_model");
  assert.equal(reroute.messageCommand, "follow_up");
  assert.deepEqual(child.commands.filter((command) => ["steer", "follow_up", "set_model"].includes(command.type)).map((command) => command.type), [
    "steer",
    "set_model",
    "follow_up",
  ]);

  finish();
  const output = await run;
  assert.equal(output.result.finalText, "controlled result");
});

test("translates workflow nodes into the deterministic Pi slash-command path", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "harnest-pi-"));
  const fake = terminalChildFactory({ finalText: "node graph result", withTaskflow: true });
  const adapter = new PiAdapter({ command: "fake-pi", taskflowExtensionPath: "C:\\pinned\\pi-taskflow\\dist\\index.js", spawnFn: fake.spawnFn });
  try {
    const output = await adapter.run(request(cwd, {
      workflow: {
        name: "node-graph",
        nodes: [
          { id: "inspect", prompt: "Inspect", dependsOn: [] },
          { id: "verify", prompt: "Verify", dependsOn: ["inspect"] },
        ],
      },
    }));
    assert.equal(output.result.finalText, "node graph result");
    const prompt = fake.child.commands.find((command) => command.type === "prompt");
    assert.match(prompt.message, /^\/tf:node-graph--req-pi-001-/);
    assert.equal(output.workflowRunId, "run-pi-001");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a saved FlowSpec cannot complete from unrelated assistant text", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "harnest-pi-"));
  const fake = terminalChildFactory({ finalText: "unrelated agent catalog", withTaskflow: false });
  const adapter = new PiAdapter({ command: "fake-pi", taskflowExtensionPath: "C:\\pinned\\pi-taskflow\\dist\\index.js", spawnFn: fake.spawnFn });
  try {
    await assert.rejects(
      adapter.run(request(cwd, {
        workflow: { name: "must-run", spec: { name: "must-run", phases: [{ id: "final", task: "Run", final: true }] } },
      })),
      /without a taskflow terminal result/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a saved FlowSpec requires an explicit completed taskflow state", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "harnest-pi-"));
  const fake = terminalChildFactory({ finalText: "plausible output", withTaskflow: true, taskflowState: false });
  const adapter = new PiAdapter({ command: "fake-pi", taskflowExtensionPath: "C:\\pinned\\pi-taskflow\\dist\\index.js", spawnFn: fake.spawnFn });
  try {
    await assert.rejects(
      adapter.run(request(cwd, {
        workflow: { name: "state-required", spec: { name: "state-required", phases: [{ id: "final", task: "Run", final: true }] } },
      })),
      /Pi taskflow did not report completed state/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("the same request produces the same deterministic Pi flow command", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "harnest-pi-"));
  const workflow = { name: "stable", nodes: [{ id: "final", prompt: "Run", dependsOn: [] }] };
  try {
    const firstFake = terminalChildFactory({ finalText: "first", withTaskflow: true });
    const secondFake = terminalChildFactory({ finalText: "second", withTaskflow: true });
    await new PiAdapter({ command: "fake-pi", taskflowExtensionPath: "C:\\pinned\\pi-taskflow\\dist\\index.js", spawnFn: firstFake.spawnFn }).run(request(cwd, { workflow }));
    await new PiAdapter({ command: "fake-pi", taskflowExtensionPath: "C:\\pinned\\pi-taskflow\\dist\\index.js", spawnFn: secondFake.spawnFn }).run(request(cwd, { workflow }));
    const firstPrompt = firstFake.child.commands.find((command) => command.type === "prompt").message;
    const secondPrompt = secondFake.child.commands.find((command) => command.type === "prompt").message;
    assert.equal(firstPrompt, secondPrompt);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a plain prompt runs natively without loading Taskflow", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "harnest-pi-"));
  const fake = terminalChildFactory({ finalText: "prompt result" });
  const adapter = new PiAdapter({ command: "fake-pi", spawnFn: fake.spawnFn });
  try {
    const output = await adapter.run(request(cwd));
    assert.equal(output.result.finalText, "prompt result");
    const prompt = fake.child.commands.find((command) => command.type === "prompt");
    assert.match(prompt.message, /Execute the assigned task directly/);
    assert.doesNotMatch(prompt.message, /invoke the taskflow tool/i);
    assert.match(prompt.message, /Do not invoke Taskflow or create a separate workflow/);
    assert.match(prompt.message, /req-pi-001/);
    assert.match(prompt.message, /contextDigest/);
    assert.ok(!fake.launch.args.includes("--extension"), "plain Pi runs must not load an extension");
    const toolList = fake.launch.args[fake.launch.args.indexOf("--tools") + 1].split(",");
    assert.ok(!toolList.includes("taskflow"), "plain Pi runs must not expose the taskflow tool");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("an explicit Taskflow extension override is used without resolving the optional package", () => {
  assert.equal(resolveTaskflowExtensionPath("C:\\pinned\\pi-taskflow\\dist\\index.js"), "C:\\pinned\\pi-taskflow\\dist\\index.js");
});

test("propagates abort without spending a model call", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "harnest-pi-"));
  let child;
  const spawnFn = (_command, _args, _options) => {
    child = new FakeChild((command, instance) => {
      if (command.type === "abort") instance.kill();
    });
    return child;
  };
  const controller = new AbortController();
  const adapter = new PiAdapter({ command: "fake-pi", spawnFn });
  try {
    const running = adapter.run(request(cwd), { signal: controller.signal });
    controller.abort();
    await assert.rejects(running, (error) => {
      assert.ok(error instanceof PiAdapterError);
      assert.equal(error.details.kind, "aborted");
      assert.equal(error.details.aborted, true);
      return true;
    });
    assert.ok(child.killed);
    assert.ok(child.commands.some((command) => command.type === "abort"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("graph node runs directly instead of asking Pi to create another Taskflow", async () => {
  const fake = terminalChildFactory({ finalText: "node result" });
  const adapter = new PiAdapter({ command: "fake-pi", spawnFn: fake.spawnFn });
  const output = await adapter.run(request(process.cwd(), { context: { graph: { graphId: "graph-fixture", nodeId: "synthesis", upstream: { review: { result: { finalText: "attributed evidence" } } } } } }));
  assert.equal(output.result.finalText, "node result");
  const prompts = fake.child.commands.filter(command => command.type === "prompt");
  assert.equal(prompts.length, 1);
  assert.match(prompts[0].message, /Execute this single agent-graph node directly/);
  assert.doesNotMatch(prompts[0].message, /invoke the taskflow tool with action=run/);
  assert.match(prompts[0].message, /attributed evidence/);
});

test("propagates a wall timeout and terminates the RPC process", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "harnest-pi-"));
  let child;
  const spawnFn = (_command, _args, _options) => {
    child = new FakeChild(() => undefined);
    return child;
  };
  const adapter = new PiAdapter({ command: "fake-pi", spawnFn });
  try {
    await assert.rejects(adapter.run(request(cwd, { execution: { timeoutMs: 5, sessionId: null } })), (error) => {
      assert.ok(error instanceof PiAdapterError);
      assert.equal(error.details.kind, "timeout");
      assert.equal(error.details.timedOut, true);
      return true;
    });
    assert.ok(child.killed);
    assert.ok(child.commands.some((command) => command.type === "abort"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("fails a terminal RPC with no downstream final output", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "harnest-pi-"));
  const fake = terminalChildFactory({ finalText: "" });
  const adapter = new PiAdapter({ command: "fake-pi", spawnFn: fake.spawnFn });
  try {
    await assert.rejects(adapter.run(request(cwd)), (error) => {
      assert.ok(error instanceof PiAdapterError);
      assert.equal(error.details.kind, "downstream");
      assert.match(error.message, /without final downstream output/);
      return true;
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("prompt-only runs prefer the post-steer assistant text over the stale taskflow output", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "harnest-pi-steer-"));
  let child;
  let launch;
  const spawnFn = (command, args, _options) => {
    launch = { command, args };
    child = new FakeChild((command, instance) => {
      if (command.type === "get_state") {
        instance.emitJson({ type: "response", id: command.id, command: "get_state", success: true, data: state() });
      } else if (command.type === "prompt") {
        instance.emitJson({ type: "response", id: command.id, command: "prompt", success: true });
        instance.emitJson({
          type: "message_end",
          message: {
            role: "toolResult",
            toolName: "taskflow",
            isError: false,
            content: [{ type: "text", text: "ORIGINAL_RESULT" }],
            details: {
              action: "run",
              finalOutput: "ORIGINAL_RESULT",
              state: { runId: "run-pi-002", flowName: "task", status: "completed", totalUsage: { totalTokens: 7 } },
            },
          },
        });
        instance.emitJson({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "STEER_APPLIED" }] } });
        instance.emitJson({ type: "agent_settled" });
      } else if (command.type === "get_last_assistant_text") {
        instance.emitJson({ type: "response", id: command.id, command: "get_last_assistant_text", success: true, data: { text: "STEER_APPLIED" } });
      } else if (command.type === "get_session_stats") {
        instance.emitJson({
          type: "response",
          id: command.id,
          command: "get_session_stats",
          success: true,
          data: { sessionId: "session-pi-002", tokens: { total: 7 }, cost: 0 },
        });
      } else if (command.type === "abort") {
        instance.kill();
      }
    });
    return child;
  };
  const adapter = new PiAdapter({ command: "fake-pi", spawnFn });
  try {
    const output = await adapter.run(request(cwd));
    assert.equal(output.result.finalText, "STEER_APPLIED");
    assert.equal(output.workflowRunId, "run-pi-002");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Pi refuses Claude models at start and reroute (Claude Code CLI only)", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "harnest-pi-claude-gate-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  assert.equal(isClaudeRoute({ provider: "anthropic", model: "sonnet" }), true);
  assert.equal(isClaudeRoute({ provider: "anthropic-vertex", model: "whatever" }), true);
  assert.equal(isClaudeRoute({ provider: "openrouter", model: "anthropic/claude-opus-4-6" }), true);
  assert.equal(isClaudeRoute({ model: "claude-sonnet-4-6" }), true);
  assert.equal(isClaudeRoute({ model: "opus" }), true);
  assert.equal(isClaudeRoute({ model: "sonnet-4-6" }), true);
  assert.equal(isClaudeRoute(null), false);
  assert.equal(isClaudeRoute({ provider: "openrouter", model: "openai/gpt-6-astra" }), false);
  assert.equal(isClaudeRoute({}), false);
  const adapter = new PiAdapter({
    command: "fake-pi",
    spawnFn() { throw new Error("Claude gate must fail before spawning"); },
  });
  await assert.rejects(
    adapter.run(request(cwd, { route: { provider: "anthropic", model: "claude-sonnet-4-6" } })),
    (error) => error instanceof PiAdapterError
      && error.details?.kind === "policy"
      && /target "claude"/.test(error.message),
  );
  await assert.rejects(
    adapter.control({
      commandId: "claude-reroute-1", kind: "reroute", delivery: "steer", message: null,
      route: { provider: "openrouter", model: "anthropic/claude-x" },
    }),
    (error) => error instanceof PiAdapterError && error.details?.kind === "policy",
  );
});

test("classifies a missing provider credential as provider-auth and names the provider", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "harnest-pi-credential-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const child = new FakeChild((command, instance) => {
    if (command.type === "get_state") {
      instance.emitJson({
        type: "response",
        id: command.id,
        command: "get_state",
        success: true,
        data: {
          sessionId: "session-pi-credential",
          model: { provider: "deepseek", id: "deepseek-v4-flash" },
          thinkingLevel: "off",
        },
      });
    } else if (command.type === "prompt") {
      instance.emitJson({ type: "response", id: command.id, command: "prompt", success: true });
      instance.emitJson({
        type: "message_end",
        message: {
          role: "assistant",
          provider: "deepseek",
          model: "deepseek-v4-flash",
          stopReason: "error",
          errorMessage: "credentials_not_configured",
          content: [],
        },
      });
    } else if (command.type === "abort") {
      instance.kill();
    }
  });
  const adapter = new PiAdapter({ command: "fake-pi", spawnFn: () => child });

  await assert.rejects(
    adapter.run(request(cwd, { route: { provider: "deepseek", model: "deepseek-v4-flash" } })),
    (error) => {
      assert.equal(error.details?.kind, "provider-auth");
      assert.equal(error.details?.provider, "deepseek");
      assert.match(error.message, /deepseek/);
      assert.match(error.message, /credentials_not_configured/);
      assert.match(error.details?.hint || "", /pi auth login --provider deepseek/);
      assert.match(error.details?.hint || "", /credential/i);
      return true;
    },
  );
  assert.equal(child.killed, true);
});

test("classifies a failed prompt response that reports a missing provider credential", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "harnest-pi-credential-response-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const child = new FakeChild((command, instance) => {
    if (command.type === "get_state") {
      instance.emitJson({ type: "response", id: command.id, command: "get_state", success: true, data: state() });
    } else if (command.type === "prompt") {
      instance.emitJson({
        type: "response",
        id: command.id,
        command: "prompt",
        success: false,
        error: "No API key for provider: openai",
      });
    } else if (command.type === "abort") {
      instance.kill();
    }
  });
  const adapter = new PiAdapter({ command: "fake-pi", spawnFn: () => child });

  await assert.rejects(
    adapter.run(request(cwd, { route: { provider: "openai", model: "gpt-test" } })),
    (error) => {
      assert.equal(error.details?.kind, "provider-auth");
      assert.equal(error.details?.provider, "openai");
      assert.match(error.details?.hint || "", /pi auth login --provider openai/);
      return true;
    },
  );
});

test("provider classification never fires on a healthy run's text", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "harnest-pi-healthy-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const text = "credentials_not_configured and regional opt-in were reviewed; nothing failed";
  const fake = terminalChildFactory({ finalText: text });
  const adapter = new PiAdapter({ command: "fake-pi", spawnFn: fake.spawnFn });

  const output = await adapter.run(request(cwd));
  assert.equal(output.result.finalText, text);
});
