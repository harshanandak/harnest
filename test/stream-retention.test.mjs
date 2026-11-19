import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { OpenCodeAdapter } from "../src/adapters/opencode.mjs";
import { PiAdapter } from "../src/adapters/pi.mjs";
import { JobStore, readTracePage } from "../src/job-store.mjs";
import { summarizeEvents } from "../src/result.mjs";

const adapters = { opencode: OpenCodeAdapter, pi: PiAdapter };
const state = { sessionId: "retained-session", model: { provider: "openai", id: "test-model" } };
const stats = { tokens: { total: 17 }, cost: 0.01 };

function request(target, overrides = {}) {
  return {
    requestId: `stream-${target}`, target, cwd: process.cwd(), task: "Return the final result.",
    context: target === "opencode" ? { graph: { graphId: "fixture" } } : {}, contextDigest: "a".repeat(64), workflow: null,
    route: { provider: "openai", model: "test-model" },
    execution: { timeoutMs: 10_000, sessionId: target === "opencode" ? null : "resumed-session" },
    policy: { write: false, tools: [] }, ...overrides,
  };
}

class ScriptChild extends EventEmitter {
  constructor(target, script, { finalText = "", code = 0 } = {}) {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.killed = false;
    this.stdin = { write: (line) => {
      const command = JSON.parse(line);
      if (command.type === "prompt") queueMicrotask(run);
      else this.emitJson({ type: "response", id: command.id, command: command.type, success: true,
        data: command.type === "get_state" ? state : command.type === "get_last_assistant_text" ? { text: finalText } : stats });
      return true;
    } };
    const run = () => {
      script(this);
      if (!this.killed) {
        if (target === "pi") this.emitJson({ type: "agent_settled" });
        else this.emit("close", code, null);
      }
    };
    if (target === "opencode") queueMicrotask(run);
  }
  emitJson(value) { this.stdout.emit("data", Buffer.from(`${JSON.stringify(value)}\n`)); }
  kill() {
    if (this.killed) return false;
    this.killed = true;
    queueMicrotask(() => this.emit("close", null, "SIGTERM"));
    return true;
  }
}

