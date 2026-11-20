import assert from "node:assert/strict";
import { exec, execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { parse } from "jsonc-parser";
import { startDaemon } from "../src/daemon.mjs";
import { createRuntimeServices } from "../src/runtime-services.mjs";
import { isPrivateInstallerFile } from "../scripts/install-files.mjs";
import { installJsonServer } from "../scripts/install-host-config.mjs";
import { bridgeHostConfig } from "../scripts/setup.mjs";
import { ACP_PRESETS } from "../src/acp-presets.mjs";
import { withHarnestOnPath } from "./fixtures/harnest-shell.mjs";

const run = promisify(execFile);
const runShell = promisify(exec);
const overrides = ["COPILOT_HOME", "QWEN_HOME", "KILO_CONFIG", "XDG_CONFIG_HOME", "CLINE_MCP_SETTINGS_PATH",
  "CLINE_DATA_DIR", "CLINE_DIR", "KIRO_HOME", "KIMI_SHARE_DIR", "GOOSE_PATH_ROOT", "VIBE_HOME"];
const jsonHosts = {
  "github-copilot-cli": [".copilot", "mcp-config.json"],
  "qwen-code": [".qwen", "settings.json"],
  kilo: [".config", "kilo", "kilo.jsonc"],
  cline: [".cline", "data", "settings", "cline_mcp_settings.json"],
  kiro: [".kiro", "settings", "mcp.json"],
  "factory-droid": [".factory", "mcp.json"],
  auggie: [".augment", "settings.json"],
  kimi: [".kimi", "mcp.json"],
  devin: process.platform === "win32"
    ? ["roaming", "devin", "mcp_config.json"] : [".config", "devin", "mcp_config.json"],
};

test("ACP preset lead setup and doctor use the stdio bridge", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "harnest-preset-hosts-"));
  const stateDir = join(fixture, "jobs");
  const daemonDir = join(fixture, "daemon");
  let daemon;
  t.after(async () => {
    await daemon?.close();
    await rm(fixture, { recursive: true, force: true, maxRetries: 5 });
  });
  daemon = await startDaemon({ port: 0, directory: daemonDir, buildServices: () => createRuntimeServices({
    stateDir, boardDir: join(fixture, "boards"), graphDir: join(fixture, "graphs"), workflowDir: join(fixture, "workflows"),
    routing: { config: {}, env: {}, policyFile: join(fixture, "routing.json") },
  }) });
  const env = await withHarnestOnPath(join(fixture, "bin"), {
    ...process.env, HARNEST_STATE_DIR: stateDir, HARNEST_LOGIN_DAEMON_DIR: daemonDir,
    HARNEST_LOGIN_JOB_DIR: stateDir, HARNEST_DAEMON_FIXTURE_PORT: String(daemon.port),
  });
  for (const name of overrides) delete env[name];
  const cliOptions = (home, pathOverrides = {}) => ({
    timeout: 35_000, windowsHide: true,
    env: { ...env, HOME: home, USERPROFILE: home, APPDATA: join(home, "roaming"), ...pathOverrides },
  });
  const cli = (home, script, ...args) => run(process.execPath, ["scripts/" + script + ".mjs", ...args], cliOptions(home));
  const bridge = { command: process.execPath, args: [join(process.cwd(), "src", "mcp-bridge.mjs")],
    env: { HARNEST_LOGIN_DAEMON_DIR: daemonDir, HARNEST_LOGIN_JOB_DIR: stateDir } };
  const expected = {
    "github-copilot-cli": { type: "local", ...bridge, tools: ["*"] },
    kilo: { type: "local", command: [bridge.command, ...bridge.args], environment: bridge.env, enabled: true },
    cline: { transport: { type: "stdio", ...bridge } },
    "factory-droid": { type: "stdio", ...bridge },
  };

  for (const [host, segments] of Object.entries(jsonHosts)) {
    await t.test(host, async () => {
      const home = join(fixture, host);
      const path = join(home, ...segments);
      const key = host === "kilo" ? "mcp" : "mcpServers";
      const comments = ["qwen-code", "kilo", "auggie", "devin"].includes(host);
      const unrelated = { kind: "keep", url: "https://example.test/path//keep" };
      const other = { command: "other", args: ['a"b'] };
      const settings = { unrelated, [key]: { other } };
      const raw = JSON.stringify(settings, null, 2).replace(/\n/g, "\r\n") + "\r\n";
      const prior = comments ? "// keep this comment\r\n" + raw
        .replace('  "unrelated"', '  /* keep this too */\r\n  "unrelated"')
        .replace('    "other"', '    // keep the server note\r\n    "other"') : raw;
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, prior);

      const setup = await cli(home, "setup", host, "--no-autostart");
      assert.match(setup.stdout, new RegExp(`^Reverse path: harnest setup remove ${host}$`, "m"));
      assert.match(setup.stdout, /Reverse path(?: \(PowerShell\))?: harnest setup --restore /);
      const installed = await readFile(path, "utf8");
      const decoded = comments ? parse(installed) : JSON.parse(installed);
      assert.deepEqual(decoded, { unrelated, [key]: { other, harnest: expected[host] ?? bridge } });
      if (comments) {
        assert.match(installed, /^\/\/ keep this comment\r\n/);
        assert.match(installed, /\/\* keep this too \*\/\r\n/);
        assert.match(installed, /\/\/ keep the server note\r\n/);
      }
      assert.ok(await isPrivateInstallerFile(path));
      const files = await readdir(dirname(path));
      assert.equal(files.length, 2);
      const backup = join(dirname(path), files.find((file) => file.includes(".bak-harnest-")));
      assert.ok(await isPrivateInstallerFile(backup));
      assert.equal(await readFile(backup, "utf8"), prior);

      await cli(home, "setup", host, "--no-autostart");
      assert.deepEqual(await readdir(dirname(path)), files);
      assert.equal(await readFile(path, "utf8"), installed);
      const doctor = await cli(home, "doctor", "--host", host, "--project", home);
      assert.ok(doctor.stdout.includes(`lead-${host}: ok (stdio bridge, MCP catalog verified) ${path}`), doctor.stdout);

      await cli(home, "setup", "--restore", backup);
      assert.equal(await readFile(path, "utf8"), prior);
    });
  }

  await t.test("fresh setup prints a command that removes only Harnest", async (t) => {
    const cases = {
      ...jsonHosts,
      kilo: ["custom settings", "kilo", "kilo.json"],
      amp: ["custom settings", "amp", "settings.json"],
      cursor: [".cursor", "mcp.json"],
    };
    for (const [host, segments] of Object.entries(cases)) {
      await t.test(host, async () => {
        const home = join(fixture, "fresh " + host);
        const path = join(home, ...segments);
        const project = join(home, "workspace");
        const projectFlags = host === "cursor" ? ["--project", project] : [];
        const options = cliOptions(home, {
          XDG_CONFIG_HOME: join(home, "custom settings"),
        });
        const key = { kilo: "mcp", amp: "amp.mcpServers" }[host] ?? "mcpServers";
        const comments = ["qwen-code", "kilo", "auggie", "devin"].includes(host);
        await assert.rejects(readFile(path), { code: "ENOENT" });
        const { stdout } = await run(process.execPath, ["scripts/setup.mjs", host, ...projectFlags, "--no-autostart"], options);
        const installed = JSON.parse(await readFile(path, "utf8"));
        const entry = expected[host] ?? bridge;
        assert.deepEqual(installed, { [key]: { harnest: entry } });
        const prefix = "Reverse path: ";
        const outputLines = stdout.split(/\r?\n/);
        const reverseLines = outputLines.filter((line) => line.startsWith(prefix));
        assert.deepEqual(reverseLines, [`Reverse path: harnest setup remove ${host}`]);
        assert.equal(outputLines[outputLines.indexOf(reverseLines[0]) + 1],
          "Use the same config path environment variables you used for setup.");

        const other = { command: "other" };
        installed[key].other = other;
        installed.unrelated = true;
        const raw = JSON.stringify(installed, null, 2);
        const edited = comments ? raw.replace('    "other"', '    // keep this note\n    "other"') : raw;
        await writeFile(path, edited);
        const projectPath = join(project, ".cursor", "mcp.json");
        if (host === "cursor") await writeFile(projectPath, raw);

        const command = reverseLines[0].slice(prefix.length);
        const removed = await runShell(command, options);
        const updated = await readFile(path, "utf8");
        assert.deepEqual(comments ? parse(updated) : JSON.parse(updated), {
          [key]: { other }, unrelated: true,
        });
        if (comments) assert.match(updated, /\/\/ keep this note\n/);
        const { backup } = JSON.parse(removed.stdout);
        assert.equal(await readFile(backup, "utf8"), edited);
        assert.ok(await isPrivateInstallerFile(backup));
        assert.ok(await isPrivateInstallerFile(path));
        if (host === "cursor") assert.equal(await readFile(projectPath, "utf8"), raw);

        const files = await readdir(dirname(path));
        const secondRemoval = await runShell(command, options);
        const { status, message } = JSON.parse(secondRemoval.stdout);
        assert.equal(status, "already-absent");
        assert.equal(message, "The Harnest MCP entry is already absent.");
        assert.equal(await readFile(path, "utf8"), updated);
        assert.deepEqual(await readdir(dirname(path)), files);
      });
    }
    const { stdout } = await cli(fixture, "setup", "--help");
    assert.match(stdout, /harnest setup remove <host>/);
    await assert.rejects(cli(fixture, "setup", "remove", "goose"), /Removal is unsupported for host: goose/);
  });

  for (const [host, segments, marker] of [
    ["goose", ["config", "config.yaml"], "extensions:"],
    ["mistral-vibe", ["config.toml"], "[[mcp_servers]]"],
  ]) {
    await t.test(host + " prints manual setup", async () => {
      const home = join(fixture, host);
      const path = join(home, ...segments);
      await mkdir(dirname(path), { recursive: true });
      const prior = "# keep the existing configuration\n";
      await writeFile(path, prior);
      const variable = host === "goose" ? "GOOSE_PATH_ROOT" : "VIBE_HOME";
      env[variable] = home;
      try {
        const { stdout } = await cli(home, "setup", host, "--no-autostart");
        for (const value of [path, marker, "harnest", "stdio", "HARNEST_LOGIN_DAEMON_DIR", JSON.stringify(bridge.args[0])]) {
          assert.ok(stdout.includes(value), stdout);
        }
        assert.equal(await readFile(path, "utf8"), prior);
      } finally {
        delete env[variable];
      }
    });
  }
  const setupPresets = ACP_PRESETS.map(({ id }) => id).filter((id) => id !== "antigravity");
  assert.deepEqual([...Object.keys(jsonHosts), "goose", "mistral-vibe"].sort(), setupPresets.sort());
  await assert.rejects(cli(fixture, "setup", "antigravity", "--no-autostart"), /Usage: harnest setup/);
});

