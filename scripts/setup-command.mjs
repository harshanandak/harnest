/** Format a command for pasting into an interactive shell. @param {string} args @param {string} path */
export function setupPathCommand(args, path) {
  const command = `harnest setup ${args}`;
  if (process.platform === "win32") {
    return [
      `Reverse path (PowerShell): ${command} '${path.replace(/['‘’]/gu, "$&$&")}'`,
      `Reverse path (cmd.exe): ${command} "${path}"`,
    ].join("\n");
  }
  return `Reverse path: ${command} '${path.replaceAll("'", "'\\''")}'`;
}
