// Interactive + non-interactive setup for simple routing preferences.
// Writes ~/.harnest/routing.json (or --out) with the small sugar keys
// (harnessOrder, tier, models) that the engine expands into full policy.
// Never spends a model call; harness detection is --version probes only.
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { harnessLaunch } from "../src/config.mjs";
import { requireNativeCommand } from "../src/launch-command.mjs";
import { updatePolicyJson } from "./policy-store.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// Pi-first doctrine: Pi runs anything portable, so it lists first; Claude
// second (only home for Claude models); Codex third (one-shot and resume
// support); OpenCode fourth (Go high-limit
// catalogs, v2 control); Cursor fifth (named cheap models only).
// Unmentioned harnesses append in this order.
const TARGETS = ["pi", "claude", "codex", "opencode", "cursor", "amp"];
const DEFAULT_SUBSCRIPTIONS = ["pi", "claude", "codex", "opencode", "cursor"];
const TIERS = ["quick", "balanced", "deep", "review"];

function parseArgs(argv) {
  const options = { models: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--order" && argv[i + 1]) options.order = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (arg === "--tier" && argv[i + 1]) options.tier = argv[++i];
    else if (arg === "--model" && argv[i + 1]) {
      const [target, ...rest] = argv[++i].split("=");
      options.models[target.trim()] = rest.join("=").trim();
    } else if (arg === "--budget" && argv[i + 1]) options.budget = Number(argv[++i]);
    else if (arg === "--out" && argv[i + 1]) options.out = argv[++i];
    else if (arg === "--yes" || arg === "-y") options.yes = true;
    else if (arg === "--no-rules") options.rules = false;
    else if (arg === "--allow-training-endpoints") options.allowTrainingEndpoints = true;
    else if (arg === "--no-training-endpoints") options.allowTrainingEndpoints = false;
    else if (arg === "--sub" && argv[i + 1]) {
      const [target, ...rest] = argv[++i].split("=");
      const value = rest.join("=").trim();
      (options.subs ||= {})[target.trim()] = value === "" ? 1 : Number(value);
    }
    else if (arg === "--cheap-lane" && argv[i + 1]) options.cheapLane = argv[++i].trim();
    else if (arg === "--flagship-lane" && argv[i + 1]) options.flagshipLane = argv[++i].trim();
    else if (arg === "--help" || arg === "-h") options.help = true;
  }
  return options;
}

function probe(target) {
  try {
    const launch = harnessLaunch(target);
    const result = spawnSync(requireNativeCommand(launch.command), [...(launch.args || []), "--version"], {
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
      shell: false,
    });
    if (result.status !== 0) return null;
    return String(result.stdout || result.stderr).trim().split(/\r?\n/)[0].slice(0, 80) || "installed";
  } catch {
    return null;
  }
}

export async function interactive(detected, { rl = createInterface({ input: stdin, output: stdout }), pickLanes = pickCursorLanes } = {}) {
  try {
    console.log("Detected harnesses (missing ones still work as fallback names):");
    for (const [index, target] of TARGETS.entries()) {
      console.log(`  ${index + 1}. ${target} — ${detected[target] || "not found on PATH"}`);
    }
    const orderRaw = await rl.question("Preferred order (comma-separated numbers, Enter = listed order): ");
    let order = [...TARGETS];
    if (orderRaw.trim()) {
      const picked = orderRaw.split(",").map((s) => TARGETS[Number(s.trim()) - 1]).filter(Boolean);
      if (picked.length) order = [...new Set([...picked, ...TARGETS])];
    }
    const tierRaw = (await rl.question("Default tier quick/balanced/deep/review [balanced]: ")).trim().toLowerCase();
    const tier = TIERS.includes(tierRaw) ? tierRaw : "balanced";
    console.log("Model per harness (Enter = default; opencode REQUIRES one to be usable):");
    const models = {};
    for (const target of TARGETS) {
      if (target === "amp") {
        console.log("  amp [native default; configure advanced candidate routes for modes]");
        continue;
      }
      const hint = target === "opencode" ? "provider/model" : target === "claude" ? "alias, e.g. sonnet" : target === "cursor" ? "e.g. composer-2.5, cursor-grok-4.6-high-fast (cheap)" : "Enter for default";
      const answer = (await rl.question(`  ${target} [${hint}]: `)).trim();
      if (answer) models[target] = answer;
    }
    const rulesRaw = (await rl.question("Add starter task rules (urgent→quick, security/audit→deep)? [Y/n]: ")).trim().toLowerCase();
    const subsRaw = (await rl.question("Subscriptions covering usage, comma-separated harnesses (Enter = existing five): ")).trim().toLowerCase();
    const picked = subsRaw ? subsRaw.split(",").map((s) => s.trim()).filter((s) => TARGETS.includes(s)) : [...DEFAULT_SUBSCRIPTIONS];
    const subscriptions = Object.fromEntries(picked.map((target) => [target, { plan: "sub", subsidy: 1 }]));
    const trainRaw = (await rl.question("Allow free/contributor endpoints (prompts may train vendor models)? [y/N]: ")).trim().toLowerCase();
    const lanes = await pickLanes(rl);
    // No budget question: everything here runs on subscriptions (marginal $0),
    // so enforcement is dead weight. API-billing operators can still pass
    // --budget, and costEff ratings keep steering selection either way.
    return { order, tier, models, budget: null, rules: rulesRaw !== "n" && rulesRaw !== "no", lanes, subscriptions, allowTrainingEndpoints: trainRaw === "y" || trainRaw === "yes" };
  } finally {
    rl.close();
  }
}

