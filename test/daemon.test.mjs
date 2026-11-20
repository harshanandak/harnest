import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import test from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { startDaemon } from "../src/daemon.mjs";
import { createDaemonClient, daemonStatus, ensureDaemon, stopDaemon } from "../src/daemon-client.mjs";
import { readDaemonToken, VERSION } from "../src/daemon-settings.mjs";
import { createRuntimeServices } from "../src/runtime-services.mjs";
import { BOARD_MESSAGE_MAX_BYTES } from "../src/board.mjs";
import { PAGE_RESPONSE_BYTES, STATUS_RESPONSE_BYTES } from "../src/mcp-output.mjs";
import { structuredResult } from "../src/result.mjs";
import { mergeProcessEnv } from "../src/process.mjs";
import { protectWindowsPath } from "../src/windows-acl.mjs";

const exec = promisify(execFile);
const root = join(import.meta.dirname, "..");

async function allowInheritedRead(path) {
  if (process.platform === "win32") {
    await exec("icacls.exe", [path, "/grant", "*S-1-1-0:(OI)(CI)RX"]);
  }
}

async function assertPrivateInstallerFile(path) {
  if (process.platform !== "win32") {
    assert.equal((await stat(path)).mode & 0o777, 0o600, path);
    return;
  }
  const command = '$acl = Get-Acl -LiteralPath $env:HARNEST_ACL_FIXTURE_PATH; ' +
    '$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; ' +
    '$entries = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])); ' +
    'if (!$acl.AreAccessRulesProtected -or $entries.Count -ne 1 -or $entries[0].IdentityReference.Value -ne $sid ' +
    '-or $entries[0].AccessControlType -ne "Allow" -or $entries[0].FileSystemRights -ne "FullControl") { exit 1 }';
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== "PSMODULEPATH"));
  await assert.doesNotReject(exec("powershell.exe", ["-NoProfile", "-Command", command], {
    env: { ...env, HARNEST_ACL_FIXTURE_PATH: path },
  }), "expected a protected ACL with full control only for the current user: " + path);
}

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), "harnest-daemon-"));
  const directory = join(home, "daemon");
  const stateDir = join(home, "jobs");
  const env = { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: home,
    XDG_STATE_HOME: home, XDG_CONFIG_HOME: home, HARNEST_STATE_DIR: stateDir };
  t.after(() => rm(home, { recursive: true, force: true }));
  return { home, directory, stateDir, env };
}

