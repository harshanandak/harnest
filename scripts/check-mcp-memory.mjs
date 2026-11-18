#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { release, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client, parseJSONRPCMessage } from "@modelcontextprotocol/client";
import { getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { assertMcpCatalog } from "./harnest-mcp-catalog.mjs";

const mib = 1024 * 1024;
const args = process.argv.slice(2);
const flag = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const budgetMiB = Number(flag("--budget-mib"));
assert.ok(Number.isFinite(budgetMiB) && budgetMiB > 0, "Set --budget-mib to a positive number");
const output = flag("--output") ?? "harnest-mcp-memory.json";
const root = fileURLToPath(new URL("../", import.meta.url));
const probe = new URL("./harnest-memory-probe.mjs", import.meta.url).href;
const manifest = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8"));
const [plugin] = Object.values(manifest.mcpServers);
// The Claude plugin reaches the shared daemon over HTTP; check-daemon-memory.mjs measures that path.
assert.equal(plugin.type, "http", "The Claude plugin must use the shared daemon, not a per-thread stdio server");
const launches = [{ name: "direct", args: ["src/mcp-server.mjs"] }];

async function bounded(work, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
  try { return await Promise.race([work, timeout]); }
  finally { clearTimeout(timer); }
}

async function measure(launch, era, fixture) {
  const child = spawn(process.execPath, ["--import", probe, ...launch.args], {
    cwd: root,
    env: {
      ...getDefaultEnvironment(), ...launch.env,
      HOME: fixture, USERPROFILE: fixture, LOCALAPPDATA: fixture, APPDATA: fixture,
      XDG_STATE_HOME: fixture, XDG_CONFIG_HOME: fixture,
    },
    stdio: ["pipe", "pipe", "ignore", "ipc"],
    windowsHide: true,
  });
  const closed = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const transport = {
    async start() {},
    async close() { child.stdin.end(); },
    send(message) {
      return new Promise((resolve, reject) => {
        child.stdin.write(`${JSON.stringify(message)}\n`, (error) => error ? reject(error) : resolve());
      });
    },
  };
  let fail;
  const fault = new Promise((_, reject) => { fail = reject; });
  child.on("error", () => fail(new Error("Server process error")));
  child.stdin.on("error", () => fail(new Error("Server stdin error")));
  lines.on("error", () => fail(new Error("Server stdout error")));
  child.once("close", () => transport.onclose?.());
  let protocol;
  lines.on("line", (line) => {
    try {
      const message = parseJSONRPCMessage(JSON.parse(line));
      protocol ??= message.result?.protocolVersion;
      transport.onmessage?.(message);
    } catch {
      fail(new Error("Invalid MCP response"));
    }
  });

  const client = new Client({ name: "harnest-memory-budget", version: "1" },
    era === "modern" ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {});
  const workload = async () => {
    await client.connect(transport);
    assert.equal(client.getProtocolEra(), era);
    const listed = await client.listTools();
    assert.equal(listed.nextCursor, undefined, "Expected the full tool catalog in one response");
    const names = assertMcpCatalog(listed);
    for (const tool of listed.tools) assert.equal(tool.inputSchema.type, "object", `Missing input schema for ${tool.name}`);
    const catalog = [...listed.tools].sort((a, b) => a.name.localeCompare(b.name));
    const toolCatalogSha256 = createHash("sha256").update(JSON.stringify(catalog)).digest("hex");

    await delay(1000);
    const sampled = once(child, "message");
    child.send("harnest-memory-sample");
    const [current] = await sampled;
    assert.equal(current.kind, "current");

    const final = once(child, "message");
    child.stdin.end();
    const [[last], ended] = await bounded(Promise.all([final, closed]), 3000, "Server did not exit cleanly after EOF");
    assert.deepEqual(ended, { code: 0, signal: null });
    assert.equal(last.kind, "final");
    return {
      protocol: protocol ?? "2026-07-28", era, toolCount: names.length, toolCatalogSha256,
      rssBytes: current.rssBytes, peakRssBytes: Math.max(current.peakRssBytes, last.peakRssBytes),
      heapUsedBytes: current.heapUsedBytes, heapTotalBytes: current.heapTotalBytes,
    };
  };

  try {
    return await bounded(Promise.race([workload(), fault]), 30_000, "Memory measurement exceeded 30 seconds");
  } finally {
    lines.close();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  }
}

const artifact = {
  platform: process.platform, release: release(), arch: process.arch, node: process.version,
  budgetMiB, samples: [],
};
for (const launch of launches) {
  for (const era of ["legacy", "modern"]) {
    for (let run = 1; run <= 3; run++) {
      const fixture = await mkdtemp(join(tmpdir(), "harnest-memory-ci-"));
      const sample = { launch: launch.name, era, run };
      try {
        Object.assign(sample, await measure(launch, era, fixture));
        sample.peakRssMiB = sample.peakRssBytes / mib;
        sample.rssMiB = sample.rssBytes / mib;
        if (sample.peakRssBytes > budgetMiB * mib) sample.error = `Peak RSS exceeded ${budgetMiB} MiB`;
      } catch (error) {
        sample.error = error.message;
      } finally {
        await rm(fixture, { recursive: true });
      }
      artifact.samples.push(sample);
      console.log(JSON.stringify(sample));
    }
  }
}
await writeFile(output, `${JSON.stringify(artifact, null, 2)}\n`);
if (artifact.samples.some((sample) => sample.error)) process.exitCode = 1;
