import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { harnessLaunch } from "../src/config.mjs";
import { windowsSystemCommand } from "../src/launch-command.mjs";
import { runProcess } from "../src/process.mjs";
import { installHostConfig } from "./install-host-config.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
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
  await pluginCommand(host, "marketplace", "add", root);
  await pluginCommand(host, host === "codex" ? "add" : "install", "harnest@harnest-local");
  if (host === "codex") {
    console.log(JSON.stringify(await installHostConfig(host)));
    const windows = process.platform === "win32";
    const script = join(root, "scripts", windows ? "install-native-agents.ps1" : "install-native-agents.sh");
    const result = await runProcess(windows ? windowsSystemCommand("powershell.exe") : "bash", windows ? ["-NoProfile", "-File", script] : [script]);
    process.stdout.write(result.stdout);
  }
}
