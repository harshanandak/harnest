import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  mkdtemp,
  mkdir,
  realpath,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  AcpClientServiceError,
  createAcpClientServices,
} from "../src/acp-client-services.mjs";

const approvedWrite = { write: true, writeApproved: true };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "acp-client-services-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof AcpClientServiceError);
    assert.equal(error.code, code);
    return true;
  });
}

class FakeChild extends EventEmitter {
  constructor({ closeDelayMs = 0 } = {}) {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.killed = false;
    this.exitCode = null;
    this.signalCode = null;
    this.closeDelayMs = closeDelayMs;
    this.killCalls = 0;
  }

  finish(code = 0, signal = null) {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
    this.stdout.end();
    this.stderr.end();
    setTimeout(() => this.emit("close", code, signal), this.closeDelayMs);
  }

  kill(signal = "SIGTERM") {
    this.killCalls += 1;
    this.killed = true;
    setTimeout(() => this.finish(null, signal), this.closeDelayMs);
    return true;
  }
}

function fakeSpawner(options = {}) {
  const calls = [];
  const children = [];
  const spawnFn = (command, args, spawnOptions) => {
    const child = new FakeChild(options);
    calls.push({ command, args, options: spawnOptions });
    children.push(child);
    return child;
  };
  return { calls, children, spawnFn };
}

test("advertises the implemented ACP v1 client capabilities only", async (t) => {
  const cwd = await fixture(t);
  const service = createAcpClientServices({ cwd });
  t.after(() => service.close());

  assert.deepEqual(service.capabilities, {
    fs: { readTextFile: true, writeTextFile: true },
    terminal: false,
  });
  assert.equal(typeof service.handleRequest, "function");
  assert.equal(typeof service.close, "function");
});

test("#39 terminal capability and creation require approved write access", async (t) => {
  const cwd = await fixture(t);
  const fake = fakeSpawner();
  for (const [write, writeApproved] of [[false, false], [true, false], [false, true], [true, true]]) {
    const service = createAcpClientServices({ cwd, write, writeApproved, spawnFn: fake.spawnFn });
    t.after(() => service.close());
    const enabled = write && writeApproved;
    assert.equal(service.capabilities.terminal, enabled);
    const creation = service.handleRequest("terminal/create", { sessionId: "session-gate", command: "node" });
    if (enabled) assert.match((await creation).terminalId, /^terminal-/);
    else await rejectsCode(creation, "METHOD_NOT_FOUND");
  }
  assert.equal(fake.calls.length, 1);
});

test("#39 terminal spawn passes only allowlisted environment variables", async (t) => {
  const cwd = await fixture(t);
  const fake = fakeSpawner();
  const variables = {
    LANG: "C.UTF-8", LC_CTYPE: "C.UTF-8", HARNEST_MCP_BEARER_TOKEN: "synthetic",
    HARNEST_CREDENTIALS: "synthetic", EXAMPLE_KEY: "synthetic", EXAMPLE_TOKEN: "synthetic",
    EXAMPLE_SECRET: "synthetic", RANDOM_SETTING: "synthetic",
  };
  for (const [name, value] of Object.entries(variables)) {
    const previous = process.env[name];
    process.env[name] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }
  const service = createAcpClientServices({ cwd, write: true, writeApproved: true, spawnFn: fake.spawnFn });
  t.after(() => service.close());
  await service.handleRequest("terminal/create", { sessionId: "session-env", command: "node" });
  const { env } = fake.calls[0].options;
  assert.ok(env, "spawn receives an explicit environment");
  const names = Object.fromEntries(Object.entries(env).map(([key, value]) => [key.toUpperCase(), value]));
  assert.equal(names.LANG, variables.LANG);
  assert.equal(names.LC_CTYPE, variables.LC_CTYPE);
  assert.equal(names.PATH, process.env.PATH);
  for (const name of Object.keys(variables).slice(2)) assert.equal(Object.hasOwn(names, name), false, name);
  for (const name of ["HOME", "USERPROFILE", "TEMP", "TMP", "SYSTEMROOT", "COMSPEC"]) {
    if (process.env[name] !== undefined) assert.equal(names[name], process.env[name], name);
  }
});