function assistant(child, target, text) {
  child.emitJson(target === "opencode" ? { type: "text", text }
    : { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
}

function fakeAdapter(target, script, options) {
  return new adapters[target]({ command: `fake-${target}`, spawnFn: () => new ScriptChild(target, script, options) });
}

test("OpenCode persists and recovers progress with a multibyte raw event and cumulative text", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harnest-opencode-trace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new JobStore(root);
  const jobId = "opencode-multibyte";
  const first = "\u20ac".repeat(600_000);
  const second = "\u20ac".repeat(400_000);
  const output = await fakeAdapter("opencode", (child) => {
    assistant(child, "opencode", first);
    assistant(child, "opencode", second);
    child.emitJson({ type: "result", result: "DONE" });
  }).run(request("opencode"), {
    onProgress: (data) => store.appendEvent(jobId, {
      at: new Date().toISOString(), event: { type: "progress", data },
    }),
  });
  assert.equal(output.result.finalText, "DONE");

  const reopened = new JobStore(root);
  assert.equal((await reopened.traceSummary(jobId)).eventCount, 3);
  const { events } = await readTracePage(reopened.tracePath(jobId), { afterSequence: 0 });
  assert.deepEqual(events.map((record) => record.sequence), [1, 2, 3]);
  assert.ok(events[1].event.data.event.text === second);
  assert.ok(events[1].event.data.finalText === first + second);
});

for (const target of Object.keys(adapters)) {
  test(`${target} preserves first-occurrence summary order after types leave the sample`, async () => {
    const observed = [];
    const output = await fakeAdapter(target, (child) => {
      for (let i = 0; i < 30; i++) child.emitJson({ type: `diagnostic-${i}` });
      for (let i = 0; i < 30; i++) child.emitJson({ type: `diagnostic-${i}` });
      assistant(child, target, "DONE");
    }).run(request(target), { onProgress: (event) => observed.push(event) });
    assert.deepEqual(output.result.eventSummary, summarizeEvents(observed));
    assert.equal(output.result.eventSummary.types.length, 20);
    assert.equal(output.result.finalText, "DONE");
  });

  test(`${target} fails explicitly instead of retaining unlimited distinct event types`, async () => {
    await assert.rejects(fakeAdapter(target, (child) => {
      for (let i = 0; i < 257 && !child.killed; i++) child.emitJson({ type: `diagnostic-${i}` });
      assistant(child, target, "DONE");
    }).run(request(target)), (error) => error.details.kind === "output-limit");
  });

  for (const terminated of [false, true]) {
    test(`${target} rejects a ${terminated ? "terminated" : "partial"} giant line without losing output-limit`, async () => {
      let child;
      const adapter = new adapters[target]({ command: `fake-${target}`, spawnFn: () => {
        child = new ScriptChild(target, (instance) => {
          if (target === "opencode") {
            instance.emitJson({ type: "error", error: { type: "provider.auth", message: "Authentication required", status: 401 } });
          } else assistant(instance, target, "candidate result");
          // Fragmented UTF-8 exceeds the byte limit before the character limit.
          const bytes = Buffer.from("\u20ac".repeat(700_000) + (terminated ? "\n" : ""));
          for (let offset = 0; offset < bytes.length && !instance.killed; offset += 8191) {
            instance.stdout.emit("data", bytes.subarray(offset, offset + 8191));
          }
        });
        return child;
      } });
      await assert.rejects(adapter.run(request(target)), (error) => {
        assert.equal(error.details.kind, "output-limit");
        assert.equal(error.details.maxLineBytes, 2 * 1024 * 1024);
        return true;
      });
      assert.equal(child.killed, true);
    });
  }

  for (const chars of [64_001, 1024 * 1024 + 1]) {
    test(`${target} rejects a required ${chars}-character final answer instead of truncating success`, async () => {
      await assert.rejects(fakeAdapter(target, (child) => assistant(child, target, "x".repeat(chars)))
        .run(request(target)), (error) => error.details.kind === "output-limit");
    });
  }

  test(`${target} permits a bounded completion envelope larger than its final answer`, async () => {
    const text = JSON.stringify({ finalText: "DONE", evidence: ["x".repeat(70_000)] });
    const output = await fakeAdapter(target, (child) => assistant(child, target, text)).run(request(target));
    assert.equal(output.result.finalText, "DONE");
    assert.ok(output.result.evidence[0].length < 4100);
  });

  test(`${target} discards oversized intermediate text when the authoritative final replaces it`, async () => {
    const output = await fakeAdapter(target, (child) => {
      if (target === "opencode") {
        for (let i = 0; i < 1100; i++) assistant(child, target, "x".repeat(1024));
        child.emitJson({ type: "result", result: "DONE" });
      } else {
        assistant(child, target, "x".repeat(1024 * 1024 + 1));
        assistant(child, target, "DONE");
      }
    }).run(request(target));
    assert.equal(output.result.finalText, "DONE");
  });

  test(`${target} decodes multibyte text across every stdout chunk boundary`, async () => {
    const text = "Result \u20ac \ud83c\udf0d \u0905";
    const output = await fakeAdapter(target, (child) => {
      const event = target === "opencode" ? { type: "text", text }
        : { type: "message_end", message: { role: "assistant", content: text } };
      const bytes = Buffer.from(`${JSON.stringify(event)}\n`);
      for (const byte of bytes) child.stdout.emit("data", Buffer.from([byte]));
    }).run(request(target));
    assert.equal(output.result.finalText, text);
  });
}

for (const [code, errorMessage, kind] of [[0, null, null], [0, "Authentication required", "provider-auth"], [1, "Authentication required", "provider-auth"], [1, "early protocol failure", "downstream"]]) {
  test(`OpenCode real child keeps early ${kind || "success"} evidence beyond the stdout tail on exit ${code}`, { timeout: 20_000 }, async () => {
    const script = String.raw`
      if (process.argv.includes("--version")) { console.log("opencode v2.2.1"); process.exit(0); }
      const { once } = require('node:events');
      async function emit(value) { if (!process.stdout.write(JSON.stringify(value) + '\n')) await once(process.stdout, 'drain'); }
      (async () => {
        await emit({type:'text',sessionID:'early-session',text:'DONE'});
        await emit({type:'step_finish',tokens:{input:12,output:5},cost:0.01});
        if (${JSON.stringify(errorMessage)}) await emit({type:'error',error:{message:${JSON.stringify(errorMessage)}}});
        for (let i=0;i<1800;i++) await emit({type:'diagnostic',payload:'x'.repeat(1024)});
        process.exitCode=${code};
      })().catch(() => { process.exitCode=3; });
    `;
    const adapter = new OpenCodeAdapter({ launch: { command: process.execPath, args: ["-e", script, "--"] } });
    let count = 0;
    const run = adapter.run(request("opencode"), { onProgress() { count++; } });
    if (kind) {
      await assert.rejects(run, (error) => error.details.kind === kind && error.message.includes(errorMessage));
      assert.equal(count, 1803);
    } else {
      const output = await run;
      assert.equal(output.result.finalText, "DONE");
      assert.equal(output.sessionId, "early-session");
      assert.equal(output.usage.input, 12);
      assert.equal(output.usage.output, 5);
      assert.equal(output.result.eventSummary.count, 1802);
      assert.equal(count, 1802);
    }
  });
}

for (const taskflow of [false, true]) {
  test(`Pi real RPC child preserves early Taskflow identity and ${taskflow ? "saved-flow" : "post-steer"} final output through a large stream`, { timeout: 20_000 }, async () => {
    const script = String.raw`
      if (process.argv.includes("--version")) { console.log("opencode v2.2.1"); process.exit(0); }
      const { once } = require('node:events');
      const { createInterface } = require('node:readline');
      async function emit(value) { if (!process.stdout.write(JSON.stringify(value) + '\n')) await once(process.stdout, 'drain'); }
      createInterface({input:process.stdin}).on('line', async (line) => {
        const command=JSON.parse(line);
        if (command.type==='prompt') {
          await emit({type:'response',id:command.id,command:command.type,success:true});
          await emit({type:'message_end',message:{role:'toolResult',toolName:'taskflow',details:{finalOutput:'SAVED',state:{status:'completed',runId:'early-flow',totalUsage:{totalTokens:17}}}}});
          for(let i=0;i<1800;i++) await emit({type:'diagnostic',payload:'x'.repeat(1024)});
          await emit({type:'message_end',message:{role:'assistant',content:'STEERED'}});
          await emit({type:'agent_settled'});
        } else await emit({type:'response',id:command.id,command:command.type,success:true,
          data:command.type==='get_state'?${JSON.stringify(state)}:command.type==='get_last_assistant_text'?{text:'STEERED'}:${JSON.stringify(stats)}});
      });
    `;
    const adapter = new PiAdapter({ materializeInlineFlows: false, taskflowExtensionPath: "C:\\pinned\\pi-taskflow\\dist\\index.js", launch: { command: process.execPath, args: ["-e", script, "--"] } });
    const output = await adapter.run(request("pi", taskflow ? {
      workflow: { spec: { name: "retained-flow", phases: [{ id: "final", task: "Return result", final: true }] } },
    } : {}));
    assert.equal(output.result.finalText, taskflow ? "SAVED" : "STEERED");
    assert.equal(output.sessionId, state.sessionId);
    assert.equal(output.workflowRunId, "early-flow");
    assert.deepEqual(output.usage, stats);
    assert.equal(output.result.eventSummary.count, 1808);
  });
}

for (const taskflow of [false, true]) {
  test(`Pi bounds ${taskflow ? "unrelated assistant" : "stale shorthand Taskflow"} text without rejecting the required final output`, async () => {
    const adapter = new PiAdapter({ command: "fake-pi", materializeInlineFlows: false, taskflowExtensionPath: "C:\\pinned\\pi-taskflow\\dist\\index.js", spawnFn: () => new ScriptChild("pi", (child) => {
      child.emitJson({ type: "message_end", message: { role: "toolResult", toolName: "taskflow", details: {
        finalOutput: taskflow ? "SAVED" : "x".repeat(1024 * 1024 + 1),
        state: { status: "completed", runId: "bounded-flow" },
      } } });
      assistant(child, "pi", taskflow ? "x".repeat(1024 * 1024 + 1) : "STEERED");
    }) });
    const output = await adapter.run(request("pi", taskflow ? { workflow: {
      spec: { name: "required-flow", phases: [{ id: "final", task: "Return result", final: true }] },
    } } : {}));
    assert.equal(output.result.finalText, taskflow ? "SAVED" : "STEERED");
    assert.equal(output.workflowRunId, "bounded-flow");
  });
}

test("Pi rejects an oversized required Taskflow result despite a short assistant answer", async () => {
  const adapter = new PiAdapter({ command: "fake-pi", materializeInlineFlows: false, spawnFn: () => new ScriptChild("pi", (child) => {
    child.emitJson({ type: "message_end", message: { role: "toolResult", toolName: "taskflow", details: {
      finalOutput: "x".repeat(1024 * 1024 + 1), state: { status: "completed", runId: "large-flow" },
    } } });
    assistant(child, "pi", "short answer");
  }) });
  await assert.rejects(adapter.run(request("pi", { workflow: {
    spec: { name: "required-flow", phases: [{ id: "final", task: "Return result", final: true }] },
  } })), (error) => error.details.kind === "output-limit");
});

test("OpenCode preserves a phase's output-limit through the Taskflow handler", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "opencode-phase-limit-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const adapter = fakeAdapter("opencode", (child) => {
    child.emitJson({ type: "error", error: { message: "Authentication required", status: 401 } });
    child.stdout.emit("data", Buffer.alloc(2 * 1024 * 1024 + 1, "x"));
  });
  await assert.rejects(adapter.run(request("opencode", { cwd, workflow: {
    spec: { name: "large-phase", phases: [{ id: "final", type: "agent", task: "Return result", final: true }] },
  } })), (error) => error.details.kind === "output-limit");
});

