import { mkdir, readFile, readdir, stat, writeFile, unlink, rename } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { basename, dirname, join, resolve } from "node:path";

import { readDaemonToken } from "../src/daemon-settings.mjs";
import { setupDaemon } from "./install-daemon.mjs";
import { httpEntry } from "./install-host-config.mjs";
import { backupStamp, replaceWithBackup, writeInstallerFile } from "./install-files.mjs";
import { setupPathCommand } from "./setup-command.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const object = value => value && typeof value === "object" && !Array.isArray(value);

export function openCodeConfigDir(env = process.env) {
  return join(env.XDG_CONFIG_HOME || join(env.USERPROFILE || env.HOME, ".config"), "opencode");
}

export async function latestInstallManifest(configDir) {
  const backups = resolve(configDir, ".harnest-backups");
  const entries = await readdir(backups, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
  for (const name of names) {
    const path = join(backups, name, "manifest.json");
    const file = await stat(path).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (file?.isFile()) return path;
  }
  return null;
}

// Tokenize strings before stripping JSONC comments/trailing commas so URLs and
// escaped quotes inside user settings remain intact. JSON.parse validates syntax.
export function parseConfig(raw) {
  const strings = [];
  const text = raw.replace(/^\uFEFF/, "").replace(/"(?:\\.|[^"\\])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g, token => {
    if (!token.startsWith('"')) return " ";
    strings.push(token);
    return `\u0000${strings.length - 1}\u0000`;
  }).replace(/,\s*([}\]])/g, "$1").replace(/\u0000(\d+)\u0000/g, (_match, index) => strings[index]);
  let config;
  try { config = JSON.parse(text); } catch { throw new Error("OpenCode configuration is invalid JSONC"); }
  if (!object(config)) throw new Error("OpenCode config must be an object");
  return config;
}

