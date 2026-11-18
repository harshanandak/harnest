// Model freshness: compare pinned models against a live-probed snapshot.
// Snapshots older than 24h are treated as unknown, never as permission to
// keep routing to a possibly-retired pin. This module is pure (testable);
// scripts/refresh-models.mjs does the probing and file IO.
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { harnessLaunch } from "./config.mjs";
import { requireNativeCommand } from "./launch-command.mjs";

export const SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;

export function defaultSnapshotPath(env = process.env) {
  return join(env.HARNEST_STATE_DIR
    || (process.platform === "win32"
      ? join(env.LOCALAPPDATA || homedir(), "harnest")
      : join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "harnest")),
  "model-snapshot.json");
}

export function bareModelId(line) {
  return String(line || "").split(" - ")[0].trim();
}

// Metadata-only probe (no inference): cursor-agent --list-models.
export function probeCursorModels() {
  try {
    const launch = harnessLaunch("cursor");
    const result = spawnSync(requireNativeCommand(launch.command), [...(launch.args || []), "--list-models"], {
      encoding: "utf8",
      timeout: 30000,
      windowsHide: true,
      shell: false,
    });
    if (result.status !== 0) return { unknown: `cursor-agent --list-models exited ${result.status}` };
    const models = String(result.stdout || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      .filter((line) => !/^available models$/i.test(line));
    if (!models.length) return { unknown: "empty model list" };
    const cheap = models.filter((line) => /composer|grok/i.test(line)).slice(0, 8);
    return { models, cheap, probe: "cursor-agent --list-models" };
  } catch (error) {
    return { unknown: error?.message || "probe failed" };
  }
}

export function snapshotAge(at, now = Date.now()) {
  const then = Date.parse(at);
  if (!Number.isFinite(then)) return null;
  return now - then;
}

export function isSnapshotFresh(snapshot, now = Date.now()) {
  if (!snapshot || typeof snapshot !== "object") return false;
  const age = snapshotAge(snapshot.at, now);
  return age !== null && age >= 0 && age <= SNAPSHOT_TTL_MS;
}

// pins: { target: "model" } from the user policy models map.
// snapshot: { at, harnesses: { cursor: { models: [...] } | { unknown: reason } } }
// Returns warnings: [{ target, model, reason }] — empty means all clear.
export function comparePins(pins = {}, snapshot = null, now = Date.now()) {
  const warnings = [];
  if (!isSnapshotFresh(snapshot, now)) {
    if (pins && Object.keys(pins).length) {
      warnings.push({ target: "*", model: "*", reason: "model snapshot is older than 24h or missing; re-run node scripts/refresh-models.mjs before trusting pins" });
    }
    return warnings;
  }
  const harnesses = snapshot.harnesses || {};
  for (const [target, model] of Object.entries(pins || {})) {
    if (typeof model !== "string" || !model.trim()) continue;
    const entry = harnesses[target];
    // Only verify against harnesses with a real probed list. Managed entries
    // (Claude aliases, Pi profiles) resolve server-side and cannot be checked
    // locally — skipping them is honesty, not a gap. Unknown probes skip too.
    if (!entry || entry.unknown || !Array.isArray(entry.models)) continue;
    const known = entry.models;
    const hit = known.some((name) => name === model || (typeof name === "string" && name.split(" - ")[0] === model));
    if (!hit) {
      warnings.push({ target, model, reason: `pinned model not in the live ${target} list; it may be renamed or retired` });
    }
  }
  return warnings;
}
