import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ACP_PRESETS } from "../src/acp-presets.mjs";
import { listConfiguredAcpAgents } from "../src/acp-registry.mjs";
import { resolveTrustedCommand } from "../src/launch-command.mjs";

export const OFFICIAL_ACP_REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const DEFAULT_MAX_BYTES = 2_000_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const defaultConfigPath = join(root, "harnest.config.local.json");

function nonEmpty(value, label, max = 4096) {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) throw new TypeError(`${label} is invalid`);
  return value.trim();
}

function metadata(entry) {
  return {
    id: entry.id,
    name: entry.name,
    version: entry.version,
    description: entry.description,
  };
}

export function validateRegistryDocument(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("ACP registry document is invalid");
  nonEmpty(value.version, "ACP registry version", 128);
  if (!Array.isArray(value.agents) || value.agents.length > 5000) throw new TypeError("ACP registry agents list is invalid");
  const seen = new Set();
  for (const [index, entry] of value.agents.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || !ID.test(entry.id || "")) throw new TypeError(`ACP registry agent ${index} is invalid`);
    if (seen.has(entry.id)) throw new TypeError(`ACP registry agent id ${entry.id} is duplicated`);
    seen.add(entry.id);
    nonEmpty(entry.name, `ACP registry agent ${entry.id} name`, 256);
    nonEmpty(entry.version, `ACP registry agent ${entry.id} version`, 128);
    if (entry.description !== undefined && (typeof entry.description !== "string" || entry.description.length > 10_000)) throw new TypeError(`ACP registry agent ${entry.id} description is invalid`);
  }
  return value;
}

export async function fetchOfficialRegistry({ fetchFn = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (typeof fetchFn !== "function") throw new TypeError("fetch is unavailable");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new TypeError("timeoutMs is invalid");
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 10_000_000) throw new TypeError("maxBytes is invalid");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchFn(OFFICIAL_ACP_REGISTRY_URL, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!response?.ok) throw new Error(`ACP registry request failed with HTTP ${response?.status ?? "unknown"}`);
    const contentType = response.headers?.get?.("content-type");
    if (contentType && !/^(?:application|text)\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/i.test(contentType)) {
      await response.body?.cancel?.().catch(() => {});
      throw new TypeError("ACP registry response content type is not JSON");
    }
    const reader = response.body?.getReader?.();
    const length = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(length) && length > maxBytes) {
      await reader?.cancel?.().catch(() => {});
      throw new Error("ACP registry response is too large");
    }
    let body;
    if (reader) {
      const chunks = [];
      let bytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        bytes += chunk.byteLength;
        if (bytes > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new Error("ACP registry response is too large");
        }
        chunks.push(chunk);
      }
      body = Buffer.concat(chunks, bytes).toString("utf8");
    } else {
      body = await response.text();
      if (Buffer.byteLength(body, "utf8") > maxBytes) throw new Error("ACP registry response is too large");
    }
    let parsed;
    try { parsed = JSON.parse(body); } catch { throw new TypeError("ACP registry response is invalid JSON"); }
    return validateRegistryDocument(parsed);
  } finally {
    clearTimeout(timer);
  }
}

export function listRegistryAgents(registry) {
  return validateRegistryDocument(registry).agents.map(metadata);
}

export function describeRegistryAgent(registry, agentId) {
  const id = nonEmpty(agentId, "registry agent id", 128);
  const entry = validateRegistryDocument(registry).agents.find((candidate) => candidate.id === id);
  if (!entry) throw new TypeError(`ACP registry agent ${id} was not found`);
  return metadata(entry);
}

async function readConfig(path) {
  const raw = await readFile(path, "utf8").catch((error) => { if (error?.code === "ENOENT") return "{}"; throw error; });
  let config;
  try { config = JSON.parse(raw); } catch { throw new TypeError("local config contains invalid JSON"); }
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new TypeError("local config must contain an object");
  return config;
}