function raw(port, path, { method = "GET", headers, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers }, async (res) => {
      const buffers = [];
      try {
        for await (const chunk of res) buffers.push(chunk);
        const wire = Buffer.concat(buffers);
        resolve({ status: res.statusCode, text: wire.toString("utf8"), bytes: wire.length });
      } catch (error) { reject(error); }
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("authenticated HTTP validates Host, Origin and body size before MCP and enforces single construction", async (t) => {
  const { directory, stateDir } = await fixture(t);
  let builds = 0;
  const buildServices = () => { builds++; return createRuntimeServices({ stateDir }); };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const record = join(directory, "daemon.json");
  await writeFile(record, '{"pid":1,"port":1,"version":"0.0.1","nonce":"stale"}');
  const daemon = await startDaemon({ port: 0, directory, buildServices });
  try {
    const { port } = daemon;
    const token = await readDaemonToken(directory);
    const auth = { Authorization: `Bearer ${token}` };
    const metadata = JSON.parse(await readFile(record, "utf8"));
    assert.deepEqual(Object.keys(metadata).sort(), ["nonce", "pid", "port", "version"]);
    assert.equal(metadata.port, port);
    assert.notEqual(metadata.nonce, "stale");
    assert.equal(await startDaemon({ port, directory, buildServices }), null);
    assert.equal(builds, 1);
    assert.equal((await raw(port, "/health")).status, 401);
    assert.equal((await raw(port, "/mcp", { method: "POST", body: "{}" })).status, 401);
    assert.equal((await raw(port, "/health", { headers: { Authorization: "Bearer wrong" } })).status, 401);
    const healthy = await raw(port, "/health", { headers: auth });
    assert.deepEqual(JSON.parse(healthy.text), { ready: true, version: VERSION });
    assert.equal((await raw(port, "/mcp", { headers: auth })).status, 405);
    assert.equal((await raw(port, "/health", { headers: { ...auth, Host: "evil.test" } })).status, 403);
    assert.equal((await raw(port, "/health", { headers: { ...auth, Origin: "https://evil.test" } })).status, 403);
    assert.equal((await raw(port, "/health", { headers: { ...auth, Origin: `http://127.0.0.1:${port}` } })).status, 200);
    assert.equal((await raw(port, "/mcp", { method: "POST",
      headers: { ...auth, "Content-Type": "application/json", "Content-Length": String(2 * 1024 * 1024 + 1) },
    })).status, 413);
    assert.equal((await raw(port, "/mcp", { method: "POST", body: Buffer.alloc(2 * 1024 * 1024 + 1),
      headers: { ...auth, "Content-Type": "application/json", "Transfer-Encoding": "chunked" },
    })).status, 413);
    if (process.platform !== "win32") {
      assert.equal((await stat(directory)).mode & 0o777, 0o700);
      assert.equal((await stat(join(directory, "token"))).mode & 0o777, 0o600);
    }
  } finally { await daemon.close(); }
  await assert.rejects(stat(record), { code: "ENOENT" });
});

for (const modern of [false, true]) {
  test(`HTTP exposes exact stdio tool catalog and schemas (${modern ? "modern" : "legacy"})`, async (t) => {
    const { directory, stateDir, env } = await fixture(t);
    const daemon = await startDaemon({ port: 0, directory, buildServices: () => createRuntimeServices({ stateDir }) });
    const options = modern ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {};
    const make = () => new Client({ name: "daemon-test", version: "1" }, options);
    const stdio = make();
    const http = make();
    try {
      const token = await readDaemonToken(directory);
      await http.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${daemon.port}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }));
      await stdio.connect(new StdioClientTransport({
        command: process.execPath, args: ["src/mcp-server.mjs"], cwd: root, env, stderr: "pipe",
      }));
      assert.equal(http.getProtocolEra(), modern ? "modern" : "legacy");
      assert.equal(stdio.getProtocolEra(), http.getProtocolEra());
      const catalog = await stdio.listTools();
      assert.equal(catalog.tools.length, 38);
      assert.deepEqual(await http.listTools(), catalog);
    } finally {
      await Promise.allSettled([http.close(), stdio.close()]);
      await daemon.close();
    }
  });
}

