import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { harnessLaunch } from "../src/config.mjs";
import { windowsSystemCommand } from "../src/launch-command.mjs";
import { runProcess } from "../src/process.mjs";
import { installHostConfig } from "./install-host-config.mjs";
import { readExisting, replaceWithBackup } from "./install-files.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
export const claudeConfigDir = (home = homedir()) => process.env.CLAUDE_CONFIG_DIR || join(home, ".claude");
const legacyPlugin = (name) => /^agent-companion(?:@.+)?$/.test(name);
const legacyMarketplace = (name) => /^agent-companion(?:-local)?$/.test(name);

export async function migrateClaudeRegistrations({ home = homedir(), configDir = claudeConfigDir(home), project = process.cwd() } = {}) {
  const edited = [];
  const migrate = async (path, transform) => {
    const previous = await readExisting(path);
    if (previous === null) return;
    let settings;
    try { settings = JSON.parse(previous.replace(/^\uFEFF/, "")); }
    catch { throw new Error("Invalid Claude configuration: " + path); }
    const migrated = [];
    const remove = (entries, match, label) => {
      for (const name of Object.keys(entries ?? {})) {
        if (!match(name)) continue;
        delete entries[name];
        if (!migrated.includes(label)) migrated.push(label);
      }
    };
    transform(settings, remove, migrated);
    if (!migrated.length) return;
    edited.push({ path, previous, next: JSON.stringify(settings, null, 2) + "\n", migrated });
  };
  const settingsPaths = [join(configDir, "settings.json"), join(project, ".claude", "settings.json"), join(project, ".claude", "settings.local.json")];
  for (const path of new Set(settingsPaths.map((file) => resolve(file)))) {
    await migrate(path, (settings, remove) => {
      remove(settings.enabledPlugins, legacyPlugin, "enabled agent-companion plugin");
      remove(settings.extraKnownMarketplaces, legacyMarketplace, "agent-companion marketplace");
    });
  }
  await migrate(join(configDir, "plugins", "known_marketplaces.json"), (settings, remove) => {
    remove(settings, legacyMarketplace, "agent-companion marketplace");
  });
  await migrate(join(configDir, "plugins", "installed_plugins.json"), (settings, remove) => {
    remove(settings.plugins, legacyPlugin, "installed agent-companion plugin");
  });
  await migrate(join(project, ".mcp.json"), (settings, remove) => {
    remove(settings.mcpServers, (name) => name === "agent-companion", "mcpServers.agent-companion");
  });
  const userMcp = join(home, ".claude.json");
  const customMcp = join(configDir, ".claude.json");
  for (const path of new Set([userMcp, ...(process.env.CLAUDE_CONFIG_DIR ? [customMcp] : [])])) {
    await migrate(path, (settings, _remove, migrated) => {
      for (const scope of [settings, ...Object.values(settings.projects ?? {})]) {
        const servers = scope?.mcpServers;
        if (!servers || !Object.hasOwn(servers, "agent-companion")) continue;
        // The installed plugin provides the replacement connection.
        delete servers["agent-companion"];
        if (!migrated.length) migrated.push("mcpServers.agent-companion");
      }
    });
  }
  const changes = [];
  for (const { path, previous, next, migrated } of edited) {
    const backup = await replaceWithBackup(path, next, previous, { sensitive: true });
    const change = { path, backup, migrated };
    changes.push(change);
    console.log(JSON.stringify(change));
  }
  return changes;
}

async function pluginCommand(host, ...args) {
  const launch = harnessLaunch(host);
  try {
    await runProcess(launch.command, [...(launch.args ?? []), "plugin", ...args], { cwd: root, timeoutMs: 120_000 });
  } catch {
    throw new Error(host + " plugin " + args.slice(0, 2).join(" ") + " failed. Check the host CLI and its plugin settings.");
  }
}

export async function installPluginHost(host, { project } = {}) {
  await pluginCommand(host, "marketplace", "add", root);
  await pluginCommand(host, host === "codex" ? "add" : "install", "harnest@harnest-local");
  if (host === "claude") {
    await migrateClaudeRegistrations({ project });
  } else {
    console.log(JSON.stringify(await installHostConfig(host)));
    const windows = process.platform === "win32";
    const script = join(root, "scripts", windows ? "install-native-agents.ps1" : "install-native-agents.sh");
    const result = await runProcess(windows ? windowsSystemCommand("powershell.exe") : "bash", windows ? ["-NoProfile", "-File", script] : [script]);
    process.stdout.write(result.stdout);
  }
}
