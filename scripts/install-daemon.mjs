import { execFileSync } from "node:child_process";
import { unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { ensureDaemon } from "../src/daemon-client.mjs";
import { withoutHarnestToken } from "../src/daemon-env.mjs";
import { daemonDirectory, jobStateDirectory } from "../src/daemon-settings.mjs";
import { NativeLaunchError, requireNativeCommand, windowsSystemCommand } from "../src/launch-command.mjs";
import { readExisting, replaceWithBackup } from "./install-files.mjs";

const daemon = fileURLToPath(new URL("../src/daemon.mjs", import.meta.url));
const launcher = fileURLToPath(new URL("./daemon.mjs", import.meta.url));
const label = "com.harnest.daemon";
const unit = "harnest.service";
const xml = (value) => value.replace(/[<>&"'\r]/g, (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;", "\r": "&#13;" })[char]);
const systemdQuote = (value) => JSON.stringify(value.replaceAll("%", "%%"));
const powershellQuote = (value) => `'${value.replace(/['‘’]/gu, "$&$&")}'`;

const runtimeSettings = [
  "PATH", "HARNEST_STATE_DIR", "HARNEST_LOGIN_JOB_DIR", "HARNEST_LOGIN_DAEMON_DIR",
  "HARNEST_AMP", "HARNEST_CLAUDE", "HARNEST_CODEX", "HARNEST_CURSOR",
  "HARNEST_OPENCODE_V2", "HARNEST_PI",
  "HARNEST_ROUTER", "HARNEST_ROUTING_POLICY", "HARNEST_ROUTE_RESOLVER", "HARNEST_WORKER_ADAPTER",
  "HARNEST_DYNAMIC_ENGINE", "HARNEST_DYNAMIC_POLL_MS", "HARNEST_DYNAMIC_HEARTBEAT_MS", "HARNEST_DYNAMIC_LEASE_MS",
];

function allowedSettings(env) {
  return Object.fromEntries(runtimeSettings
    .filter((name) => typeof env[name] === "string")
    .map((name) => [name, env[name]]));
}

export function applyLoginEnvironment(encoded, env = process.env) {
  Object.assign(env, allowedSettings(JSON.parse(Buffer.from(encoded, "base64").toString("utf8"))));
}

function loginItemTarget(platform, { home, sid, env }) {
  if (platform === "win32") {
    if (!/^S-1-(?:\d+-)+\d+$/i.test(sid)) throw new Error("Could not determine the current Windows user SID");
    return `Harnest-${sid}`;
  }
  if (platform === "darwin") return join(home, "Library", "LaunchAgents", `${label}.plist`);
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "systemd", "user", unit);
}

