import { spawn } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { basename, delimiter, isAbsolute, join, parse, win32 } from "node:path";

const windows = process.platform === "win32";
const windowsExecutable = /^\.(?:com|exe)$/i;

function envValue(env, name) {
  if (!windows) return env[name];
  // Node passes the first lexicographic spelling of a Windows environment key.
  const key = Object.keys(env).filter((key) => key.toUpperCase() === name).sort()[0];
  return env[key];
}

function isFullyQualified(path) {
  // A Windows path rooted at a single slash still depends on the child's drive.
  return isAbsolute(path) && (!windows || parse(path).root.length > 1);
}

export function* trustedPathDirectories(env = process.env) {
  for (const entry of (envValue(env, "PATH") || "").split(delimiter)) {
    const directory = windows ? entry.replace(/^"(.*)"$/, "$1") : entry;
    if (isFullyQualified(directory)) yield directory;
  }
}

export function resolveTrustedCommand(command, env = process.env) {
  if (typeof command !== "string" || !command || command.includes("\0")) return;
  if (isFullyQualified(command)) return command;
  if (basename(command) !== command || command === "." || command === "..") return;

  const names = windows && !windowsExecutable.test(parse(command).ext)
    ? (envValue(env, "PATHEXT") || ".COM;.EXE").split(delimiter)
      .filter((extension) => windowsExecutable.test(extension))
      .map((extension) => command + extension)
    : [command];
  for (const directory of trustedPathDirectories(env)) {
    for (const name of names) {
      const candidate = join(directory, name);
      try {
        if (!statSync(candidate).isFile()) continue;
        if (!windows) accessSync(candidate, constants.X_OK);
        return candidate;
      } catch { /* Try the next PATH candidate. */ }
    }
  }
}

export class NativeLaunchError extends Error {
  constructor(command) {
    super(`Could not find ${JSON.stringify(command)} in absolute PATH directories. Install the CLI or configure an absolute path to it.`);
    this.name = "NativeLaunchError";
    this.details = { kind: "downstream", phase: "launch" };
  }
}

export function requireNativeCommand(command, env) {
  const executable = resolveTrustedCommand(command, env);
  if (!executable) throw new NativeLaunchError(command);
  return executable;
}

let hostWindowsRoot;

export function windowsSystemCommand(command, env = process.env) {
  if (windows && env === process.env && !hostWindowsRoot) {
    // Resolve the Windows object manager's SystemRoot alias to a regular path.
    try { hostWindowsRoot = realpathSync.native("\\\\?\\GLOBALROOT\\SystemRoot"); }
    catch { /* Some environments restrict access to the NT namespace. */ }
  }
  // SystemRoot and windir are trusted host environment when the OS path is unavailable.
  const root = (env === process.env && hostWindowsRoot) || env.SystemRoot || env.windir;
  if (!root || !win32.isAbsolute(root) || win32.parse(root).root.length <= 1) {
    throw new Error("SystemRoot or windir must be a fully qualified Windows path to launch " + command);
  }
  const file = command === "powershell.exe" ? "WindowsPowerShell\\v1.0\\powershell.exe" : command;
  return win32.join(root, "System32", file);
}

export function spawnNativeCommand(command, args, options) {
  return spawn(requireNativeCommand(command, options.env), args, options);
}
