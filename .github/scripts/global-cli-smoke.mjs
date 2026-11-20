import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repo = resolve(import.meta.dirname, "../..");
const { name, version } = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
const fixture = realpathSync(mkdtempSync(join(tmpdir(), "harnest global ")));
const prefix = join(fixture, ".bun");
const bin = join(prefix, "bin");
const globalDir = join(prefix, "install", "global");
const install = join(globalDir, "node_modules", name);
const windows = process.platform === "win32";
const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
const env = {
  ...process.env,
  HOME: fixture,
  USERPROFILE: fixture,
  XDG_CONFIG_HOME: join(fixture, "config"),
  LOCALAPPDATA: join(fixture, "local"),
  BUN_INSTALL: prefix,
  BUN_INSTALL_GLOBAL_DIR: globalDir,
  BUN_INSTALL_BIN: bin,
  BUN_INSTALL_CACHE_DIR: join(fixture, "cache"),
  HARNEST_STATE_DIR: join(fixture, "jobs"),
  HARNEST_LOGIN_DAEMON_DIR: join(fixture, "daemon"),
  HARNEST_LOGIN_JOB_DIR: join(fixture, "jobs"),
  [pathKey]: bin + delimiter + process.env[pathKey],
};
const run = (file, args, cwd = fixture) => execFileSync(file, args, { cwd, env, encoding: "utf8", windowsHide: true });
const cli = (...args) => run(join(bin, windows ? "harnest.exe" : "harnest"), args);

async function checkInstall(source) {
  for (const asset of [
    ".claude-plugin/marketplace.json",
    ".codex-plugin/plugin.json",
    ".agents/plugins/marketplace.json",
    ".mcp.json",
    ".cursor/commands/workflows.md",
    "codex-agents/acp_worker.toml",
    "pi-extension/harnest.mjs",
  ]) {
    assert.ok(existsSync(join(install, asset)), `Global install is missing ${asset}`);
  }
  assert.equal(cli("--version").trim(), version);
  assert.match(cli("--help"), /Usage: harnest <command>/);
  assert.match(cli("setup", "--help"), /harnest setup remove/);
  assert.match(cli("doctor", "--help"), /Usage: harnest doctor/);
  assert.match(cli("routing", "setup", "--help"), /Usage: harnest routing setup/);

  const bridge = JSON.parse(cli("setup", "other")).mcpServers.harnest;
  assert.match(bridge.command, /[/\\]node(?:\.exe)?$/i);
  assert.deepEqual(bridge.args, [join(install, "src", "mcp-bridge.mjs")]);
  assert.ok(existsSync(bridge.args[0]));

  const { loginItem } = await import(pathToFileURL(join(install, "scripts", "install-daemon.mjs")).href + "?" + source);
  const login = loginItem(process.platform, { home: fixture, env, sid: "S-1-5-21-1000" });
  const launcher = windows ? join(install, "scripts", "daemon.mjs") : join(install, "src", "daemon.mjs");
  assert.ok(existsSync(launcher));
  assert.ok(login.content.includes(process.platform === "linux" ? JSON.stringify(launcher) : launcher));
  return { bridge, login, launcher };
}

try {
  mkdirSync(env.XDG_CONFIG_HOME, { recursive: true });
  run("bun", ["pm", "pack", "--destination", fixture], repo);
  run("bun", ["add", "-g", "--omit", "optional", join(fixture, `${name}-${version}.tgz`)]);
  const before = await checkInstall("packed");

  // Reinstall from the same GitHub identifier documented for users, pinned to the code under test.
  // Removing the old launcher makes the test prove that Bun replaced the installed files.
  unlinkSync(before.launcher);
  run("bun", [
    "add",
    "-g",
    "--omit",
    "optional",
    `github:${process.env.HARNEST_INSTALL_REPO}#${process.env.HARNEST_INSTALL_REVISION}`,
  ]);
  assert.deepEqual(await checkInstall("github"), before);
  console.log("Global Harnest CLI, package files and launcher paths verified.");
} finally {
  rmSync(fixture, { recursive: true, force: true, maxRetries: 5 });
}