test("#39 terminal command trace contains only the executable name and session identity", async (t) => {
  const cwd = await fixture(t);
  const fake = fakeSpawner();
  const progress = [];
  const service = createAcpClientServices({
    cwd, write: true, writeApproved: true, spawnFn: fake.spawnFn,
    onProgress: (event) => progress.push(event),
  });
  t.after(() => service.close());
  for (const command of ["node", "git"]) {
    await service.handleRequest("terminal/create", {
      sessionId: "session-trace", command: join(cwd, command), args: ["private-argument"],
    });
  }
  assert.deepEqual(progress, ["node", "git"].map((command) => ({
    type: "acp_terminal_command", sessionId: "session-trace", command,
  })));
});

test("reads line ranges and writes files within the canonical workspace", async (t) => {
  const cwd = await fixture(t);
  const service = createAcpClientServices({ cwd });
  t.after(() => service.close());
  const path = join(cwd, "notes.txt");

  assert.deepEqual(await service.handleRequest("fs/write_text_file", {
    sessionId: "session-1",
    path,
    content: "alpha\nbeta\ngamma\n",
  }), {});
  assert.equal(await readFile(path, "utf8"), "alpha\nbeta\ngamma\n");
  assert.deepEqual(await service.handleRequest("fs/read_text_file", {
    sessionId: "session-1",
    path,
    line: 2,
    limit: 1,
  }), { content: "beta\n" });
});

test("rejects relative, credential, oversized, and missing-parent file requests", async (t) => {
  const cwd = await fixture(t);
  const service = createAcpClientServices({ cwd });
  t.after(() => service.close());

  await rejectsCode(service.handleRequest("fs/read_text_file", {
    sessionId: "session-1",
    path: "relative.txt",
  }), "INVALID_PARAMS");
  await rejectsCode(service.handleRequest("fs/read_text_file", {
    sessionId: "session-1",
    path: join(cwd, ".env"),
  }), "CREDENTIAL_PATH");
  await rejectsCode(service.handleRequest("fs/write_text_file", {
    sessionId: "session-1",
    path: join(cwd, "missing", "file.txt"),
    content: "no recursive parent creation",
  }), "INVALID_PATH");
  await rejectsCode(service.handleRequest("fs/read_text_file", {
    sessionId: "session-1",
    path: join(cwd, "notes.txt"),
    line: 0,
  }), "INVALID_PARAMS");
  await rejectsCode(service.handleRequest("fs/write_text_file", {
    sessionId: "session-1",
    path: join(cwd, "huge.txt"),
    content: "x".repeat(1024 * 1024 + 1),
  }), "OUTPUT_LIMIT");
});

test("canonical realpaths prevent symlink escapes for reads and writes", async (t) => {
  const cwd = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), "acp-client-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "outside.txt"), "outside", "utf8");
  const link = join(cwd, "escape");
  try {
    await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("symlink creation is unavailable on this host");
      return;
    }
    throw error;
  }
  const service = createAcpClientServices({ cwd });
  t.after(() => service.close());

  await rejectsCode(service.handleRequest("fs/read_text_file", {
    sessionId: "session-1",
    path: join(link, "outside.txt"),
  }), "PATH_OUTSIDE_CWD");
  await rejectsCode(service.handleRequest("fs/write_text_file", {
    sessionId: "session-1",
    path: join(link, "new.txt"),
    content: "blocked",
  }), "PATH_OUTSIDE_CWD");
  await assert.rejects(readFile(join(outside, "new.txt"), "utf8"), { code: "ENOENT" });
});