test("Pi retains only the stderr byte tail and reports its end after large diagnostics", async () => {
  const adapter = new PiAdapter({ command: "fake-pi", spawnFn: () => new ScriptChild("pi", (child) => {
    const block = Buffer.alloc(4096, "x");
    for (let i = 0; i < 1024; i++) child.stderr.emit("data", block);
    child.stderr.emit("data", Buffer.from("LAST-ERROR"));
    child.emit("close", 1, null);
  }) });
  await assert.rejects(adapter.run(request("pi")), (error) => {
    assert.equal(error.details.kind, "transport");
    assert.equal(Buffer.byteLength(error.details.stderr), 64 * 1024);
    assert.ok(error.details.stderr.endsWith("LAST-ERROR"));
    return true;
  });
});

// Run with explicit GC in a disposable Node process so the memory assertion
// measures retained data, not the test runner's allocation/collection timing.
async function memoryProbe(urls, selectedTarget) {
  const { default: assert } = await import("node:assert/strict");
  const { EventEmitter } = await import("node:events");
  const { OpenCodeAdapter } = await import(urls.opencode);
  const { PiAdapter } = await import(urls.pi);
  const results = [];
  for (const [target, Adapter] of Object.entries({ opencode: OpenCodeAdapter, pi: PiAdapter })) {
    if (target !== selectedTarget) continue;
    let growth;
    let count = 0;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { child.killed = true; queueMicrotask(() => child.emit("close", null, "SIGTERM")); };
    const emit = (event) => child.stdout.emit("data", Buffer.from(JSON.stringify(event) + "\n"));
    function flood() {
      global.gc();
      const before = process.memoryUsage();
      for (let i = 0; i < 2048; i++) {
        emit(target === "opencode" ? { type: "diagnostic", payload: "x".repeat(32768) }
          : { type: "message_end", message: { role: "assistant", content: "x".repeat(32768) } });
        if (target === "pi") {
          emit({ type: "response", command: "diagnostic", id: `history-${i}`, success: true, data: "y".repeat(32768) });
          child.stderr.emit("data", Buffer.alloc(32768, "z"));
        }
      }
      global.gc();
      const after = process.memoryUsage();
      growth = { heap: after.heapUsed - before.heapUsed, buffers: after.arrayBuffers - before.arrayBuffers };
      assert.ok(growth.heap < 16 * 1024 * 1024, `${target} retained ${growth.heap} heap bytes`);
      assert.ok(growth.buffers < 8 * 1024 * 1024, `${target} retained ${growth.buffers} buffer bytes`);
      if (target === "opencode") {
        emit({ type: "result", result: "DONE" });
        child.emit("close", 0, null);
      } else {
        emit({ type: "message_end", message: { role: "assistant", content: "DONE" } });
        emit({ type: "agent_settled" });
      }
    }
    child.stdin = { write(line) {
      const command = JSON.parse(line);
      if (command.type === "prompt") queueMicrotask(flood);
      else emit({ type: "response", command: command.type, id: command.id, success: true,
        data: command.type === "get_state" ? { model: { provider: "openai", id: "test" } }
          : command.type === "get_last_assistant_text" ? { text: "DONE" } : { tokens: { total: 17 } } });
      return true;
    } };
    const adapter = new Adapter({ command: `fake-${target}`, spawnFn: () => {
      if (target === "opencode") queueMicrotask(flood);
      return child;
    } });
    const output = await adapter.run({ requestId: "memory", target, cwd: process.cwd(), task: "Return result", context: {},
      policy: { write: false }, route: { model: "openai/test" }, execution: { timeoutMs: 20_000 } }, {
      onProgress() { count++; },
    });
    assert.equal(output.result.finalText, "DONE");
    assert.equal(output.result.eventSummary.count, count);
    results.push({ target, count, ...growth });
  }
  console.log(JSON.stringify(results));
}

for (const target of Object.keys(adapters)) {
  test(`${target} retained memory stays bounded across 64 MiB streams`, { timeout: 45_000 }, async (t) => {
    const urls = Object.fromEntries(Object.keys(adapters).map((name) => [name, new URL(`../src/adapters/${name}.mjs`, import.meta.url).href]));
    const script = `(${memoryProbe.toString()})(${JSON.stringify(urls)}, ${JSON.stringify(target)}).catch(error => { console.error(error); process.exitCode=1; });`;
    const { stdout } = await promisify(execFile)(process.execPath, ["--expose-gc", "--input-type=module", "-e", script], {
      cwd: process.cwd(), timeout: 40_000, maxBuffer: 128 * 1024,
    });
    const results = JSON.parse(stdout.trim());
    assert.deepEqual(results.map((result) => result.target), [target]);
    for (const result of results) t.diagnostic(`${result.target}: ${result.count} events, retained heap growth ${result.heap} bytes, buffer growth ${result.buffers} bytes`);
  });
}
