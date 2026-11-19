import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import test from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { startDaemon } from "../src/daemon.mjs";
import { createDaemonClient, ensureDaemon, stopDaemon } from "../src/daemon-client.mjs";
import { readDaemonToken, VERSION } from "../src/daemon-settings.mjs";
import { createRuntimeServices } from "../src/runtime-services.mjs";
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
        resolve({ status: res.statusCode, text: Buffer.concat(buffers).toString("utf8") });
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

test("closing the daemon drops connections that are mid-request", { timeout: 15_000 }, async (t) => {
  const { stateDir, directory } = await fixture(t);
  const daemon = await startDaemon({ port: 0, directory, buildServices: () => createRuntimeServices({ stateDir }) });
  // A partial request keeps the connection active, so server.close() alone
  // would wait on it until the request timeout.
  const socket = connect({ host: "127.0.0.1", port: daemon.port });
  socket.on("error", () => {}); // the daemon resets this socket on close
  await once(socket, "connect");
  socket.write("GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n");
  const closed = once(socket, "close");
  const outcome = await Promise.race([
    daemon.close().then(() => "closed"),
    delay(5_000).then(() => "hung"),
  ]);
  assert.equal(outcome, "closed");
  await closed;
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
