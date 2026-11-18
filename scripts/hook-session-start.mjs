// Claude hook: session start. Prints one status line so the lead knows the
// companion is installed; always exit 0 and make no model calls.
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDaemon } from "../src/daemon-client.mjs";

const GRAPH_FILE = /^graph-[a-f0-9]{64}\.json$/;
// Read-only, best-effort hint. Candidate files are scanned newest-first so an
// actively updated (running) graph stays inside the read cap; the cap keeps
// the hook fast on large state dirs.
const MAX_GRAPHS_READ = 100;
const MAX_RUNNING_LISTED = 5;

async function summarizeRunningGraphs(stateDir) {
  const graphRoot = join(stateDir, "graphs");
  let entries;
  try {
    entries = await readdir(graphRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  const names = entries.filter((entry) => entry.isFile() && GRAPH_FILE.test(entry.name)).map((entry) => entry.name);
  const ranked = await Promise.all(names.map(async (name) => {
    const info = await stat(join(graphRoot, name)).catch(() => null);
    return { name, mtimeMs: info?.mtimeMs ?? 0 };
  }));
  ranked.sort((left, right) => right.mtimeMs - left.mtimeMs);
  const running = [];
  let found = 0;
  let reads = 0;
  for (const { name } of ranked) {
    if (reads >= MAX_GRAPHS_READ) break;
    reads += 1;
    try {
      const record = JSON.parse(await readFile(join(graphRoot, name), "utf8"));
      if (record?.state !== "running") continue;
      found += 1;
      if (running.length >= MAX_RUNNING_LISTED) continue;
      const nodes = Array.isArray(record.nodes) ? record.nodes : [];
      const done = nodes.filter((node) => node.state === "completed").length;
      running.push(`${name.slice(6, 14)} (${done}/${nodes.length})`);
    } catch {
      // Unreadable or mid-write graph record; this is a best-effort hint, skip it.
    }
  }
  if (!found) return null;
  const count = found > running.length ? `at least ${found}` : `${found}`;
  return `${count} workflow graph(s) running: ${running.join(", ")}. Run /workflows to view live.`;
}

try {
  const stateDir = process.env.HARNEST_STATE_DIR
    || (process.platform === "win32"
      ? join(process.env.LOCALAPPDATA || tmpdir(), "harnest", "jobs")
      : join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "harnest", "jobs"));
  let active = 0;
  try {
    const entries = await readdir(stateDir);
    active = entries.filter((name) => name.endsWith(".json") && !name.startsWith("requests")).length;
  } catch {
    active = 0;
  }
  const running = await ensureDaemon().then(() => true, () => false);
  const daemon = running ? "Harnest ready" : "Harnest daemon unavailable";
  const lines = [`${daemon} (handoff skill + 9 bridge workers available). ${active} durable job file(s) in state dir; recover any run with handoff_status by requestId.`];
  const graphLine = await summarizeRunningGraphs(stateDir);
  if (graphLine) lines.push(graphLine);
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: lines.join(" "),
    },
  }));
} catch {
  // Best-effort only.
}
process.exit(0);
