// Claude hook: a bridge worker started. Best-effort log only; always exit 0.
// Never block or deny here — a failing Start hook breaks the worker launch.
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

try {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  const dir = join(process.env.HARNEST_STATE_DIR || join(homedir(), ".harnest"), "hook-log");
  await mkdir(dir, { recursive: true }).catch(() => {});
  const line = JSON.stringify({ at: new Date().toISOString(), hook: "SubagentStart", bytes: input.length }) + "\n";
  await appendFile(join(dir, "workers.jsonl"), line).catch(() => {});
} catch {
  // Best-effort only.
}
process.exit(0);