export function loginItem(platform, {
  home = homedir(), exe = process.execPath, sid, env = process.env, windowsLauncher = launcher,
} = {}) {
  const target = loginItemTarget(platform, { home, sid, env });
  const settings = allowedSettings(env);
  // The default job and token directories need not be siblings.
  settings.HARNEST_LOGIN_JOB_DIR = resolve(jobStateDirectory({ platform, home, env }));
  settings.HARNEST_LOGIN_DAEMON_DIR = resolve(daemonDirectory({ platform, home, env }));
  if (env.HARNEST_STATE_DIR) settings.HARNEST_STATE_DIR = resolve(env.HARNEST_STATE_DIR);
  if (platform === "win32") {
    const encoded = Buffer.from(JSON.stringify(settings)).toString("base64");
    let command = exe;
    let args = `"${windowsLauncher}" start --login-env ${encoded}`;
    // Task Scheduler expands percent variables before launch. Decode literal paths inside PowerShell.
    if (exe.includes("%") || windowsLauncher.includes("%")) {
      command = windowsSystemCommand("powershell.exe", env);
      const script = `$ErrorActionPreference = 'Stop'; & ${powershellQuote(exe)} ${powershellQuote(windowsLauncher)} start --login-env ${encoded}; exit $LASTEXITCODE`;
      args = `-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
    }
    return { name: target, content: `<?xml version="1.0" encoding="UTF-8"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers><LogonTrigger><UserId>${sid}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="User"><UserId>${sid}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT0S</ExecutionTimeLimit></Settings>
  <Actions Context="User"><Exec><Command>${xml(command)}</Command><Arguments>${xml(args)}</Arguments></Exec></Actions>
</Task>
` };
  }
  if (platform === "darwin") return {
    path: target,
    content: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(exe)}</string><string>${xml(daemon)}</string></array>
<key>EnvironmentVariables</key><dict>
${Object.entries(settings).map(([name, value]) => `<key>${name}</key><string>${xml(value)}</string>`).join("\n")}
</dict>
<key>RunAtLoad</key><true/>
</dict></plist>
`,
  };
  return {
    path: target,
    content: `[Unit]\nDescription=Harnest MCP daemon\n\n[Service]\nExecStart=${systemdQuote(exe.replaceAll("$", "$$"))} ${systemdQuote(daemon.replaceAll("$", "$$"))}\n`
      + Object.entries(settings).map(([name, value]) => `Environment=${systemdQuote(`${name}=${value}`)}\n`).join("")
      + "\n[Install]\nWantedBy=default.target\n",
  };
}

const run = (command, args) => execFileSync(command, args, {
  encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
  env: withoutHarnestToken(process.env),
});

function currentSid(execute, env) {
  return /"(S-1-(?:\d+-)+\d+)"/i.exec(execute(windowsSystemCommand("whoami.exe", env), ["/user", "/fo", "csv", "/nh"]))?.[1];
}

async function autostart() {
  if (process.platform === "win32") {
    const sid = currentSid(run);
    const scheduler = windowsSystemCommand("schtasks.exe");
    const { name, content } = loginItem(process.platform, { sid });
    const path = join(daemonDirectory(), "login-task.xml");
    let priorTask;
    try { priorTask = run(scheduler, ["/query", "/tn", name, "/xml"]); } catch { /* new task */ }
    const previous = await readExisting(path);
    if (priorTask && previous === content) return;
    if (priorTask) await replaceWithBackup(join(daemonDirectory(), "previous-login-task.xml"), priorTask);
    await replaceWithBackup(path, content, previous);
    run(scheduler, ["/create", "/tn", name, "/xml", path, "/f"]);
    return;
  }
  const mac = process.platform === "darwin";
  const serviceManager = requireNativeCommand(mac ? "launchctl" : "systemctl");
  const { path, content } = loginItem(process.platform);
  const previous = await readExisting(path);
  await replaceWithBackup(path, content, previous);
  if (mac) {
    const domain = `gui/${process.getuid()}`;
    try { run(serviceManager, ["print", `${domain}/${label}`]); } catch {
      run(serviceManager, ["bootstrap", domain, path]);
    }
  } else {
    run(serviceManager, ["--user", "daemon-reload"]);
    run(serviceManager, ["--user", "enable", unit]);
  }
}

export async function removeAutostart({
  platform = process.platform, home = homedir(), env = process.env, uid = process.getuid?.(),
  execute = run, removeFile = unlink,
} = {}) {
  const sid = platform === "win32" ? currentSid(execute, env) : undefined;
  const target = loginItemTarget(platform, { home, sid, env });
  if (platform === "win32") {
    execute(windowsSystemCommand("schtasks.exe", env), ["/delete", "/tn", target, "/f"]);
    return;
  }
  const mac = platform === "darwin";
  const serviceManager = requireNativeCommand(mac ? "launchctl" : "systemctl", env);
  if (mac) {
    const service = `gui/${uid}/${label}`;
    let loaded = false;
    try { execute(serviceManager, ["print", service]); loaded = true; } catch { /* already unloaded */ }
    if (loaded) execute(serviceManager, ["bootout", service]);
  } else {
    execute(serviceManager, ["--user", "disable", unit]);
  }
  await removeFile(target).catch((error) => { if (error.code !== "ENOENT") throw error; });
  if (!mac) execute(serviceManager, ["--user", "daemon-reload"]);
}

export async function setupDaemon({ noAutostart = false } = {}) {
  await ensureDaemon();
  if (!noAutostart) {
    try { await autostart(); } catch (error) {
      const message = error instanceof NativeLaunchError ? error.message : "Could not register the Harnest login item.";
      throw new Error(message + " Use --no-autostart to install without a login item.", { cause: error });
    }
  }
}
