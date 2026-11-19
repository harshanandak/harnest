import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readDaemonToken } from "../src/daemon-settings.mjs";
import { setupDaemon } from "./install-daemon.mjs";
import { bridgeEntry, cursorUserConfig, httpEntry, installJsonServer, removeJsonServer } from "./install-host-config.mjs";
import { installPluginHost } from "./install-plugin-host.mjs";
import { cursorProject, installCursorIntegration } from "./install-cursor-integration.mjs";
import { installIntegration, openCodeConfigDir } from "./install-opencode-integration.mjs";
import { installPiIntegration } from "./install-pi-integration.mjs";
import { manualBridgeConfig, manualBridgeHosts, presetBridgeHosts } from "./preset-lead-hosts.mjs";

const bridgeHosts = ["gemini", "amp", ...Object.keys(presetBridgeHosts)];
export const namedHosts = ["claude", "codex", "opencode", "cursor", "pi", ...bridgeHosts, ...manualBridgeHosts];

export function bridgeHostConfig(host, home = homedir(), env = process.env, platform = process.platform) {
  if (host === "gemini") return { path: join(env.GEMINI_CLI_HOME || home, ".gemini", "settings.json"), key: "mcpServers" };
  if (host === "amp") return { path: join(env.XDG_CONFIG_HOME || join(home, ".config"), "amp", "settings.json"), key: "amp.mcpServers" };
  if (!Object.hasOwn(presetBridgeHosts, host)) return null;
  const preset = presetBridgeHosts[host];
  return { path: preset.path(home, env, platform), key: preset.key ?? "mcpServers", format: preset.format };
}

export async function installBridgeHost(host, options = {}) {
  const { path, key, format } = bridgeHostConfig(host, options.home, options.env, options.platform);
  const bridge = bridgeEntry();
  const entry = presetBridgeHosts[host]?.entry?.(bridge) ?? bridge;
  if (host === "gemini") entry.trust = false;
  return installJsonServer(path, key, entry, { format });
}

const setupUsage = "Usage: bun run setup " + [...namedHosts, "other"].join("|") +
  " [--no-autostart] [--project DIR for claude/cursor | --http-config FILE for other]\n" +
  "       bun run setup remove <host>\n" +
  "Removal supports cursor (user config), " + bridgeHosts.join(", ") + ".\n" +
  "Manual MCP configuration: " + manualBridgeHosts.join(", ") + ".";

function hostConfigReverse(result, host) {
  if (result?.backup) {
    const quote = process.platform === "win32" ? "''" : "'\\''";
    return [`Reverse path: node scripts/install-host-config.mjs --restore '${result.backup.replaceAll("'", quote)}'`];
  }
  if (result?.created && host) {
    return [`Reverse path: bun run setup remove ${host}`, "Run it from the Harnest repository root, with the same config path environment variables you used for setup."];
  }
  return [];
}

async function setup(args) {
  const [host, ...flags] = args;
  if (["--help", "-h"].includes(host)) { console.log(setupUsage); return; }
  if (host === "remove") {
    if (flags.length !== 1) throw new Error(setupUsage);
    const [target] = flags;
    const config = target === "cursor" ? cursorUserConfig() : bridgeHostConfig(target);
    if (!config) throw new Error(`Removal is unsupported for host: ${target}. See bun run setup --help.`);
    const result = await removeJsonServer(config);
    const messages = {
      "config-missing": "Host configuration file does not exist.",
      "already-absent": "The Harnest MCP entry is already absent.",
      removed: "Removed the Harnest MCP entry.",
    };
    console.log(JSON.stringify({ ...result, message: messages[result.status] }, null, 2));
    return;
  }
  if (!namedHosts.includes(host) && host !== "other") throw new Error(setupUsage);
  const positional = flags.filter((flag) => flag !== "--no-autostart");
  const project = ["claude", "cursor"].includes(host) && positional[0] === "--project" &&
    positional.length === 2 && positional[1] && !positional[1].startsWith("--") ? resolve(positional[1]) : null;
  const http = host === "other" && positional[0] === "--http-config" && positional.length === 2 && !positional[1].startsWith("--");
  if (positional.length && !project && !http) throw new Error("Unsupported setup option for " + host);
  if (host === "other" && !http) {
    console.log(JSON.stringify({ mcpServers: { harnest: bridgeEntry() } }, null, 2));
    return;
  }

  const prepareDaemon = () => setupDaemon({ noAutostart: flags.includes("--no-autostart") });
  if (host !== "opencode") await prepareDaemon();
  const manual = manualBridgeConfig(host);
  if (manual) {
    console.log(`Edit ${manual.path}\n${manual.merge}\n\n${manual.snippet(bridgeEntry())}\n\n${manual.verify}`);
    return;
  }
  let result;
  const reverse = [];
  switch (host) {
    case "claude":
    case "codex":
      await installPluginHost(host, { project: project ?? process.cwd() });
      break;
    case "opencode":
      result = await installIntegration(openCodeConfigDir(), { prepareDaemon });
      if (result.manifest) console.log('Reverse path: node scripts/install-opencode-integration.mjs --restore "' + result.manifest + '"');
      break;
    case "cursor":
      result = await installCursorIntegration(project ?? cursorProject([]));
      reverse.push(...hostConfigReverse(result.mcp, host), ...hostConfigReverse(result.projectMcp));
      break;
    case "pi":
      result = await installPiIntegration();
      break;
    case "other":
      result = await installJsonServer(resolve(positional[1]), "mcpServers", { type: "http", ...httpEntry(await readDaemonToken()) });
      reverse.push(...hostConfigReverse(result));
      break;
    default:
      result = await installBridgeHost(host);
      reverse.push(...hostConfigReverse(result, host));
      break;
  }
  if (result) console.log(JSON.stringify(result, null, 2));
  if (host === "gemini") console.log("Legacy Gemini target. Gemini CLI now serves only paid Gemini API keys and enterprise Code Assist. Personal Google accounts should use the antigravity ACP preset.");
  if (host === "amp") console.log("If Amp requests approval, run: amp mcp approve harnest");
  if (host === "kiro") console.log("In Kiro, run /mcp to check Harnest. For custom agents, enable includeMcpJson to load user-level servers.");
  console.log("Restart or reload the host to use Harnest.");
  for (const line of reverse) console.log(line);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await setup(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
