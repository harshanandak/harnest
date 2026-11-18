import assert from "node:assert/strict";
import childProcess, { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { windowsSystemCommand } from "../src/launch-command.mjs";
import { terminateProcessTree } from "../src/process.mjs";

const exec = promisify(execFile);
const windows = process.platform === "win32";
const doctor = fileURLToPath(new URL("../scripts/doctor.mjs", import.meta.url));
const processModule = new URL("../src/process.mjs", import.meta.url).href;

async function probeDirectory(t) {
  const cwd = await mkdtemp(join(tmpdir(), "harnest-native-probe-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

test("doctor uses the installed Codex for plugin diagnostics and never runs the cwd decoy", async (t) => {
  const cwd = await probeDirectory(t);
  const install = join(cwd, "installed bin");
  const marker = join(cwd, "codex-decoy-ran");
  const trustedMarker = join(cwd, "codex-plugins-checked");
  await mkdir(install);
  if (windows) {
    await copyFile(process.execPath, join(cwd, "codex.exe"));
    await writeFile(join(cwd, "plugin"), 'require("node:fs").writeFileSync("codex-decoy-ran", "ran");\n');
    await writeFile(join(install, "codex.cmd"), "@ECHO off\n");
    const bin = join(install, "node_modules", "@openai", "codex", "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "codex.js"), `
if (process.argv[2] === "--version") console.log("trusted Codex version");
else if (process.argv.slice(2).join(" ") === "plugin list") require("node:fs").writeFileSync("codex-plugins-checked", "ran");
else process.exitCode = 1;
`);
  } else {
    await writeFile(join(cwd, "codex"), '#!/bin/sh\nprintf ran > codex-decoy-ran\n', { mode: 0o755 });
    await writeFile(join(install, "codex"), `#!/bin/sh
case "$*" in
  --version) echo "trusted Codex version" ;;
  "plugin list") printf ran > codex-plugins-checked ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  }
  const { stdout } = await exec(process.execPath, [doctor], {
    cwd,
    timeout: 20_000,
    env: {
      PATH: [".", install].join(delimiter),
      HOME: cwd,
      USERPROFILE: cwd,
      LOCALAPPDATA: cwd,
      HARNEST_STATE_DIR: join(cwd, "jobs"),
      ...(windows && { SystemRoot: process.env.SystemRoot, PATHEXT: ".EXE" }),
    },
  });

  assert.equal(existsSync(marker), false, "the Codex executable in the doctor cwd ran");
  assert.equal(existsSync(trustedMarker), true, "the installed Codex must run plugin list");
  assert.match(stdout, /^codex: trusted Codex version /m);
  assert.match(stdout, /^marketplace-isolation: ok /m);
});

test("Windows system commands require a fully qualified root and fall back to windir", () => {
  assert.equal(
    windowsSystemCommand("taskkill.exe", { SystemRoot: "D:\\Windows", windir: "C:\\Windows" }),
    "D:\\Windows\\System32\\taskkill.exe",
  );
  assert.equal(
    windowsSystemCommand("powershell.exe", { windir: "C:\\Windows" }),
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  );
  for (const env of [{}, { SystemRoot: "Windows" }, { SystemRoot: "\\Windows" }, { windir: "C:Windows" }]) {
    assert.throws(() => windowsSystemCommand("taskkill.exe", env), /fully qualified Windows path/);
  }
});

test("Windows system commands prefer the OS directory to SystemRoot", { skip: !windows }, async (t) => {
  const cwd = await probeDirectory(t);
  const launchCommand = new URL("../src/launch-command.mjs", import.meta.url).href;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(systemroot|windir)$/i.test(key)));
  env.SystemRoot = env.windir = cwd;
  const { stdout } = await exec(process.execPath, ["--input-type=module", "-e", `
const { windowsSystemCommand } = await import(process.argv[1]);
console.log(windowsSystemCommand("taskkill.exe"));
`, launchCommand], { env, timeout: 5000 });
  assert.equal(stdout.trim().toLowerCase(), join(process.env.SystemRoot, "System32", "taskkill.exe").toLowerCase());
});

test("Windows process cleanup never runs taskkill.exe from the cwd", { skip: !windows }, async (t) => {
  const cwd = await probeDirectory(t);
  const marker = join(cwd, "taskkill-decoy-ran");
  await copyFile(process.execPath, join(cwd, "taskkill.exe"));
  const preload = `
import { writeFileSync } from "node:fs";
import { basename } from "node:path";
if (basename(process.execPath).toLowerCase() === "taskkill.exe") {
  writeFileSync(${JSON.stringify(marker)}, "ran");
}
`;
  const script = `
import { spawn } from "node:child_process";
import { once } from "node:events";
import { terminateProcessTree } from ${JSON.stringify(processModule)};
const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 3000)"], { stdio: "ignore" });
await once(child, "spawn");
const closed = once(child, "close");
terminateProcessTree(child);
console.log(JSON.stringify(await closed));
`;
  const { stdout } = await exec(process.execPath, ["--input-type=module", "-e", script], {
    cwd,
    timeout: 10_000,
    env: {
      SystemRoot: process.env.SystemRoot,
      PATH: [".", join(process.env.SystemRoot, "System32")].join(delimiter),
      NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(preload)}`,
    },
  });

  assert.equal(existsSync(marker), false, "the taskkill.exe executable in the cleanup cwd ran");
  assert.notDeepEqual(JSON.parse(stdout), [0, null], "cleanup must stop the child before it exits naturally");
});

test("Windows cleanup stops a grandchild when taskkill cannot launch", { skip: !windows, timeout: 20_000 }, async (t) => {
  const cwd = await probeDirectory(t);
  const child = spawn(process.execPath, ["-e", `
const { spawn } = require("node:child_process");
// Node's Windows job object would automatically terminate a non-detached child.
const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { detached: true, stdio: "ignore" });
grandchild.once("spawn", () => process.send(grandchild.pid));
`], { stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true });
  const closed = once(child, "close");
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  const [grandchildPid] = await once(child, "message");
  let grandchildStopped = false;
  t.after(() => {
    if (grandchildStopped) return;
    try { process.kill(grandchildPid); } catch (error) { if (error.code !== "ESRCH") throw error; }
  });
  process.kill(grandchildPid, 0);

  const spawnProcess = childProcess.spawn;
  const taskkill = windowsSystemCommand("taskkill.exe");
  let taskkillAttempts = 0;
  const intercepted = t.mock.method(childProcess, "spawn", (command, args, options) => {
    if (command === taskkill) {
      assert.deepEqual(args, ["/PID", String(child.pid), "/T", "/F"]);
      taskkillAttempts++;
      command = join(cwd, "missing-taskkill.exe");
    }
    return spawnProcess(command, args, options);
  });
  syncBuiltinESMExports();
  t.after(() => { intercepted.mock.restore(); syncBuiltinESMExports(); });

  terminateProcessTree(child);
  await closed;
  assert.equal(taskkillAttempts, 1);
  for (let attempt = 0; attempt < 80; attempt++) {
    try { process.kill(grandchildPid, 0); }
    catch (error) {
      if (error.code === "ESRCH") {
        grandchildStopped = true;
        return;
      }
      throw error;
    }
    await delay(100);
  }
  assert.fail("grandchild survived Windows cleanup after taskkill failed to launch");
});
