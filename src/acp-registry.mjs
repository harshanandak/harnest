import { readLocalConfig } from "./config.mjs";
import { isFullyQualified } from "./launch-command.mjs";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FIELDS = new Set(["command", "args", "trusted", "registryId", "version", "protocolVersion"]);

function error(message, kind = "config") {
  return Object.assign(new TypeError(message), { details: { kind } });
}

function sourceRegistrations(registrations) {
  let source = registrations;
  if (registrations === undefined) {
    let config;
    try { config = readLocalConfig(); }
    catch { throw error("harnest.config.local.json is invalid"); }
    if (config.acp !== undefined && (!config.acp || typeof config.acp !== "object" || Array.isArray(config.acp))) {
      throw error("acp must be an object");
    }
    source = config.acp?.agents;
  }
  if (source === undefined) return {};
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw error("acp.agents must be an object keyed by agent id");
  }
  return source;
}

function text(value, label, max = 4096) {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) {
    throw error(`${label} must be a non-empty string without NUL bytes`);
  }
  return value.trim();
}

function validate(agentId, raw) {
  const id = text(agentId, "ACP agent id", 128);
  if (!ID.test(id)) throw error("ACP agent id is invalid");
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw error(`ACP agent ${id} registration must be an object`);
  const unsupported = Object.keys(raw).filter((key) => !FIELDS.has(key));
  if (unsupported.length) throw error(`ACP agent ${id} registration has unsupported fields: ${unsupported.join(", ")}`);
  if (raw.trusted !== true) throw error(`ACP agent ${id} is not trusted`, "policy");
  const command = text(raw.command, `ACP agent ${id} command`);
  if (!isFullyQualified(command)) {
    const addPreset = "acp add <preset-id> --trust";
    const hint = process.env.HARNEST_INVOKED_VIA_CLI === "1"
      ? `harnest ${addPreset}`
      : `bun run ${addPreset} from a checkout or harnest ${addPreset} with the global CLI`;
    throw error(`ACP agent ${id} command must be an absolute executable path. Set the path in the manual registration or register a preset with ${hint}.`);
  }
  if (!Array.isArray(raw.args) || raw.args.length > 128) throw error(`ACP agent ${id} args must be an array of at most 128 strings`);
  const args = raw.args.map((value, index) => {
    if (typeof value !== "string" || value.length > 16_384 || value.includes("\0")) {
      throw error(`ACP agent ${id} args[${index}] must be a bounded string without NUL bytes`);
    }
    return value;
  });
  const optional = {};
  if (raw.registryId !== undefined) optional.registryId = text(raw.registryId, `ACP agent ${id} registryId`, 256);
  if (raw.version !== undefined) optional.version = text(raw.version, `ACP agent ${id} version`, 128);
  if (raw.protocolVersion !== undefined) {
    if (![1, 2].includes(raw.protocolVersion)) throw error(`ACP agent ${id} protocolVersion must be 1 or 2`);
    optional.protocolVersion = raw.protocolVersion;
  }
  return Object.freeze({ id, command, args: Object.freeze(args), trusted: true, ...optional });
}

export async function resolveAcpAgent(agentId, { registrations } = {}) {
  const id = text(agentId, "route.agent", 128);
  if (!ID.test(id)) throw error("route.agent is invalid", "validation");
  const source = sourceRegistrations(registrations);
  if (!Object.prototype.hasOwnProperty.call(source, id)) throw error(`ACP agent ${id} is not registered`);
  return validate(id, source[id]);
}

export function listConfiguredAcpAgents({ registrations } = {}) {
  const source = sourceRegistrations(registrations);
  return Object.keys(source).sort().map((id) => {
    if (!ID.test(id)) throw error("acp.agents contains an invalid agent id");
    const raw = source[id];
    const item = { id, trusted: raw?.trusted === true };
    if (raw?.registryId !== undefined) item.registryId = text(raw.registryId, `ACP agent ${id} registryId`, 256);
    if (raw?.version !== undefined) item.version = text(raw.version, `ACP agent ${id} version`, 128);
    if ([1, 2].includes(raw?.protocolVersion)) item.protocolVersion = raw.protocolVersion;
    return item;
  });
}
