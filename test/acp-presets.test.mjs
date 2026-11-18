import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ACP_PRESETS } from "../src/acp-presets.mjs";
import { resolveAcpAgent } from "../src/acp-registry.mjs";
import { ACPAdapter } from "../src/adapters/acp.mjs";

const cli = fileURLToPath(new URL("../scripts/acp-registry.mjs", import.meta.url));

function addPreset(id, ...args) {
  return runRegistry(["add", id, ...args]);
}

function runRegistry(args, options = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 10_000, windowsHide: true, ...options });
  assert.ifError(result.error);
  return result;
}

test("ACP presets have unique registry ids, bounded native launch fields, and unverified status", () => {
  assert.deepEqual(ACP_PRESETS.map(({ id }) => id).sort(), [
    "auggie", "cline", "devin", "factory-droid", "github-copilot-cli", "goose", "kilo", "kimi", "kiro", "mistral-vibe", "qwen-code",
  ]);
  for (const { id, name, command, args, installHint, docsUrl, verified } of ACP_PRESETS) {
    assert.match(id, /^[a-z0-9][a-z0-9-]{0,127}$/);
    assert.match(name, /\S/);
    assert.match(command, /^[a-z][a-z0-9-]*$/);
    assert.ok(Array.isArray(args) && args.length <= 128);
    for (const arg of args) assert.match(arg, /^[^\0]{1,16384}$/);
    assert.match(installHint, /\S/);
    assert.equal(new URL(docsUrl).protocol, "https:");
    assert.equal(verified, false);
  }
});

test("every ACP preset needs trust to register and write approval to launch", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "harnest-acp-presets-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fakeExecutable = join(directory, "fixture-acp.exe");

  for (const { id, command, args } of ACP_PRESETS) {
    const configPath = join(directory, `${id}.json`);
    const preview = addPreset(id, "--config", configPath);
    assert.equal(preview.status, 1, preview.stderr);
    assert.ok(preview.stderr.includes(JSON.stringify({ command, args })));
    assert.match(preview.stderr, /requires explicit --trust/);
    await assert.rejects(readFile(configPath), { code: "ENOENT" });

    const added = addPreset(id, "--command", fakeExecutable, "--config", configPath, "--trust");
    assert.equal(added.status, 0, added.stderr);
    assert.deepEqual(JSON.parse(added.stdout), { registered: id, trusted: true, command: fakeExecutable, args, verified: false });
    const { acp: { agents } } = JSON.parse(await readFile(configPath, "utf8"));
    assert.deepEqual(await resolveAcpAgent(id, { registrations: agents }), { id, command: fakeExecutable, args, trusted: true });

    let spawnCount = 0;
    const adapter = new ACPAdapter({ registrations: agents, spawn: () => { spawnCount++; throw new Error("unexpected spawn"); } });
    const approved = {
      target: "acp", route: { agent: id }, cwd: directory, task: "Fixture", policy: { write: true },
      metadata: { harnest: { writeApproved: true } },
    };
    await assert.rejects(adapter.run({ ...approved, metadata: {} }), /writeApproved=true/);
    await assert.rejects(adapter.run({ ...approved, policy: { write: false } }), /write/i);
    assert.equal(spawnCount, 0);
  }
});

test("ACP preset pins the PATH executable even when the handoff cwd contains a decoy", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "harnest-acp-preset-path-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const install = join(directory, "trusted install");
  const cwd = join(directory, "handoff");
  await mkdir(install);
  await mkdir(cwd);
  const name = process.platform === "win32" ? "copilot.exe" : "copilot";
  const trustedExecutable = join(install, name);
  await copyFile(process.execPath, trustedExecutable);
  await copyFile(process.execPath, join(cwd, name));
  const configPath = join(directory, "local.json");
  const env = {
    PATH: ["", ".", join("..", "handoff"), install].join(delimiter),
    ...(process.platform === "win32" && { PATHEXT: ".CMD;.exe", SystemRoot: process.env.SystemRoot }),
  };

  const added = runRegistry(["add", "github-copilot-cli", "--config", configPath, "--trust"], { cwd, env });
  assert.equal(added.status, 0, added.stderr);
  const { acp: { agents } } = JSON.parse(await readFile(configPath, "utf8"));
  const { command } = await resolveAcpAgent("github-copilot-cli", { registrations: agents });
  assert.equal(command, trustedExecutable, "registration must pin the absolute executable on PATH");
  assert.equal(JSON.parse(added.stdout).command, trustedExecutable);

  const fixture = fileURLToPath(new URL("./fixtures/process-child.mjs", import.meta.url));
  const child = spawnSync(command, [fixture, "exec-path"], { cwd, env, shell: false, encoding: "utf8", timeout: 10_000, windowsHide: true });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(await realpath(child.stdout.trim()), await realpath(trustedExecutable));

  const override = runRegistry(["add", "github-copilot-cli", "--command", name, "--config", configPath, "--trust"], { cwd, env });
  assert.equal(override.status, 0, override.stderr);
  assert.equal(JSON.parse(override.stdout).command, trustedExecutable);

  const registryStub = "globalThis.fetch = async () => Response.json({ version: '1.0.0', agents: [] });";
  const listed = runRegistry(["list", "--config", configPath], {
    cwd,
    env: { ...env, NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(registryStub)}` },
  });
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(JSON.parse(listed.stdout).configuredAgents, [
    { id: "github-copilot-cli", trusted: true, command: trustedExecutable },
  ]);

  const missingConfig = join(directory, "unresolved.json");
  const relativePath = ["", ".", join("..", "handoff")].join(delimiter);
  const missing = runRegistry(["add", "github-copilot-cli", "--config", missingConfig, "--trust"], {
    cwd,
    env: { ...env, PATH: relativePath },
  });
  assert.equal(missing.status, 1, missing.stderr);
  assert.match(missing.stderr, /absolute --command/);
  const relative = runRegistry(["add", "github-copilot-cli", "--command", `./${name}`, "--config", missingConfig, "--trust"], { cwd, env });
  assert.equal(relative.status, 1, relative.stderr);
  assert.match(relative.stderr, /absolute --command/);
  await assert.rejects(readFile(missingConfig), { code: "ENOENT" });
});

test("ACP preset CLI reports an unknown id before writing config", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "harnest-acp-preset-unknown-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, "local.json");

  const result = addPreset("unknown-agent", "--config", configPath, "--trust");
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Unknown ACP preset "unknown-agent".*Available presets:.*devin/);
  await assert.rejects(readFile(configPath), { code: "ENOENT" });
});

test("ACP preset rejects an absolute Windows batch shim before writing config", { skip: process.platform !== "win32" }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "harnest-acp-preset-shim-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, "local.json");
  for (const extension of [".cmd", ".BAT"]) {
    const result = addPreset("github-copilot-cli", "--command", join(directory, `copilot${extension}`), "--config", configPath, "--trust");
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /native executable/i);
    await assert.rejects(readFile(configPath), { code: "ENOENT" });
  }
});