async function updateConfig(path, update, { timeoutMs = 10_000 } = {}) {
  await mkdir(dirname(path), { recursive: true });
  const lock = `${path}.lock`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { await mkdir(lock); break; }
    catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Error(`ACP config is locked: ${lock}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  try {
    const config = await readConfig(path);
    await update(config);
    const temporary = join(dirname(path), `.acp-config-${randomUUID()}.json`);
    try {
      await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
    JSON.parse(await readFile(path, "utf8"));
  } finally { await rm(lock, { recursive: true, force: true }); }
}

export function registerAcpAgent(options) {
  return registerLaunch(options, { fromRegistry: true });
}

async function registerLaunch({ registry, agentId, command, args = [], trust, protocolVersion, configPath = defaultConfigPath } = {}, { fromRegistry = false } = {}) {
  if (trust !== true) throw new TypeError("register requires explicit --trust");
  const selected = fromRegistry ? describeRegistryAgent(registry, agentId) : undefined;
  const id = selected?.id ?? agentId;
  const nativeCommand = nonEmpty(command, "--command");
  if (!Array.isArray(args) || args.length > 128 || args.some((arg) => typeof arg !== "string" || arg.length > 16_384 || arg.includes("\0"))) {
    throw new TypeError("--arg values are invalid");
  }
  if (protocolVersion !== undefined && ![1, 2].includes(protocolVersion)) throw new TypeError("--protocol-version must be 1 or 2");
  if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(nativeCommand)) {
    throw new TypeError("ACP cannot launch Windows .cmd or .bat shims. Pass --command with the path to the native executable.");
  }
  const executable = resolveTrustedCommand(nativeCommand);
  if (!executable) throw new TypeError("Could not resolve the ACP executable on PATH. Pass an absolute --command path to a native executable.");
  const stored = {
    command: executable,
    args: [...args],
    trusted: true,
    ...(selected && { registryId: selected.id, version: selected.version }),
    ...(protocolVersion === undefined ? {} : { protocolVersion }),
  };
  await updateConfig(configPath, async (config) => {
    if (config.acp !== undefined && (!config.acp || typeof config.acp !== "object" || Array.isArray(config.acp))) throw new TypeError("local config acp must be an object");
    const acp = config.acp || {};
    if (acp.agents !== undefined && (!acp.agents || typeof acp.agents !== "object" || Array.isArray(acp.agents))) throw new TypeError("local config acp.agents must be an object");
    const agents = acp.agents || {};
    config.acp = { ...acp, agents: { ...agents, [id]: stored } };
  });
  return { id, ...stored };
}

function usage() {
  return "Usage: bun run acp list [--config <path>] | describe <registry-id> | register <registry-id> --command <native-executable> [--arg <value> ...] [--protocol-version 1|2] --trust | add <preset-id> [--command <native-executable>] [--protocol-version 1|2] --trust";
}

function parseRegisterArgs(argv) {
  const result = { args: [], trust: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--trust") result.trust = true;
    else if (["--command", "--arg", "--config", "--protocol-version"].includes(value)) {
      const next = argv[++index];
      if (next === undefined) throw new TypeError(`${value} requires a value`);
      if (value === "--command") result.command = next;
      else if (value === "--arg") result.args.push(next);
      else if (value === "--config") result.configPath = next;
      else result.protocolVersion = Number(next);
    } else throw new TypeError("unknown argument; expected --command, --arg, --protocol-version, --config, or --trust");
  }
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const [action, agentId, ...rest] = argv;
  if (!action || !["list", "describe", "register", "add"].includes(action)) throw new TypeError(usage());
  if (action === "add") {
    if (!agentId) throw new TypeError(usage());
    const preset = ACP_PRESETS.find(({ id }) => id === agentId);
    if (!preset) throw new TypeError(`Unknown ACP preset ${JSON.stringify(agentId)}. Available presets: ${ACP_PRESETS.map(({ id }) => id).join(", ")}`);
    const options = parseRegisterArgs(rest);
    if (options.args.length) throw new TypeError("add uses the preset's arguments. Use register to supply --arg values.");

    const launch = { command: nonEmpty(options.command ?? preset.command, "--command"), args: preset.args };
    if (!options.trust) {
      process.stderr.write(`ACP preset ${preset.id} launch: ${JSON.stringify(launch)}\n${preset.installHint} ${preset.docsUrl}\n`);
    }
    const saved = await registerLaunch({ ...options, ...launch, agentId: preset.id });
    process.stdout.write(`${JSON.stringify({ registered: saved.id, trusted: saved.trusted, command: saved.command, args: saved.args, verified: preset.verified, protocolVersion: saved.protocolVersion }, null, 2)}\n`);
    return;
  }
  const registry = await fetchOfficialRegistry();
  if (action === "list") {
    if (agentId !== undefined && (agentId !== "--config" || rest.length !== 1)) throw new TypeError(usage());
    const config = await readConfig(rest[0] ?? defaultConfigPath);
    const registrations = config.acp?.agents ?? {};
    const configuredAgents = listConfiguredAcpAgents({ registrations }).map((agent) => {
      const command = registrations[agent.id]?.command;
      return typeof command === "string" ? { ...agent, command } : agent;
    });
    process.stdout.write(`${JSON.stringify({ registry: OFFICIAL_ACP_REGISTRY_URL, version: registry.version, agents: listRegistryAgents(registry), configuredAgents }, null, 2)}\n`);
    return;
  }
  if (!agentId) throw new TypeError(usage());
  if (action === "describe") {
    if (rest.length) throw new TypeError(usage());
    process.stdout.write(`${JSON.stringify(describeRegistryAgent(registry, agentId), null, 2)}\n`);
    return;
  }
  const saved = await registerAcpAgent({ registry, agentId, ...parseRegisterArgs(rest) });
  process.stdout.write(`${JSON.stringify({ registered: saved.id, trusted: true, registryId: saved.registryId, version: saved.version, ...(saved.protocolVersion === undefined ? {} : { protocolVersion: saved.protocolVersion }) }, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
