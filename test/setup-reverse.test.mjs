import assert from "node:assert/strict";
import { exec, execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { startDaemon } from "../src/daemon.mjs";
import { createRuntimeServices } from "../src/runtime-services.mjs";
import { windowsSystemCommand } from "../src/launch-command.mjs";
import { withHarnestOnPath } from "./fixtures/harnest-shell.mjs";

const run = promisify(execFile);
const shell = promisify(exec);
const windows = process.platform === "win32";
const fakePlugin = `
  import { existsSync, writeFileSync, unlinkSync } from "node:fs";
  import { join } from "node:path";
  const [plugin, action, object, value] = process.argv.slice(1);
  const dir = process.env.HARNEST_TEST_PLUGIN_DIR;
  const marketplace = join(dir, "marketplace");
  const installed = join(dir, "installed");
  if (plugin !== "plugin") process.exit(1);
  if (action === "marketplace" && object === "add" && existsSync(value)) writeFileSync(marketplace, value);
  else if (action === "marketplace" && object === "remove" && value === "harnest-local" && !existsSync(installed)) unlinkSync(marketplace);
  else if (object === "harnest@harnest-local" && existsSync(marketplace)) {
    if (action === "add" || action === "install") writeFileSync(installed, object);
    else if (action === "remove" || action === "uninstall") unlinkSync(installed);
    else process.exit(1);
  } else process.exit(1);
`;

function command(stdout, label = "Reverse path") {
  const prefix = label + ": ";
  const line = stdout.split(/\r?\n/).find((value) => value.startsWith(prefix));
  assert.ok(line, `Missing ${label}`);
  return line.slice(prefix.length);
}

test("printed setup reversal works from a different directory", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "harnest reversal "));
  const stateDir = join(home, "jobs");
  const daemonDir = join(home, "daemon");
  let daemon;
  t.after(async () => {
    await daemon?.close();
    await rm(home, { recursive: true, force: true, maxRetries: 5 });
  });
  daemon = await startDaemon({
    port: 0,
    directory: daemonDir,
    buildServices: () => createRuntimeServices({ stateDir }),
  });
  const env = await withHarnestOnPath(join(home, "bin"), {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: join(home, "local"),
    XDG_CONFIG_HOME: join(home, "config with $ and ' spaces"),
    HARNEST_STATE_DIR: stateDir,
    HARNEST_LOGIN_DAEMON_DIR: daemonDir,
    HARNEST_LOGIN_JOB_DIR: stateDir,
    HARNEST_DAEMON_FIXTURE_PORT: String(daemon.port),
    HARNEST_CLAUDE: process.execPath,
    HARNEST_CODEX: process.execPath,
    CODEX_HOME: join(home, "codex home"),
    CLAUDE_CONFIG_DIR: join(home, "claude home"),
    PI_CODING_AGENT_DIR: join(home, "pi home"),
  });
  const options = { cwd: home, env, timeout: 35_000, windowsHide: true };
  const preload = join(home, "fake-plugin.mjs");
  await writeFile(
    preload,
    `
    import childProcess from "node:child_process";
    import { syncBuiltinESMExports } from "node:module";
    const { spawn } = childProcess;
    childProcess.spawn = (exe, args, options) => args[0] === "plugin" && exe === process.execPath
      ? spawn(exe, ["--input-type=module", "-e", ${JSON.stringify(fakePlugin)}, ...args], options)
      : spawn(exe, args, options);
    syncBuiltinESMExports();
  `,
  );

  for (const host of ["claude", "codex"]) {
    await t.test(host, async () => {
      const dir = env[host === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"];
      await mkdir(dir, { recursive: true });
      const config = join(dir, "config.toml");
      const hostOptions = {
        ...options,
        env: { ...env, HARNEST_TEST_PLUGIN_DIR: dir, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` },
      };
      await assert.rejects(readFile(config), { code: "ENOENT" });
      const { stdout } = await shell(`harnest setup ${host} --no-autostart`, hostOptions);
      assert.equal(await readFile(join(dir, "installed"), "utf8"), "harnest@harnest-local");
      const unrelated =
        '[mcp_servers.keep]\ncommand = "other"\nnotes = """\n[mcp_servers.harnest]\nkeep this text\n"""\n';
      if (host === "codex") {
        const installed = await readFile(config, "utf8");
        assert.match(installed, /^\[mcp_servers.harnest\]/m);
        await writeFile(config, "\uFEFF" + installed + "\n" + unrelated);
        assert.ok(await readFile(join(dir, "agents", "claude_worker.toml"), "utf8"));
      }
      const reverse = command(stdout);
      assert.equal(reverse, `harnest setup remove ${host}`);
      await shell(reverse, hostOptions);
      await assert.rejects(readFile(join(dir, "installed")), { code: "ENOENT" });
      await assert.rejects(readFile(join(dir, "marketplace")), { code: "ENOENT" });
      if (host === "codex") {
        assert.equal(await readFile(config, "utf8"), "\uFEFF" + unrelated);
        await assert.rejects(readFile(join(dir, "agents", "claude_worker.toml")), { code: "ENOENT" });
      }
    });
  }

  await t.test("Pi unregisters the extension and stops auto-loading it", async () => {
    const dir = env.PI_CODING_AGENT_DIR;
    const extension = join(dir, "extensions", "harnest.mjs");
    const settings = join(dir, "settings.json");
    const { stdout } = await shell("harnest setup pi --no-autostart", options);
    assert.ok(await readFile(extension, "utf8"));
    assert.deepEqual(JSON.parse(await readFile(settings, "utf8")), { extensions: [extension] });
    await writeFile(settings, JSON.stringify({ extensions: [extension, "keep.mjs"], theme: "keep" }));
    const reverse = command(stdout);
    assert.equal(reverse, "harnest setup remove pi");
    await shell(reverse, options);
    assert.deepEqual(JSON.parse(await readFile(settings, "utf8")), { extensions: ["keep.mjs"], theme: "keep" });
    await assert.rejects(readFile(extension), { code: "ENOENT" });
    await assert.rejects(readFile(join(dir, "skills", "handoff", "SKILL.md")), { code: "ENOENT" });
    assert.deepEqual(JSON.parse((await shell(reverse, options)).stdout), { backups: [] });
  });

  const shells = windows ? ["PowerShell", "cmd.exe"] : ["POSIX"];
  for (const name of shells) {
    await t.test(`quoted restore via ${name}`, async () => {
      const paste = (text) =>
        name === "PowerShell"
          ? run(windowsSystemCommand("powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", text], options)
          : shell(text, options);
      const path = join(env.XDG_CONFIG_HOME, name, "host config.json");
      await mkdir(dirname(path), { recursive: true });
      const original = '{"mcpServers":{"keep":{"command":"other"}}}\n';
      await writeFile(path, original);
      const { stdout } = await shell(`harnest setup other --http-config "${path}" --no-autostart`, options);
      const label = windows ? `Reverse path (${name})` : "Reverse path";
      const commands = stdout.split(/\r?\n/).filter((line) => line.startsWith(label + ": "));
      const restore = commands.find((line) => line.includes("harnest setup --restore "));
      assert.ok(restore, `Missing restore command for ${name}`);
      await paste(restore.slice(label.length + 2));
      assert.equal(await readFile(path, "utf8"), original);

      const openCode = await shell("harnest setup opencode --no-autostart", options);
      const reverse = command(openCode.stdout, label);
      const repeated = await shell("harnest setup opencode --no-autostart", options);
      assert.equal(command(repeated.stdout, label), reverse);
      await paste(reverse);
      await assert.rejects(readFile(join(env.XDG_CONFIG_HOME, "opencode", "opencode.json")), { code: "ENOENT" });
    });
  }
});
