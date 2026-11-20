import { mkdir, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

export async function withHarnestOnPath(directory, env) {
  await mkdir(directory, { recursive: true });
  const cli = fileURLToPath(new URL("../../scripts/harnest.mjs", import.meta.url));
  const windows = process.platform === "win32";
  const quote = (arg) => `'${arg.replaceAll("'", "'\\''")}'`;
  const shim = windows
    ? `@"${process.execPath}" "${cli}" %*\r\n`
    : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(cli)} "$@"\n`;
  await writeFile(join(directory, windows ? "harnest.cmd" : "harnest"), shim, { mode: 0o700 });
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  return { ...env, [pathKey]: directory + delimiter + env[pathKey] };
}
