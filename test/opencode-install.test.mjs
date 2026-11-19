import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { installIntegration, restoreIntegration, parseConfig } from "../scripts/install-opencode-integration.mjs";

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "harnest-opencode-install-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("installer copies every plugin import, preserves unrelated JSONC config, repeats without writes, and restores originals", { timeout: 60000 }, async t => {
  const dir = await fixture(t);
  await mkdir(join(dir, "plugins", "harnest"), { recursive: true });
  const priorAsset = "// user integration revision\n";
  await writeFile(join(dir, "plugins", "harnest", "host-info.mjs"), priorAsset);
  const prior = `{
    // Keep my provider and MCP settings.
    "model": "provider/model", "providers": {"local": {"url":"https://example.com/a,}"}},
    "plugins": [{"package":"user-plugin", "options":{"enabled":true}}],
    "mcp": {"timeout":{"execution":999999}, "servers":{"other":{"type":"remote","url":"https://example.com"},
      "harnest":{"type":"local","command":["previous"],"disabled":true,"environment":{"HARNEST_ROUTER":"saved-router"}}}},
  }\n`;
  await writeFile(join(dir, "opencode.jsonc"), prior);
  await writeFile(join(dir, "package.json"), '{"dependencies":{"unrelated":"1"}}');
  const first = await installIntegration(dir, { token: "fixture-token" });
  const references = await readdir(new URL("../skills/handoff/references/", import.meta.url));
  const plugins = await readdir(new URL("../opencode-plugin/", import.meta.url));
  const expected = [
    "opencode.jsonc",
    ...["opencode", "pi", "cursor", "claude", "codex", "gemini", "amp", "acp"].map(name => `agents/${name}-worker.md`),
    "skills/handoff/SKILL.md", "skills/handoff/agents/openai.yaml",
    ...references.map(name => `skills/handoff/references/${name}`),
    ...plugins.map(name => `plugins/harnest/${name}`),
    ...["handoff", "handoff-status", "handoff-graph"].map(name => `commands/${name}.md`),
  ].map(path => join(dir, path)).sort();
  assert.deepEqual([...first.changed].sort(), expected, "every installed asset must be accounted for");
  for (const reference of ["routing-precedence.md", "live-trace-loop.md", "agent-graphs.md", "dynamic-workflows.md", "workflow-fanout-verify.json", "workflow-observer.md"]) {
    assert.ok(references.includes(reference), `required reference: ${reference}`);
  }
  for (const reference of references) {
    assert.deepEqual(await readFile(join(dir, "skills", "handoff", "references", reference)),
      await readFile(new URL(`../skills/handoff/references/${reference}`, import.meta.url)));
  }
  const config = parseConfig(await readFile(join(dir, "opencode.jsonc"), "utf8"));
  assert.deepEqual(config.providers, parseConfig(prior).providers);
  assert.deepEqual(config.mcp.servers.other, parseConfig(prior).mcp.servers.other);
  assert.deepEqual(config.mcp.timeout, { execution: 999999 });
  assert.equal(config.mcp.servers["harnest"].disabled, true);
  assert.deepEqual(config.mcp.servers.harnest.headers, { Authorization: "Bearer fixture-token" });
  assert.equal(config.mcp.servers.harnest.environment, undefined);
  assert.deepEqual(config.mcp.servers["harnest"].timeout, { startup: 15000, catalog: 15000 });
  assert.deepEqual(config.plugins, [{ package: "user-plugin", options: { enabled: true } }, "./plugins/harnest"]);
  const installed = await import(pathToFileURL(join(dir, "plugins", "harnest", "index.js")).href);
  assert.equal(installed.default.id, "harnest");
  assert.equal(typeof installed.default.setup, "function");
  assert.deepEqual(await readdir(join(dir, "plugins")), ["harnest"]);
  assert.equal((await readdir(join(dir, "plugins", "harnest"))).length, 8);
  const dynamicPlugin = await readFile(join(dir, "plugins", "harnest", "dynamic-ui.mjs"), "utf8");
  assert.ok(dynamicPlugin.includes(new URL("../src/daemon-client.mjs", import.meta.url).href));
  assert.doesNotMatch(dynamicPlugin, /__HARNEST_DYNAMIC_CLIENT_URL__|dynamic-tools\.mjs|dynamic-runner\.mjs/);
  assert.equal(await readFile(join(dir, "package.json"), "utf8"), '{"dependencies":{"unrelated":"1"}}');
  const second = await installIntegration(dir, { token: "fixture-token" });
  assert.deepEqual(second, { changed: [], manifest: null, migrated: [] });
  const manifest = JSON.parse(await readFile(first.manifest, "utf8"));
  assert.equal(manifest.files.filter(file => file.backup).length, 2);
  await restoreIntegration(first.manifest);
  assert.equal(await readFile(join(dir, "opencode.jsonc"), "utf8"), prior);
  assert.equal(await readFile(join(dir, "plugins", "harnest", "host-info.mjs"), "utf8"), priorAsset);
  assert.deepEqual(await readdir(join(dir, "agents")), []);
  await restoreIntegration(first.manifest);
});

