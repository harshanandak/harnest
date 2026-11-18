// Record subscription pressure: how hot each harness sub is running.
// Usage: node scripts/set-pressure.mjs --pressure cursor=0.3,claude=0.8 [--out path] [--yes]
// Values are remaining-allowance fractions (1 = fresh, 0 = exhausted).
// Writes health overlays keyed by auto-candidate id so generated catalog
// entries keep their ratings and only gain pressure. Unknown = neutral:
// targets you do not name are left alone entirely.
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { updatePolicyJson } from "./policy-store.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const AUTO_IDS = { opencode: "auto-opencode", pi: "auto-pi", cursor: "auto-cursor", claude: "auto-claude", codex: "auto-codex", gemini: "auto-gemini", amp: "auto-amp" };

function defaultPolicyPath() {
  return process.env.HARNEST_ROUTING_POLICY || join(homedir(), ".harnest", "routing.json");
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h") || !args.includes("--pressure")) {
  console.log([
    "Usage: node scripts/set-pressure.mjs --pressure cursor=0.3,claude=0.8 [--out path] [--yes]",
    "  1 = fresh allowance, 0 = exhausted. Refresh whenever a sub feels hot;",
    "  pressure halves efficiency at 0 and leaves it whole at 1.",
  ].join("\n"));
  process.exit(args.includes("--help") || args.includes("-h") ? 0 : 1);
}

const get = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
};

const entries = (get("--pressure") || "").split(",").map((s) => s.trim()).filter(Boolean);
if (!entries.length) {
  console.error("no --pressure entries parsed (expected target=0..1 pairs)");
  process.exit(1);
}
const pressures = {};
for (const entry of entries) {
  const [target, raw] = entry.split("=").map((s) => s.trim());
  const value = Number(raw);
  if (!AUTO_IDS[target] || !Number.isFinite(value) || value < 0 || value > 1) {
    console.error(`bad entry ${JSON.stringify(entry)} (expected ${Object.keys(AUTO_IDS).join("|")}=0..1)`);
    process.exit(1);
  }
  pressures[target] = value;
}

const outPath = get("--out") || defaultPolicyPath();
await updatePolicyJson(outPath, async (policy, previousRaw) => {
if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
  console.error(`${outPath} does not contain a policy object`);
  process.exit(1);
}
const candidates = Array.isArray(policy.candidates) ? [...policy.candidates] : [];
const generatedTargets = new Set(["pi", "claude"]);
for (const target of ["opencode", "cursor", "codex", "gemini"]) {
  if (policy.models?.[target]) generatedTargets.add(target);
}
for (const [target, id] of Object.entries(AUTO_IDS)) {
  if (candidates.some((candidate) => candidate?.id === id && candidate?.target === target)) generatedTargets.add(target);
}
for (const [target, headroom] of Object.entries(pressures)) {
  if (!generatedTargets.has(target)) {
    console.error(`${target} has no configured lane — set models.${target} or define candidate ${AUTO_IDS[target]} first; refusing to create a model-less lane`);
    throw new TypeError(`no generated lane for ${target}`);
  }
  const id = AUTO_IDS[target];
  const index = candidates.findIndex((c) => c && c.id === id);
  // Manual provenance: the auto-detector never overwrites source="manual".
  // Zero remaining allowance is degraded, not healthy.
  const overlay = { id, target, health: { status: headroom <= 0 ? "degraded" : "healthy", headroom, source: "manual" } };
  if (index >= 0) candidates[index] = { ...candidates[index], ...overlay, health: { ...(candidates[index].health || {}), ...overlay.health } };
  else candidates.push(overlay);
}
policy.candidates = candidates;
if (previousRaw !== null && !args.includes("--yes") && !args.includes("-y")) {
  const backup = `${outPath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  await writeFile(backup, previousRaw);
  console.log(`backed up previous policy to ${backup}`);
}
});
console.log(`pressure recorded in ${outPath}: ${Object.entries(pressures).map(([t, v]) => `${t}=${v}`).join(", ")}`);