async function current(path) {
  try { return await readFile(path); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

const isConfigFile = (path) => /^opencode\.jsonc?$/.test(basename(path));

async function writeAtomic(path, bytes) {
  const staging = `${path}.${randomUUID()}.tmp`;
  try {
    await writeInstallerFile(staging, bytes, { sensitive: isConfigFile(path) });
    await rename(staging, path);
  } finally {
    await unlink(staging).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
}

export async function restoreIntegration(manifestPath) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.version !== 1 || !Array.isArray(manifest.files)) throw new Error("Invalid installation manifest");
  // Preflight every file before restoring any, so later user edits are not lost.
  const files = [];
  for (const file of manifest.files) {
    const now = await current(file.path);
    const backup = file.backup ? await readFile(file.backup) : null;
    if (backup && digest(backup) !== file.before) throw new Error(`Backup changed: ${file.backup}`);
    const hash = now === null ? null : digest(now);
    if (hash !== file.after && hash !== file.before) throw new Error(`File changed since install: ${file.path}`);
    files.push({ ...file, backup, restored: hash === file.before });
  }
  for (const file of files.reverse()) {
    if (file.restored) {
      if (file.backup && isConfigFile(file.path)) await replaceWithBackup(file.path, file.backup, file.backup, { sensitive: true });
      continue;
    }
    if (file.backup === null) await unlink(file.path);
    else await writeAtomic(file.path, file.backup);
  }
  return { restored: files.length };
}

export async function installIntegration(configDir, { token, prepareDaemon } = {}) {
  configDir = resolve(configDir);
  const json = join(configDir, "opencode.json");
  const jsonc = join(configDir, "opencode.jsonc");
  const configPaths = [json, jsonc];
  const originalFiles = await Promise.all(configPaths.map(current));
  if (originalFiles.every((bytes) => bytes !== null)) throw new Error("Both opencode.json and opencode.jsonc exist; consolidate them before installing");
  const selected = originalFiles[1] === null ? 0 : 1;
  const configPath = configPaths[selected];
  const original = originalFiles[selected];
  const assertConfigUnchanged = async () => {
    const files = await Promise.all(configPaths.map(current));
    if (files.some((bytes, index) => {
      const originalBytes = originalFiles[index];
      return bytes === null || originalBytes === null ? bytes !== originalBytes : !bytes.equals(originalBytes);
    })) {
      throw new Error("OpenCode configuration changed during daemon preparation or installation. Retry with the current config.");
    }
  };
  const config = original ? parseConfig(original.toString("utf8")) : { $schema: "https://opencode.ai/config.json" };
  const migrateConfig = () => {
    throw new Error("Migrate the OpenCode configuration to V2 before installing Harnest. Use plugins and mcp.servers (https://opencode.ai/docs/migrate-v1/).");
  };
  if (config.mcp !== undefined && !object(config.mcp)) throw new Error("mcp must be an object");
  config.mcp ??= {};
  if (config.mcp.servers !== undefined && !object(config.mcp.servers)) throw new Error("mcp.servers must be an object");
  if (Object.hasOwn(config, "plugin") || Object.hasOwn(config.mcp, "harnest")
    || Object.entries(config.mcp).some(([key, entry]) =>
    key !== "servers" && object(entry) && ["type", "enabled", "command", "url"].some((field) => Object.hasOwn(entry, field)))) {
    migrateConfig();
  }
  const servers = config.mcp.servers ??= {};
  if (Object.values(servers).some((entry) => object(entry) &&
    (Object.hasOwn(entry, "enabled") || typeof entry.timeout === "number"))) migrateConfig();
  if (config.plugins !== undefined && !Array.isArray(config.plugins)) throw new Error("plugins must be an array");
  const plugins = config.plugins ?? [];
  if (plugins.some(Array.isArray)) migrateConfig();

  const previous = Object.hasOwn(servers, "harnest") ? servers.harnest : {};
  if (!object(previous)) throw new Error("The Harnest MCP entry must be an object");
  const entry = "./plugins/harnest";
  config.plugins = plugins.some((value) => (value?.package ?? value) === entry) ? plugins : [...plugins, entry];

  await prepareDaemon?.();
  token ??= await readDaemonToken();
  const { command, environment, cwd, ...previousRemote } = previous;
  const connection = httpEntry(token);
  const headers = Object.fromEntries(Object.entries(previousRemote.headers ?? {})
    .filter(([name]) => name.toLowerCase() !== "authorization"));
  servers.harnest = {
    ...previousRemote,
    type: "remote",
    ...connection,
    headers: { ...headers, ...connection.headers },
    oauth: false,
    disabled: previous.disabled ?? false,
    codemode: previous.codemode ?? false,
    timeout: previous.timeout ?? { startup: 15_000, catalog: 15_000 },
  };

  const candidates = [];
  const add = async (source, relative) => {
    let bytes = await readFile(join(root, source));
    if (source === "opencode-plugin/harnest.mjs") bytes = Buffer.from(bytes.toString("utf8").replace("__HARNEST_DAEMON_CLIENT_URL__", pathToFileURL(join(root, "src", "daemon-client.mjs")).href));
    if (source === "opencode-plugin/dynamic-ui.mjs") bytes = Buffer.from(bytes.toString("utf8").replace("__HARNEST_DYNAMIC_CLIENT_URL__", pathToFileURL(join(root, "src", "daemon-client.mjs")).href));
    candidates.push({ path: join(configDir, relative), bytes });
  };
  for (const name of ["opencode-worker.md", "pi-worker.md", "cursor-worker.md", "claude-worker.md", "codex-worker.md", "amp-worker.md", "acp-worker.md"]) {
    await add(`opencode-agents/${name}`, `agents/${name}`);
  }
  const addTree = async (source, relative) => {
    for (const entry of await readdir(join(root, source), { withFileTypes: true })) {
      if (entry.isDirectory()) await addTree(`${source}/${entry.name}`, `${relative}/${entry.name}`);
      else if (entry.isFile()) await add(`${source}/${entry.name}`, `${relative}/${entry.name}`);
    }
  };
  await addTree("skills/handoff", "skills/handoff");
  for (const name of await readdir(join(root, "opencode-plugin"))) {
    if (/\.(mjs|js|tsx|ts)$/.test(name) || name === "package.json") await add(`opencode-plugin/${name}`, `plugins/harnest/${name}`);
  }
  for (const name of ["handoff.md", "handoff-status.md", "handoff-graph.md"]) await add(`opencode-commands/${name}`, `commands/${name}`);
  // Keep JSONC byte-for-byte on a no-op install, including its comments.
  const unchanged = original && JSON.stringify(parseConfig(original.toString("utf8"))) === JSON.stringify(config);
  candidates.push({ path: configPath, bytes: unchanged ? original : Buffer.from(JSON.stringify(config, null, 2) + "\n") });
  const changes = [];
  for (const file of candidates) {
    const before = file.path === configPath ? original : await current(file.path);
    if (before?.equals(file.bytes)) continue;
    changes.push({ ...file, before });
  }
  await assertConfigUnchanged();
  if (unchanged) await replaceWithBackup(configPath, original, original, { sensitive: true });
  if (!changes.length) return { changed: [], manifest: null };
  const backupDir = join(configDir, ".harnest-backups", backupStamp());
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  const manifest = { version: 1, files: [] };
  for (const [index, file] of changes.entries()) {
    const backup = file.before === null ? null : join(backupDir, `${index}.bak`);
    if (backup) await writeInstallerFile(backup, file.before, { sensitive: isConfigFile(file.path) });
    manifest.files.push({ path: file.path, backup, before: file.before === null ? null : digest(file.before), after: digest(file.bytes) });
  }
  const manifestPath = join(backupDir, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
  try {
    for (const file of changes) {
      if (file.path === configPath) await assertConfigUnchanged();
      const now = await current(file.path);
      if ((now === null ? null : digest(now)) !== (file.before === null ? null : digest(file.before))) throw new Error(`File changed during install: ${file.path}`);
      await mkdir(dirname(file.path), { recursive: true });
      await writeAtomic(file.path, file.bytes);
      const written = await current(file.path);
      if (!written?.equals(file.bytes)) throw new Error(`Read-back failed: ${file.path}`);
    }
  } catch (error) {
    throw new Error(`Installation interrupted.\n${setupPathCommand("opencode --restore", manifestPath)}`, { cause: error });
  }
  return { changed: changes.map(file => file.path), manifest: manifestPath };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.versions.bun) throw new Error("Run this installer with Node, not Bun");
  const noAutostart = process.argv.includes("--no-autostart");
  const args = process.argv.slice(2).filter((arg) => arg !== "--no-autostart");
  if (args[0] === "--restore" && args.length === 2) console.log(JSON.stringify(await restoreIntegration(resolve(args[1]))));
  else {
    if (args.length && !(args[0] === "--config-dir" && args.length === 2)) throw new Error("Usage: node scripts/install-opencode-integration.mjs [--config-dir PATH] [--no-autostart] or --restore MANIFEST");
    const configDir = args[1] ?? openCodeConfigDir();
    const result = await installIntegration(configDir, { prepareDaemon: () => setupDaemon({ noAutostart }) });
    console.log(JSON.stringify(result, null, 2));
    const manifest = result.manifest ?? await latestInstallManifest(configDir);
    if (manifest) console.log(setupPathCommand("opencode --restore", manifest));
  }
}
