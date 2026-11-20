import assert from "node:assert/strict";
import { exec, execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { startDaemon } from "../src/daemon.mjs";
import { createRuntimeServices } from "../src/runtime-services.mjs";
import { windowsSystemCommand } from "../src/launch-command.mjs";
import { setupCommand } from "../scripts/setup-command.mjs";
import { withHarnestOnPath } from "./fixtures/harnest-shell.mjs";

const run = promisify(execFile);
const shell = promisify(exec);
const windows = process.platform === "win32";
const checkout = fileURLToPath(new URL("..", import.meta.url));
const dispatcher = join(checkout, "scripts", "harnest.mjs");
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

test("dispatcher reports failures with a nonzero exit code", async () => {
  /** @type {[string[], RegExp][]} */
  const failures = [
    [["unknown-command"], /Usage: harnest <command>/],
    [["daemon", "unknown-command"], /Usage: harnest daemon start/],
    [["setup", "--restore", "invalid-backup"], /Expected a Harnest configuration backup/],
  ];
  for (const [args, message] of failures) {
    await assert.rejects(run(process.execPath, [dispatcher, ...args]), { code: 1, stdout: "", stderr: message });
  }
});

test("cmd.exe reverse commands quote spaces and omit paths with shell metacharacters", () => {
  const format = (path) => setupCommand("--restore", path, { platform: "win32", cli: true });
  assert.ok(format("C:\\host configs\\backup").includes('Reverse path (cmd.exe): harnest setup --restore "C:\\host configs\\backup"'));
  assert.ok(format("C:\\").includes('Reverse path (cmd.exe): harnest setup --restore "C:\\\\"'));
  for (const character of ["%TEMP%", "^", "&", "!"]) {
    const path = `C:\\host configs\\${character}\\backup`;
    const output = format(path);
    assert.ok(output.includes(`Reverse path (PowerShell): harnest setup --restore '${path}'`));
    assert.doesNotMatch(output, /Reverse path \(cmd\.exe\)/);
    assert.match(output, /Use the PowerShell reverse path/);
  }
});

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
  const cli = (args, overrides = {}) => run(process.execPath, [dispatcher, ...args], { ...options, ...overrides });
  const powershell = (text) =>
    run(windowsSystemCommand("powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", text], options);
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

  for (const [host, editConfig] of [["claude", false], ["codex", true], ["codex", false]]) {
    await t.test(host === "codex" && !editConfig ? "fresh untouched Codex config" : host, async () => {
      const dir = editConfig ? env.CODEX_HOME
        : host === "codex" ? join(home, "fresh codex home") : env.CLAUDE_CONFIG_DIR;
      await mkdir(dir, { recursive: true });
      const config = join(dir, "config.toml");
      const hostOptions = {
        ...options,
        env: { ...env, CODEX_HOME: dir, HARNEST_TEST_PLUGIN_DIR: dir, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` },
      };
      await assert.rejects(readFile(config), { code: "ENOENT" });
      const { stdout } = await shell(`harnest setup ${host} --no-autostart`, hostOptions);
      assert.equal(await readFile(join(dir, "installed"), "utf8"), "harnest@harnest-local");
      const unrelated =
        '[mcp_servers.keep]\ncommand = "other"\nnotes = """\n[mcp_servers.harnest]\nkeep this text\n"""\n';
      if (host === "codex") {
        const installed = await readFile(config, "utf8");
        assert.match(installed, /^\[mcp_servers.harnest\]/m);
        if (editConfig) await writeFile(config, "\uFEFF" + installed + "\n" + unrelated);
        assert.ok(await readFile(join(dir, "agents", "claude_worker.toml"), "utf8"));
      }
      const reverse = command(stdout);
      assert.equal(reverse, `harnest setup remove ${host}`);
      await shell(reverse, hostOptions);
      await assert.rejects(readFile(join(dir, "installed")), { code: "ENOENT" });
      await assert.rejects(readFile(join(dir, "marketplace")), { code: "ENOENT" });
      if (host === "codex") {
        if (editConfig) assert.equal(await readFile(config, "utf8"), "\uFEFF" + unrelated);
        else await assert.rejects(readFile(config), { code: "ENOENT" });
        await assert.rejects(readFile(join(dir, "agents", "claude_worker.toml")), { code: "ENOENT" });
      }
    });
  }

  await t.test("checkout setup prints a removal command that works without a global CLI", async () => {
    const checkoutOptions = { ...options, env: { ...env, XDG_CONFIG_HOME: join(home, "checkout config") } };
    const pathKey = Object.keys(checkoutOptions.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
    checkoutOptions.env[pathKey] = process.env[pathKey];
    const path = join(checkoutOptions.env.XDG_CONFIG_HOME, "amp", "settings.json");
    const { stdout } = await run("bun", ["run", "setup", "amp", "--no-autostart"], { ...checkoutOptions, cwd: checkout });
    const reverse = command(stdout, windows ? "Reverse path (cmd.exe)" : "Reverse path");
    assert.match(reverse, /^bun run --cwd .+ setup remove amp$/);
    assert.ok(JSON.parse(await readFile(path, "utf8"))["amp.mcpServers"].harnest);
    await shell(reverse, checkoutOptions);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8"))["amp.mcpServers"], {});
  });

  await t.test("Cursor reversal from a different directory includes both scopes after a repeat setup", async () => {
    const project = await realpath(await mkdtemp(join(home, "cursor workspace ")));
    const alias = join(home, "cursor workspace link");
    await symlink(project, alias, windows ? "junction" : "dir");
    const cursorDir = join(project, ".cursor");
    const userMcp = join(home, ".cursor", "mcp.json");
    const projectMcp = join(cursorDir, "mcp.json");
    const router = join(cursorDir, "rules", "harnest-router.mdc");
    const unrelated = { mcpServers: { keep: { command: "other" } } };
    await mkdir(dirname(userMcp));
    await mkdir(dirname(router), { recursive: true });
    await writeFile(userMcp, JSON.stringify(unrelated));
    await writeFile(projectMcp, JSON.stringify({
      mcpServers: { ...unrelated.mcpServers, harnest: { command: "old-bridge" } },
    }));
    await writeFile(router, "original router");
    const existing = join(cursorDir, "agents", "keep.md");
    await mkdir(dirname(existing));
    await writeFile(existing, "unrelated agent");
    const preexisting = join(cursorDir, "skills", "handoff", "SKILL.md");
    const skill = await readFile(join(checkout, "skills", "handoff", "SKILL.md"));
    await mkdir(dirname(preexisting), { recursive: true });
    await writeFile(preexisting, skill);

    const args = ["setup", "cursor", "--no-autostart"];
    const label = windows ? "Reverse path (cmd.exe)" : "Reverse path";
    const first = await cli([...args, "--project", alias]);
    assert.ok(first.stdout.includes(`Cursor project: ${project}`));
    assert.match(first.stdout, /"projectMcp":\s*\{/);
    const repeated = await cli(args, { cwd: project });
    assert.ok(repeated.stdout.includes(`Cursor project: ${project}`));
    assert.match(repeated.stdout, /"projectMcp":\s*\{[^}]*"backup": null/);
    const reverse = command(repeated.stdout, label);
    assert.equal(reverse, command(first.stdout, label));
    assert.match(reverse, /^harnest setup remove cursor --project /);
    assert.ok(JSON.parse(await readFile(userMcp, "utf8")).mcpServers.harnest);
    assert.notEqual(JSON.parse(await readFile(projectMcp, "utf8")).mcpServers.harnest.command, "old-bridge");
    const edited = join(cursorDir, "agents", "cursor-worker.md");
    await writeFile(edited, "edited worker");
    const removal = await shell(reverse, options);
    assert.deepEqual(JSON.parse(removal.stdout).project.preserved, ["agents/cursor-worker.md"]);
    const viaAlias = await cli(["setup", "remove", "cursor", "--project", alias]);
    assert.deepEqual(JSON.parse(viaAlias.stdout).project.preserved, ["agents/cursor-worker.md"]);
    const implicit = await cli(["setup", "remove", "cursor"], { cwd: project });
    assert.deepEqual(JSON.parse(implicit.stdout).project.preserved, ["agents/cursor-worker.md"]);
    assert.deepEqual(JSON.parse(await readFile(userMcp, "utf8")), unrelated);
    // The project already registered harnest before setup; undo restores that entry, not deletes it.
    assert.deepEqual(JSON.parse(await readFile(projectMcp, "utf8")), {
      mcpServers: { ...unrelated.mcpServers, harnest: { command: "old-bridge" } },
    });
    assert.equal(await readFile(router, "utf8"), "original router");
    assert.equal(await readFile(existing, "utf8"), "unrelated agent");
    assert.equal(await readFile(edited, "utf8"), "edited worker");
    assert.deepEqual(await readFile(preexisting), skill);
    assert.deepEqual(await readdir(join(dirname(preexisting), "references")).then(
      (files) => files.filter((name) => !name.includes(".bak-harnest-")),
    ), []);
    for (const file of ["commands/workflows.md", "skills/handoff/agents/openai.yaml"]) {
      await assert.rejects(readFile(join(cursorDir, file)), { code: "ENOENT" });
    }
  });

  await t.test("Cursor refuses an implicit project at home or a filesystem root", async () => {
    for (const cwd of [home, parse(home).root]) {
      await assert.rejects(cli(["setup", "cursor", "--no-autostart"], { cwd }), {
        code: 1, stderr: /home directory or a filesystem root by default.*--project/,
      });
    }
  });

  if (windows) {
    await t.test("PowerShell restores a literal path when cmd.exe would reinterpret it", async () => {
      const path = join(home, "config %TEMP% ^ & !", "host config.json");
      await mkdir(dirname(path), { recursive: true });
      const original = '{"mcpServers":{"keep":{"command":"other"}}}\n';
      await writeFile(path, original);
      const setup = await cli(["setup", "other", "--http-config", path, "--no-autostart"]);
      assert.doesNotMatch(setup.stdout, /Reverse path \(cmd\.exe\)/);
      assert.match(setup.stdout, /Use the PowerShell reverse path/);
      const prefix = "Reverse path (PowerShell): ";
      const restore = setup.stdout.split(/\r?\n/).find((line) => line.startsWith(prefix + "harnest setup --restore "));
      assert.ok(restore);
      const quote = (value) => "'" + value.replace(/['‘’]/gu, "$&$&") + "'";
      await powershell(`function harnest { & ${quote(process.execPath)} ${quote(dispatcher)} @args }; ${restore.slice(prefix.length)}; exit $LASTEXITCODE`);
      assert.equal(await readFile(path, "utf8"), original);
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
          ? powershell(text)
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
