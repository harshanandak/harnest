import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { release, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createDaemonClient } from "../src/daemon-client.mjs";
import { readDaemonToken } from "../src/daemon-settings.mjs";
import { requireNativeCommand, windowsSystemCommand } from "../src/launch-command.mjs";
import { STATUS_RESPONSE_BYTES } from "../src/mcp-output.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const exec = promisify(execFile);
const file = fileURLToPath(import.meta.url);
const probe = new URL("./daemon-memory-probe.mjs", import.meta.url).href;
const MiB = 1024 * 1024;
const protocol = { legacy: "2025-11-25", modern: "2026-07-28" };
const budgets = { aggregate: 320, daemon: 200, driver: 120, bridge: 80 };
const clientInfo = { name: "harnest-memory-ci", version: "1" };
const requestIds = Array.from({ length: 3 }, (_, i) => `memory-status-fixture-${i}`);
const pollRounds = 4;
const toolNames = [
  "cancel", "compare", "dynamic_control", "dynamic_delete", "dynamic_get", "dynamic_history",
  "dynamic_inspect", "dynamic_invoke", "dynamic_list", "dynamic_result", "dynamic_resume",
  "dynamic_revisions", "dynamic_save", "dynamic_start", "dynamic_status", "dynamic_validate",
  "fleet", "graph_cancel", "graph_result", "graph_resume", "graph_start", "graph_status",
  "graph_validate", "host_info", "message", "page", "post", "read", "reroute", "result", "resume",
  "review", "routing_configure", "routing_get", "routing_preview", "sessions", "status", "trace", "workflow",
].map((name) => `handoff_${name}`);

function client(send, era) {
  let id = 0;
  const version = protocol[era];
  const modern = era === "modern";
  const meta = {
    "io.modelcontextprotocol/protocolVersion": version,
    "io.modelcontextprotocol/clientInfo": clientInfo,
    "io.modelcontextprotocol/clientCapabilities": {},
  };
  const rpc = async (method, params, checkReply) => {
    const reply = await send({
      jsonrpc: "2.0", id: ++id, method, ...((params || modern) && { params: { ...params, ...(modern && { _meta: meta }) } }),
    }, version);
    assert.ok(reply?.result && !reply.error && !reply.result.isError, `${era} ${method} failed`);
    checkReply?.(reply);
    return reply.result;
  };
  return {
    async discover() {
      if (modern) await rpc("server/discover");
      else {
        assert.equal((await rpc("initialize", { protocolVersion: version, capabilities: {}, clientInfo })).protocolVersion, version);
        await send({ jsonrpc: "2.0", method: "notifications/initialized" }, version);
      }
      const { tools, nextCursor } = await rpc("tools/list");
      assert.equal(nextCursor, undefined);
      const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
      assert.deepEqual(sorted.map((tool) => tool.name), toolNames);
      for (const tool of tools) assert.equal(tool.inputSchema.type, "object", tool.name);
      return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
    },
    async status(index = 0) {
      const requestId = requestIds[index % requestIds.length];
      let size;
      const result = await rpc("tools/call", { name: "handoff_status", arguments: { requestId } }, (reply) => {
        size = Buffer.byteLength(JSON.stringify(reply), "utf8");
        assert.ok(size <= STATUS_RESPONSE_BYTES, `${era} status returned ${size} bytes`);
      });
      const { receipt } = result.structuredContent;
      assert.equal(receipt.state, "completed");
      assert.equal(receipt.requestId, requestId);
      assert.equal(receipt.result, undefined);
      assert.equal(receipt.resultRef.tool, "handoff_result");
      return size;
    },
  };
}

