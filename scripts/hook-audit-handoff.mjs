// Claude hook: after a Harnest MCP tool call. Audit trail only;
// always exit 0. Never deny here — a deny-happy PostToolUse hook breaks polling.
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

try {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  const tool = JSON.parse(input || "{}")?.tool_input?.tool_name || JSON.parse(input || "{}")?.tool_name || "unknown";
  const dir = join(process.env.HARNEST_STATE_DIR || join(homedir(), ".harnest"), "hook-log");
  await mkdir(dir, { recursive: true }).catch(() => {});
  const line = JSON.stringify({ at: new Date().toISOString(), hook: "PostToolUse", tool: String(tool).slice(0, 120) }) + "\n";
  await appendFile(join(dir, "tools.jsonl"), line).catch(() => {});
} catch {
  // Best-effort only.
}
process.exit(0);
