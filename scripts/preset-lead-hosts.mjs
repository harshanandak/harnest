import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";

const roaming = (home, env) => env.APPDATA || join(home, "AppData", "Roaming");
const xdg = (home, env) => env.XDG_CONFIG_HOME || join(home, ".config");
const expandHome = (path, home) => path === "~" ? home : path.replace(/^~[/\\]/, () => home + "/");

function kiloConfig(home, env) {
  if (env.KILO_CONFIG) return resolve(env.KILO_CONFIG);
  const dir = join(xdg(home, env), "kilo");
  const jsonc = join(dir, "kilo.jsonc");
  return existsSync(jsonc) ? jsonc : join(dir, "kilo.json");
}

function kiroHome(home, env) {
  const path = env.KIRO_HOME;
  if (path && isAbsolute(path)) {
    const absolute = resolve(path);
    const toHome = relative(absolute, home);
    if (absolute !== parse(absolute).root && (isAbsolute(toHome) || toHome === ".." || toHome.startsWith(".." + sep))) return absolute;
  }
  return join(home, ".kiro");
}

export const presetBridgeHosts = {
  "github-copilot-cli": {
    path: (home, env) => join(env.COPILOT_HOME || join(home, ".copilot"), "mcp-config.json"),
    entry: (bridge) => ({ type: "local", ...bridge, tools: ["*"] }),
  },
  "qwen-code": {
    path: (home, env) => join(env.QWEN_HOME ? resolve(expandHome(env.QWEN_HOME, home)) : join(home, ".qwen"), "settings.json"),
    format: "json-with-comments",
  },
  kilo: {
    path: kiloConfig,
    key: "mcp",
    format: "jsonc",
    entry: ({ command, args, env }) => ({ type: "local", command: [command, ...args], environment: env, enabled: true }),
  },
  cline: {
    path: (home, env) => env.CLINE_MCP_SETTINGS_PATH || join(env.CLINE_DATA_DIR || join(env.CLINE_DIR || join(home, ".cline"), "data"), "settings", "cline_mcp_settings.json"),
    entry: (bridge) => ({ transport: { type: "stdio", ...bridge } }),
  },
  kiro: {
    path: (home, env) => join(kiroHome(home, env), "settings", "mcp.json"),
  },
  "factory-droid": {
    path: (home) => join(home, ".factory", "mcp.json"),
    entry: (bridge) => ({ type: "stdio", ...bridge }),
  },
  auggie: {
    path: (home) => join(home, ".augment", "settings.json"),
    format: "jsonc",
  },
  kimi: {
    path: (home, env) => join(env.KIMI_SHARE_DIR || join(home, ".kimi"), "mcp.json"),
  },
  devin: {
    path: (home, env, platform) => join(platform === "win32" ? roaming(home, env) : join(home, ".config"), "devin", "mcp_config.json"),
    format: "json-with-comments",
  },
};

const manualHosts = {
  goose: {
    path(home, env, platform) {
      if (env.GOOSE_PATH_ROOT && isAbsolute(env.GOOSE_PATH_ROOT)) return join(env.GOOSE_PATH_ROOT, "config", "config.yaml");
      if (platform === "win32") return join(roaming(home, env), "Block", "goose", "config", "config.yaml");
      if (platform === "darwin") return join(home, "Library", "Application Support", "Block", "goose", "config.yaml");
      return join(xdg(home, env), "goose", "config.yaml");
    },
    merge: "Add or replace harnest under extensions. Create extensions if it is missing.",
    snippet({ command, args, env }) {
      return ["extensions:", "  harnest:", "    name: harnest", "    enabled: true", "    type: stdio",
        `    cmd: ${JSON.stringify(command)}`, `    args: ${JSON.stringify(args)}`, "    envs:",
        ...Object.entries(env).map(([name, value]) => `      ${name}: ${JSON.stringify(value)}`)].join("\n");
    },
    verify: "Run goose info -v and check the config path and the harnest extension.",
  },
  "mistral-vibe": {
    path: (home, env) => join(env.VIBE_HOME ? expandHome(env.VIBE_HOME, home) : join(home, ".vibe"), "config.toml"),
    merge: 'Add this table or replace the existing [[mcp_servers]] table with name = "harnest".',
    snippet({ command, args, env }) {
      const entries = Object.entries(env).map(([name, value]) => `${name} = ${JSON.stringify(value)}`);
      return ['[[mcp_servers]]', 'name = "harnest"', 'transport = "stdio"',
        `command = ${JSON.stringify(command)}`, `args = ${JSON.stringify(args)}`, `env = { ${entries.join(", ")} }`].join("\n");
    },
    verify: "Restart Vibe and run /mcp harnest to list the Harnest tools.",
  },
};

export const manualBridgeHosts = Object.keys(manualHosts);

export function manualBridgeConfig(host, { home = homedir(), env = process.env, platform = process.platform } = {}) {
  if (!Object.hasOwn(manualHosts, host)) return null;
  const { path, merge, snippet, verify } = manualHosts[host];
  return { path: path(home, env, platform), merge, snippet, verify };
}