async function clientDriver() {
  process.channel.ref();
  const make = (i) => {
    const transport = createDaemonClient();
    return { ...client(transport.rpc, i % 2 ? "modern" : "legacy"), close: transport.close };
  };
  const clients = Array.from({ length: 10 }, (_, i) => make(i));
  const expected = [await clients[0].discover(), await clients[1].discover()];
  const verify = async (peer, i) => assert.equal(await peer.discover(), expected[i % 2]);
  for (let i = 0; i < 3; i++) await verify(clients[i], i);
  await Promise.all(clients.map(verify));
  clients[0].close();
  clients[1].close();
  clients[0] = make(0);
  clients[1] = make(1);
  const sizes = await Promise.all(clients.map(async (peer, i) => {
    const polls = [];
    for (let round = 0; round < pollRounds; round++) {
      polls.push(await peer.status(i + round));
      await verify(peer, i);
      await delay(30);
    }
    return polls;
  }));
  process.send({ kind: "catalogs", digest: { legacy: expected[0], modern: expected[1] }, clients: clients.length,
    completedJobs: requestIds.length, statusPolls: sizes.flat().length, maxStatusBytes: Math.max(...sizes.flat()) });
  await new Promise((resolve) => process.once("disconnect", resolve));
  for (const peer of clients) peer.close();
}

// Windows never updates ParentProcessId and reuses PIDs, so a process that was already running
// (csrss.exe, wininit.exe) can name a dead parent whose PID the daemon or driver later receives.
// Such a sample cannot tell real children from stale ones. Record every running process by PID
// plus creation time before anything is launched; if one of them later shows up as a child, the
// sample is discarded and taken again with new processes. No row is ever filtered out, so an
// accepted sample is checked exactly as strictly as before.
const AMBIGUOUS_PARENT_PID = "AMBIGUOUS_PARENT_PID";