test("preset lead config honors user path overrides", () => {
  const home = join(tmpdir(), "harnest-paths");
  const custom = join(home, "custom");
  const cases = [
    ["github-copilot-cli", { COPILOT_HOME: custom }, join(custom, "mcp-config.json")],
    ["qwen-code", { QWEN_HOME: "~/custom" }, join(custom, "settings.json")],
    ["kilo", { XDG_CONFIG_HOME: custom }, join(custom, "kilo", "kilo.json")],
    ["kilo", { KILO_CONFIG: custom }, custom],
    ["cline", { CLINE_DIR: custom }, join(custom, "data", "settings", "cline_mcp_settings.json")],
    ["cline", { CLINE_DIR: home, CLINE_DATA_DIR: custom }, join(custom, "settings", "cline_mcp_settings.json")],
    ["cline", { CLINE_DATA_DIR: home, CLINE_MCP_SETTINGS_PATH: custom }, custom],
    ["kiro", { KIRO_HOME: custom }, join(custom, "settings", "mcp.json")],
    ["kiro", { KIRO_HOME: home }, join(home, ".kiro", "settings", "mcp.json")],
    ["kimi", { KIMI_SHARE_DIR: custom }, join(custom, "mcp.json")],
  ];
  for (const [host, env, path] of cases) assert.equal(bridgeHostConfig(host, home, env).path, path, host);
  assert.equal(bridgeHostConfig("devin", home, { APPDATA: custom }, "win32").path, join(custom, "devin", "mcp_config.json"));
  assert.equal(bridgeHostConfig("devin", home, {}, "darwin").path, join(home, ".config", "devin", "mcp_config.json"));
});

