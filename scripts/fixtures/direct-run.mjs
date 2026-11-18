// Regression fixture for issue 14: a plain Pi/OpenCode task must execute
// natively without importing the optional Taskflow packages, while an explicit
// workflow request must fail before spawn with missing-optional-dependency.
// Run under reject-taskflow-loader.mjs so any eager import is fatal.
// Kept outside test/ because Node's default test discovery executes .mjs fixtures.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

const { PiAdapter } = await import("../../src/adapters/pi.mjs");
const { OpenCodeAdapter } = await import("../../src/adapters/opencode.mjs");
const { normalizeRequest } = await import("../../src/protocol.mjs");

class FakeChild extends EventEmitter {
  constructor(onCommand = null, lines = []) {
    super();
    this.killed = false;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdin = {
      write: (line) => {
        onCommand?.(JSON.parse(line), this);
        return true;
      },
      end() {},
    };
    if (lines.length) {
      queueMicrotask(() => {
        for (const line of lines) this.stdout.emit("data", Buffer.from(`${line}\n`));
        this.emit("close", 0, null);
      });
    }
  }
  emitJson(value) {
    this.stdout.emit("data", Buffer.from(`${JSON.stringify(value)}\n`));
  }
  kill() {
    if (this.killed) return false;
    this.killed = true;
    queueMicrotask(() => this.emit("close", null, "SIGTERM"));
    return true;
  }
}

const request = (target, overrides = {}) => normalizeRequest({
  target,
  requestId: `direct-${target}`,
  task: "Do the task natively.",
  cwd: process.cwd(),
  route: target === "opencode" ? { model: "fixture/model" } : {},
  ...overrides,
});

// Eval mode simulates a Taskflow module that exists but throws while loading:
// that must surface as a downstream failure, not as a missing optional dep.
const evalMode = process.env.REJECT_TASKFLOW_MODE === "eval";
const expectTaskflowFailure = (dependency) => (error) => {
  if (evalMode) {
    return error.details?.kind === "downstream"
      && new RegExp(dependency).test(`${error.message} ${JSON.stringify(error.details ?? {})}`)
      && !/install optional dependencies/i.test(error.message)
      && /failed to (load|resolve)|exploded during evaluation/i.test(error.message);
  }
  return error.details?.kind === "missing-optional-dependency" && new RegExp(dependency).test(error.message);
};

// Plain Pi: no extension, no taskflow tool, native completion.
let piSpawned = 0;
let piArgs = null;
let piPrompt = null;
const piAdapter = new PiAdapter({
  command: "synthetic-pi",
  spawnFn(_command, args) {
    piSpawned += 1;
    piArgs = args;
    return new FakeChild((command, child) => {
      if (command.type === "get_state") {
        child.emitJson({ type: "response", id: command.id, command: "get_state", success: true, data: { model: { provider: "fixture", id: "fixture" }, sessionId: "pi-direct" } });
      } else if (command.type === "prompt") {
        piPrompt = command.message;
        child.emitJson({ type: "response", id: command.id, command: "prompt", success: true });
        child.emitJson({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "native pi answer" }] } });
        child.emitJson({ type: "agent_settled" });
      } else if (command.type === "get_last_assistant_text") {
        child.emitJson({ type: "response", id: command.id, command: command.type, success: true, data: { text: "native pi answer" } });
      } else if (command.type === "get_session_stats") {
        child.emitJson({ type: "response", id: command.id, command: command.type, success: true, data: {} });
      }
    });
  },
});
const piOutput = await piAdapter.run(request("pi"));
assert.equal(piOutput.result.finalText, "native pi answer");
assert.equal(piSpawned, 1);
assert.ok(!piArgs.includes("--extension"), "plain Pi must not load a Taskflow extension");
assert.ok(!piArgs[piArgs.indexOf("--tools") + 1].split(",").includes("taskflow"), "plain Pi must not expose the taskflow tool");
assert.doesNotMatch(piPrompt, /invoke the taskflow tool/i, "plain Pi prompt must not instruct a Taskflow invocation");
assert.match(piPrompt, /Do not invoke Taskflow or create a separate workflow/);
assert.match(piPrompt, /Execute the assigned task directly/);

// Explicit Pi workflow without the optional package fails before spawn.
let piWorkflowSpawned = 0;
const piWorkflow = new PiAdapter({
  command: "synthetic-pi",
  spawnFn() {
    piWorkflowSpawned += 1;
    return new FakeChild();
  },
});
await assert.rejects(
  piWorkflow.run(request("pi", {
    workflow: { engine: "taskflow", spec: { name: "blocked", phases: [{ id: "final", task: "Run", final: true }] } },
  })),
  expectTaskflowFailure("pi-taskflow"),
);
assert.equal(piWorkflowSpawned, 0, "a missing optional dependency must fail before spawning the harness");

// Plain OpenCode: taskflow-mcp-core is never imported.
let opencodeSpawned = 0;
const opencodeLines = [
  JSON.stringify({ type: "session.created", properties: { info: { id: "direct-session" } } }),
  JSON.stringify({ type: "text", sessionID: "direct-session", part: { type: "text", text: "native opencode answer" } }),
  JSON.stringify({ type: "step_finish", sessionID: "direct-session", part: { type: "step-finish", reason: "stop", tokens: { input: 1, output: 1, total: 2 } } }),
];
const opencodeAdapter = new OpenCodeAdapter({
  command: "synthetic-opencode",
  spawnFn() {
    opencodeSpawned += 1;
    return new FakeChild(null, opencodeLines);
  },
});
const opencodeOutput = await opencodeAdapter.run(request("opencode"));
assert.equal(opencodeOutput.result.finalText, "native opencode answer");
assert.equal(opencodeSpawned, 1);

// Explicit OpenCode workflow without the optional package fails before spawn.
let opencodeWorkflowSpawned = 0;
const opencodeWorkflow = new OpenCodeAdapter({
  command: "synthetic-opencode",
  spawnFn() {
    opencodeWorkflowSpawned += 1;
    return new FakeChild(null, opencodeLines);
  },
});
await assert.rejects(
  opencodeWorkflow.run(request("opencode", {
    workflow: { engine: "taskflow", spec: { name: "blocked", phases: [{ id: "final", task: "Run", final: true }] } },
  })),
  expectTaskflowFailure("taskflow-mcp-core"),
);
assert.equal(opencodeWorkflowSpawned, 0, "a missing optional dependency must fail before spawning the harness");

// A V2 spec request must fail before the control server starts: the optional
// core is loaded ahead of controlRuntime.start, so no process is spawned.
let opencodeV2Spawned = 0;
const opencodeV2Workflow = new OpenCodeAdapter({
  command: "synthetic-opencode",
  fetchFn: () => Promise.resolve({ ok: true, status: 200 }),
  spawnFn() {
    opencodeV2Spawned += 1;
    return new FakeChild(null, opencodeLines);
  },
});
await assert.rejects(
  opencodeV2Workflow.run(request("opencode", {
    route: { model: "fixture/model", harnessVersion: "v2" },
    workflow: { engine: "taskflow", spec: { name: "blocked-v2", phases: [{ id: "final", task: "Run", final: true }] } },
  })),
  expectTaskflowFailure("taskflow-mcp-core"),
);
assert.equal(opencodeV2Spawned, 0, "V2 workflow must not start a control server before the optional dependency check");

console.log("DIRECT_RUN_OK");