async function runningProcessIdentities() {
  if (process.platform !== "win32") return new Set();
  const { stdout } = await exec(windowsSystemCommand("powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command",
    `Get-CimInstance Win32_Process -Property ProcessId,CreationDate | ` +
    `ForEach-Object { if ($_.CreationDate) { '{0}:{1}' -f $_.ProcessId, $_.CreationDate.Ticks } }`],
  { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  return new Set(stdout.split(/\r?\n/).map((row) => row.trim()).filter(Boolean));
}

async function childProcesses(parentPids, preexisting = new Set()) {
  if (process.platform === "win32") {
    const filter = parentPids.map((pid) => `ParentProcessId = ${pid}`).join(" OR ");
    const { stdout } = await exec(windowsSystemCommand("powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command",
      `$children = Get-CimInstance Win32_Process -Filter '${filter}' | Select-Object ` +
      `@{n='image';e={$_.Name}}, @{n='pid';e={$_.ProcessId}}, ` +
      `@{n='parentPid';e={$_.ParentProcessId}}, @{n='rssBytes';e={[uint64]$_.WorkingSetSize}}, ` +
      `@{n='created';e={if ($_.CreationDate) { $_.CreationDate.Ticks.ToString() } else { '' }}}; ` +
      `ConvertTo-Json -InputObject @($children) -Compress`],
    { windowsHide: true });
    const rows = JSON.parse(stdout);
    const stale = rows.filter(({ pid, created }) => created && preexisting.has(`${pid}:${created}`));
    if (stale.length) {
      throw Object.assign(new Error("A process that was already running names a reused parent PID: " +
        stale.map(({ image, pid, parentPid }) => `${image} ${pid} (parent ${parentPid})`).join(", ")),
      { code: AMBIGUOUS_PARENT_PID });
    }
    return rows.map((row) => ({ image: row.image, pid: row.pid, parentPid: row.parentPid, rssBytes: row.rssBytes }));
  }
  const { stdout } = await exec(requireNativeCommand("ps"), ["-eo", "pid=,ppid=,rss=,comm="]);
  return stdout.trim().split("\n").map((row) => {
    const [, pid, parentPid, rss, image] = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(row);
    return { image: image.trim(), pid: Number(pid), parentPid: Number(parentPid), rssBytes: Number(rss) * 1024 };
  }).filter(({ parentPid }) => parentPids.includes(parentPid));
}

function launch(args, env, pipes = false) {
  const child = spawn(process.execPath, ["--import", probe, ...args], {
    // A hidden Windows console can still create a conhost.exe child.
    detached: process.platform === "win32",
    cwd: root, env, windowsHide: true, stdio: [pipes ? "pipe" : "ignore", pipes ? "pipe" : "ignore", args.includes("--driver") ? "inherit" : "ignore", "ipc"],
  });
  const closed = once(child, "exit");
  return {
    child, closed,
    async sample() {
      const result = once(child, "message");
      child.send("sample");
      const [message] = await result;
      assert.equal(message.kind, "sample");
      return Object.fromEntries(Object.entries(message).filter(([name]) => name !== "kind"));
    },
    async shutdown() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
    },
  };
}

async function daemonReady(child, fixture) {
  while (child.exitCode === null && child.signalCode === null) {
    try { return JSON.parse(await readFile(join(fixture, "daemon", "daemon.json"), "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await delay(40);
  }
  throw new Error("Daemon exited before publishing readiness");
}

async function bridgeWorkload(bridge, expected) {
  const lines = createInterface({ input: bridge.child.stdout, crlfDelay: Infinity });
  let reply;
  lines.on("line", (line) => reply?.(JSON.parse(line)));
  const send = (message) => new Promise((resolve) => {
    if (message.id === undefined) resolve();
    else reply = resolve;
    bridge.child.stdin.write(JSON.stringify(message) + "\n");
  });
  try {
    for (const era of ["legacy", "modern"]) {
      const peer = client(send, era);
      assert.equal(await peer.discover(), expected[era]);
      await peer.status();
    }
    const memory = await bridge.sample();
    bridge.child.stdin.end();
    assert.deepEqual(await bridge.closed, [0, null]);
    return memory;
  } finally { lines.close(); }
}

async function measure(sampleNumber) {
  const fixture = await mkdtemp(join(tmpdir(), "harnest-daemon-ci-"));
  const stateDir = join(fixture, "jobs");
  const env = { ...process.env, HOME: fixture, USERPROFILE: fixture, LOCALAPPDATA: fixture, APPDATA: fixture,
    XDG_STATE_HOME: fixture, XDG_CONFIG_HOME: fixture, HARNEST_STATE_DIR: stateDir };
  const sample = { sample: sampleNumber };
  let daemon, driver, bridge, timer, stop;
  try {
    const { Companion } = await import("../src/companion.mjs");
    const result = { finalText: "界".repeat(64_000), summary: "界".repeat(16_000) };
    const fixtureOwner = new Companion({
      stateDir, routeResolver: async (request) => request,
      adapterFactory: () => ({ run: async () => ({ sessionId: "memory-fixture", result }) }),
    });
    for (const requestId of requestIds) {
      const receipt = await fixtureOwner.start({ requestId, cwd: fixture, target: "pi", task: "fixture" });
      assert.equal(receipt.state, "completed");
      assert.ok(Buffer.byteLength(receipt.result.finalText, "utf8") > STATUS_RESPONSE_BYTES);
    }
    await fixtureOwner.close();
    const preexisting = await runningProcessIdentities();
    const workload = async () => {
      daemon = launch(["src/daemon.mjs", "--fixture-port", "0"], env);
      const { port, pid } = await daemonReady(daemon.child, fixture);
      assert.equal(pid, daemon.child.pid);
      env.HARNEST_DAEMON_FIXTURE_PORT = String(port);
      const token = await readDaemonToken(join(fixture, "daemon"));
      stop = () => fetch(`http://127.0.0.1:${port}/stop`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
      driver = launch([file, "--driver"], env);
      const [catalogs] = await Promise.race([
        once(driver.child, "message"),
        driver.closed.then(() => { throw new Error("HTTP client driver exited before finishing"); }),
      ]);
      assert.equal(catalogs.kind, "catalogs");
      assert.equal(catalogs.clients, 10);
      assert.equal(catalogs.completedJobs, requestIds.length);
      assert.equal(catalogs.statusPolls, catalogs.clients * pollRounds);
      sample.statusPolling = { completedJobs: catalogs.completedJobs, polls: catalogs.statusPolls,
        maxResponseBytes: catalogs.maxStatusBytes, budgetBytes: STATUS_RESPONSE_BYTES };
      sample.protocols = protocol;
      sample.toolCount = toolNames.length;
      sample.catalogSha256 = catalogs.digest;
      sample.clientCount = catalogs.clients;
      const parentPids = [pid, driver.child.pid];
      const children = await childProcesses(parentPids, preexisting);
      sample.processes = { daemon: pid, driver: driver.child.pid, children };
      assert.ok(children.every(({ image, parentPid }) => process.platform === "win32"
        && image.toLowerCase() === "conhost.exe" && parentPids.includes(parentPid)),
      "Discovery and completed-status reads must not spawn unexpected child processes");
      const childRssBytes = children.reduce((total, child) => total + child.rssBytes, 0);
      [sample.daemon, sample.driver] = await Promise.all([daemon.sample(), driver.sample()]);
      driver.child.disconnect();
      assert.deepEqual(await driver.closed, [0, null]);
      bridge = launch(["src/mcp-bridge.mjs"], env, true);
      sample.bridge = await Promise.race([
        bridgeWorkload(bridge, catalogs.digest),
        bridge.closed.then(([code]) => {
          if (code !== 0) throw new Error("Bridge exited before finishing");
          return new Promise(() => {});
        }),
      ]);
      const afterBridge = await daemon.sample();
      sample.daemon.peakRssBytes = Math.max(sample.daemon.peakRssBytes, afterBridge.peakRssBytes);
      const stopped = await stop();
      assert.equal(stopped.status, 200);
      await stopped.json();
      assert.deepEqual(await daemon.closed, [0, null]);
      sample.processes.bridge = bridge.child.pid;
      sample.currentAggregateMiB = (sample.daemon.rssBytes + sample.driver.rssBytes + childRssBytes) / MiB;
      sample.peakMiB = {
        daemon: sample.daemon.peakRssBytes / MiB, driver: sample.driver.peakRssBytes / MiB, bridge: sample.bridge.peakRssBytes / MiB,
        aggregate: (sample.daemon.peakRssBytes + sample.driver.peakRssBytes + childRssBytes) / MiB,
      };
      for (const [name, budget] of Object.entries(budgets)) {
        assert.ok(sample.peakMiB[name] <= budget, `${name} peak exceeded ${budget} MiB`);
      }
    };
    await Promise.race([workload(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Daemon memory measurement exceeded 30 seconds")), 30_000);
    })]);
  } catch (error) {
    sample.error = error.message;
    if (error.code === AMBIGUOUS_PARENT_PID) sample.discarded = true;
  }
  finally {
    clearTimeout(timer);
    await Promise.all([bridge, driver, daemon].filter(Boolean).map((process) => process.shutdown()));
    await rm(fixture, { recursive: true, force: true });
  }
  return sample;
}

if (process.argv.includes("--driver")) {
  await clientDriver().catch((error) => process.stderr.write(String(error.stack ?? error) + "\n", () => process.exit(1)));
} else {
  const result = { platform: process.platform, release: release(), arch: process.arch, node: process.version, budgets, samples: [], discarded: [] };
  for (let run = 1; run <= 3; run++) {
    let sample;
    // Only a reused parent PID discards a sample. After three discards the last one is kept,
    // with its error, so the run fails instead of passing unmeasured.
    for (let attempt = 1; attempt <= 3; attempt++) {
      sample = await measure(run);
      if (!sample.discarded || attempt === 3) break;
      result.discarded.push(sample);
      console.log(JSON.stringify(sample));
    }
    result.samples.push(sample);
    console.log(JSON.stringify(sample));
  }
  await writeFile("harnest-daemon-memory.json", JSON.stringify(result, null, 2) + "\n");
  if (result.samples.some((sample) => sample.error)) process.exitCode = 1;
}