test("terminal/create spawns argv directly with an explicit environment and contained cwd", async (t) => {
  const cwd = await fixture(t);
  const nested = join(cwd, "nested");
  await mkdir(nested);
  const fake = fakeSpawner();
  const service = createAcpClientServices({ cwd, ...approvedWrite, spawnFn: fake.spawnFn });
  t.after(() => service.close());

  const created = await service.handleRequest("terminal/create", {
    sessionId: "session-1",
    command: "node",
    args: ["--version"],
    env: [],
    cwd: nested,
    outputByteLimit: 128,
  });
  assert.match(created.terminalId, /^terminal-/);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].command, "node");
  assert.deepEqual(fake.calls[0].args, ["--version"]);
  assert.equal(fake.calls[0].options.shell, false);
  assert.equal(fake.calls[0].options.windowsHide, true);
  assert.equal(fake.calls[0].options.cwd, await realpath(resolve(nested)));
  assert.equal(Object.hasOwn(fake.calls[0].options, "env"), true);
  assert.deepEqual(fake.calls[0].options.stdio, ["ignore", "pipe", "pipe"]);

  await rejectsCode(service.handleRequest("terminal/create", {
    sessionId: "session-1",
    command: "node",
    env: [{ name: "EXPLICIT_SECRET", value: "blocked" }],
  }), "INVALID_PARAMS");
  await rejectsCode(service.handleRequest("terminal/create", {
    sessionId: "session-1",
    command: "node",
    env: null,
  }), "INVALID_PARAMS");
  await rejectsCode(service.handleRequest("terminal/create", {
    sessionId: "session-1",
    command: "node",
    args: null,
  }), "INVALID_PARAMS");
  assert.equal(fake.calls.length, 1);
});

test("terminal lifecycle works with a disposable native child process", async (t) => {
  const cwd = await fixture(t);
  const service = createAcpClientServices({ cwd, ...approvedWrite, timeoutMs: 5_000 });
  t.after(() => service.close());
  const { terminalId } = await service.handleRequest("terminal/create", {
    sessionId: "session-native",
    command: process.execPath,
    args: ["-e", "process.stdout.write('native-ok')"],
    cwd,
  });

  assert.deepEqual(await service.handleRequest("terminal/wait_for_exit", {
    sessionId: "session-native",
    terminalId,
  }), { exitCode: 0, signal: null });
  assert.deepEqual(await service.handleRequest("terminal/output", {
    sessionId: "session-native",
    terminalId,
  }), {
    output: "native-ok",
    truncated: false,
    exitStatus: { exitCode: 0, signal: null },
  });
  assert.deepEqual(await service.handleRequest("terminal/release", {
    sessionId: "session-native",
    terminalId,
  }), {});
});

test("terminal output is bounded, backpressured, session-owned, and released after exit", async (t) => {
  const cwd = await fixture(t);
  const fake = fakeSpawner();
  let releaseProgress;
  const progressGate = new Promise((resolveGate) => { releaseProgress = resolveGate; });
  const progress = [];
  const service = createAcpClientServices({
    cwd,
    ...approvedWrite,
    spawnFn: fake.spawnFn,
    onProgress: async (event) => {
      if (event.type !== "acp_terminal_output") return;
      progress.push(event);
      await progressGate;
    },
  });
  t.after(() => service.close());
  const { terminalId } = await service.handleRequest("terminal/create", {
    sessionId: "session-1",
    command: "node",
    outputByteLimit: 5,
  });
  const child = fake.children[0];
  child.stdout.write(Buffer.from("A€B€C", "utf8"));

  const outputPromise = service.handleRequest("terminal/output", { sessionId: "session-1", terminalId });
  let settled = false;
  outputPromise.finally(() => { settled = true; });
  await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  assert.equal(settled, false);
  releaseProgress();
  assert.deepEqual(await outputPromise, { output: "B€C", truncated: true });
  assert.deepEqual(progress.map(({ type, stream, terminalId: id }) => ({ type, stream, terminalId: id })), [{
    type: "acp_terminal_output",
    stream: "stdout",
    terminalId,
  }]);

  await rejectsCode(service.handleRequest("terminal/output", {
    sessionId: "foreign-session",
    terminalId,
  }), "TERMINAL_SESSION_MISMATCH");

  const wait = service.handleRequest("terminal/wait_for_exit", { sessionId: "session-1", terminalId });
  child.finish(0, null);
  assert.deepEqual(await wait, { exitCode: 0, signal: null });
  assert.deepEqual(await service.handleRequest("terminal/output", {
    sessionId: "session-1",
    terminalId,
  }), {
    output: "B€C",
    truncated: true,
    exitStatus: { exitCode: 0, signal: null },
  });
  assert.deepEqual(await service.handleRequest("terminal/release", { sessionId: "session-1", terminalId }), {});
  await rejectsCode(service.handleRequest("terminal/output", {
    sessionId: "session-1",
    terminalId,
  }), "UNKNOWN_TERMINAL");
});

