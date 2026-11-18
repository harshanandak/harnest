import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readDaemonToken } from "../src/daemon-settings.mjs";
import { setupDaemon } from "./install-daemon.mjs";
import { bridgeEntry, httpEntry, installJsonServer } from "./install-host-config.mjs";
import { installPluginHost } from "./install-plugin-host.mjs";
import { cursorProject, installCursorIntegration } from "./install-cursor-integration.mjs";
import { installIntegration, openCodeConfigDir } from "./install-opencode-integration.mjs";
import { installPiIntegration } from "./install-pi-integration.mjs";

export const namedHosts = ["claude", "codex", "opencode", "cursor", "pi", "gemini", "amp"];

export function bridgeHostConfig(host, home = homedir(), env = process.env) {
  if (host === "gemini") return { path: join(env.GEMINI_CLI_HOME || home, ".gemini", "settings.json"), key: "mcpServers" };
  return { path: join(env.XDG_CONFIG_HOME || join(home, ".config"), "amp", "settings.json"), key: "amp.mcpServers" };
}

export async function installBridgeHost(host, options = {}) {
  const { path, key } = bridgeHostConfig(host, options.home, options.env);
  const entry = bridgeEntry();
  if (host === "gemini") entry.trust = false;
  return installJsonServer(path, key, entry);
}

async function setup(args) {
  const [host, ...flags] = args;
  const positional = flags.filter((flag) => flag !== "--no-autostart");
  if (!namedHosts.includes(host) && host !== "other") {
    throw new Error("Usage: bun run setup " + [...namedHosts, "other"].join("|") + " [--no-autostart] [--project DIR for claude/cursor | --http-config FILE for other]");
  }
  const project = ["claude", "cursor"].includes(host) && positional[0] === "--project" &&
    positional.length === 2 && positional[1] && !positional[1].startsWith("--") ? resolve(positional[1]) : null;
  const http = host === "other" && positional[0] === "--http-config" && positional.length === 2 && !positional[1].startsWith("--");
  if (positional.length && !project && !http) throw new Error("Unsupported setup option for " + host);
  if (host === "other" && !http) {
    console.log(JSON.stringify({ mcpServers: { harnest: bridgeEntry() } }, null, 2));
    return;
  }

  await setupDaemon({ noAutostart: flags.includes("--no-autostart") });
  let result;
  switch (host) {
    case "claude":
    case "codex":
      await installPluginHost(host, { project: project ?? process.cwd() });
      break;
    case "opencode":
      result = await installIntegration(openCodeConfigDir());
      if (result.manifest) console.log('Reverse path: node scripts/install-opencode-integration.mjs --restore "' + result.manifest + '"');
      break;
    case "cursor":
      result = await installCursorIntegration(project ?? cursorProject([]));
      break;
    case "pi":
      result = await installPiIntegration();
      break;
    case "gemini":
    case "amp":
      result = await installBridgeHost(host);
      break;
    case "other":
      result = await installJsonServer(resolve(positional[1]), "mcpServers", { type: "http", ...httpEntry(await readDaemonToken()) });
      break;
  }
  if (result) console.log(JSON.stringify(result, null, 2));
  if (host === "amp") console.log("If Amp requests approval, run: amp mcp approve harnest");
  console.log("Restart or reload the host to use Harnest.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await setup(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
