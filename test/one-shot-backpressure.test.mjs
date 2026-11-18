import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import test from "node:test";
import { ClaudeAdapter } from "../src/adapters/claude.mjs";
import { CodexAdapter } from "../src/adapters/codex.mjs";
import { CursorAdapter } from "../src/adapters/cursor.mjs";

const adapters = { claude: ClaudeAdapter, cursor: CursorAdapter, codex: CodexAdapter };
const tick = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class StreamingChild extends EventEmitter {
  constructor(chunks, code = 0) {
    super();
    this.stdout = Readable.from(chunks, { objectMode: false, highWaterMark: 1024 });
    this.stderr = new EventEmitter();
    this.stdin = { write() { return true; }, end() {} };
    this.stdout.on("end", () => this.emit("close", code, null));
  }
  kill() {
    if (this.killed) return false;
    this.killed = true;
    this.stdout.destroy();
    queueMicrotask(() => this.emit("close", null, "SIGTERM"));
    return true;
  }
}

function request(target) {
  return { requestId: `backpressure-${target}`, target, task: "Return a final answer.", cwd: process.cwd(),
    context: { requiredResultFields: ["finalText"] }, execution: { timeoutMs: 5000 } };
}

function terminal(target, failed = false) {
  if (target === "codex") return { type: "turn.completed", usage: { input_tokens: 12, output_tokens: 4 } };
  return { type: "result", subtype: failed ? "error_during_execution" : "success", is_error: failed,
    result: failed ? "Authentication required." : "DONE", session_id: "backpressure-session",
    usage: target === "claude" ? { input_tokens: 12, output_tokens: 4 } : { inputTokens: 12, outputTokens: 4 } };
}

function* stream(target, count = 128, paddingBytes = 0) {
  const encode = (event) => JSON.stringify({ ...event, ...(paddingBytes ? { padding: "x".repeat(paddingBytes) } : {}) });
  yield Buffer.from(`${encode(target === "codex" ? { type: "thread.started", thread_id: "backpressure-session" }
    : { type: "system", subtype: "init", session_id: "backpressure-session" })}\n`);
  for (let index = 0; index < count; index += 1) {
    const text = `delta-${index} ${"x".repeat(1024)}`;
    const event = target === "claude" ? { type: "assistant", message: { content: [{ type: "text", text }] } }
      : target === "codex" ? { type: "item.completed", item: { type: "agent_message", text } }
        : { type: "assistant", delta: text };
    yield Buffer.from(`${encode(event)}\n`);
  }
  yield Buffer.from(encode(terminal(target)));
}

function adapter(target, chunks, code = 0, onChild = () => {}) {
  return new adapters[target]({
    command: `fake-${target}`,
    ...(target === "codex" ? {
      gitCheckFn: async () => true,
      quotaProbeFn: async () => ({ status: "unknown", source: "test", observedAt: 0, reason: "fixture" }),
    } : {}),
    spawnFn(_command, args) {
      if (target === "codex") writeFileSync(args[args.indexOf("-o") + 1], "DONE");
      const child = new StreamingChild(chunks, code);
      onChild(child);
      return child;
    },
  });
}

for (const target of Object.keys(adapters)) {
  test(`${target} streaming progress applies backpressure and settles before success`, async () => {
    const gate = deferred();
    const started = deferred();
    let active = 0;
    let maximum = 0;
    let delivered = 0;
    let persisted = 0;
    let settled = false;
    let child;
    let produced = 0;
    function* chunks() {
      // Each record fills the byte budget, so a bounded batch contains one callback.
      for (const chunk of stream(target, 128, 64 * 1024)) { produced += 1; yield chunk; }
    }
    const run = adapter(target, chunks(), 0, (value) => { child = value; }).run(request(target), { onProgress(event) {
      if (event.type === `${target}_stdout`) return;
      active += 1;
      maximum = Math.max(maximum, active);
      delivered += 1;
      started.resolve();
      return gate.promise.then(async () => { await tick(); persisted += 1; active -= 1; });
    } });
    void run.then(() => { settled = true; }, () => { settled = true; });
    await started.promise;
    await tick();
    const beforeRelease = { active, delivered, settled, paused: child.stdout.isPaused() };
    const producedBeforeRelease = produced;
    gate.resolve();
    const output = await run;
    assert.deepEqual(beforeRelease, { active: 1, delivered: 1, settled: false, paused: true });
    assert.ok(producedBeforeRelease < 130, "the reader must pause the source instead of queueing the whole stream");
    assert.equal(maximum, 1, "only one persistence callback may be pending");
    assert.equal(persisted, delivered);
    assert.equal(delivered, 130, "identity, all deltas and terminal usage must reach progress");
    assert.equal(output.result.finalText, "DONE");
  });

  test(`${target} final progress rejection fails instead of returning success`, async () => {
    await assert.rejects(adapter(target, stream(target, 0)).run(request(target), { onProgress(event) {
      if (event.type === `${target}_stdout`) return Promise.reject(new Error("persistence unavailable"));
    } }), (error) => error.details?.kind === "transport" && /progress callback failed/.test(error.message));
  });

  for (const mode of ["throw", "reject"]) {
    test(`${target} streaming progress ${mode} is an explicit transport failure`, async () => {
      let calls = 0;
      await assert.rejects(adapter(target, stream(target, 0)).run(request(target), { onProgress() {
        calls += 1;
        const error = new Error("persistence unavailable");
        if (mode === "throw") throw error;
        return Promise.reject(error);
      } }), (error) => error.details?.kind === "transport" && /progress callback failed/.test(error.message));
      assert.equal(calls, 1, "no more progress may be delivered after consumer failure");
    });
  }

  test(`${target} synchronous progress consumers finish without pending work`, async () => {
    let count = 0;
    const output = await adapter(target, stream(target, 4)).run(request(target), { onProgress() { count += 1; } });
    assert.equal(output.result.finalText, "DONE");
    assert.equal(count, 7);
  });
}

for (const target of ["claude", "cursor"]) {
  for (const code of [0, 1]) {
    test(`${target} single-JSON fallback awaits progress on exit ${code}`, async () => {
      const gate = deferred();
      const started = deferred();
      let persisted = false;
      let settled = false;
      const stdout = JSON.stringify(terminal(target, code !== 0), null, 2);
      const run = adapter(target, [Buffer.from(stdout)], code).run(request(target), { onProgress(event) {
        if (event.type === `${target}_stdout`) return;
        started.resolve();
        return gate.promise.then(() => { persisted = true; });
      } });
      void run.then(() => { settled = true; }, () => { settled = true; });
      await started.promise;
      await tick();
      const settledBeforeProgress = settled;
      gate.resolve();
      if (code) await assert.rejects(run, (error) => error.details?.kind === "provider-auth");
      else assert.equal((await run).result.finalText, "DONE");
      assert.equal(settledBeforeProgress, false);
      assert.equal(persisted, true);
    });

    test(`${target} single-JSON fallback progress rejection is not swallowed on exit ${code}`, async () => {
      const stdout = JSON.stringify(terminal(target, code !== 0), null, 2);
      await assert.rejects(adapter(target, [Buffer.from(stdout)], code).run(request(target), { onProgress() {
        return Promise.reject(new Error("persistence unavailable"));
      } }), (error) => error.details?.kind === "transport" && /progress callback failed/.test(error.message));
    });
  }
}
