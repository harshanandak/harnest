import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { bridgeEntry, installHostConfig, restoreHostConfig } from "../scripts/install-host-config.mjs";
import { cursorProject, installCursorIntegration } from "../scripts/install-cursor-integration.mjs";
import { migrateClaudeRegistrations } from "../scripts/install-plugin-host.mjs";
import { installIntegration, restoreIntegration } from "../scripts/install-opencode-integration.mjs";
import { installPiIntegration } from "../scripts/install-pi-integration.mjs";
import { bridgeHostConfig, installBridgeHost } from "../scripts/setup.mjs";

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), "harnest-migrate-"));
  t.after(() => rm(home, { recursive: true, force: true, maxRetries: 5 }));
  return home;
}

async function put(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof data === "string" ? data : JSON.stringify(data) + "\n");
}

const read = (path) => readFile(path, "utf8");
const json = async (path) => JSON.parse(await read(path));
const legacyServer = { command: "node", args: ["legacy-server.mjs"] };
const existing = { command: "unrelated" };
const expectStamp = (path) => assert.match(path, /\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/);

test("Codex migrates the old server, plugin and marketplace and restores the original config", async (t) => {
  const home = await fixture(t);
  const codexHome = join(home, ".codex");
  const path = join(codexHome, "config.toml");
  const prior = [
    'model = "keep"', '[mcp_servers."agent-companion"]', 'command = "old"', "tool_timeout_sec = 55",
    '[mcp_servers."agent-companion".env]', 'OLD = "remove"',
    '[plugins."agent-companion@agent-companion-local"]', 'enabled = true',
    "[marketplaces.agent-companion-local]", 'source = "/old"',
    '[plugins."harnest@harnest-local"]', "enabled = true",
    "[mcp_servers.agent-companion-test]", 'command = "leave"',
  ].join("\n") + "\n";
  await put(path, prior);
  const options = { home, codexHome };
  const result = await installHostConfig("codex", options);
  assert.deepEqual(result.migrated, ["mcp_servers.agent-companion", "agent-companion plugin", "agent-companion marketplace"]);
  expectStamp(result.backup);
  const config = await read(path);
  assert.doesNotMatch(config, /agent-companion-local|mcp_servers\."agent-companion"|OLD =/);
  assert.match(config, /\[mcp_servers\.agent-companion-test\]\ncommand = "leave"/);
  assert.match(config, /\[plugins\."harnest@harnest-local"\]\nenabled = true/);
  assert.match(config, /\[mcp_servers\.harnest\][\s\S]*tool_timeout_sec = 55/);
  assert.equal((await installHostConfig("codex", options)).backup, null);
  await restoreHostConfig(result.backup);
  assert.equal(await read(path), prior);
});

test("Cursor migrates user and selected workspace entries without replacing other servers", async (t) => {
  const home = await fixture(t);
  const project = join(home, "external project");
  const configs = [join(home, ".cursor", "mcp.json"), join(project, ".cursor", "mcp.json")];
  const prior = { mcpServers: { "agent-companion": legacyServer, existing } };
  for (const path of configs) await put(path, prior);
  const result = await installCursorIntegration(cursorProject(["--project", project]), { home });
  for (const [index, file] of [result.mcp, result.projectMcp].entries()) {
    assert.equal(file.path, configs[index]);
    assert.deepEqual(file.migrated, ["mcpServers.agent-companion"]);
    assert.deepEqual(await json(file.path), { mcpServers: { existing, harnest: bridgeEntry() } });
    expectStamp(file.backup);
    await restoreHostConfig(file.backup);
    assert.deepEqual(await json(file.path), prior);
  }
});

test("OpenCode migration preserves V2 server settings and plugin options and restores both registrations", async (t) => {
  const home = await fixture(t);
  const path = join(home, "opencode.jsonc");
  const prior = { mcp: { servers: { "agent-companion": { type: "local", disabled: true }, existing } },
    plugins: [{ package: "./plugins/agent-companion", options: { keep: true } }, "agent-companion-helper"] };
  const raw = "// fixture\n" + JSON.stringify(prior, null, 2) + "\n";
  await put(path, raw);
  const result = await installIntegration(home, { token: "fixture-token" });
  assert.deepEqual(result.migrated, ["mcp.servers.agent-companion", "agent-companion plugin registration"]);
  expectStamp(result.manifest);
  const next = await json(path);
  assert.deepEqual(next.mcp.servers.existing, existing);
  assert.equal(next.mcp.servers["agent-companion"], undefined);
  assert.equal(next.mcp.servers.harnest.disabled, true);
  assert.deepEqual(next.plugins, ["agent-companion-helper", { package: "./plugins/harnest", options: { keep: true } }]);
  await restoreIntegration(result.manifest);
  assert.equal(await read(path), raw);
});

