import test from "node:test";
import assert from "node:assert/strict";
import { exec, execFile, execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { bridgeEntry, installHostConfig, restoreHostConfig } from "../scripts/install-host-config.mjs";
import { applyLoginEnvironment, loginItem, removeAutostart } from "../scripts/install-daemon.mjs";
import { daemonDirectory, jobStateDirectory } from "../src/daemon-settings.mjs";

const sid = "S-1-5-21-11-22-33-1001";

test("Cursor bridge keeps custom Linux XDG state when the host drops XDG_STATE_HOME", { skip: process.platform !== "linux" }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), "harnest-xdg-bridge-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const state = join(home, "custom state");
  const env = { ...process.env, HOME: home, XDG_STATE_HOME: state };
  for (const key of ["HARNEST_STATE_DIR", "HARNEST_LOGIN_DAEMON_DIR", "HARNEST_LOGIN_JOB_DIR"]) delete env[key];
  const installer = new URL("../scripts/install-host-config.mjs", import.meta.url).href;
  await promisify(execFile)(process.execPath, ["--input-type=module", "-e",
    'const { installHostConfig } = await import(process.argv[1]); await installHostConfig("cursor");', installer], { env });
  const config = JSON.parse(await readFile(join(home, ".cursor", "mcp.json"), "utf8"));
  const launchEnv = config.mcpServers.harnest.env;
  assert.deepEqual(launchEnv, {
    HARNEST_LOGIN_DAEMON_DIR: join(state, "harnest", "daemon"),
    HARNEST_LOGIN_JOB_DIR: join(state, "harnest", "jobs"),
  });
  assert.equal(daemonDirectory({ env: launchEnv, home }), join(state, "harnest", "daemon"));
  assert.equal(jobStateDirectory({ env: launchEnv, home }), join(state, "harnest", "jobs"));
});

test("Codex replaces the standalone stdio transport, preserves unrelated settings and restores prior bytes", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "harnest-config-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const codexHome = join(home, ".codex");
  await mkdir(codexHome);
  const path = join(codexHome, "config.toml");
  const original = `model = "keep"
[mcp_servers.harnest]
command = "node"
args = [
  "src/mcp-server.mjs",
]
tool_timeout_sec = 55
[mcp_servers.harnest.env]
OLD_SETTING = "old"
[mcp_servers.other]
command = "other"
`;
  await writeFile(path, original);
  const options = { home, codexHome };
  const result = await installHostConfig("codex", options);
  const current = await readFile(path, "utf8");
  assert.match(current, /model = "keep"/);
  assert.match(current, /\[mcp_servers\.other\]\ncommand = "other"/);
  const bridge = bridgeEntry();
  assert.ok(current.includes("[mcp_servers.harnest]\ncommand = " + JSON.stringify(bridge.command) + "\nargs = " + JSON.stringify(bridge.args)));
  assert.match(current, /tool_timeout_sec = 55/);
  assert.doesNotMatch(current, /mcp-server\.mjs|OLD_SETTING/);
  assert.equal((await installHostConfig("codex", options)).backup, null);
  assert.equal(await readFile(result.backup, "utf8"), original);
  await restoreHostConfig(result.backup);
  assert.equal(await readFile(path, "utf8"), original);
});

test("Claude resolves its HTTP headers helper from an unrelated project and Codex has no bundled server", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "harnest-helper-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pluginRoot = join(directory, "plugin root");
  const project = join(directory, "unrelated project");
  await mkdir(join(pluginRoot, "scripts"), { recursive: true });
  await mkdir(project);
  await writeFile(join(pluginRoot, "scripts", "claude-mcp-headers.mjs"), 'console.log(JSON.stringify({ fixture: "helper-ran" }));');
  const read = async (relative) => JSON.parse(await readFile(new URL(relative, import.meta.url), "utf8"));
  for (const path of ["../.mcp.json", "../mcp.json"]) {
    const { mcpServers } = await read(path);
    const command = mcpServers.harnest.headersHelper.replace("${CLAUDE_PLUGIN_ROOT}", () => pluginRoot);
    const { stdout } = await promisify(exec)(command, { cwd: project });
    assert.deepEqual(JSON.parse(stdout), { fixture: "helper-ran" });
    assert.deepEqual(mcpServers.harnest, {
      type: "http", url: "http://127.0.0.1:41237/mcp", headersHelper: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/claude-mcp-headers.mjs"',
    });
  }
  assert.deepEqual((await read("../.codex-plugin/plugin.json")).mcpServers, {});
  const { hooks } = await read("../hooks/hooks.json");
  for (const kind of ["PreToolUse", "PostToolUse"]) {
    const applies = new RegExp(hooks[kind][0].matcher);
    assert.ok(applies.test("mcp__plugin_harnest_harnest__handoff_workflow"));
    assert.ok(applies.test("mcp__harnest__handoff_workflow"));
  }
});

