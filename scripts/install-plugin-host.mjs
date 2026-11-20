import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { harnessLaunch } from "../src/config.mjs";
import { windowsSystemCommand } from "../src/launch-command.mjs";
import { runProcess } from "../src/process.mjs";
import { codexConfigDir, installHostConfig, removeCodexConfig } from "./install-host-config.mjs";
import { readExisting, removeInstalledCopy } from "./install-files.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const marketplace = "harnest-local";
const plugin = `harnest@${marketplace}`;
export const claudeConfigDir = (home = homedir()) => process.env.CLAUDE_CONFIG_DIR || join(home, ".claude");
async function pluginCommand(host, ...args) {
  const launch = harnessLaunch(host);
  try {
    await runProcess(launch.command, [...(launch.args ?? []), "plugin", ...args], { cwd: root, timeoutMs: 120_000 });
  } catch {
    throw new Error(host + " plugin " + args.slice(0, 2).join(" ") + " failed. Check the host CLI and its plugin settings.");
  }
}

export async function installPluginHost(host) {
  const created = host === "codex" && await readExisting(join(codexConfigDir(), "config.toml")) === null;
  await pluginCommand(host, "marketplace", "add", root);
  await pluginCommand(host, host === "codex" ? "add" : "install", plugin);
  if (host === "codex") {
    console.log(JSON.stringify(await installHostConfig(host, { created })));
    const windows = process.platform === "win32";
    const script = join(root, "scripts", windows ? "install-native-agents.ps1" : "install-native-agents.sh");
    const result = await runProcess(windows ? windowsSystemCommand("powershell.exe") : "bash", windows ? ["-NoProfile", "-File", script] : [script]);
    process.stdout.write(result.stdout);
  }
}
export async function removePluginHost(host) {
  await pluginCommand(host, host === "codex" ? "remove" : "uninstall", plugin);
  await pluginCommand(host, "marketplace", "remove", marketplace);
  if (host === "claude") return { status: "removed" };

  const config = await removeCodexConfig();
  const source = join(root, "codex-agents");
  const workerBackups = [];
  for (const worker of await readdir(source)) {
    if (!worker.endsWith("_worker.toml")) continue;
    const backup = await removeInstalledCopy(join(source, worker), join(codexConfigDir(), "agents", worker));
    if (backup) workerBackups.push(backup);
  }
  return { config, workerBackups };
}
