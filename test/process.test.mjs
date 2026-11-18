import assert from "node:assert/strict";
import childProcess, { execFile, spawn } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { ProcessError, runProcess, terminateProcessTree } from "../src/process.mjs";

const exec = promisify(execFile);
const runner = fileURLToPath(new URL("./fixtures/process-runner.mjs", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/process-child.mjs", import.meta.url));

function trackedSpawn(t) {
  const state = { child: null, closed: false };
  state.spawnFn = (...args) => {
    state.child = spawn(...args);
    state.child.once("close", () => { state.closed = true; });
    return state.child;
  };
  t.after(() => { if (state.child && !state.closed) state.child.kill("SIGKILL"); });
  return state;
}

function assertStopped(state) {
  assert.equal(state.closed, true, "promise settles only after the child closes");
  assert.throws(() => process.kill(state.child.pid, 0), { code: "ESRCH" });
}

test("80 KB stdin and early real child exit cannot crash the runner", { timeout: 20000 }, async () => {
  const { stdout, stderr } = await exec(process.execPath, [runner, "early-close"], { timeout: 15000 });
  assert.equal(stdout.trim(), "settled all early closes");
  assert.equal(stderr, "");
});

for (const [mode, expected] of [
  ["async-reject", "handled async callback failure"],
  ["async-after-close", "handled callback failure after close"],
  ["async-deadline", "deadline settled pending callback after close"],
]) {
  test(`${mode} settles in an isolated real process`, { timeout: 6000 }, async () => {
    const { stdout, stderr } = await exec(process.execPath, [runner, mode], { timeout: 5000 });
    assert.equal(stdout.trim(), expected);
    assert.equal(stderr, "");
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function terminationProbe(t) {
  const child = fakeChild();
  child.pid = 424242;
  child.stdout = new PassThrough();
  const state = { exited: false, closed: false };
  const kills = [];
  child.on("exit", () => { state.exited = true; });
  child.stdout.on("end", () => {
    state.closed = true;
    child.emit("close", 0, null);
  });
  child.kill = (signal = "SIGTERM") => { kills.push({ ...state, signal }); return true; };
  const intercepted = t.mock.method(childProcess, "spawn", (command) => {
    assert.match(command, /^[a-z]:[\\/].*[\\/]System32[\\/]taskkill\.exe$/i);
    kills.push({ ...state, signal: "taskkill" });
    return new EventEmitter();
  });
  syncBuiltinESMExports();
  t.after(() => { intercepted.mock.restore(); syncBuiltinESMExports(); });
  return { child, state, kills };
}

function windowsCleanupProbe(t) {
  const child = fakeChild();
  child.pid = 424242;
  child.kill = t.mock.fn();
  const taskkill = new EventEmitter();
  const warnings = t.mock.method(console, "warn", () => {});
  const intercepted = t.mock.method(childProcess, "spawn", () => taskkill);
  syncBuiltinESMExports();
  t.after(() => { intercepted.mock.restore(); syncBuiltinESMExports(); });
  return { child, taskkill, warnings, intercepted };
}

function assertWindowsCleanupWarning(warnings) {
  assert.deepEqual(warnings.mock.calls.map((call) => call.arguments), [
    ["Windows process tree cleanup failed. Descendants may survive."],
  ]);
}

test("Windows cleanup warns once and kills the direct child when taskkill cannot launch", { skip: process.platform !== "win32" }, (t) => {
  const { child, taskkill, warnings, intercepted } = windowsCleanupProbe(t);
  terminateProcessTree(child);
  taskkill.emit("error", new Error("taskkill could not launch"));
  taskkill.emit("close", -1, null);

  assert.equal(intercepted.mock.callCount(), 1);
  const [command, args] = intercepted.mock.calls[0].arguments;
  assert.match(command, /^[a-z]:[\\/].*[\\/]System32[\\/]taskkill\.exe$/i);
  assert.deepEqual(args, ["/PID", String(child.pid), "/T", "/F"]);
  assert.equal(child.kill.mock.callCount(), 1);
  assertWindowsCleanupWarning(warnings);
});

test("Windows cleanup warns once and kills the direct child when spawning taskkill throws", { skip: process.platform !== "win32" }, (t) => {
  const { child, warnings, intercepted } = windowsCleanupProbe(t);
  intercepted.mock.mockImplementation(() => { throw new Error("taskkill could not launch"); });
  terminateProcessTree(child);

  assert.equal(intercepted.mock.callCount(), 1);
  assert.equal(child.kill.mock.callCount(), 1);
  assertWindowsCleanupWarning(warnings);
});

test("Windows cleanup warns once and kills the direct child when taskkill exits nonzero", { skip: process.platform !== "win32" }, (t) => {
  const { child, taskkill, warnings, intercepted } = windowsCleanupProbe(t);
  terminateProcessTree(child);
  taskkill.emit("close", 1, null);

  assert.equal(intercepted.mock.callCount(), 1);
  assert.equal(child.kill.mock.callCount(), 1);
  assertWindowsCleanupWarning(warnings);
});

test("Windows cleanup warns without targeting the root after it exits before taskkill fails", { skip: process.platform !== "win32" }, (t) => {
  const { child, taskkill, warnings, intercepted } = windowsCleanupProbe(t);
  terminateProcessTree(child);
  child.exitCode = 0;
  child.emit("exit", 0, null);
  taskkill.emit("close", 1);

  assert.equal(intercepted.mock.callCount(), 1);
  assert.equal(child.kill.mock.callCount(), 0);
  assertWindowsCleanupWarning(warnings);
});

test("Windows cleanup warns without launching taskkill when the root has already exited", { skip: process.platform !== "win32" }, (t) => {
  const { child, warnings, intercepted } = windowsCleanupProbe(t);
  child.exitCode = 0;
  terminateProcessTree(child);

  assert.equal(intercepted.mock.callCount(), 0);
  assert.equal(child.kill.mock.callCount(), 0);
  assertWindowsCleanupWarning(warnings);
});

test("Windows cleanup emits no warning when taskkill succeeds", { skip: process.platform !== "win32" }, (t) => {
  const { child, taskkill, warnings, intercepted } = windowsCleanupProbe(t);
  terminateProcessTree(child);
  taskkill.emit("close", 0, null);

  assert.equal(intercepted.mock.callCount(), 1);
  assert.equal(child.kill.mock.callCount(), 0);
  assert.equal(warnings.mock.callCount(), 0);
});

for (const mode of ["callback rejection", "timeout"]) {
  test(`${mode} after exit drains streams without targeting the released PID`, { timeout: 3000 }, async (t) => {
    const { child, state, kills } = terminationProbe(t);
    const started = deferred();
    const callback = deferred();
    const tail = "tail\n".repeat(32_000);
    const promise = runProcess("synthetic", [], {
      spawnFn: () => child,
      timeoutMs: mode === "timeout" ? 100 : 1000,
      onStdoutLine() { started.resolve(); return callback.promise; },
    });
    child.stdout.write("ready\n");
    await started.promise;
    child.stdout.end(tail);
    child.emit("exit", 0, null);
    assert.deepEqual(state, { exited: true, closed: false });
    const rejected = assert.rejects(promise, (error) => {
      assert.ok(error instanceof ProcessError);
      assert.equal(error.details.kind, mode === "timeout" ? "timeout" : "transport");
      assert.equal(error.details.stdoutBytes, 6 + Buffer.byteLength(tail));
      assert.ok(error.details.stdout.endsWith(tail));
      return true;
    });
    if (mode === "callback rejection") callback.reject(new Error("synthetic callback failure after exit"));
    await rejected;
    callback.reject(new Error("synthetic late callback failure"));
    await nextTurn();
    assert.equal(state.closed, true);
    assert.deepEqual(kills, [], "neither taskkill nor child.kill may target an exited child");
  });
}

test("kill escalation stops once exit has released the PID, even before stream close", { timeout: 4000 }, async (t) => {
  const { child, state, kills } = terminationProbe(t);
  const started = deferred();
  const callback = deferred();
  const promise = runProcess("synthetic", [], {
    spawnFn: () => child,
    timeoutMs: 3000,
    onStdoutLine() { started.resolve(); return callback.promise; },
  });
  const rejected = assert.rejects(promise, (error) => error instanceof ProcessError && /synthetic callback failure/.test(error.message));
  child.stdout.write("ready\n");
  await started.promise;
  callback.reject(new Error("synthetic callback failure"));
  await nextTurn();
  assert.equal(kills.length, 1, "initial termination targets the still-owned child");
  assert.equal(kills[0].exited, false);
  child.emit("exit", 0, null);
  await delay(1100);
  assert.deepEqual(state, { exited: true, closed: false });
  child.stdout.end("remaining diagnostics\n");
  await rejected;
  assert.equal(state.closed, true);
  assert.equal(kills.length, 1, "no delayed SIGKILL may target the released PID");
});

test("successful child close waits for its async final-line callback", { timeout: 6000 }, async (t) => {
  const state = trackedSpawn(t);
  const started = deferred();
  const callback = deferred();
  let settled = false;
  const promise = runProcess(process.execPath, ["-e", "process.stdout.write('last')"], {
    spawnFn: state.spawnFn,
    timeoutMs: 3000,
    async onStdoutLine(line) {
      assert.equal(line, "last");
      started.resolve();
      await callback.promise;
    },
  }).then((output) => { settled = true; return output; });
  await started.promise;
  await nextTurn();
  assert.equal(state.closed, true);
  assert.equal(settled, false);
  callback.resolve();
  const output = await promise;
  assert.equal(output.code, 0);
  assert.equal(output.stdout, "last");
  assertStopped(state);
});

test("async callbacks apply real stdout backpressure through 64 MiB", { timeout: 20000 }, async (t) => {
  const state = trackedSpawn(t);
  const first = deferred();
  const gate = deferred();
  let callbacks = 0;
  let active = 0;
  let maxActive = 0;
  const promise = runProcess(process.execPath, [fixture, "volume"], {
    spawnFn: state.spawnFn,
    timeoutMs: 10000,
    async onStdoutLine(line) {
      maxActive = Math.max(maxActive, ++active);
      const index = callbacks++;
      if (index === 0) {
        first.resolve();
        await gate.promise;
      } else await Promise.resolve();
      if (index < 1024) assert.equal(line, "x".repeat(65535));
      else assert.equal(line, '{"type":"result","result":"terminal"}');
      active--;
    },
  });
  let output;
  try {
    await first.promise;
    await delay(50);
    assert.equal(callbacks, 1, "do not queue callbacks while the first is pending");
    assert.equal(state.child.exitCode, null, "the producer cannot finish 64 MiB while the consumer is blocked");
    t.diagnostic(JSON.stringify({ readableLength: state.child.stdout.readableLength, highWaterMark: state.child.stdout.readableHighWaterMark }));
    // highWaterMark is a threshold; a single 64 KiB pipe read may overshoot it.
    assert.ok(state.child.stdout.readableLength <= state.child.stdout.readableHighWaterMark + 65536);
  } finally {
    gate.resolve();
    output = await promise;
  }
  assert.equal(callbacks, 1025);
  assert.equal(maxActive, 1);
  assert.equal(active, 0);
  assert.equal(output.stdoutBytes, 64 * 1024 * 1024 + 38);
  assert.equal(output.stderrBytes, 512 * 1024);
  assert.ok(Buffer.byteLength(output.stdout) <= 1024 * 1024);
  assert.ok(Buffer.byteLength(output.stderr) <= 64 * 1024);
  assertStopped(state);
});

test("async callbacks preserve every line in a single chunk and its final partial line", { timeout: 6000 }, async () => {
  const lines = [];
  const output = await runProcess(process.execPath, ["-e", "process.stdout.write('first\\nsecond\\nthird')"], {
    timeoutMs: 3000,
    async onStdoutLine(line) {
      await nextTurn();
      lines.push(line);
    },
  });
  assert.deepEqual(lines, ["first", "second", "third"]);
  assert.equal(output.stdout, "first\nsecond\nthird");
});

test("400 real streamed lines use bounded concurrent callback batches", { timeout: 6000 }, async () => {
  let active = 0;
  let peak = 0;
  const lines = [];
  const output = await runProcess(process.execPath, ["-e", "process.stdout.write(Array.from({length:400}, (_, i) => i + '\\n').join(''))"], {
    timeoutMs: 3000,
    async onStdoutLine(line) {
      lines.push(Number(line));
      peak = Math.max(peak, ++active);
      await delay(25);
      active--;
    },
  });
  assert.equal(output.code, 0);
  assert.deepEqual(lines, Array.from({ length: 400 }, (_, i) => i));
  assert.equal(active, 0);
  assert.ok(peak > 1 && peak <= 100, `peak pending callbacks: ${peak}`);
});

for (const [lineBytes, maxBatch] of [[16, 100], [2048, 32], [70_000, 1]]) {
  test(`injected giant chunks keep ${lineBytes}-byte lines within the callback batch cap`, async () => {
    const child = fakeChild();
    child.stdout = new PassThrough();
    child.stdout.on("end", () => child.emit("close", 0, null));
    const started = deferred();
    const gate = deferred();
    const count = lineBytes > 65536 ? 3 : 400;
    let active = 0;
    let peak = 0;
    let callbacks = 0;
    const promise = runProcess("unused", [], {
      spawnFn: () => child,
      timeoutMs: 3000,
      async onStdoutLine(line) {
        assert.equal(Buffer.byteLength(line) + 1, lineBytes);
        callbacks++;
        peak = Math.max(peak, ++active);
        started.resolve();
        await gate.promise;
        active--;
      },
    });
    child.stdout.end(Buffer.from(`${"x".repeat(lineBytes - 1)}\n`.repeat(count)));
    await started.promise;
    await nextTurn();
    assert.equal(callbacks, maxBatch);
    gate.resolve();
    await promise;
    assert.equal(callbacks, count);
    assert.equal(peak, maxBatch);
    assert.equal(active, 0);
  });
}

for (const stateAtAbort of ["running", "closed"]) {
  test(`abort wins over a late callback rejection when the child is ${stateAtAbort}`, { timeout: 6000 }, async (t) => {
    const state = trackedSpawn(t);
    const controller = new AbortController();
    const started = deferred();
    const callback = deferred();
    const promise = runProcess(process.execPath, stateAtAbort === "running" ? [fixture, "wait"] : ["-e", "process.stdout.write('ready')"], {
      spawnFn: state.spawnFn,
      signal: controller.signal,
      timeoutMs: 3000,
      onStdoutLine() { started.resolve(); return callback.promise; },
    });
    await started.promise;
    assert.equal(state.closed, stateAtAbort === "closed");
    const rejected = assert.rejects(promise, (error) => {
      assert.ok(error instanceof ProcessError);
      assert.equal(error.details.aborted, true);
      assert.equal(error.details.kind, "abort");
      assert.match(error.details.stdout, /^ready/);
      return true;
    });
    controller.abort();
    callback.reject(new Error("synthetic late callback failure"));
    await rejected;
    await nextTurn();
    assertStopped(state);
  });
}

test("timeout kills a live child with a pending callback and absorbs a late rejection", { timeout: 6000 }, async (t) => {
  const state = trackedSpawn(t);
  const callback = deferred();
  await assert.rejects(runProcess(process.execPath, [fixture, "wait"], {
    spawnFn: state.spawnFn,
    timeoutMs: 1000,
    onStdoutLine: () => callback.promise,
  }), (error) => {
    assert.equal(error.details.timedOut, true);
    assert.equal(error.details.kind, "timeout");
    assert.equal(error.details.stdout, "ready\n");
    assert.equal(error.details.stderr, "diagnostic tail\n");
    return true;
  });
  callback.reject(new Error("synthetic late callback failure"));
  await nextTurn();
  assertStopped(state);
});

test("nonzero exit drains pending callbacks before returning its original exit code", { timeout: 6000 }, async (t) => {
  const state = trackedSpawn(t);
  const callback = deferred();
  const started = deferred();
  let callbacks = 0;
  let settled = false;
  const promise = runProcess(process.execPath, ["-e", "process.stdout.write('final'); process.stderr.write('diagnostic'); process.exitCode = 7"], {
    spawnFn: state.spawnFn,
    timeoutMs: 3000,
    onStdoutLine() { callbacks++; started.resolve(); return callback.promise; },
  });
  promise.then(() => { settled = true; }, () => { settled = true; });
  await started.promise;
  await nextTurn();
  assert.equal(state.closed, true);
  assert.equal(settled, false);
  const rejected = assert.rejects(promise, (error) => {
    assert.equal(error.details.code, 7);
    assert.equal(error.details.stdout, "final");
    assert.equal(error.details.stderr, "diagnostic");
    assert.equal(error.details.timedOut, undefined);
    return true;
  });
  assert.equal(callbacks, 1);
  callback.resolve();
  await rejected;
  assertStopped(state);
});

test("event-mode streams queue small chunks until async callbacks finish before a nonzero exit", async () => {
  const child = fakeChild();
  const gate = deferred();
  const expected = [
    { type: "session", id: "synthetic-session" },
    { type: "error", error: { type: "provider.auth", status: 401, message: "synthetic authorization failure" } },
  ];
  const seen = [];
  let settled = false;
  const promise = runProcess("synthetic", [], {
    spawnFn: () => child,
    timeoutMs: 1000,
    onStdoutLine(line) { seen.push(JSON.parse(line)); return gate.promise; },
  });
  promise.then(() => { settled = true; }, () => { settled = true; });
  const rejected = assert.rejects(promise, (error) => {
    assert.ok(error instanceof ProcessError);
    assert.equal(error.details.code, 7);
    assert.equal(error.details.kind, undefined);
    assert.equal(error.details.stdoutBytes, Buffer.byteLength(expected.map((event) => JSON.stringify(event) + "\n").join("")));
    return true;
  });
  for (const event of expected) child.stdout.emit("data", Buffer.from(JSON.stringify(event) + "\n"));
  child.emit("exit", 7, null);
  child.emit("close", 7, null);
  await nextTurn();
  assert.equal(settled, false);
  assert.equal(seen.length, 1);
  gate.resolve();
  await rejected;
  assert.deepEqual(seen, expected);
});

for (const limit of ["bytes", "chunks"]) {
  test(`event-mode callback backlog enforces its ${limit} bound`, async () => {
    const child = fakeChild();
    const callback = deferred();
    let callbacks = 0;
    const promise = runProcess("synthetic", [], {
      spawnFn: () => child,
      timeoutMs: 1000,
      onStdoutLine() { callbacks++; return callback.promise; },
    });
    const rejected = assert.rejects(promise, (error) => {
      assert.ok(error instanceof ProcessError);
      assert.equal(error.details.kind, "output-limit");
      assert.equal(error.details.stream, "stdout");
      assert.equal(error.details.maxPendingStdoutBytes, 4 * 1024 * 1024);
      assert.equal(error.details.maxPendingStdoutChunks, 256);
      assert.equal(error.details.stdoutBytes, 6 + (limit === "bytes" ? 4 * 1024 * 1024 : 256 * 2) + 1);
      assert.ok(Buffer.byteLength(error.details.stdout) <= 1024 * 1024);
      return true;
    });
    child.stdout.emit("data", Buffer.from("ready\n"));
    if (limit === "bytes") child.stdout.emit("data", Buffer.alloc(4 * 1024 * 1024, "x"));
    else for (let i = 0; i < 256; i++) child.stdout.emit("data", Buffer.from("x\n"));
    assert.equal(child.killed, undefined, "the exact backlog limit remains accepted");
    child.stdout.emit("data", Buffer.from("x"));
    await rejected;
    callback.reject(new Error("synthetic late callback failure"));
    await nextTurn();
    assert.equal(callbacks, 1);
    assert.equal(child.killed, true);
  });
}

test("64 MiB real output keeps bounded tails and all streaming callbacks", { timeout: 20000 }, async (t) => {
  const { stdout, stderr } = await exec(process.execPath, ["--expose-gc", runner, "volume"], { timeout: 15000 });
  assert.equal(stderr, "");
  const measured = JSON.parse(stdout);
  t.diagnostic(JSON.stringify(measured));
  assert.ok(measured.retainedStdoutBytes <= 1024 * 1024);
  assert.ok(measured.retainedStderrBytes <= 64 * 1024);
  assert.equal(measured.stdoutBytes, 64 * 1024 * 1024 + Buffer.byteLength(`${measured.lastLine}\n`));
  assert.equal(measured.stderrBytes, 512 * 1024);
  assert.equal(measured.stdoutTruncated, true);
  assert.equal(measured.stderrTruncated, true);
  assert.equal(measured.callbacks, 1025);
  assert.equal(measured.lastLine, '{"type":"result","result":"terminal"}');
  assert.equal(measured.terminalTail, true);
  assert.equal(measured.stderrTail, true);
  assert.ok(measured.peakGrowth < 128 * 1024 * 1024, `peak RSS grew ${measured.peakGrowth} bytes`);
});

test("unterminated output fails at the line limit and cleans up the real child", { timeout: 10000 }, async (t) => {
  const state = trackedSpawn(t);
  let callbacks = 0;
  await assert.rejects(runProcess(process.execPath, [fixture, "unterminated"], {
    spawnFn: state.spawnFn,
    timeoutMs: 5000,
    onStdoutLine() { callbacks++; },
  }), (error) => {
    assert.ok(error instanceof ProcessError);
    assert.equal(error.details.kind, "output-limit");
    assert.equal(error.details.maxLineBytes, 2 * 1024 * 1024);
    assert.equal(error.details.stream, "stdout");
    assert.ok(error.details.stdoutBytes > error.details.maxLineBytes);
    assert.ok(Buffer.byteLength(error.details.stdout) <= 1024 * 1024);
    assert.equal(error.details.stdoutTruncated, true);
    assert.equal(error.details.stderrBytes, 0);
    assert.equal(error.details.stderrTruncated, false);
    return true;
  });
  assert.equal(callbacks, 0, "never pass a truncated JSON line to the adapter");
  assertStopped(state);
});

test("real input drains completely before EOF", { timeout: 10000 }, async () => {
  const lines = Array.from({ length: 12 }, () => "界".repeat(80_000));
  const output = await runProcess(process.execPath, [fixture, "read"], { stdinLines: lines, timeoutMs: 5000 });
  assert.equal(Number(output.stdout.trim()), lines.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0));
  assert.equal(output.stdoutBytes, Buffer.byteLength(output.stdout));
  assert.equal(output.stderrBytes, 0);
  assert.equal(output.stdoutTruncated, false);
  assert.equal(output.stderrTruncated, false);
});

for (const mode of ["abort", "timeout", "callback"]) {
  test(`${mode} retains diagnostics and settles after real child cleanup`, { timeout: 10000 }, async (t) => {
    const state = trackedSpawn(t);
    const controller = new AbortController();
    await assert.rejects(runProcess(process.execPath, [fixture, "wait"], {
      spawnFn: state.spawnFn,
      signal: controller.signal,
      timeoutMs: mode === "timeout" ? 1000 : 5000,
      onStdoutLine(line) {
        assert.equal(line, "ready");
        if (mode === "abort") controller.abort();
        if (mode === "callback") throw new Error("synthetic callback failure");
      },
    }), (error) => {
      assert.ok(error instanceof ProcessError);
      if (mode === "abort") assert.equal(error.details.aborted, true);
      if (mode === "timeout") assert.equal(error.details.timedOut, true);
      if (mode === "callback") assert.match(error.message, /synthetic callback failure/);
      assert.equal(error.details.stdout, "ready\n");
      assert.equal(error.details.stderr, "diagnostic tail\n");
      assert.equal(error.details.stdoutBytes, 6);
      assert.equal(error.details.stderrBytes, 16);
      assert.equal(error.details.stdoutTruncated, false);
      assert.equal(error.details.stderrTruncated, false);
      return true;
    });
    assertStopped(state);
  });
}

test("pre-aborted calls and invalid byte bounds never spawn", async () => {
  const spawnFn = () => { assert.fail("must not spawn"); };
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runProcess("unused", [], { spawnFn, signal: controller.signal }), (error) => {
    assert.equal(error.details.aborted, true);
    assert.equal(error.details.stdoutBytes, 0);
    assert.equal(error.details.stdoutTruncated, false);
    return true;
  });
  for (const name of ["maxStdoutBytes", "maxStderrBytes", "maxLineBytes"]) {
    for (const value of [0, -1, Infinity, NaN, null, "1024", 1.5]) {
      await assert.rejects(runProcess("unused", [], { spawnFn, [name]: value }), RangeError);
    }
  }
});

test("nonzero exits carry configured byte tails and complete streamed lines", async () => {
  const lines = [];
  await assert.rejects(runProcess(process.execPath, ["-e", "process.stdout.write('first\\nlast\\n'); process.stderr.write('diagnostic'); process.exitCode = 7"], {
    maxStdoutBytes: 5,
    maxStderrBytes: 4,
    maxLineBytes: 5,
    onStdoutLine: (line) => lines.push(line),
    timeoutMs: 5000,
  }), (error) => {
    assert.equal(error.details.code, 7);
    assert.equal(error.details.stdout, "last\n");
    assert.equal(error.details.stderr, "stic");
    assert.equal(error.details.stdoutBytes, 11);
    assert.equal(error.details.stderrBytes, 10);
    assert.equal(error.details.stdoutTruncated, true);
    assert.equal(error.details.stderrTruncated, true);
    return true;
  });
  assert.deepEqual(lines, ["first", "last"]);
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => { child.killed = true; queueMicrotask(() => child.emit("close", null, "SIGTERM")); };
  return child;
}

test("a giant single chunk cannot bypass the line bound with or without a newline", async () => {
  for (const suffix of ["", "\n"]) {
    const child = fakeChild();
    const promise = runProcess("unused", [], {
      spawnFn: () => child,
      maxStdoutBytes: 32,
      maxLineBytes: 64,
      onStdoutLine() { assert.fail("oversized lines must never reach a parser"); },
    });
    const chunk = Buffer.from(`${"x".repeat(4 * 1024 * 1024)}${suffix}`);
    child.stdout.emit("data", chunk);
    await assert.rejects(promise, (error) => {
      assert.equal(error.details.kind, "output-limit");
      assert.equal(error.details.stdoutBytes, chunk.length);
      assert.equal(error.details.stdoutTruncated, true);
      assert.equal(Buffer.byteLength(error.details.stdout), 32);
      return true;
    });
  }
});

test("abort while generating stdin prevents the pending write", async () => {
  const child = fakeChild();
  const controller = new AbortController();
  child.stdin = new EventEmitter();
  child.stdin.write = () => { assert.fail("must not write after abort"); };
  function* input() { controller.abort(); yield "pending"; }
  await assert.rejects(runProcess("unused", [], {
    spawnFn: () => child, signal: controller.signal, stdinLines: input(),
  }), (error) => error.details.aborted);
});

test("UTF-8 split at every byte survives callbacks, CRLF and the unterminated final line", async () => {
  const child = fakeChild();
  const text = "é🙂\r\n漢字";
  const lines = [];
  const promise = runProcess("unused", [], {
    spawnFn: () => child,
    maxStdoutBytes: 8,
    maxStderrBytes: 5,
    onStdoutLine: (line) => lines.push(line),
  });
  for (const byte of Buffer.from(text)) child.stdout.emit("data", Buffer.from([byte]));
  for (const byte of Buffer.from("é🙂")) child.stderr.emit("data", Buffer.from([byte]));
  child.emit("close", 0, null);
  const output = await promise;
  assert.deepEqual(lines, ["é🙂", "漢字"]);
  assert.equal(output.stdout, "\r\n漢字");
  assert.equal(output.stderr, "🙂");
  assert.equal(output.stdoutBytes, Buffer.byteLength(text));
  assert.equal(output.stderrBytes, 6);
  assert.equal(output.stdoutTruncated, true);
  assert.equal(output.stderrTruncated, true);
});

test("stdin backpressure stops iterator advancement until drain, then closes stdin", async () => {
  const child = fakeChild();
  const writes = [];
  const callbacks = [];
  child.stdin = new Writable({ highWaterMark: 1, write(chunk, encoding, callback) { writes.push(String(chunk)); callbacks.push(callback); } });
  const promise = runProcess("unused", [], { spawnFn: () => child, stdinLines: ["one", "two", "three"] });
  assert.deepEqual(writes, ["one\n"]);
  callbacks.shift()();
  assert.deepEqual(writes, ["one\n", "two\n"]);
  callbacks.shift()();
  assert.deepEqual(writes, ["one\n", "two\n", "three\n"]);
  callbacks.shift()();
  assert.equal(child.stdin.writableEnded, true);
  child.emit("close", 0, null);
  await promise;
});

for (const mode of ["abort", "exit", "stdin-error", "synchronous-write-error"]) {
  test(`${mode} stops queued stdin writes, including late drain/error events`, async () => {
    const child = fakeChild();
    const controller = new AbortController();
    let writes = 0;
    let returned = false;
    child.stdin = new EventEmitter();
    child.stdin.write = () => {
      writes++;
      if (mode === "synchronous-write-error") throw Object.assign(new Error("closed pipe"), { code: "EPIPE" });
      return false;
    };
    child.stdin.end = () => { assert.fail("closed stdin must not receive end"); };
    function* input() { try { yield "one"; yield "two"; } finally { returned = true; } }
    const promise = runProcess("unused", [], { spawnFn: () => child, signal: controller.signal, stdinLines: input() });
    if (mode === "abort") controller.abort();
    if (mode === "exit") child.emit("exit", 0, null);
    if (mode === "stdin-error") child.stdin.emit("error", Object.assign(new Error("closed pipe"), { code: "EPIPE" }));
    child.stdin.emit("drain");
    if (mode === "exit") child.emit("close", 0, null);
    if (mode === "exit") await promise;
    else await assert.rejects(promise, (error) => mode === "abort" ? error.details.aborted : error.details.code === "EPIPE");
    child.stdin.emit("error", Object.assign(new Error("late closed pipe"), { code: "EOF" }));
    child.stdin.emit("drain");
    child.emit("close", 0, null);
    assert.equal(writes, 1);
    assert.equal(returned, true);
  });
}

test("a CLI missing from trusted PATH is a downstream launch failure", async () => {
  await assert.rejects(runProcess("harnest-synthetic-missing-executable", [], { timeoutMs: 5000 }), {
    name: "NativeLaunchError",
    details: { kind: "downstream", phase: "launch" },
  });
});

test("spawn failure carries empty output metadata", async () => {
  await assert.rejects(runProcess("harnest-synthetic-missing-executable", [], { timeoutMs: 5000, spawnFn: spawn }), (error) => {
    assert.equal(error.details.kind, "transport");
    assert.equal(error.details.code, "ENOENT");
    assert.equal(error.details.stdoutBytes, 0);
    assert.equal(error.details.stderrBytes, 0);
    assert.equal(error.details.stdoutTruncated, false);
    assert.equal(error.details.stderrTruncated, false);
    return true;
  });
});