test("login item uses user launch mechanisms and works with paths containing spaces", () => {
  const task = loginItem("win32", { sid, exe: "C:\\Program Files\\Node & Tools\\node.exe" });
  assert.match(task.content, /<LogonTrigger><UserId>S-1-5-21-11-22-33-1001<\/UserId>/);
  assert.match(task.content, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.ok(task.content.includes("<Command>C:\\Program Files\\Node &amp; Tools\\node.exe</Command>"));
  assert.match(task.content, /<Arguments>&quot;.+daemon\.mjs&quot; start --login-env [\w+/=]+<\/Arguments>/);
  const mac = loginItem("darwin", { home: "/Users/Example User", exe: "/Node & Tools/node" });
  assert.match(mac.path, /LaunchAgents/);
  assert.match(mac.content, /<string>\/Node &amp; Tools\/node<\/string>/);
  assert.match(mac.content, /<key>RunAtLoad<\/key><true\/>/);
  const linux = loginItem("linux", { home: "/home/example", exe: "/Node Tools/node" });
  assert.match(linux.path, /systemd[\\/]user[\\/]harnest\.service$/);
  assert.match(linux.content, /ExecStart="\/Node Tools\/node" ".+daemon\.mjs"/);
});

test("#35 Windows login item preserves literal percent variables in both executable paths", () => {
  const exe = "C:\\Node %USERPROFILE% & Tools\\node.exe";
  const windowsLauncher = "C:\\checkout %PATH% & O'Brien\\scripts\\daemon.mjs";
  const { content } = loginItem("win32", { sid, exe, windowsLauncher, env: { windir: "C:\\Windows" } });
  assert.doesNotMatch(content, /%USERPROFILE%|%PATH%/);
  assert.ok(content.includes("<Command>C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe</Command>"));
  const [, encoded] = content.match(/-EncodedCommand ([\w+/=]+)<\/Arguments>/);
  const command = Buffer.from(encoded, "base64").toString("utf16le");
  assert.ok(command.includes(`'${exe}'`));
  assert.ok(command.includes(`'${windowsLauncher.replaceAll("'", "''")}'`));
  assert.match(command, / start --login-env [\w+/=]+/);
});

test("Windows executes the encoded login command from a checkout with percent variables", {
  skip: process.platform !== "win32",
}, async (t) => {
  const home = await mkdtemp(join(tmpdir(), "harnest-task-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const checkout = join(home, "checkout %USERNAME% & O'Brien");
  const exe = join(checkout, "node.exe");
  const windowsLauncher = join(checkout, "daemon.mjs");
  await mkdir(checkout);
  await copyFile(process.execPath, exe);
  await writeFile(windowsLauncher, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
  const env = { SystemRoot: process.env.SystemRoot, windir: process.env.windir, HARNEST_PI: "fixture" };
  const { content } = loginItem("win32", { home, sid, exe, windowsLauncher, env });
  const [, command] = content.match(/<Command>([^<]+)<\/Command>/);
  const [, args] = content.match(/<Arguments>([^<]+)<\/Arguments>/);
  const output = execFileSync(command, args.split(" "), { encoding: "utf8", windowsHide: true });
  const [start, loginFlag, encoded] = JSON.parse(output);
  assert.deepEqual([start, loginFlag], ["start", "--login-env"]);
  const loginEnv = {};
  applyLoginEnvironment(encoded, loginEnv);
  assert.equal(loginEnv.HARNEST_PI, "fixture");
});

test("login items round-trip only allowlisted settings and preserve both state directories", () => {
  const env = {
    PATH: 'C:\\Node & Tools;"<bin>";%USERPROFILE%;$HOME',
    HARNEST_PI: "pi-custom",
    HARNEST_MCP_BEARER_TOKEN: "fixture-bearer",
    HARNEST_API_KEY: "fixture-key",
    HARNEST_CREDENTIALS: "fixture-credentials",
    OPENAI_API_KEY: "fixture-provider-key",
    HARNEST_DAEMON_FIXTURE_PORT: "1234",
  };
  const entities = { "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": '"', "&apos;": "'" };
  const home = resolve("fixture home");
  for (const platform of ["win32", "darwin", "linux"]) {
    for (const stateDir of [undefined, join("fixture state", "custom jobs")]) {
      const installEnv = { ...env, HARNEST_STATE_DIR: stateDir };
      const { content } = loginItem(platform, { env: installEnv, home, sid });
      const expected = {
        PATH: env.PATH,
        HARNEST_PI: env.HARNEST_PI,
        HARNEST_LOGIN_JOB_DIR: resolve(jobStateDirectory({ env: installEnv, platform, home })),
        HARNEST_LOGIN_DAEMON_DIR: resolve(daemonDirectory({ env: installEnv, platform, home })),
        ...(stateDir && { HARNEST_STATE_DIR: resolve(stateDir) }),
      };
      let loginEnv;
      if (platform === "win32") {
        const [, encoded] = content.match(/--login-env ([\w+/=]+)<\/Arguments>/);
        assert.deepEqual(JSON.parse(Buffer.from(encoded, "base64").toString("utf8")), expected);
        loginEnv = {};
        applyLoginEnvironment(encoded, loginEnv);
      } else if (platform === "darwin") {
        const [, variables] = content.match(/<key>EnvironmentVariables<\/key><dict>([\s\S]*?)<\/dict>/);
        assert.ok(variables.includes("C:\\Node &amp; Tools;&quot;&lt;bin&gt;&quot;"));
        loginEnv = Object.fromEntries(Array.from(variables.matchAll(/<key>(\w+)<\/key><string>(.*?)<\/string>/g),
          ([, name, value]) => [name, value.replace(/&(?:lt|gt|amp|quot|apos);/g, (entity) => entities[entity])]));
      } else {
        assert.ok(content.includes('%%USERPROFILE%%;$HOME'));
        loginEnv = Object.fromEntries(Array.from(content.matchAll(/^Environment=(.+)$/gm), ([, assignment]) => {
          const [name, ...value] = JSON.parse(assignment).split("=");
          return [name, value.join("=").replaceAll("%%", "%")];
        }));
      }
      assert.deepEqual(loginEnv, expected);
      assert.doesNotMatch(content, /HARNEST_MCP_BEARER_TOKEN|HARNEST_CREDENTIALS|API_KEY|fixture-bearer|fixture-key/);
      const login = { env: loginEnv, platform, home: resolve("different login home") };
      assert.equal(jobStateDirectory(login), expected.HARNEST_LOGIN_JOB_DIR);
      assert.equal(daemonDirectory(login), expected.HARNEST_LOGIN_DAEMON_DIR);
    }
  }
});

test("uninstall removes only the registered login item on each platform", async () => {
  const home = resolve("fixture home");
  const env = { XDG_CONFIG_HOME: join(home, "custom config"), SystemRoot: "C:\\Windows" };
  const cases = {
    win32: [
      ["C:\\Windows\\System32\\whoami.exe", "/user", "/fo", "csv", "/nh"],
      ["C:\\Windows\\System32\\schtasks.exe", "/delete", "/tn", `Harnest-${sid}`, "/f"],
    ],
    darwin: [
      ["launchctl", "print", "gui/501/com.harnest.daemon"],
      ["launchctl", "bootout", "gui/501/com.harnest.daemon"],
      ["unlink", join(home, "Library", "LaunchAgents", "com.harnest.daemon.plist")],
    ],
    linux: [
      ["systemctl", "--user", "disable", "harnest.service"],
      ["unlink", join(env.XDG_CONFIG_HOME, "systemd", "user", "harnest.service")],
      ["systemctl", "--user", "daemon-reload"],
    ],
  };
  for (const [platform, expected] of Object.entries(cases)) {
    const calls = [];
    await removeAutostart({
      platform, home, env, uid: 501,
      execute(command, args) { calls.push([command, ...args]); return `"Example User","${sid}"`; },
      async removeFile(path) { calls.push(["unlink", path]); },
    });
    assert.deepEqual(calls, expected);
  }
});

test("Pi installer backs up the extension and bakes the daemon client link", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "harnest-pi-daemon-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const extensions = join(home, ".pi", "agent", "extensions");
    await mkdir(extensions, { recursive: true });
    const original = "// prior Pi extension\n";
    await writeFile(join(extensions, "harnest.mjs"), original);
    const installer = await import(`../scripts/install-pi-integration.mjs?fixture=${Date.now()}`);
    const result = await installer.installPiIntegration();
    const source = await readFile(result.extensionPath, "utf8");
    assert.match(source, /src\/daemon-client\.mjs/);
    assert.doesNotMatch(source, /__HARNEST_[A-Z_]+__|src\/companion\.mjs/);
    const backup = (await readdir(extensions)).find((file) => file.startsWith("harnest.mjs.bak-harnest-"));
    await restoreHostConfig(join(extensions, backup));
    assert.equal(await readFile(result.extensionPath, "utf8"), original);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
