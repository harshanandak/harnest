import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { windowsSystemCommand } from "../src/launch-command.mjs";

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
  assert.match(stdout, /^codex-workers: ok \(\d+ workers, high effort\)$/m);
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
  // Node needs the real SystemRoot to start, so the child installs the decoy after startup.
  const { stdout } = await exec(process.execPath, ["--input-type=module", "-e", `
for (const key of Object.keys(process.env)) if (/^(systemroot|windir)$/i.test(key)) delete process.env[key];
process.env.SystemRoot = process.env.windir = process.argv[2];
const { windowsSystemCommand } = await import(process.argv[1]);
console.log(windowsSystemCommand("taskkill.exe"));
`, launchCommand, cwd], { timeout: 5000 });
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
