import { access, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { clientPort, daemonAddress, readDaemonToken } from "../src/daemon-settings.mjs";
import { assertMcpCatalog } from "./harnest-mcp-catalog.mjs";
import { readExisting } from "./install-files.mjs";
import { bridgeEntry, httpEntry, readJsonServers } from "./install-host-config.mjs";
import { claudeConfigDir } from "./install-plugin-host.mjs";
import { isLegacyOpenCodePlugin, openCodeConfigDir, parseConfig } from "./install-opencode-integration.mjs";
import { isLegacyPiExtension, piConfigDir } from "./install-pi-integration.mjs";
import { bridgeHostConfig, namedHosts } from "./setup.mjs";
import { manualBridgeConfig } from "./preset-lead-hosts.mjs";

export const doctorHosts = [...namedHosts];

async function readJson(path) {
  const raw = await readExisting(path);
  if (raw === null) return {};
  try { return JSON.parse(raw.replace(/^\uFEFF/, "")); }
  catch { throw new Error("Invalid JSON in " + path); }
}

const exists = (path) => access(path).then(() => true, () => false);
const legacy = (entries) => Object.hasOwn(entries ?? {}, "agent-companion");
const fromJson = async (path, key = "mcpServers", format = "json") => {
  const servers = await readJsonServers(path, key, format);
  return { entry: servers?.harnest, old: legacy(servers), path };
};

async function presetConnection(host, home) {
  const { path, key, format } = bridgeHostConfig(host, home);
  const result = await fromJson(path, key, format);
  const entry = result.entry;
  if (entry?.disabled === true || entry?.enabled === false) throw new Error(`Harnest is disabled in ${path}`);
  if (host === "cline" && entry?.transport?.type === "stdio") result.entry = entry.transport;
  if (host === "kilo" && entry?.type === "local" && Array.isArray(entry.command)) {
    const [command, ...args] = entry.command;
    result.entry = { command, args, env: entry.environment };
  }
  return result;
}

function codexEntry(config) {
  const pick = (name) => new RegExp('^\\s*' + name + '\\s*=\\s*(.+)$', "m").exec(config)?.[1];
  const value = (name, pattern) => {
    const raw = pick(name)?.match(pattern)?.[0];
    return raw === undefined ? undefined : JSON.parse(raw);
  };
  const command = value("command", /^"(?:\\.|[^"\\])*"/);
  if (command) {
    const env = Object.fromEntries(Array.from((pick("env") ?? "").matchAll(/(HARNEST_LOGIN_(?:DAEMON|JOB)_DIR)\s*=\s*("(?:\\.|[^"\\])*")/g), ([, name, val]) => [name, JSON.parse(val)]));
    return { command, args: value("args", /^\[\s*"(?:\\.|[^"\\])*"\s*\]/), env };
  }
  const authorization = (pick("http_headers") ?? "").match(/\bAuthorization\s*=\s*("(?:\\.|[^"\\])*")/i)?.[1];
  return { url: value("url", /^"(?:\\.|[^"\\])*"/), headers: { Authorization: authorization && JSON.parse(authorization) } };
}

async function installedConnection(host, { home, project, configPath }) {
  switch (host) {
    case "codex": {
      const dir = process.env.CODEX_HOME || join(home, ".codex");
      const path = join(dir, "config.toml");
      const raw = await readExisting(path) ?? "";
      const section = /^\s*\[\s*mcp_servers\s*\.\s*["']?harnest["']?\s*\][^\r\n]*\r?\n([\s\S]*?)(?=^\s*\[|(?![\s\S]))/m.exec(raw)?.[1];
      const old = /^\s*\[\s*mcp_servers\s*\.\s*["']?agent-companion["']?(?:\s*\.|\s*\])|^\s*\[\s*(?:plugins|marketplaces)\s*\.[^\r\n]*\bagent-companion\b/m.test(raw);
      return { entry: section && codexEntry(section), path, old, assets: [
        ...["acp", "amp", "claude", "cursor", "gemini", "opencode", "pi"].map((target) => join(dir, "agents", target + "_worker.toml")),
      ] };
    }
    case "cursor": {
      const local = await fromJson(join(project, ".cursor", "mcp.json"));
      const global = await fromJson(join(home, ".cursor", "mcp.json"));
      const assets = ["skills/handoff/SKILL.md", "rules/harnest-router.mdc", "agents/cursor-worker.md", "commands/workflows.md"]
        .map((file) => join(project, ".cursor", file));
      return { ...(local.entry ? local : global), old: local.old || global.old, assets };
    }
    case "opencode": {
      const dir = openCodeConfigDir();
      const json = join(dir, "opencode.json");
      const jsonc = join(dir, "opencode.jsonc");
      const raw = await readExisting(json);
      const rawc = await readExisting(jsonc);
      if (raw !== null && rawc !== null) throw new Error("Both opencode.json and opencode.jsonc exist.");
      const config = parseConfig(rawc ?? raw ?? "{}");
      const servers = config.mcp?.servers;
      const plugins = config.plugins ?? [];
      return { entry: servers?.harnest, old: legacy(servers) || legacy(config.mcp) || plugins.some(isLegacyOpenCodePlugin), path: rawc === null ? json : jsonc,
        assets: ["plugins/harnest/package.json", "skills/handoff/SKILL.md", "agents/acp-worker.md", "commands/handoff.md"].map((file) => join(dir, file)) };
    }
    case "pi": {
      const dir = piConfigDir();
      const path = join(dir, "settings.json");
      const extensions = (await readJson(path)).extensions ?? [];
      const matches = extensions.filter((entry) => typeof entry === "string" && /(?:^|[\\/])harnest\.mjs$/i.test(entry));
      if (matches.length > 1) throw new Error("Pi has more than one Harnest extension registration.");
      const autoLoaded = await readdir(join(dir, "extensions")).catch((error) => {
        if (error.code !== "ENOENT") throw error;
        return [];
      });
      const old = extensions.some(isLegacyPiExtension) || autoLoaded.some(isLegacyPiExtension);
      return { entry: matches.length ? httpEntry(await readDaemonToken()) : null, old, path,
        assets: matches.map((file) => resolve(dir, file)).concat(join(dir, "skills", "handoff", "SKILL.md")) };
    }
    case "claude": {
      const dir = claudeConfigDir(home);
      const path = join(dir, "plugins", "installed_plugins.json");
      const plugins = (await readJson(path)).plugins ?? {};
      const marketplaces = await readJson(join(dir, "plugins", "known_marketplaces.json"));
      const settings = await readJson(join(dir, "settings.json"));
      const projectSettings = await readJson(join(project, ".claude", "settings.json"));
      const localSettings = await readJson(join(project, ".claude", "settings.local.json"));
      const projectMcp = await fromJson(join(project, ".mcp.json"));
      const userMcp = await readJson(process.env.CLAUDE_CONFIG_DIR ? join(dir, ".claude.json") : join(home, ".claude.json"));
      const old = [...Object.keys(plugins), ...Object.keys(marketplaces), ...[settings, projectSettings, localSettings].flatMap((config) => [
        ...Object.keys(config.enabledPlugins ?? {}), ...Object.keys(config.extraKnownMarketplaces ?? {}),
      ])]
        .some((name) => /^agent-companion(?:-local|@.+)?$/.test(name)) || projectMcp.old || legacy(userMcp.mcpServers)
        || Object.values(userMcp.projects ?? {}).some((record) => legacy(record?.mcpServers));
      const id = "harnest@harnest-local";
      const install = plugins[id]?.find((plugin) => plugin.scope === "user") ?? plugins[id]?.[0];
      if (!install?.installPath) {
        const direct = userMcp.projects?.[project]?.mcpServers?.harnest ?? projectMcp.entry ?? userMcp.mcpServers?.harnest;
        const entry = direct?.headersHelper?.includes("CLAUDE_PLUGIN_ROOT") ? null : direct;
        return { entry, old, path };
      }
      if ((localSettings.enabledPlugins?.[id] ?? projectSettings.enabledPlugins?.[id] ?? settings.enabledPlugins?.[id]) === false) {
        throw new Error("The Harnest Claude plugin is disabled.");
      }
      const installedMcp = await fromJson(join(install.installPath, ".mcp.json"));
      const entry = installedMcp.entry;
      if (entry?.headersHelper !== 'node "\${CLAUDE_PLUGIN_ROOT}/scripts/claude-mcp-headers.mjs"') {
        throw new Error("The installed Claude plugin has an outdated MCP headers helper.");
      }
      return { entry: { ...httpEntry(await readDaemonToken()), url: entry.url }, old, path,
        assets: ["scripts/claude-mcp-headers.mjs", "skills/handoff/SKILL.md", "agents/acp-worker.md", "hooks/hooks.json"].map((file) => join(install.installPath, file)) };
    }
    case "gemini":
    case "amp": {
      const { path, key } = bridgeHostConfig(host, home);
      const local = await fromJson(join(project, host === "amp" ? ".amp" : ".gemini", "settings.json"), key);
      const global = await fromJson(path, key);
      return { ...(local.entry ? local : global), old: local.old || global.old };
    }
    case "devin": {
      const { key, format } = bridgeHostConfig(host, home);
      const local = await fromJson(join(project, ".devin", "mcp_config.local.json"), key, format);
      const shared = await fromJson(join(project, ".devin", "mcp_config.json"), key, format);
      const global = await presetConnection(host, home);
      return { ...(local.entry ? local : shared.entry ? shared : global), old: local.old || shared.old || global.old };
    }
    case "other":
      return fromJson(configPath);
    default:
      return presetConnection(host, home);
  }
}

async function checkConnection(entry, project) {
  const client = new Client({ name: "harnest-doctor", version: "1" });
  let transport;
  if (entry.command) {
    const expected = bridgeEntry();
    if (!/^node(?:\.exe)?$/i.test(basename(entry.command)) || entry.args?.length !== 1 ||
        !entry.args[0] || await realpath(resolve(project, entry.args[0])).catch(() => null) !== await realpath(expected.args[0])) {
      throw new Error("Expected the stdio bridge from this Harnest checkout. Run setup again.");
    }
    if (entry.command !== "node" && !await exists(entry.command)) throw new Error("The configured Node executable is missing.");
    const env = Object.fromEntries(Object.entries(entry.env ?? {}).filter(([name, value]) =>
      ["HARNEST_LOGIN_DAEMON_DIR", "HARNEST_LOGIN_JOB_DIR"].includes(name) && typeof value === "string"));
    transport = new StdioClientTransport({ command: process.execPath, args: expected.args, cwd: project, env: { ...process.env, ...env }, stderr: "pipe" });
  } else {
    const auth = Object.entries(entry.headers ?? {}).find(([name]) => name.toLowerCase() === "authorization")?.[1];
    if (entry.url !== daemonAddress(clientPort()) + "/mcp" || typeof auth !== "string" || !/^Bearer [a-f0-9]{64}$/.test(auth)) {
      throw new Error("Expected the local Harnest URL and its Authorization bearer header.");
    }
    transport = new StreamableHTTPClientTransport(new URL(entry.url), { requestInit: { headers: { Authorization: auth } } });
  }
  try {
    await client.connect(transport, { timeout: 15_000 });
    assertMcpCatalog(await client.listTools(undefined, { timeout: 15_000 }));
    return entry.command ? "stdio bridge" : "Streamable HTTP";
  } catch {
    throw new Error("MCP discovery failed. Check the daemon and reload the host configuration.");
  } finally {
    await client.close();
  }
}

export async function checkLeadConnections({ host, home = homedir(), project = process.cwd(), configPath } = {}) {
  if (host && !doctorHosts.includes(host) && !(host === "other" && configPath)) {
    throw new Error("Use --host " + doctorHosts.join("|") + " or --host other --config FILE.");
  }
  let ok = true;
  for (const name of host ? [host] : doctorHosts) {
    try {
      const manual = manualBridgeConfig(name, { home });
      if (manual) {
        if (host) throw new Error(`Verify ${manual.path} in the host. ${manual.verify}`);
        continue;
      }
      const { entry, path, assets = [], old } = await installedConnection(name, { home, project, configPath });
      if (old) throw new Error("A legacy agent-companion registration remains.");
      if (!entry && !host) continue;
      if (!entry) throw new Error("Harnest is not registered in " + path);
      for (const file of assets) {
        if (!await exists(file)) {
          // Cursor's user-level MCP works independently of its workspace assets.
          if (name === "cursor" && !host) break;
          throw new Error("Missing installed artifact " + file);
        }
      }
      const transport = await checkConnection(entry, project);
      console.log("lead-" + name + ": ok (" + transport + ", MCP catalog verified) " + path);
    } catch (error) {
      console.error("lead-" + name + ": FAIL. " + (error instanceof SyntaxError ? "Invalid host configuration." : error.message));
      ok = false;
    }
  }
  return ok;
}
