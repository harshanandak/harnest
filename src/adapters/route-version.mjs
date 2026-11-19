import { runProcess } from "../process.mjs";

export async function requireRouteVersion(command, args, options, prefix, minimum, field) {
  const { stdout } = await runProcess(command, [...args, "--version"], {
    ...options, timeoutMs: 5_000, maxStdoutBytes: 1_024, maxStderrBytes: 1_024,
  });
  const match = new RegExp(`^${prefix}(\\d+)\\.(\\d+)\\.(\\d+)(?:\\s|$)`).exec(stdout.trim());
  const version = match?.slice(1).map(Number);
  const firstDifference = version?.findIndex((part, index) => part !== minimum[index]);
  if (version && (firstDifference === -1 || version[firstDifference] > minimum[firstDifference])) return;
  throw Object.assign(new Error(`${field} requires ${prefix.trim() || "Claude Code"} ${minimum.join(".")} or later`), {
    details: { kind: "policy", field },
  });
}
