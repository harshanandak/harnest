import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readDaemonToken } from "../src/daemon-settings.mjs";
import { setupDaemon } from "./install-daemon.mjs";
import { bridgeEntry, cursorUserConfig, httpEntry, installJsonServer, removeJsonServer, restoreHostConfig } from "./install-host-config.mjs";
import { installPluginHost, removePluginHost } from "./install-plugin-host.mjs";
import { installCursorIntegration } from "./install-cursor-integration.mjs";
import { installIntegration, latestInstallManifest, openCodeConfigDir, restoreIntegration } from "./install-opencode-integration.mjs";
import { installPiIntegration, removePiIntegration } from "./install-pi-integration.mjs";
import { manualBridgeConfig, manualBridgeHosts, presetBridgeHosts } from "./preset-lead-hosts.mjs";
import { setupPathCommand } from "./setup-command.mjs";

const bridgeHosts = ["amp", ...Object.keys(presetBridgeHosts)];
export const namedHosts = ["claude", "codex", "opencode", "cursor", "pi", ...bridgeHosts, ...manualBridgeHosts];

export function bridgeHostConfig(host, home = homedir(), env = process.env, platform = process.platform) {
  if (host === "amp") return { path: join(env.XDG_CONFIG_HOME || join(home, ".config"), "amp", "settings.json"), key: "amp.mcpServers" };
  if (!Object.hasOwn(presetBridgeHosts, host)) return null;
  const preset = presetBridgeHosts[host];
  return { path: preset.path(home, env, platform), key: preset.key ?? "mcpServers", format: preset.format };
}

export async function installBridgeHost(host, options = {}) {
  const { path, key, format } = bridgeHostConfig(host, options.home, options.env, options.platform);
  const bridge = bridgeEntry();
  const entry = presetBridgeHosts[host]?.entry?.(bridge) ?? bridge;
  return installJsonServer(path, key, entry, { format });
}

const setupUsage = "Usage: harnest setup " + [...namedHosts, "other"].join("|") +
  " [--no-autostart] [--project DIR for cursor | --http-config FILE for other]\n" +
  "       harnest setup remove <host> [--http-config FILE for other]\n" +
  "       harnest setup --restore BACKUP | harnest setup opencode --restore MANIFEST\n" +
  "Removal supports claude, codex, pi, cursor (user config), " + bridgeHosts.join(", ") + ", and other with --http-config.\n" +
  "Manual MCP configuration: " + manualBridgeHosts.join(", ") + ".";

function printResult(result) {
  console.log(JSON.stringify(result, null, 2));
}

async function removeHost([target, ...flags]) {
  const http = target === "other" && flags.length === 2 && flags[0] === "--http-config" && !flags[1].startsWith("--");
  if (!target || (target === "other" ? !http : flags.length !== 0)) throw new Error(setupUsage);
  if (target === "claude" || target === "codex") return printResult(await removePluginHost(target));
  if (target === "pi") return printResult(await removePiIntegration());
  const config = http ? { path: resolve(flags[1]), key: "mcpServers" }
    : target === "cursor" ? cursorUserConfig() : bridgeHostConfig(target);
  if (!config) throw new Error(`Removal is unsupported for host: ${target}. See harnest setup --help.`);
  const result = await removeJsonServer(config);
  const messages = {
    "config-missing": "Host configuration file does not exist.",
    "already-absent": "The Harnest MCP entry is already absent.",
    removed: "Removed the Harnest MCP entry.",
  };
  printResult({ ...result, message: messages[result.status] });
}

async function setup(args) {
  const [host, ...flags] = args;
  if (["--help", "-h"].includes(host)) { console.log(setupUsage); return; }
  if (host === "remove") return removeHost(flags);
  if (host === "--restore" && flags.length === 1) return printResult(await restoreHostConfig(resolve(flags[0])));
  if (host === "opencode" && flags[0] === "--restore" && flags.length === 2) {
    return printResult(await restoreIntegration(resolve(flags[1])));
  }
  if (!namedHosts.includes(host) && host !== "other") throw new Error(setupUsage);
  const positional = flags.filter((flag) => flag !== "--no-autostart");
  const project = host === "cursor" && positional[0] === "--project" &&
    positional.length === 2 && positional[1] && !positional[1].startsWith("--") ? resolve(positional[1]) : null;
  const http = host === "other" && positional[0] === "--http-config" && positional.length === 2 && !positional[1].startsWith("--");
  if (positional.length && !project && !http) throw new Error("Unsupported setup option for " + host);
  if (host === "other" && !http) {
    printResult({ mcpServers: { harnest: bridgeEntry() } });
    console.error("To reverse a manual setup, remove the harnest entry you added to your host config.");
    return;
  }

  const manual = manualBridgeConfig(host);
  if (manual) {
    console.log(`Edit ${manual.path}\n${manual.merge}\n\n${manual.snippet(bridgeEntry())}\n\n${manual.verify}`);
    console.log("To reverse a manual setup, remove the harnest entry you added to that file.");
    return;
  }
  const prepareDaemon = () => setupDaemon({ noAutostart: flags.includes("--no-autostart") });
  if (host !== "opencode") await prepareDaemon();
  let result;
  const reverse = [];
  switch (host) {
    case "claude":
    case "codex":
      await installPluginHost(host);
      reverse.push(`Reverse path: harnest setup remove ${host}`);
      break;
    case "opencode": {
      const dir = openCodeConfigDir();
      result = await installIntegration(dir, { prepareDaemon });
      const manifest = result.manifest ?? await latestInstallManifest(dir);
      if (manifest) reverse.push(setupPathCommand("opencode --restore", manifest));
      break;
    }
    case "cursor":
      result = await installCursorIntegration(project ?? process.cwd());
      reverse.push(`Reverse path: harnest setup remove ${host}`);
      if (result.mcp.backup) reverse.push(setupPathCommand("--restore", resolve(result.mcp.backup)));
      if (result.projectMcp?.backup) reverse.push(setupPathCommand("--restore", resolve(result.projectMcp.backup)));
      break;
    case "pi":
      result = await installPiIntegration();
      reverse.push(`Reverse path: harnest setup remove ${host}`);
      break;
    case "other":
      result = await installJsonServer(resolve(positional[1]), "mcpServers", { type: "http", ...httpEntry(await readDaemonToken()) });
      reverse.push(setupPathCommand("remove other --http-config", result.path));
      if (result.backup) reverse.push(setupPathCommand("--restore", result.backup));
      break;
    default:
      result = await installBridgeHost(host);
      reverse.push(`Reverse path: harnest setup remove ${host}`);
      if (result.backup) reverse.push(setupPathCommand("--restore", resolve(result.backup)));
      break;
  }
  if (result) printResult(result);
  if (host === "amp") console.log("If Amp requests approval, run: amp mcp approve harnest");
  if (host === "kiro") console.log("In Kiro, run /mcp to check Harnest. For custom agents, enable includeMcpJson to load user-level servers.");
  console.log("Restart or reload the host to use Harnest.");
  for (const line of reverse) console.log(line);
  if (reverse[0]?.startsWith("Reverse path: harnest setup remove")) {
    console.log("Use the same config path environment variables you used for setup.");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await setup(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
