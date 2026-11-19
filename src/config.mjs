import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTrustedCommand, trustedPathDirectories, windowsSystemCommand } from "./launch-command.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// Windows PowerShell 5.1 rebuilds the command line when a .ps1 shim forwards
// $args to a native binary: embedded double quotes are stripped and long or
// quote-heavy prompts can split into fragments (observed: `diff --git` inside a
// prompt surfacing as `unknown option '--git'`). handoff prompts are JSON
// envelopes, so any shim in the spawn path corrupts them. The direct launches
// below bypass the .ps1 entirely by resolving the underlying node entrypoint.
function windowsPowerShellShim(name) {
  if (process.platform !== "win32") return null;
  for (const directory of trustedPathDirectories()) {
    const candidate = join(directory, `${name}.ps1`);
    if (existsSync(candidate)) {
      return { command: windowsSystemCommand("powershell.exe"), args: ["-NoProfile", "-File", candidate] };
    }
  }
  return null;
}

function hasWindowsNodeShim(directory, name) {
  return [".ps1", ".cmd"].some((extension) => existsSync(join(directory, name + extension)));
}

function windowsOpenCodeV2DirectLaunch() {
  if (process.platform !== "win32") return null;
  for (const directory of trustedPathDirectories()) {
    if (!hasWindowsNodeShim(directory, "opencode") && !hasWindowsNodeShim(directory, "opencode2")) continue;
    // The package renamed its native binary across releases; probe current and
    // legacy names so an OpenCode update cannot break direct launch.
    for (const name of ["opencode.exe", "opencode2.exe"]) {
      const executable = join(directory, "node_modules", "@opencode", "cli", "bin", name);
      if (existsSync(executable)) return { command: executable, args: [] };
    }
  }
  return null;
}

function openCodeLaunch() {
  return windowsOpenCodeV2DirectLaunch()
    || resolveTrustedCommand("opencode2")
    || windowsPowerShellShim("opencode2")
    || "opencode";
}

export function isOpenCodeV2Version(output) {
  return /^(?:opencode\s+)?v?2\.\d+\.\d+(?:[-+][\w.+-]+)?$/i.test(output.trim());
}

function parseCursorVersion(name) {
  const match = /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:-(\d{2})-(\d{2})-(\d{2}))?-[a-f0-9]+$/.exec(name);
  if (!match) return null;
  return [match[1], match[2], match[3], match[4] || "00", match[5] || "00", match[6] || "00"].map(Number);
}

function compareVersionTuple(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

// cursor-agent ships node.exe + index.js inside versions/<date>-<hash>/ next to
// its .ps1 shim. Spawn those directly so prompt argv never crosses PowerShell.
function windowsCursorDirectLaunch() {
  if (process.platform !== "win32") return null;
  for (const directory of trustedPathDirectories()) {
    if (!existsSync(join(directory, "cursor-agent.ps1"))) continue;
    let entries;
    try {
      entries = readdirSync(join(directory, "versions"), { withFileTypes: true });
    } catch {
      continue;
    }
    const ranked = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ name: entry.name, tuple: parseCursorVersion(entry.name) }))
      .filter((entry) => entry.tuple)
      .sort((left, right) => compareVersionTuple(left.tuple, right.tuple));
    const latest = ranked.at(-1);
    if (!latest) continue;
    const nodeExe = join(directory, "versions", latest.name, "node.exe");
    const entrypoint = join(directory, "versions", latest.name, "index.js");
    if (existsSync(nodeExe) && existsSync(entrypoint)) {
      return { command: nodeExe, args: [entrypoint] };
    }
  }
  return null;
}

// codex ships as an npm .cmd wrapper around node_modules/@openai/codex.
// Spawning the .cmd without a shell fails on Windows, so resolve the
// underlying node entrypoint the same way the wrapper does.
function windowsCodexDirectLaunch() {
  if (process.platform !== "win32") return null;
  for (const directory of trustedPathDirectories()) {
    if (!existsSync(join(directory, "codex.cmd"))) continue;
    const entrypoint = join(directory, "node_modules", "@openai", "codex", "bin", "codex.js");
    if (!existsSync(entrypoint)) continue;
    const bundledNode = join(directory, "node.exe");
    return {
      command: existsSync(bundledNode) ? bundledNode : process.execPath,
      args: [entrypoint],
    };
  }
  return null;
}

