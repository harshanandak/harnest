// Probe live model lists per harness and snapshot them for freshness checks.
// This command probes Cursor; other catalogs remain explicitly unchecked.
// Alias resolution and profile defaults do not prove model freshness.
// Never spends a model call:
// --list-models is metadata only. Never rewrites pins; it only warns.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bareModelId, comparePins, defaultSnapshotPath, isSnapshotFresh, probeCursorModels } from "../src/model-freshness.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function defaultPolicyPath() {
  return process.env.HARNEST_ROUTING_POLICY || join(homedir(), ".harnest", "routing.json");
}

const args = process.argv.slice(2);
const get = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
};
if (args.includes("--help") || args.includes("-h")) {
  console.log("Usage: node scripts/refresh-models.mjs [--out path] [--policy path]\nProbes live model lists (metadata only, no inference) and checks pinned models.");
  process.exit(0);
}

const snapshot = {
  at: new Date().toISOString(),
  harnesses: {
    cursor: probeCursorModels(),
    claude: { unknown: "catalog not probed; alias resolution is not freshness verification" },
    pi: { unknown: "catalog not probed; profile defaults are not freshness verification" },
    codex: { unknown: "catalog not probed" },
    opencode: { unknown: "catalog not probed by this command; inspect opencode models" },
    amp: { unknown: "native model catalog unavailable; --mode is not a model pin" },
  },
};

const outPath = get("--out") || defaultSnapshotPath();
await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, JSON.stringify(snapshot, null, 2) + "\n");
console.log(`snapshot: ${outPath} at ${snapshot.at}`);
const cursor = snapshot.harnesses.cursor;
if (cursor.models) {
  console.log(`cursor models (${cursor.models.length}): ${cursor.models.slice(0, 12).join(" | ")}${cursor.models.length > 12 ? " | ..." : ""}`);
  if (cursor.cheap?.length) console.log(`cheap lanes: ${cursor.cheap.join(" | ")}`);
} else {
  console.log(`cursor list unknown: ${cursor.unknown}`);
}

const policyPath = get("--policy") || defaultPolicyPath();
let pins = {};
try {
  if (existsSync(policyPath)) {
    const parsed = JSON.parse(await readFile(policyPath, "utf8"));
    if (parsed?.models && typeof parsed.models === "object") pins = parsed.models;
  }
} catch { console.error("policy is unreadable or invalid JSON; pins were not checked"); process.exitCode = 1; }
const warnings = comparePins(pins, snapshot);
if (!Object.keys(pins).length) {
  console.log("no pinned models in user policy; nothing to verify (omitted models follow harness defaults)");
} else if (!warnings.length) {
  const checked = Object.keys(pins).filter(target => Array.isArray(snapshot.harnesses[target]?.models));
  const unchecked = Object.keys(pins).filter(target => !checked.includes(target));
  console.log(`catalog matches: ${checked.length}; unchecked: ${unchecked.join(", ") || "none"}. Catalog presence does not verify inference or quota.`);
} else {
  for (const warning of warnings) console.log(`WARN [${warning.target}] ${warning.model}: ${warning.reason}`);
  process.exitCode = 1;
}
if (!isSnapshotFresh(snapshot)) {
  console.log("snapshot is stale; re-run before trusting pins");
  process.exitCode = 1;
}