test("redacts recognized credentials at terminal callback and output boundaries", async (t) => {
  const cwd = await fixture(t);
  const fake = fakeSpawner();
  const progress = [];
  const service = createAcpClientServices({
    cwd,
    ...approvedWrite,
    spawnFn: fake.spawnFn,
    onProgress: (event) => {
      if (event.type === "acp_terminal_output") progress.push(event.text);
    },
  });
  t.after(() => service.close());
  const { terminalId } = await service.handleRequest("terminal/create", {
    sessionId: "session-redaction",
    command: "node",
  });
  const sensitiveValue = ["synthetic", "credential", "value"].join("-");
  fake.children[0].stdout.write(`authorization: Bearer ${sensitiveValue}`);
  fake.children[0].finish(0, null);
  await service.handleRequest("terminal/wait_for_exit", {
    sessionId: "session-redaction",
    terminalId,
  });

  const output = await service.handleRequest("terminal/output", {
    sessionId: "session-redaction",
    terminalId,
  });
  assert.equal(progress.join("").includes(sensitiveValue), false);
  assert.equal(output.output.includes(sensitiveValue), false);
  assert.match(progress.join(""), /\[REDACTED\]/u);
  assert.match(output.output, /\[REDACTED\]/u);
  assert.equal(output.truncated, false);
});

test("abort and close do not wait for a stalled progress callback", async (t) => {
  const cwd = await fixture(t);
  for (const mode of ["abort", "close"]) {
    await t.test(mode, async () => {
      const controller = new AbortController();
      const fake = fakeSpawner();
      let markProgressStarted;
      let rejectProgress;
      const progressStarted = new Promise((resolveStarted) => { markProgressStarted = resolveStarted; });
      const service = createAcpClientServices({
        cwd,
        ...approvedWrite,
        signal: controller.signal,
        spawnFn: fake.spawnFn,
        timeoutMs: 60 * 60 * 1000,
        onProgress: (event) => {
          if (event.type !== "acp_terminal_output") return;
          markProgressStarted();
          return new Promise((_, reject) => { rejectProgress = reject; });
        },
      });
      const { terminalId } = await service.handleRequest("terminal/create", {
        sessionId: `session-${mode}`,
        command: "stalled-progress",
      });
      fake.children[0].stdout.write("progress awaiting persistence");
      await progressStarted;

      if (mode === "abort") controller.abort();
      const cleanup = service.close();
      let cleanupTimer;
      try {
        await Promise.race([
          cleanup,
          new Promise((_, reject) => {
            cleanupTimer = setTimeout(() => reject(new Error(`${mode} cleanup remained blocked`)), 500);
          }),
        ]);
      } finally {
        clearTimeout(cleanupTimer);
      }
      assert.equal(fake.children[0].killCalls, 1);
      assert.equal(fake.children[0].signalCode, "SIGTERM");

      // A persistence callback that rejects after shutdown is no longer owned,
      // but its rejection must still be observed rather than becoming global.
      rejectProgress(new Error("late synthetic progress rejection"));
      await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
      await service.close();
      await assert.rejects(service.handleRequest("terminal/output", {
        sessionId: `session-${mode}`,
        terminalId,
      }), (error) => error?.code === "SERVICE_CLOSED");
    });
  }
});

