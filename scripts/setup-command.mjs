import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const checkout = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** Format a command for pasting into an interactive shell. @param {string} args @param {string} [path] */
export function setupCommand(args, path, { platform = process.platform, cli = process.env.HARNEST_SETUP_VIA_CLI === "1" } = {}) {
  const command = (quote) => [
    cli ? "harnest" : `bun run --cwd ${quote(checkout)}`,
    "setup",
    args,
    ...(path ? [quote(path)] : []),
  ].join(" ");
  if (platform !== "win32") return `Reverse path: ${command((value) => `'${value.replaceAll("'", "'\\''")}'`)}`;
  if (cli && !path) return `Reverse path: ${command(String)}`;
  const powershell = command((value) => `'${value.replace(/['‘’]/gu, "$&$&")}'`);
  // Percent expansion and optional delayed expansion also affect quoted cmd.exe arguments.
  const cmd = [cli ? "" : checkout, path ?? ""].some((value) => /[%^&!]/.test(value))
    ? "Use the PowerShell reverse path. cmd.exe can reinterpret characters in this path."
    : `Reverse path (cmd.exe): ${command((value) => `"${value.replace(/\\+$/, "$&$&")}"`)}`;
  return `Reverse path (PowerShell): ${powershell}\n${cmd}`;
}