test("Pi deactivates both configured and auto-loaded legacy extensions and retains their backups", async (t) => {
  const piDir = await fixture(t);
  const oldPath = join(piDir, "extensions", "agent-companion.mjs");
  const directoryExtension = join(piDir, "extensions", "agent-companion", "index.ts");
  const settingsPath = join(piDir, "settings.json");
  const prior = { extensions: [oldPath, "C:\\legacy\\Agent-Companion.mjs", "other.mjs"], theme: "keep" };
  await put(oldPath, "// old source\n");
  await put(directoryExtension, "// old directory source\n");
  await put(settingsPath, prior);
  const result = await installPiIntegration(piDir);
  assert.deepEqual(new Set(result.migrated), new Set(["settings.extensions agent-companion", "extensions/agent-companion.mjs", "extensions/agent-companion"]));
  assert.deepEqual(await json(settingsPath), { ...prior, extensions: ["other.mjs", result.extensionPath] });
  for (const file of result.backups) {
    expectStamp(file.backup);
    await assert.rejects(access(file.path), { code: "ENOENT" });
    await rename(file.backup, file.path);
  }
  assert.equal(await read(oldPath), "// old source\n");
  assert.equal(await read(directoryExtension), "// old directory source\n");
  const backup = (await readdir(piDir)).find((file) => file.startsWith("settings.json.bak-harnest-"));
  await restoreHostConfig(join(piDir, backup));
  assert.deepEqual(await json(settingsPath), prior);
});

test("Claude migration retains the installed Harnest marketplace and can restore old MCP, plugin and marketplace records", async (t) => {
  const home = await fixture(t);
  const dir = join(home, ".claude");
  const project = join(home, "claude workspace");
  const oldId = "agent-companion@agent-companion-local";
  const newId = "harnest@harnest-local";
  const fixtures = new Map([
    [join(dir, "settings.json"), { enabledPlugins: { [oldId]: true, [newId]: true, keep: false } }],
    [join(dir, "plugins", "known_marketplaces.json"), { "agent-companion-local": {}, "harnest-local": {}, keep: {} }],
    [join(dir, "plugins", "installed_plugins.json"), { version: 2, plugins: { [oldId]: [], [newId]: [], keep: [] } }],
    [join(home, ".claude.json"), { mcpServers: { "agent-companion": legacyServer, existing }, projects: { example: { mcpServers: { "agent-companion": legacyServer } } } }],
    [join(project, ".mcp.json"), { mcpServers: { "agent-companion": legacyServer, existing } }],
    [join(project, ".claude", "settings.json"), { enabledPlugins: { [oldId]: true, [newId]: true } }],
  ]);
  for (const [path, config] of fixtures) await put(path, config);
  const options = { home, configDir: dir, project };
  const changes = await migrateClaudeRegistrations(options);
  assert.equal(changes.length, fixtures.size);
  for (const { path, backup } of changes) {
    expectStamp(backup);
    assert.doesNotMatch(await read(path), /agent-companion/);
    assert.match(await read(path), /harnest|existing/);
  }
  assert.deepEqual(await migrateClaudeRegistrations(options), []);
  for (const { path, backup } of changes) {
    await restoreHostConfig(backup);
    assert.deepEqual(await json(path), fixtures.get(path));
  }
});

for (const host of ["gemini", "amp"]) {
  test(host + " setup installs the user bridge and preserves other settings", async (t) => {
    const home = await fixture(t);
    const { path, key } = bridgeHostConfig(host, home, {});
    const prior = { [key]: { "agent-companion": legacyServer, existing }, keep: true };
    await put(path, prior);
    const result = await installBridgeHost(host, { home, env: {} });
    const entry = host === "gemini" ? { ...bridgeEntry(), trust: false } : bridgeEntry();
    assert.deepEqual(await json(path), { [key]: { existing, harnest: entry }, keep: true });
    assert.deepEqual(result.migrated, [key + ".agent-companion"]);
    await restoreHostConfig(result.backup);
    assert.deepEqual(await json(path), prior);
  });
}