test("bounded MCP reads preserve durable state and reconstruct oversized payloads in both eras", async (t) => {
  const { home, directory, stateDir } = await fixture(t);
  const smallResult = structuredResult("done");
  const largeResult = structuredResult(JSON.stringify({
    finalText: "界😀".repeat(21_333) + "x",
    summary: "界".repeat(16_000),
    ...Object.fromEntries(["artifacts", "files", "evidence", "tests", "risks"].map((field) => [
      field, Array.from({ length: 100 }, (_, i) => `${field}-${i}-`.padEnd(4000, i % 2 ? "x" : "\\")),
    ])),
  }));
  assert.equal(largeResult.finalText.length, 64_000);
  assert.equal(largeResult.summary.length, 16_000);
  for (const field of ["artifacts", "files", "evidence", "tests", "risks"]) {
    assert.equal(largeResult[field].length, 100);
    assert.ok(largeResult[field].every((item) => item.length === 4000));
  }
  const services = createRuntimeServices({
    stateDir, boardDir: join(home, "boards"), routeResolver: async (request) => request,
    adapterFactory: () => ({ run: async () => ({ sessionId: "bounded-session", result: smallResult }) }),
  });
  const { companion } = services;
  const { jobId } = await companion.start({ requestId: "bounded-fixture", cwd: home, target: "pi", task: "fixture" });
  await companion.store.appendEvent(jobId, {
    at: "2026-01-01T00:00:00.000Z", activity: "large trace event",
    event: { type: "fixture", values: Array.from({ length: 24 }, (_, i) => `${i}${"界😀".repeat(1200)}`.slice(0, 4000)) },
  });
  const controls = Array.from({ length: 300 }, (_, i) => ({
    commandId: `control-${i}`, kind: "message", state: "applied", acknowledgement: "🙂".repeat(500),
  }));
  await companion.store.transition(jobId, (job) => {
    job.receipt.controls = controls;
    return job;
  });
  const largeError = {
    name: "InterruptedExecution", message: "Lease lost while recovering",
    details: { kind: "interrupted", unsafeResume: true, stderr: "\u0000".repeat(2500), warnings: ["界".repeat(2000)] },
  };
  const interrupted = await companion.start({ requestId: "bounded-partial", cwd: home, target: "pi", task: "fixture" });
  const cancellation = { state: "unacknowledged", requestedAt: "2026-01-01T00:00:00.000Z", acknowledgedAt: null };
  await companion.store.transition(interrupted.jobId, (job) => {
    Object.assign(job.receipt, { state: "partial", result: null, cancellation, error: largeError });
    job.receipt.recovery.canResume = false;
    return job;
  });
  const topic = "bounded-board";
  const message = "😀".repeat(BOARD_MESSAGE_MAX_BYTES / 4);
  assert.equal(Buffer.byteLength(message), BOARD_MESSAGE_MAX_BYTES);
  const entries = Array.from({ length: 200 }, (_, i) => ({
    entryId: `board-${i}`, sequence: i + 1, at: "2026-01-01T00:00:00.000Z", topic, from: "fixture", message,
  }));
  const boardPath = companion.boards.path(topic);
  await mkdir(join(home, "boards"), { recursive: true });
  await writeFile(boardPath, entries.map((entry) => JSON.stringify(entry) + "\n").join(""));
  const daemon = await startDaemon({ port: 0, directory, buildServices: () => services });
  try {
    const token = await readDaemonToken(directory);
    for (const modern of [false, true]) {
      await t.test(modern ? "modern" : "legacy", async () => {
        const version = modern ? "2026-07-28" : "2025-11-25";
        const clientInfo = { name: "bounded-output-test", version: "1" };
        const rpc = (method, params, id = 1, budget = Infinity) => raw(daemon.port, "/mcp", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`, Accept: "application/json, text/event-stream",
            "Content-Type": "application/json", "MCP-Protocol-Version": version,
            ...(modern && { "Mcp-Method": method, ...(params?.name && { "Mcp-Name": params.name }) }),
          },
          body: JSON.stringify({
            jsonrpc: "2.0", ...(id === null ? {} : { id }), method,
            params: modern ? { ...params, _meta: {
              "io.modelcontextprotocol/protocolVersion": version,
              "io.modelcontextprotocol/clientInfo": clientInfo,
              "io.modelcontextprotocol/clientCapabilities": {},
            } } : params,
          }),
        }).then((reply) => {
          const size = reply.bytes;
          assert.ok(size <= budget, `${method} ${params?.name ?? ""} returned ${size} bytes`);
          return { result: reply.text ? JSON.parse(reply.text).result : undefined, size, status: reply.status };
        });
        if (modern) assert.ok((await rpc("server/discover")).result);
        else {
          assert.equal((await rpc("initialize", { protocolVersion: version, clientInfo, capabilities: {} })).result.protocolVersion, version);
          assert.equal((await rpc("notifications/initialized", {}, null)).status, 202);
        }
        const call = async (name, args, key, budget = PAGE_RESPONSE_BYTES) => {
          const { result, size } = await rpc("tools/call", { name, arguments: args }, 1, budget);
          assert.ok(result && !result.isError, result?.content?.[0]?.text);
          assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent[key]);
          return { value: result.structuredContent[key], size };
        };
        const setResult = (result) => companion.store.transition(jobId, (job) => {
          job.receipt.result = result;
          return job;
        });
        await setResult(smallResult);
        const small = await call("handoff_status", { jobId }, "receipt", STATUS_RESPONSE_BYTES);
        assert.deepEqual((await call("handoff_result", { jobId }, "receipt")).value.result, smallResult);
        await setResult(largeResult);
        const large = await call("handoff_status", { jobId }, "receipt", STATUS_RESPONSE_BYTES);
        assert.equal(large.size, small.size);
        assert.deepEqual(large.value, small.value);
        assert.equal(large.value.result, undefined);
        assert.equal(large.value.controlCount, controls.length);
        assert.deepEqual(large.value.resultRef, { tool: "handoff_result", arguments: { jobId } });
        const sessions = (await call("handoff_sessions", {}, "sessions")).value.sessions;
        assert.deepEqual(new Set(sessions.map((session) => session.jobId)), new Set([jobId, interrupted.jobId]));
        assert.ok(sessions.every((session) => !Object.hasOwn(session, "result")));

        const partial = (await call("handoff_status", { jobId: interrupted.jobId }, "receipt", STATUS_RESPONSE_BYTES)).value;
        assert.equal(partial.state, "partial");
        assert.equal(partial.error.details.kind, "interrupted");
        assert.equal(partial.error.details.unsafeResume, true);
        assert.deepEqual(partial.cancellation, cancellation);
        assert.equal(partial.recovery.canResume, false);
        const partialResult = (await call("handoff_result", { jobId: interrupted.jobId }, "receipt")).value;
        assert.equal(partialResult.state, "partial");
        assert.equal(partialResult.result, null);
        assert.deepEqual(partialResult.error, largeError);

        const collectReceipt = async (tool, input, budget, state) => {
          let next = { tool, arguments: input };
          const chunks = [];
          let offset = 0;
          while (next) {
            const { value } = await call(next.tool, next.arguments, "receipt", budget);
            assert.equal(value.jobId, input.jobId);
            assert.equal(value.state, state);
            assert.ok(value.page);
            assert.equal(value.page.offset, offset);
            assert.ok(value.page.chunk.length);
            chunks.push(value.page.chunk);
            offset += Buffer.byteLength(value.page.chunk, "utf8");
            assert.equal(value.page.originalBytes - offset, value.page.omittedBytes);
            assert.equal(value.page.omittedCount, Number(value.page.continuation !== null));
            next = value.page.continuation;
          }
          return chunks.join("");
        };
        const full = await collectReceipt("handoff_result", { jobId }, PAGE_RESPONSE_BYTES, "completed");
        assert.deepEqual(Buffer.from(full), Buffer.from(JSON.stringify(await companion.result(jobId))));
        const recoveredStatus = await collectReceipt("handoff_status", { jobId: interrupted.jobId }, STATUS_RESPONSE_BYTES, "partial");
        const { result, controls: ignored, ...recordedStatus } = await companion.status(interrupted.jobId);
        assert.deepEqual(Buffer.from(recoveredStatus), Buffer.from(JSON.stringify({
          ...recordedStatus, controls: [], resultRef: { tool: "handoff_result", arguments: { jobId: interrupted.jobId } },
        })));

        const collectRecords = async (tool, args, key, field, expected) => {
          let next = { tool, arguments: args };
          let count = 0;
          let itemOffset = 0;
          let chunks = [];
          let lastSequence = args.afterSequence ?? 0;
          while (next) {
            const { value } = await call(next.tool, next.arguments, key);
            if (key === "trace") {
              assert.equal(value.receipt.state, "completed");
              assert.equal(value.receipt.result, undefined);
            }
            for (const entry of value[field]) {
              assert.deepEqual(entry, expected[count++]);
              lastSequence = entry.sequence;
            }
            const item = value.page?.item;
            if (item) {
              assert.equal(item.sequence, expected[count].sequence);
              assert.equal(item.offset, itemOffset);
              assert.ok(item.chunk.length);
              chunks.push(item.chunk);
              itemOffset += Buffer.byteLength(item.chunk, "utf8");
              assert.equal(item.originalBytes - itemOffset, item.omittedBytes);
              if (!item.omittedBytes) {
                assert.deepEqual(Buffer.from(chunks.join("")), Buffer.from(JSON.stringify(expected[count++])));
                lastSequence = item.sequence;
                chunks = [];
                itemOffset = 0;
              }
            }
            assert.equal(value.nextSequence, lastSequence);
            if (value.page) assert.ok(value.page.originalBytes >= (item?.originalBytes ?? 2));
            assert.ok(count <= expected.length);
            next = value.page?.continuation;
          }
          assert.equal(count, expected.length);
          assert.equal(itemOffset, 0);
        };
        const { events } = await companion.store.readTrace(jobId, { afterSequence: 0, limit: 200 });
        await collectRecords("handoff_trace", { jobId, afterSequence: 0, limit: 200 }, "trace", "events", events);
        const firstBoard = (await call("handoff_read", { topic, afterSequence: 0, limit: 200 }, "board")).value;
        assert.equal(firstBoard.page.omittedCount, 200);
        assert.equal(firstBoard.page.originalBytes, Buffer.byteLength(JSON.stringify(entries), "utf8"));
        if (!modern) await collectRecords("handoff_read", { topic, afterSequence: 0, limit: 200 }, "board", "entries", entries);
        const postTopic = `bounded-post-${modern ? "modern" : "legacy"}`;
        const post = (await call("handoff_post", { topic: postTopic, message, from: "fixture" }, "post")).value;
        assert.equal(post.message, undefined);
        const stored = (await companion.boards.read({ topic: postTopic })).entries;
        assert.equal(stored[0].message, message);
        await collectRecords(post.page.continuation.tool, post.page.continuation.arguments, "board", "entries", stored);
      });
    }
  } finally { await daemon.close(); }
});

test("an accepted foreground handoff completes after its HTTP client disconnects", async (t) => {
  const { stateDir, home, directory } = await fixture(t);
  let accepted, release;
  const entered = new Promise((resolve) => { accepted = resolve; });
  const done = new Promise((resolve) => { release = resolve; });
  const daemon = await startDaemon({ port: 0, directory, buildServices: () => createRuntimeServices({
    stateDir, routeResolver: async (request) => request,
    adapterFactory: () => ({ run: async () => { accepted(); await done; return { result: { finalText: "completed after disconnect" } }; } }),
  }) });
  const token = await readDaemonToken(directory);
  const requestId = "disconnect-fixture";
  const requestBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
    name: "handoff_workflow", arguments: { request: { requestId, cwd: home, target: "pi", task: "complete", policy: { write: false } } },
  } });
  const call = request(`http://127.0.0.1:${daemon.port}/mcp`, { method: "POST", headers: {
    Authorization: `Bearer ${token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json",
  } });
  call.on("error", () => {});
  call.end(requestBody);
  try {
    await Promise.race([entered, delay(5000, null, { ref: false }).then(() => { throw new Error("Handoff did not start"); })]);
    const disconnected = new Promise((resolve) => call.once("close", resolve));
    call.destroy();
    await disconnected;
    release();
    const client = createDaemonClient({ port: daemon.port, directory });
    let status;
    for (let i = 0; i < 50; i++) {
      status = (await client.call("handoff_status", { requestId })).receipt;
      if (status.state === "completed") break;
      await delay(50);
    }
    assert.equal(status.state, "completed");
    assert.equal((await client.call("handoff_result", { requestId })).receipt.result.finalText, "completed after disconnect");
  } finally { release(); await daemon.close(); }
});

async function freePort() {
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const { port } = listener.address();
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

test("daemon control probes open a fresh connection each time (#26)", { timeout: 15_000 }, async (t) => {
  const { directory, stateDir } = await fixture(t);
  // A real daemon writes the private token that inspect() reads; closing it keeps the token.
  const daemon = await startDaemon({ port: 0, directory, buildServices: () => createRuntimeServices({ stateDir }) });
  await daemon.close();
  let connections = 0;
  const stub = createServer((_req, res) => { res.writeHead(404); res.end(); });
  stub.on("connection", () => { connections++; });
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { stub.close(resolve); stub.closeAllConnections(); }));
  const oldState = process.env.HARNEST_STATE_DIR;
  process.env.HARNEST_STATE_DIR = stateDir;
  try {
    for (let i = 0; i < 3; i++) {
      assert.deepEqual(await daemonStatus({ port: stub.address().port }), { ready: false, version: null });
    }
  } finally {
    if (oldState === undefined) delete process.env.HARNEST_STATE_DIR;
    else process.env.HARNEST_STATE_DIR = oldState;
  }
  // A kept-alive socket would serve all three probes over one connection.
  assert.equal(connections, 3);
});

test("concurrent callers converge, retain the token and replace an older daemon only when idle", { timeout: 30_000 }, async (t) => {
  const { stateDir, directory, env } = await fixture(t);
  const port = await freePort();
  let busy = true;
  const older = await startDaemon({ port, version: "0.0.1", directory, buildServices: () => ({
    ...createRuntimeServices({ stateDir }), isBusy: () => busy,
  }) });
  const before = JSON.parse(await readFile(join(directory, "daemon.json"), "utf8"));
  const token = await readDaemonToken(directory);
  const oldState = process.env.HARNEST_STATE_DIR;
  process.env.HARNEST_STATE_DIR = stateDir;
  try {
    assert.deepEqual(await ensureDaemon({ port }), { ready: true, version: "0.0.1" });
    assert.equal(JSON.parse(await readFile(join(directory, "daemon.json"), "utf8")).nonce, before.nonce);
    busy = false;
    const clients = Array.from({ length: 20 }, () => ensureDaemon({ port }));
    assert.ok((await Promise.all(clients)).every((health) => health.ready && health.version === VERSION));
    const current = JSON.parse(await readFile(join(directory, "daemon.json"), "utf8"));
    assert.notEqual(current.nonce, before.nonce);
    assert.ok((await readDaemonToken(directory)) === token);
    // Exercise the independent-process bind as well as in-process single-flight.
    const contender = await exec(process.execPath, ["src/daemon.mjs", "--fixture-port", String(port)], { cwd: root, env });
    assert.equal(contender.stderr, "");
    assert.equal(JSON.parse(await readFile(join(directory, "daemon.json"), "utf8")).pid, current.pid);
  } finally {
    await older.close();
    await stopDaemon({ port });
    for (let i = 0; i < 50 && await stat(join(directory, "daemon.json")).then(() => true, () => false); i++) await delay(50);
    if (oldState === undefined) delete process.env.HARNEST_STATE_DIR;
    else process.env.HARNEST_STATE_DIR = oldState;
  }
});

test("the running stdio bridge rediscovers tools after the fixture daemon stops", { timeout: 30_000 }, async (t) => {
  const { home, directory, stateDir, env } = await fixture(t);
  const daemon = await startDaemon({ port: 0, directory, buildServices: () => createRuntimeServices({
    stateDir, adapterFactory: () => { throw new Error("Smoke must never call a downstream adapter"); },
  }) });
  const { port } = daemon;
  const client = new Client({ name: "bridge-recovery", version: "1" });
  const fixtureEnv = { ...env, HARNEST_DAEMON_FIXTURE_PORT: String(port) };
  const record = join(directory, "daemon.json");
  const nonce = async () => JSON.parse(await readFile(record, "utf8")).nonce;
  const oldState = process.env.HARNEST_STATE_DIR;
  process.env.HARNEST_STATE_DIR = stateDir;
  try {
    const firstDaemon = await nonce();
    await client.connect(new StdioClientTransport({
      command: process.execPath, args: [join(root, "src", "mcp-bridge.mjs")], cwd: home, env: fixtureEnv, stderr: "pipe",
    }));
    const catalog = await client.listTools();
    assert.equal(catalog.tools.length, 38);
    await daemon.close();
    assert.deepEqual(await client.listTools(), catalog);
    assert.notEqual(await nonce(), firstDaemon, "bridge must start a replacement without restarting the MCP client");
  } finally {
    await client.close();
    await daemon.close();
    try {
      await stopDaemon({ port });
      for (let i = 0; i < 50 && await stat(record).then(() => true, () => false); i++) await delay(50);
    } finally {
      if (oldState === undefined) delete process.env.HARNEST_STATE_DIR;
      else process.env.HARNEST_STATE_DIR = oldState;
    }
  }
});

test("the setup CLI installs Cursor into a selected project and doctor checks its bridge", { timeout: 30_000 }, async (t) => {
  const { home, directory, stateDir, env } = await fixture(t);
  const daemon = await startDaemon({ port: 0, directory, buildServices: () => createRuntimeServices({ stateDir }) });
  const project = join(home, "cursor project");
  const options = { cwd: root, env: { ...env, HARNEST_DAEMON_FIXTURE_PORT: String(daemon.port) } };
  try {
    const setup = await exec(process.execPath, ["scripts/setup.mjs", "cursor", "--project", project, "--no-autostart"], options);
    assert.match(setup.stdout, /skills\/handoff\/SKILL\.md/);
    assert.ok((await stat(join(project, ".cursor", "commands", "workflows.md"))).isFile());
    const doctor = await exec(process.execPath, ["scripts/doctor.mjs", "--host", "cursor", "--project", project], options);
    assert.match(doctor.stdout, /lead-cursor: ok \(stdio bridge, MCP catalog verified\)/);
  } finally {
    await daemon.close();
  }
});

test("daemon credentials stay private in CLI diagnostics and child environments", async (t) => {
  const { home, directory, env, stateDir } = await fixture(t);
  const daemon = await startDaemon({ port: 0, directory, buildServices: () => createRuntimeServices({ stateDir }) });
  try {
    const token = await readDaemonToken(directory);
    const args = ["scripts/daemon.mjs", "status"];
    const childEnv = { ...env, NODE_DEBUG: "http", HARNEST_DAEMON_FIXTURE_PORT: String(daemon.port), HARNEST_MCP_BEARER_TOKEN: token };
    assert.ok(!args.join(" ").includes(token));
    assert.equal(mergeProcessEnv(childEnv).HARNEST_MCP_BEARER_TOKEN, undefined);
    const status = await exec(process.execPath, args, { cwd: root, env: childEnv });
    assert.deepEqual(JSON.parse(status.stdout), { ready: true, version: VERSION });
    assert.ok(!(status.stdout + status.stderr).includes(token));
    const doctor = await exec(process.execPath, ["scripts/doctor.mjs"], {
      cwd: root, env: { ...childEnv, PATH: "" }, timeout: 30_000,
    }).catch((error) => {
      assert.equal(process.platform, "win32");
      assert.equal(error.code, 1);
      assert.match(error.stdout, /^marketplace-isolation: UNKNOWN /m);
      return error;
    });
    assert.match(doctor.stdout, /transport: shared Streamable HTTP/);
    assert.match(doctor.stdout, /daemon: ready version=/);
    assert.ok(!(doctor.stdout + doctor.stderr).includes(token));
    const configDir = join(home, "permissive config");
    await mkdir(configDir);
    await allowInheritedRead(configDir);
    const privateConfig = join(configDir, "mcp.json");
    await writeFile(privateConfig, JSON.stringify({
      mcpServers: { harnest: { url: 'http://127.0.0.1:' + daemon.port + '/mcp', headers: { Authorization: 'Bearer ' + token } } },
    }), { mode: 0o600 });
    const lead = await exec(process.execPath, ["scripts/doctor.mjs", "--host", "other", "--config", privateConfig], {
      cwd: root, env: childEnv, timeout: 30_000,
    });
    assert.match(lead.stdout, /lead-other: ok \(Streamable HTTP, MCP catalog verified\)/);
    assert.ok(!(lead.stdout + lead.stderr).includes(token));
    const generated = await exec(process.execPath, ["scripts/setup.mjs", "other", "--http-config", privateConfig, "--no-autostart"], {
      cwd: root, env: childEnv, timeout: 30_000,
    });
    assert.ok(!(generated.stdout + generated.stderr).includes(token));
    const written = JSON.parse(await readFile(privateConfig, "utf8")).mcpServers.harnest;
    assert.equal(written.url, "http://127.0.0.1:41237/mcp");
    assert.ok(written.headers.Authorization === "Bearer " + token, "setup should write the header directly to the local file");
    const result = JSON.parse(generated.stdout.slice(0, generated.stdout.lastIndexOf("Restart or reload")));
    assert.equal(result.path, privateConfig);
    await assertPrivateInstallerFile(result.path);
    await assertPrivateInstallerFile(result.backup);
  } finally { await daemon.close(); }
  const bridge = await readFile(join(root, "src", "mcp-bridge.mjs"), "utf8");
  const client = await readFile(join(root, "src", "daemon-client.mjs"), "utf8");
  assert.doesNotMatch(bridge + client, /mcp-server|companion\.mjs|runtime-services|adapters\/|dynamic-runner|modelcontextprotocol\/server/);
});

test("Windows ACL protection replaces explicit file and directory rules", { skip: process.platform !== "win32" }, async (t) => {
  const { home } = await fixture(t);
  const directory = join(home, "explicit ACL");
  await mkdir(directory);
  await allowInheritedRead(directory);
  protectWindowsPath(directory, { directory: true });

  const path = join(directory, "test file");
  await writeFile(path, "");
  await exec("icacls.exe", [path, "/grant", "*S-1-1-0:R"]);
  protectWindowsPath(path);
  await assertPrivateInstallerFile(path);
});

test("Windows daemon re-hardens an existing token and directory before reuse", { skip: process.platform !== "win32" }, async (t) => {
  const { directory, stateDir } = await fixture(t);
  const path = join(directory, "token");
  const token = randomBytes(32).toString("hex");
  await mkdir(directory);
  await writeFile(path, token);
  await exec("icacls.exe", [directory, "/grant", "*S-1-1-0:R"]);
  await exec("icacls.exe", [path, "/grant", "*S-1-1-0:R"]);

  const daemon = await startDaemon({ port: 0, directory, buildServices: () => createRuntimeServices({ stateDir }) });
  try {
    assert.equal((await readDaemonToken(directory)) === token, true, "expected the existing token to stay on disk");
    assert.equal((await raw(daemon.port, "/health", { headers: { Authorization: `Bearer ${token}` } })).status, 200);
    await assertPrivateInstallerFile(directory);
    await assertPrivateInstallerFile(path);
  } finally { await daemon.close(); }
});

test("OpenCode config, rollback copies, and restored config keep a user-only ACL or 0600", async (t) => {
  const { home } = await fixture(t);
  const directory = join(home, "permissive opencode");
  await mkdir(directory);
  await allowInheritedRead(directory);
  const path = join(directory, "opencode.json");
  const prior = '{"mcp":{"servers":{"harnest":{"headers":{"Authorization":"Bearer synthetic-old"}}}}}';
  await writeFile(path, prior, { mode: 0o644 });
  const { installIntegration, restoreIntegration } = await import("../scripts/install-opencode-integration.mjs");
  const { manifest } = await installIntegration(directory, { token: "synthetic-new" });
  const record = JSON.parse(await readFile(manifest, "utf8")).files.find((item) => item.path === path);
  await assertPrivateInstallerFile(path);
  await assertPrivateInstallerFile(record.backup);
  await restoreIntegration(manifest);
  assert.equal(await readFile(path, "utf8"), prior);
  await assertPrivateInstallerFile(path);
});
