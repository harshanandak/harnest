import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import test from "node:test";
import { OpenCodeAdapter } from "../src/adapters/opencode.mjs";
import { PiAdapter } from "../src/adapters/pi.mjs";

const turn = () => new Promise((resolve) => setImmediate(resolve));
const state = { sessionId: "lifecycle-session", model: { provider: "openai", id: "test" } };

function request(target, timeoutMs = 5000) {
  return { target, requestId: "lifecycle", cwd: process.cwd(), task: "Return DONE", context: target === "opencode" ? { graph: { graphId: "fixture" } } : {},
    route: { provider: "openai", model: "test" }, policy: { write: false }, execution: { timeoutMs } };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class PiChild extends EventEmitter {
  constructor(produce, stdout = new PassThrough()) {
    super();
    this.stdout = stdout;
    this.stderr = new PassThrough();
    this.killed = false;
    this.stdin = { write: (line) => {
      const command = JSON.parse(line);
      if (command.type === "prompt") queueMicrotask(() => produce(this));
      else if (command.type === "abort") this.kill();
      else this.emitJson({ type: "response", command: command.type, id: command.id, success: true,
        data: command.type === "get_state" ? state : command.type === "get_last_assistant_text" ? { text: "DONE" } : { tokens: { total: 1 } } });
      return true;
    } };
  }
  emitJson(event) { return this.stdout.write(`${JSON.stringify(event)}\n`); }
  finish() {
    this.emitJson({ type: "message_end", message: { role: "assistant", content: "DONE" } });
    this.emitJson({ type: "agent_settled" });
  }
  kill() {
    if (this.killed) return;
    this.killed = true;
    queueMicrotask(() => this.emit("close", null, "SIGTERM"));
  }
}

// Strict subprocess isolation makes an unhandled callback rejection or thrown
// stdout listener fail this test without taking down the other regressions.
async function callbackFailureScenario(url, format, asynchronous) {
  const { default: assert } = await import("node:assert/strict");
  const { EventEmitter } = await import("node:events");
  const { PiAdapter } = await import(url);
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => { child.killed = true; queueMicrotask(() => child.emit("close", null, "SIGTERM")); };
  const emit = (event) => child.stdout.emit("data", Buffer.from(JSON.stringify(event) + "\n"));
  child.stdin = { write(line) {
    const command = JSON.parse(line);
    if (command.type === "prompt") queueMicrotask(() => {
      if (format === "json") emit({ type: "callback-test" });
      else child.stdout.emit("data", Buffer.from("callback-test plain output\n"));
      emit({ type: "message_end", message: { role: "assistant", content: "DONE" } });
      emit({ type: "agent_settled" });
    });
    else emit({ type: "response", id: command.id, command: command.type, success: true,
      data: command.type === "get_state" ? { model: { provider: "openai", id: "test" } }
        : command.type === "get_last_assistant_text" ? { text: "DONE" } : { tokens: { total: 1 } } });
    return true;
  } };
  const adapter = new PiAdapter({ command: "fake-pi", spawnFn: () => child });
  const callback = (event) => {
    if (event.type !== "callback-test" && event.type !== "pi_stdout") return;
    if (asynchronous) return Promise.reject(new Error("callback persistence failed"));
    throw new Error("callback persistence failed");
  };
  await assert.rejects(adapter.run({ target: "pi", requestId: "callback", cwd: process.cwd(), task: "Return DONE",
    route: {}, policy: { write: false }, execution: { timeoutMs: 1000 } }, { onProgress: callback }), (error) => {
    assert.equal(error.details.kind, "transport");
    assert.equal(error.details.phase, "progress-callback");
    assert.match(error.message, /callback persistence failed/);
    return true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(child.killed, true);
}

for (const format of ["json", "plain"]) {
  for (const asynchronous of [false, true]) {
    test(`Pi ${format} ${asynchronous ? "async rejection" : "sync throw"} fails the run without escaping`, async () => {
      const url = new URL("../src/adapters/pi.mjs", import.meta.url).href;
      const script = `(${callbackFailureScenario.toString()})(${JSON.stringify(url)}, ${JSON.stringify(format)}, ${asynchronous}).catch(error => { console.error(error); process.exitCode=1; });`;
      await promisify(execFile)(process.execPath, ["--unhandled-rejections=strict", "--input-type=module", "-e", script], {
        timeout: 10_000, maxBuffer: 64 * 1024,
      });
    });
  }

  for (const reject of [false, true]) {
    test(`Pi awaits accepted ${format} progress before ${reject ? "rejecting a late persistence failure" : "reporting success"}`, async () => {
      const gate = deferred();
      let accepted = false;
      let settled = false;
      const child = new PiChild((instance) => {
        instance.stdout.write(format === "json" ? '{"type":"callback-test"}\n' : "callback-test plain output\n");
        instance.finish();
      });
      const adapter = new PiAdapter({ command: "fake-pi", spawnFn: () => child });
      const result = adapter.run(request("pi"), { onProgress(event) {
        if (event.type === "callback-test" || event.type === "pi_stdout") {
          accepted = true;
          return gate.promise;
        }
      } }).then((value) => { settled = true; return { value }; }, (error) => { settled = true; return { error }; });
      await turn();
      const premature = settled;
      if (reject) gate.reject(new Error("late persistence failed"));
      else gate.resolve();
      const outcome = await result;
      assert.equal(accepted, true);
      assert.equal(premature, false, "success must wait for accepted progress persistence");
      if (reject) {
        assert.equal(outcome.error?.details.kind, "transport");
        assert.equal(outcome.error?.details.phase, "progress-callback");
      } else assert.equal(outcome.value?.result.finalText, "DONE");
      assert.equal(child.killed, true);
    });
  }
}

test("Pi applies progress backpressure to 64 MiB and drains every accepted callback", async () => {
  let active = 0;
  let peak = 0;
  let delivered = 0;
  let producer;
  const child = new PiChild((instance) => {
    producer = (async () => {
      for (let i = 0; i < 4096; i++) {
        if (!instance.emitJson({ type: "progress-load", payload: "x".repeat(16384) })) await once(instance.stdout, "drain");
      }
      instance.finish();
    })();
  });
  const adapter = new PiAdapter({ command: "fake-pi", spawnFn: () => child });
  const output = await adapter.run(request("pi"), { async onProgress(event) {
    active++;
    peak = Math.max(peak, active);
    await turn();
    if (event.type === "progress-load") assert.equal(event.payload.length, 16384);
    delivered++;
    active--;
  } });
  await producer;
  assert.equal(output.result.finalText, "DONE");
  assert.equal(active, 0);
  assert.equal(peak, 1, "only one callback should be in flight under backpressure");
  assert.equal(delivered, output.result.eventSummary.count);
});

for (const reject of [false, true]) {
  test(`Pi ${reject ? "rejects" : "completes"} only after the terminal callback settles, even after process close`, async () => {
    const gate = deferred();
    const child = new PiChild((instance) => {
      instance.finish();
      instance.emit("close", 0, null);
    });
    const adapter = new PiAdapter({ command: "fake-pi", spawnFn: () => child });
    let settled = false;
    const result = adapter.run(request("pi"), { onProgress(event) {
      if (event.command === "get_session_stats") return gate.promise;
    } }).then((value) => { settled = true; return { value }; }, (error) => { settled = true; return { error }; });
    await turn();
    const premature = settled;
    if (reject) gate.reject(new Error("terminal persistence failed"));
    else gate.resolve();
    const outcome = await result;
    assert.equal(premature, false);
    if (reject) assert.equal(outcome.error?.details.phase, "progress-callback");
    else assert.equal(outcome.value?.result.finalText, "DONE");
  });
}

for (const limit of ["bytes", "chunks"]) {
  test(`Pi bounds queued stdout ${limit} when an injected source ignores progress backpressure`, async () => {
    const gate = deferred();
    const stdout = new EventEmitter();
    stdout.write = (value) => stdout.emit("data", Buffer.from(value));
    const chunk = limit === "bytes" ? Buffer.alloc(65536, "\n") : Buffer.from("\n");
    let callbacks = 0;
    const child = new PiChild((instance) => {
      instance.emitJson({ type: "callback-test" });
      for (let i = 0; i < 300 && !instance.killed; i++) instance.stdout.write(chunk);
    }, stdout);
    const adapter = new PiAdapter({ command: "fake-pi", spawnFn: () => child });
    await assert.rejects(adapter.run(request("pi"), { onProgress(event) {
      if (event.type === "callback-test") { callbacks++; return gate.promise; }
    } }), (error) => {
      assert.equal(error.details.kind, "output-limit");
      assert.equal(error.details.maxPendingBytes, 4 * 1024 * 1024);
      assert.equal(error.details.maxPendingChunks, 256);
      return true;
    });
    gate.reject(new Error("callback rejected after backlog failure"));
    await turn();
    assert.equal(callbacks, 1);
    assert.equal(child.killed, true);
  });
}

test("Pi timeout remains active while progress persistence is pending", async (t) => {
  const keepAlive = setTimeout(() => {}, 1000);
  t.after(() => clearTimeout(keepAlive));
  const gate = deferred();
  const child = new PiChild((instance) => instance.finish());
  const adapter = new PiAdapter({ command: "fake-pi", spawnFn: () => child });
  const result = adapter.run(request("pi", 50), { onProgress: () => gate.promise })
    .then((value) => ({ value }), (error) => ({ error }));
  const outcome = await result;
  gate.resolve();
  assert.equal(outcome.error?.details.kind, "timeout");
  assert.equal(child.killed, true);
});

test("Pi caller cancellation interrupts pending progress without an unhandled late rejection", async () => {
  const gate = deferred();
  const controller = new AbortController();
  const child = new PiChild((instance) => instance.finish());
  const adapter = new PiAdapter({ command: "fake-pi", spawnFn: () => child });
  const run = adapter.run(request("pi"), { signal: controller.signal, onProgress: () => gate.promise });
  controller.abort();
  await assert.rejects(run, (error) => error.details.kind === "aborted" && error.details.aborted === true);
  gate.reject(new Error("callback rejected after cancellation"));
  await turn();
  assert.equal(child.killed, true);
});

for (const reason of ["aborted", "timeout"]) {
  test(`Pi accepted ${reason} cannot become DONE from shutdown terminal events`, async (t) => {
    const controller = new AbortController();
    const ready = deferred();
    const closed = deferred();
    const child = new PiChild((instance) => {
      instance.emitJson({ type: "message_end", message: { role: "assistant", content: "DONE" } });
      ready.resolve();
    });
    const normalWrite = child.stdin.write;
    let abortCommands = 0;
    child.stdin.write = (line) => {
      if (JSON.parse(line).type !== "abort") return normalWrite(line);
      abortCommands++;
      // Cancellation racing with an already accepted timeout must not replace it.
      if (reason === "timeout" && abortCommands === 1) controller.abort();
      child.emitJson({ type: "agent_settled" });
      return true;
    };
    let closeTimer;
    child.kill = () => {
      if (child.killed) return;
      child.killed = true;
      closeTimer = setTimeout(() => {
        child.emit("close", null, "SIGTERM");
        closed.resolve();
      }, 80);
    };
    // This scheduled caller cancellation also represents a live fake child's
    // handle until the earlier execution deadline fires.
    const cancelTimer = setTimeout(() => controller.abort(), 150);
    t.after(() => { clearTimeout(cancelTimer); clearTimeout(closeTimer); });
    const adapter = new PiAdapter({ command: "fake-pi", spawnFn: () => child });
    const result = adapter.run(request("pi", 50), { signal: controller.signal })
      .then((value) => ({ value }), (error) => ({ error }));
    await ready.promise;
    if (reason === "aborted") controller.abort();
    const outcome = await result;
    await closed.promise;
    assert.equal(outcome.error?.details.kind, reason);
    assert.equal(outcome.error.details.aborted, reason === "aborted");
    assert.equal(outcome.error.details.timedOut, reason === "timeout");
    assert.equal(abortCommands, 1, "only the first stop reason may initiate shutdown");
    assert.equal(child.killed, true);
  });
}

test("Pi preserves accepted cancellation when the abort command itself throws", async () => {
  const ready = deferred();
  const child = new PiChild((instance) => {
    instance.emitJson({ type: "message_end", message: { role: "assistant", content: "DONE" } });
    ready.resolve();
  });
  const normalWrite = child.stdin.write;
  child.stdin.write = (line) => {
    if (JSON.parse(line).type === "abort") throw new Error("shutdown write failed");
    return normalWrite(line);
  };
  const controller = new AbortController();
  const adapter = new PiAdapter({ command: "fake-pi", spawnFn: () => child });
  const run = adapter.run(request("pi"), { signal: controller.signal });
  const rejected = assert.rejects(run, (error) => error.details.kind === "aborted" && error.details.aborted === true);
  await ready.promise;
  controller.abort();
  await rejected;
  assert.equal(child.killed, true);
});

async function postCloseDeadlineScenario(url) {
  const { default: assert } = await import("node:assert/strict");
  const { spawn } = await import("node:child_process");
  const { PiAdapter } = await import(url);
  const script = String.raw`
    const { createInterface } = require('node:readline');
    createInterface({input:process.stdin}).on('line', (line) => {
      const command = JSON.parse(line);
      if (command.type === 'get_state') process.stdout.write(JSON.stringify({
        type:'response',id:command.id,command:'get_state',success:true,
        data:{model:{provider:'openai',id:'test'}}
      }) + '\n');
      if (command.type === 'prompt') process.exit(0);
    });
  `;
  let child;
  let closed = false;
  let writesAfterClose = 0;
  let killsAfterClose = 0;
  const adapter = new PiAdapter({ launch: { command: process.execPath, args: ["-e", script, "--"] },
    spawnFn(command, args, options) {
      child = spawn(command, args, options);
      child.once("close", () => { closed = true; console.log("CLOSED"); });
      const write = child.stdin.write.bind(child.stdin);
      child.stdin.write = (...args) => { if (closed) writesAfterClose++; return write(...args); };
      const kill = child.kill.bind(child);
      child.kill = (...args) => { if (closed) killsAfterClose++; return kill(...args); };
      return child;
    },
  });
  await assert.rejects(adapter.run({ target: "pi", requestId: "post-close", cwd: process.cwd(), task: "Return DONE",
    route: {}, policy: { write: false }, execution: { timeoutMs: 1000 } }, {
    onProgress() { console.log("CALLBACK"); return new Promise(() => {}); },
  }), (error) => error.details.kind === "timeout" && error.details.timedOut === true);
  assert.equal(closed, true);
  assert.equal(child.exitCode, 0);
  assert.equal(writesAfterClose, 0);
  assert.equal(killsAfterClose, 0);
  console.log("TIMEOUT");
}

test("Pi post-close pending callback keeps the deadline alive without any extra handles", async () => {
  const url = new URL("../src/adapters/pi.mjs", import.meta.url).href;
  const script = `await (${postCloseDeadlineScenario.toString()})(${JSON.stringify(url)});`;
  const { stdout } = await promisify(execFile)(process.execPath, ["--unhandled-rejections=strict", "--input-type=module", "-e", script], {
    timeout: 10_000, maxBuffer: 64 * 1024,
  });
  assert.deepEqual(stdout.trim().split(/\r?\n/), ["CALLBACK", "CLOSED", "TIMEOUT"]);
});

class IdleChild extends EventEmitter {
  constructor(closeDelay = 0) {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.closeDelay = closeDelay;
  }
  kill() {
    if (this.killed) return;
    this.killed = true;
    setTimeout(() => this.emit("close", null, "SIGTERM"), this.closeDelay);
  }
}

test("OpenCode's internal 50ms deadline is timeout, not caller cancellation", async (t) => {
  const keepAlive = setTimeout(() => {}, 1000);
  t.after(() => clearTimeout(keepAlive));
  const child = new IdleChild();
  const adapter = new OpenCodeAdapter({ command: "fake-opencode", spawnFn: () => child });
  await assert.rejects(adapter.run(request("opencode", 50)), (error) => {
    assert.equal(error.details.kind, "timeout");
    assert.equal(error.details.timedOut, true);
    assert.equal(error.details.aborted, false);
    return true;
  });
  assert.equal(child.killed, true);
});

for (const closeDelay of [0, 80]) {
  test(`OpenCode preserves caller cancellation with a ${closeDelay}ms child shutdown`, async () => {
    const controller = new AbortController();
    const child = new IdleChild(closeDelay);
    const adapter = new OpenCodeAdapter({ command: "fake-opencode", spawnFn: () => child });
    const run = adapter.run(request("opencode", 50), { signal: controller.signal });
    controller.abort();
    await assert.rejects(run, (error) => {
      assert.equal(error.details.kind, "abort");
      assert.equal(error.details.aborted, true);
      assert.equal(error.details.timedOut, false);
      return true;
    });
  });
}