test("kill and close wait for owned process exit and never address unknown terminals", async (t) => {
  const cwd = await fixture(t);
  const fake = fakeSpawner({ closeDelayMs: 10 });
  const service = createAcpClientServices({ cwd, ...approvedWrite, spawnFn: fake.spawnFn });
  const first = await service.handleRequest("terminal/create", { sessionId: "session-1", command: "first" });
  await service.handleRequest("terminal/kill", { sessionId: "session-1", terminalId: first.terminalId });
  assert.equal(fake.children[0].killCalls, 1);
  assert.notEqual(fake.children[0].exitCode !== null || fake.children[0].signalCode !== null, false);

  await rejectsCode(service.handleRequest("terminal/kill", {
    sessionId: "session-1",
    terminalId: "terminal-not-owned",
  }), "UNKNOWN_TERMINAL");

  await service.handleRequest("terminal/create", { sessionId: "session-1", command: "second" });
  await service.close();
  assert.equal(fake.children[1].killCalls, 1);
  await rejectsCode(service.handleRequest("terminal/create", {
    sessionId: "session-1",
    command: "after-close",
  }), "SERVICE_CLOSED");
  assert.equal(fake.calls.length, 2);
});

test("abort, timeout, unsupported methods, and malformed params fail closed", async (t) => {
  const cwd = await fixture(t);
  const abortController = new AbortController();
  abortController.abort();
  const abortedFake = fakeSpawner();
  const aborted = createAcpClientServices({
    cwd,
    ...approvedWrite,
    signal: abortController.signal,
    spawnFn: abortedFake.spawnFn,
  });
  await rejectsCode(aborted.handleRequest("terminal/create", {
    sessionId: "session-1",
    command: "never",
  }), "SERVICE_CLOSED");
  assert.equal(abortedFake.calls.length, 0);

  const fake = fakeSpawner();
  const service = createAcpClientServices({ cwd, ...approvedWrite, timeoutMs: 20, spawnFn: fake.spawnFn });
  t.after(() => service.close());
  const { terminalId } = await service.handleRequest("terminal/create", {
    sessionId: "session-1",
    command: "times-out",
  });
  await new Promise((resolveWait) => setTimeout(resolveWait, 40));
  assert.equal(fake.children[0].killCalls, 1);
  await rejectsCode(service.handleRequest("terminal/wait_for_exit", {
    sessionId: "session-1",
    terminalId,
  }), "TIMEOUT");

  await rejectsCode(service.handleRequest("terminal/create", null), "INVALID_PARAMS");
  await rejectsCode(service.handleRequest("custom/unknown", {}), "METHOD_NOT_FOUND");
  assert.equal(basename(cwd).startsWith("acp-client-services-"), true);
});

test("abort during canonical path checks prevents later writes and spawns", async (t) => {
  const cwd = await fixture(t);
  const writeController = new AbortController();
  const writeService = createAcpClientServices({ cwd, signal: writeController.signal });
  const target = join(cwd, "must-not-exist.txt");
  const pendingWrite = writeService.handleRequest("fs/write_text_file", {
    sessionId: "session-1",
    path: target,
    content: "blocked after abort",
  });
  writeController.abort();
  await rejectsCode(pendingWrite, "SERVICE_CLOSED");
  await assert.rejects(readFile(target, "utf8"), { code: "ENOENT" });
  await writeService.close();

  const spawnController = new AbortController();
  const fake = fakeSpawner();
  const terminalService = createAcpClientServices({
    cwd,
    ...approvedWrite,
    signal: spawnController.signal,
    spawnFn: fake.spawnFn,
  });
  const pendingCreate = terminalService.handleRequest("terminal/create", {
    sessionId: "session-1",
    command: "must-not-spawn",
    cwd,
  });
  spawnController.abort();
  await rejectsCode(pendingCreate, "SERVICE_CLOSED");
  assert.equal(fake.calls.length, 0);
  await terminalService.close();
});
