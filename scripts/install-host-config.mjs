import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { applyEdits, createScanner, getNodeValue, modify, parseTree, SyntaxKind } from "jsonc-parser";
import { daemonAddress, daemonDirectory, jobStateDirectory } from "../src/daemon-settings.mjs";
import { setupDaemon } from "./install-daemon.mjs";
import { readExisting, replaceWithBackup } from "./install-files.mjs";

export function httpEntry(token) {
  return { url: `${daemonAddress()}/mcp`, headers: { Authorization: `Bearer ${token}` } };
}

export function bridgeEntry() {
  return {
    command: process.execPath,
    args: [fileURLToPath(new URL("../src/mcp-bridge.mjs", import.meta.url))],
    env: { HARNEST_LOGIN_DAEMON_DIR: resolve(daemonDirectory()), HARNEST_LOGIN_JOB_DIR: resolve(jobStateDirectory()) },
  };
}

const codexServerTable = /^[ \t]*\[\s*(?:mcp_servers|"mcp_servers"|'mcp_servers')\s*\.\s*["']?(harnest|agent-companion)["']?\s*(?:\.\s*(.+?))?\s*\][ \t]*(?:#.*)?$/;
const codexOldPluginTable = /^\[\s*(?:plugins\s*\.\s*["']agent-companion(?:@[^"']+)?["']|marketplaces\s*\.\s*["']?agent-companion(?:-local)?["']?)\s*(?:\.|\])/;

// Replace just the Harnest transport table(s), keeping all other Codex configuration verbatim.
export function codexConfig(previous, entry, migrated = []) {
  const tables = (previous ?? "").split(/(?=^\s*\[{1,2}[^\r\n\]]+\]{1,2}\s*(?:#.*)?$)/m);
  const unmanaged = [];
  const keptSettings = [];
  const serverHeaders = tables.map((section) => codexServerTable.exec(section.trimStart().split(/\r?\n/, 1)[0]));
  const hasCurrent = serverHeaders.some((header) => header?.[1] === "harnest");
  const transportKey = /^(?:command|args|env|env_vars|cwd|url|http_headers|env_http_headers|bearer_token_env_var|auth)\s*=/;
  for (const [index, section] of tables.entries()) {
    const name = section.trimStart().split(/\r?\n/, 1)[0];
    const header = serverHeaders[index];
    if (codexOldPluginTable.test(name)) {
      migrated.push(name.startsWith("[plugins") ? "agent-companion plugin" : "agent-companion marketplace");
    } else if (/^\[\s*(?:plugins|marketplaces)\s*\]/.test(name)) {
      unmanaged.push(section.replace(/^[ \t]*["']?agent-companion(?:-local|@[^"'\r\n]+)?["']?[ \t]*=.*(?:\r?\n|$)/gm, () => {
        migrated.push(name.includes("marketplaces") ? "agent-companion marketplace" : "agent-companion plugin");
        return "";
      }));
    } else if (!header) {
      unmanaged.push(section);
    } else {
      if (header[1] === "agent-companion") {
        if (!migrated.includes("mcp_servers.agent-companion")) migrated.push("mcp_servers.agent-companion");
        if (hasCurrent) continue;
      }
      if (header[2]) {
        if (!["env", "http_headers", "env_http_headers"].includes(header[2].replaceAll(/["']/g, ""))) {
          unmanaged.push(header[1] === "agent-companion" ? section.replace(name, name.replace("agent-companion", "harnest")) : section);
        }
        continue;
      }
      let removing = false;
      for (const line of section.trimStart().split(/\r?\n/).slice(1)) {
        if (/^[\w-]+\s*=/.test(line.trim())) removing = transportKey.test(line.trim());
        if (!removing && line.trim()) keptSettings.push(line);
      }
    }
  }
  const remainder = unmanaged.join("").trimEnd();
  const lines = ["[mcp_servers.harnest]", `command = ${JSON.stringify(entry.command)}`, `args = ${JSON.stringify(entry.args)}`];
  if (entry.env) lines.push(`env = { ${Object.entries(entry.env).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join(", ")} }`);
  return (remainder ? `${remainder}\n\n` : "") + [...lines, ...keptSettings].join("\n") + "\n";
}

export async function installHostConfig(host, { home = homedir(), codexHome = process.env.CODEX_HOME || join(home, ".codex") } = {}) {
  const entry = bridgeEntry();
  const path = host === "codex" ? join(codexHome, "config.toml")
    : host === "cursor" ? join(home, ".cursor", "mcp.json") : null;
  if (!path) throw new Error("Expected codex or cursor");
  if (host === "cursor") return installJsonServer(path, "mcpServers", entry);
  const previous = await readExisting(path);
  const migrated = [];
  const backup = await replaceWithBackup(path, codexConfig(previous, entry, migrated), previous, { sensitive: true });
  return { path, backup, migrated };
}

const jsonOptions = (format) => ({ disallowComments: format === "json", allowTrailingComma: format === "jsonc" });

function parseHostJson(text, path, format) {
  const errors = [];
  const root = parseTree(text, errors, jsonOptions(format));
  if (errors.length || root?.type !== "object") throw new Error(`Invalid MCP configuration: ${path}`);
  return root;
}

function propertyValue(object, key, path) {
  const matches = object?.children?.filter(({ children }) => children[0].value === key) ?? [];
  if (matches.length > 1) throw new Error(`Duplicate MCP configuration key ${key}: ${path}`);
  return matches[0]?.children[1];
}

function removeLegacyServer(text, map, property) {
  const scanner = createScanner(text, true);
  const after = property.offset + property.length;
  scanner.setPosition(after);
  if (scanner.scan() !== SyntaxKind.CommaToken) {
    const index = map.children.indexOf(property);
    if (index === 0) return text.slice(0, property.offset) + text.slice(after);
    const previous = map.children[index - 1];
    scanner.setPosition(previous.offset + previous.length);
    scanner.scan();
  }
  // Remove the separator and property separately so comments between them survive.
  return applyEdits(text, [
    { offset: property.offset, length: property.length, content: "" },
    { offset: scanner.getTokenOffset(), length: 1, content: "" },
  ]);
}

export async function readJsonServers(path, key, format = "json") {
  const raw = await readExisting(path);
  if (raw === null) return {};
  const root = parseHostJson(raw.replace(/^\uFEFF/, ""), path, format);
  const servers = propertyValue(root, key, path);
  if (!servers || servers.type === "null") return {};
  if (servers.type !== "object") throw new Error(`Invalid MCP configuration: ${path}`);
  return Object.fromEntries(["harnest", "agent-companion"].flatMap((name) => {
    const node = propertyValue(servers, name, path);
    return node ? [[name, getNodeValue(node)]] : [];
  }));
}

export async function installJsonServer(path, key, entry, { existingOnly = false, format = "json" } = {}) {
  const previous = await readExisting(path);
  const bom = previous?.startsWith("\uFEFF") ? "\uFEFF" : "";
  let text = previous?.slice(bom.length) ?? "{}\n";
  const root = parseHostJson(text, path, format);
  const servers = propertyValue(root, key, path);
  if (servers && !["object", "null"].includes(servers.type)) throw new Error(`Invalid MCP configuration: ${path}`);
  const map = servers?.type === "object" ? servers : undefined;
  const legacy = propertyValue(map, "agent-companion", path);
  const current = propertyValue(map, "harnest", path);
  if (existingOnly && !legacy && !current) return null;

  if (legacy) text = removeLegacyServer(text, map, legacy.parent);
  const options = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: text.includes("\r\n") ? "\r\n" : "\n" } };
  const edit = (location, value) => { text = applyEdits(text, modify(text, location, value, options)); };
  if (!map) edit([key], { harnest: entry });
  else if (!current || !isDeepStrictEqual(JSON.parse(JSON.stringify(getNodeValue(current))), entry)) {
    edit([key, "harnest"], entry);
  }
  parseHostJson(text, path, format);
  const backup = await replaceWithBackup(path, bom + text, previous, { sensitive: true });
  const migrated = legacy ? [`${key}.agent-companion`] : [];
  return { path, backup, migrated };
}

export async function restoreHostConfig(backup) {
  const path = backup.replace(/\.bak-harnest-[a-z0-9-]+$/i, "");
  if (path === backup) throw new Error("Expected a Harnest configuration backup");
  const original = await readExisting(backup, null);
  if (original === null) throw new Error("Harnest configuration backup unavailable");
  return { path, backup: await replaceWithBackup(path, original, undefined, { sensitive: true }) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [host, ...flags] = process.argv.slice(2);
  if (host === "--restore" && flags.length === 1) {
    try { console.log(JSON.stringify(await restoreHostConfig(flags[0]))); }
    catch { console.error("Harnest configuration restore failed"); process.exitCode = 1; }
  } else if (!["claude", "codex", "cursor"].includes(host) || flags.some((flag) => flag !== "--no-autostart")) {
    console.error("Usage: node scripts/install-host-config.mjs claude|codex|cursor [--no-autostart]");
    process.exitCode = 1;
  } else {
    try {
      await setupDaemon({ noAutostart: flags.includes("--no-autostart") });
      if (host === "claude") console.log("Harnest daemon ready for the Claude plugin");
      else console.log(JSON.stringify(await installHostConfig(host)));
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