// Offer explicit cheap + flagship Cursor lanes from the live model list, so
// one harness can field both ends of the capability/cost spectrum and the
// engine scores them honestly (model capability separate from harness loop).
async function pickCursorLanes(rl) {
  const { probeCursorModels, bareModelId } = await import("../src/model-freshness.mjs");
  const { buildNamedLane } = await import("../src/routing-presets.mjs");
  console.log("Probing live Cursor models (metadata only)…");
  const snapshot = probeCursorModels();
  if (snapshot.unknown || !snapshot.cheap?.length) {
    console.log(`  list unavailable (${snapshot.unknown || "no cheap lanes"}); skipping explicit lanes.`);
    return [];
  }
  console.log(`  cheap right now: ${snapshot.cheap.slice(0, 4).join(" | ")}`);
  const cheapRaw = (await rl.question("  Cheap Cursor lane model id (Enter = skip explicit lanes): ")).trim();
  if (!cheapRaw) return [];
  const cheapId = bareModelId(cheapRaw);
  const flagRaw = (await rl.question("  Flagship Cursor lane model id (Enter = none): ")).trim();
  const lanes = [];
  try {
    lanes.push(buildNamedLane({ id: "cursor-cheap", target: "cursor", model: cheapId, tags: ["cheap", "fast"] }));
    if (flagRaw) lanes.push(buildNamedLane({ id: "cursor-flagship", target: "cursor", model: bareModelId(flagRaw), tags: ["flagship", "deep"] }));
  } catch (error) {
    console.log(`  lane setup skipped: ${error.message}`);
    return [];
  }
  return lanes;
}