test("restore refuses to overwrite subsequent edits before restoring any files", { timeout: 60000 }, async t => {
  const dir = await fixture(t);
  const installed = await installIntegration(dir, { token: "fixture-token" });
  await writeFile(join(dir, "agents", "pi-worker.md"), "later user edit");
  await assert.rejects(restoreIntegration(installed.manifest), /changed since install/);
  assert.equal(await readFile(join(dir, "agents", "pi-worker.md"), "utf8"), "later user edit");
  assert.ok((await readFile(join(dir, "opencode.json"), "utf8")).includes('"plugins"'));
});

test("invalid config aborts before installing assets", async t => {
  const dir = await fixture(t);
  await writeFile(join(dir, "opencode.json"), "{broken");
  await assert.rejects(installIntegration(dir, { token: "fixture-token" }));
  assert.deepEqual(await readdir(dir), ["opencode.json"]);
});

test("installer rejects legacy and mixed layouts before daemon preparation or file changes", async t => {
  const dir = await fixture(t);
  const path = join(dir, "opencode.json");
  const flat = { type: "local", command: ["other"], enabled: false, timeout: 10_000 };
  for (const config of [
    { mcp: { other: flat }, plugin: ["other-plugin"] },
    { mcp: { other: flat, servers: { existing: { type: "local", command: ["existing"] } } } },
    { plugin: ["other-plugin"], plugins: ["current-plugin"] },
    { mcp: { servers: { harnest: flat } } },
  ]) {
    const before = JSON.stringify(config);
    await writeFile(path, before);
    await assert.rejects(installIntegration(dir, { prepareDaemon() { assert.fail("must not prepare daemon"); } }), /Migrate.*V2/);
    assert.deepEqual(await readdir(dir), ["opencode.json"]);
    assert.equal(await readFile(path, "utf8"), before);
  }
});

test("upgrade backs up changed package assets and preserves canonical plugin options", { timeout: 60000 }, async t => {
  const dir = await fixture(t);
  await installIntegration(dir, { token: "fixture-token" });
  const asset = join(dir, "plugins", "harnest", "host-info.mjs");
  await writeFile(asset, "// earlier local customization\n");
  const path = join(dir, "opencode.json");
  const config = JSON.parse(await readFile(path, "utf8"));
  config.plugins = [{ package: "./plugins/harnest", options: { example: true } }];
  config.mcp.servers.harnest.command = ["previous"];
  await writeFile(path, JSON.stringify(config));
  const upgraded = await installIntegration(dir, { token: "fixture-token" });
  assert.equal(upgraded.changed.length, 2);
  const next = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(next.plugins, config.plugins);
  assert.equal(next.mcp.servers.harnest.command, undefined);
  assert.equal(next.mcp.servers.harnest.type, "remote");
  assert.deepEqual(await installIntegration(dir, { token: "fixture-token" }), { changed: [], manifest: null, migrated: [] });
  await restoreIntegration(upgraded.manifest);
  assert.equal(await readFile(asset, "utf8"), "// earlier local customization\n");
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), config);
});

test("CLI bootstraps before configuring the OpenCode user home", { timeout: 60000 }, async t => {
  const dir = await fixture(t);
  const stateDir = join(dir, "jobs");
  const { startDaemon } = await import("../src/daemon.mjs");
  const daemon = await startDaemon({ port: 0, directory: join(dir, "daemon") });
  try {
    const env = { ...process.env, HOME: dir, USERPROFILE: dir, XDG_CONFIG_HOME: join(dir, "xdg"),
      HARNEST_STATE_DIR: stateDir, HARNEST_DAEMON_FIXTURE_PORT: String(daemon.port) };
    // A synchronous child would block the fixture HTTP listener in this process.
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = await promisify(execFile)(process.execPath, [resolve("scripts/install-opencode-integration.mjs"), "--no-autostart"], { env, timeout: 15000 });
    const config = JSON.parse(await readFile(join(dir, "xdg", "opencode", "opencode.json"), "utf8"));
    assert.equal(config.mcp.servers.harnest.type, "remote");
    assert.equal(config.mcp.servers.harnest.url, "http://127.0.0.1:41237/mcp");
    assert.ok(/^Bearer [a-f0-9]{64}$/.test(config.mcp.servers.harnest.headers.Authorization));
    assert.ok(!(run.stdout + run.stderr).includes(config.mcp.servers.harnest.headers.Authorization.slice(7)));
  } finally { await daemon.close(); }
});