test("the JSONC installer retains trailing commas and rejects ambiguous MCP maps", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "harnest-preset-jsonc-"));
  t.after(() => rm(home, { recursive: true, force: true, maxRetries: 5 }));
  const path = join(home, "settings.json");
  const prior = '\ufeff{\n  // server list\n  "mcpServers": { "other": { "command": "other" }, },\n}\n';
  await writeFile(path, prior);
  await installJsonServer(path, "mcpServers", { command: "harnest" }, { format: "jsonc" });
  const installed = await readFile(path, "utf8");
  assert.match(installed, /^\ufeff\{\n  \/\/ server list/);
  assert.match(installed, /,\s*}\s*,\s*}\n$/);
  assert.deepEqual(parse(installed.slice(1), [], { allowTrailingComma: true }), {
    mcpServers: { other: { command: "other" }, harnest: { command: "harnest" } },
  });
  const alreadyConfigured = '{ "mcpServers": { "harnest": {"args": [], "command": "harnest"} } }\n';
  await writeFile(path, alreadyConfigured);
  const retained = await installJsonServer(path, "mcpServers", { command: "harnest", args: [] }, { format: "jsonc" });
  assert.equal(retained.backup, null);
  assert.equal(await readFile(path, "utf8"), alreadyConfigured);
  const duplicate = '{ "mcpServers": {}, "mcpServers": {} }';
  await writeFile(path, duplicate);
  await assert.rejects(installJsonServer(path, "mcpServers", { command: "harnest" }, { format: "jsonc" }), /Duplicate MCP configuration key/);
  assert.equal(await readFile(path, "utf8"), duplicate);
});