function defaultPolicyPath() {
  return process.env.HARNEST_ROUTING_POLICY || join(homedir(), ".harnest", "routing.json");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
const options = parseArgs(process.argv.slice(2));
if (options.help) {
  console.log([
    "Usage: node scripts/setup-routing.mjs [--order pi,claude,codex,opencode,cursor,amp] [--tier balanced]",
    "  [--model target=model] [--budget 2] [--cheap-lane model-id] [--flagship-lane model-id]",
    "  [--sub target=1] [--no-rules] [--allow-training-endpoints|--no-training-endpoints] [--out path] [--yes]",
    "Writes the simple preference keys plus starter task rules; the engine expands them into full policy.",
  ].join("\n"));
  process.exit(0);
}

const detected = Object.fromEntries(TARGETS.map((target) => [target, probe(target)]));
let answers;
if (options.order || options.tier || Object.keys(options.models).length || options.cheapLane || options.flagshipLane || options.yes || options.allowTrainingEndpoints !== undefined) {
  const order = options.order?.length ? [...new Set([...options.order, ...TARGETS])] : [...TARGETS];
  for (const name of order) {
    if (!TARGETS.includes(name)) {
      console.error(`unknown harness in --order: ${name} (expected ${TARGETS.join(",")})`);
      process.exit(1);
    }
  }
  if (options.tier && !TIERS.includes(options.tier)) {
    console.error(`unknown --tier: ${options.tier} (expected ${TIERS.join(",")})`);
    process.exit(1);
  }
  answers = { order, tier: options.tier || "balanced", models: options.models, budget: options.budget ?? null, rules: options.rules, allowTrainingEndpoints: options.allowTrainingEndpoints };
  if (options.subs) {
    for (const [target, subsidy] of Object.entries(options.subs)) {
      if (!TARGETS.includes(target) || !Number.isFinite(subsidy) || subsidy < 0 || subsidy > 1) {
        console.error(`bad --sub ${target}=${subsidy} (expected harness=0..1)`);
        process.exit(1);
      }
    }
    answers.subscriptions = Object.fromEntries(
      Object.entries(options.subs).map(([target, subsidy]) => [target, { plan: "sub", subsidy }]),
    );
  }
} else {
  answers = await interactive(detected);
}

const { buildNamedLane } = await import("../src/routing-presets.mjs");
const lanes = [];
if (options.cheapLane) {
  lanes.push(buildNamedLane({ id: "cursor-cheap", target: "cursor", model: options.cheapLane, tags: ["cheap", "fast"] }));
}
if (options.flagshipLane) {
  lanes.push(buildNamedLane({ id: "cursor-flagship", target: "cursor", model: options.flagshipLane, tags: ["flagship", "deep"] }));
}
if (answers.lanes?.length) lanes.push(...answers.lanes);

const policy = { harnessOrder: answers.order, tier: answers.tier };
if (answers.allowTrainingEndpoints !== undefined) policy.allowTrainingEndpoints = answers.allowTrainingEndpoints;
if (Object.keys(answers.models).length) policy.models = answers.models;
if (answers.subscriptions && Object.keys(answers.subscriptions).length) policy.subscriptions = answers.subscriptions;
if (answers.budget) policy.maxCostUsd = answers.budget;
if (lanes.length) policy.candidates = lanes;
if (answers.rules !== false) {
  policy.rules = [
    { id: "starter-urgent-quick", priority: 20, when: { taskAny: ["urgent", "quick", "fast"] }, apply: { tier: "quick" } },
    { id: "starter-security-deep", priority: 10, when: { taskAny: ["security", "audit", "architecture", "review"] }, apply: { tier: "deep" } },
    // Difficulty gates the upgrade: trivial work stays on cheap lanes even
    // when the order prefers flagships; hard work earns depth.
    { id: "starter-trivial-cheap", priority: 15, when: { difficulty: "trivial" }, apply: { tier: "quick", prefer: { tags: ["cheap"] } } },
    { id: "starter-hard-deep", priority: 15, when: { difficulty: "hard" }, apply: { tier: "deep" } },
    // Code review goes to Codex (strong async reviewer); UI-flavored reviews
    // keep Claude via the higher-priority ui rule declared below.
    { id: "starter-review-codex", priority: 11, when: { taskAny: ["review"] }, apply: { target: "codex" } },
    // Taste-critical UI work goes to Claude for a second-opinion review lane.
    { id: "starter-ui-claude", priority: 12, when: { taskAny: ["ui", "design", "frontend", "css", "layout"] }, apply: { tier: "review", target: "claude" } },
    // Browser/computer-use work prefers Codex (soft preference, not a
    // capability claim: no one-shot CLI route has verified computer-use yet).
    { id: "starter-computer-codex", priority: 12, when: { taskAny: ["browser", "computer-use", "screenshot", "automation"] }, apply: { target: "codex" } },
  ];
}

const outPath = options.out || defaultPolicyPath();
await updatePolicyJson(outPath, async (existing, previousRaw) => {
if (previousRaw !== null && !options.yes) {
  const backup = `${outPath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  await writeFile(backup, previousRaw);
  console.log(`backed up previous policy to ${backup}`);
}
const candidates = new Map((existing.candidates || []).map((candidate) => [candidate.id, candidate]));
for (const candidate of policy.candidates || []) candidates.set(candidate.id, { ...candidates.get(candidate.id), ...candidate });
Object.assign(existing, policy);
if (candidates.size) existing.candidates = [...candidates.values()];
});
console.log(`wrote ${outPath}:`);
console.log(JSON.stringify(policy, null, 2));
console.log("Cheap Cursor lanes: cursor-grok-4.6-high-fast / composer-2.5. Opencode needs models.opencode to join auto-selection.");
console.log("On subs, record heat with: node scripts/set-pressure.mjs --pressure cursor=0.3 (1=fresh, 0=exhausted).");
}