function windowsNodePackageLaunch(name, packageParts) {
  if (process.platform !== "win32") return null;
  for (const directory of trustedPathDirectories()) {
    if (!hasWindowsNodeShim(directory, name)) continue;
    const entrypoint = join(directory, "node_modules", ...packageParts);
    if (existsSync(entrypoint)) return { command: process.execPath, args: [entrypoint] };
  }
  return null;
}

export function readLocalConfig() {
  try {
    return JSON.parse(readFileSync(join(root, "harnest.config.local.json"), "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw new TypeError(`harnest.config.local.json is invalid: ${error.message}`, { cause: error });
    }
    return {};
  }
}

export function harnessCommand(target, injected) {
  return harnessLaunch(target, injected).command;
}

export function harnessLaunch(target, injected, { env = process.env, config } = {}) {
  if (injected) {
    return typeof injected === "string" ? { command: injected, args: [] } : injected;
  }
  const envName = {
    opencode: "HARNEST_OPENCODE_V2",
    pi: "HARNEST_PI",
    cursor: "HARNEST_CURSOR",
    claude: "HARNEST_CLAUDE",
    codex: "HARNEST_CODEX",
    gemini: "HARNEST_GEMINI",
    amp: "HARNEST_AMP",
  }[target];
  if (!envName) throw new TypeError(`unsupported harness launch target: ${target}`);
  const defaults = {
    get opencode() { return openCodeLaunch(); },
    // Pi RPC needs the Node entrypoint so the npm shim cannot drop piped stdin.
    get pi() {
      return windowsNodePackageLaunch("pi", ["@earendil-works", "pi-coding-agent", "dist", "cli.js"])
        || windowsPowerShellShim("pi") || "pi";
    },
    get cursor() {
      return windowsCursorDirectLaunch() || windowsPowerShellShim("cursor-agent") || windowsPowerShellShim("agent") || "cursor-agent";
    },
    claude: "claude",
    get codex() { return windowsCodexDirectLaunch() || "codex"; },
    get gemini() { return windowsNodePackageLaunch("gemini", ["@google", "gemini-cli", "dist", "index.js"]) || "gemini"; },
    amp: "amp",
  };
  const localKey = target === "opencode" ? "opencode2" : target;
  const environmentValue = env[envName];
  const localValue = (config ?? readLocalConfig()).executables?.[localKey];
  const configured = environmentValue || localValue || defaults[target] || target;
  let launch = typeof configured === "string" ? { command: configured, args: [] } : configured;
  const isAbsolute = (value) => typeof value === "string"
    && (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\"));
  // A pin can never be honored after the CLI renames its binary. Fall back to
  // automatic detection with provenance instead of blocking every run until an
  // operator edits the environment; fail only when nothing resolveable remains.
  if (isAbsolute(launch?.command) && !existsSync(launch.command)) {
    const fallback = defaults[target];
    const fallbackLaunch = typeof fallback === "string" ? { command: fallback, args: [] } : fallback;
    const fallbackUsable = isAbsolute(fallbackLaunch?.command) ? existsSync(fallbackLaunch.command) : resolveTrustedCommand(fallbackLaunch?.command);
    if (fallbackUsable) {
      const source = environmentValue ? envName : localValue ? `executables.${localKey}` : "automatic detection";
      launch = { ...fallbackLaunch, fallbackFrom: source, missing: launch.command };
    } else {
      const source = environmentValue ? envName : localValue ? `executables.${localKey}` : "automatic detection";
      throw Object.assign(new Error(`configured ${target} executable does not exist: ${launch.command}`), {
        details: { kind: "not-ready", configured: launch.command, source, hint: `fix ${source} or unset it so automatic detection can run` },
      });
    }
  }
  return launch;
}

export function pluginRoot() {
  return root;
}
