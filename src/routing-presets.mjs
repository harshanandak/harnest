import { resolveUserPreset } from "./routing-preferences.mjs";
import { TARGETS } from "./protocol.mjs";

// Simple preference presets: a small user-facing layer over the declarative
// routing engine. Users state WHAT they want (task tier, harness order,
// per-harness models); this module compiles it into catalog candidates that
// the existing policy machinery scores, explains, and fails over.
//
// Design notes:
// - Tiers never name a harness or model, so they survive subscription, limit,
//   and catalog changes. Costs are deliberately NOT invented here: marginal
//   cost under Cursor/Claude subscriptions is $0, under API billing it is
//   account-specific. Set costUsd on your own candidates when billing matters;
//   maxCostUsd budgets only bite candidates that carry a cost.
// - Capability flags below are static harness facts, not model facts.
// - OpenCode gets no auto candidate: policy cannot invent a model for a
//   modelless route (the adapter requires one). Set models.opencode to opt in;
//   a bare target: "opencode" then ranks only OpenCode candidates.

function splitModel(value) {
  const text = String(value || "").trim();
  const slash = text.indexOf("/");
  if (slash > 0) {
    return { provider: text.slice(0, slash), model: text.slice(slash + 1) };
  }
  return { model: text };
}

// Model ratings, evidence-backed, snapshot 2026-09-11 (AA Intelligence Index
// v4.3 + AA coding/agent indexes; LMArena text/coding Elo + Senior-SWE
// tasteful; CursorBench/terminal-bench trajectory steps). Scales 1-10,
// more-is-better; costEff = cost-EFFICIENCY (10 = cheapest). decisiveness =
// finishes in few turns, first-pass success (trajectory steps, not vibes).
// taste stays null only where no human-preference source exists. Keyed by
// family so one entry covers version churn; ORDER MATTERS (first match wins),
// specific before generic. Override per candidate with an explicit model
// block; omit it to keep legacy flat scores.
const FAMILY_RATINGS = [
  // Grok 4.5/4.6: AA II 44 (#20); CursorBench beats Sol but DeepSWE/TB3 trail;
  // Senior basic-2nd vs tasteful-5th (capable output, weaker taste discipline);
  // 39 traj steps best-in-class; $1.04/task but 10x flash + >200k rebill trap.
  [/grok/i, { intelligence: 8, taste: 6, speed: 5, costEff: 7, decisiveness: 8 }],
  // Composer 2.5: NO AA intelligence entry (provisional 6, IDE-editing only);
  // 33 lean traj steps; Standard is cheapest-in-class because the Cursor sub
  // subsidises it to ~$0 marginal (Fast 6x is the bill trap, excluded here).
  [/composer/i, { intelligence: 6, taste: 6, speed: 7, costEff: 10, decisiveness: 8 }],
  // Provisional Terra rating. Keep the legacy family matches for user pins.
  [/luna|terra/i, { intelligence: 7, taste: 7, speed: 8, costEff: 8, decisiveness: 7 }],
  [/5\.6|sol/i, { intelligence: 9, taste: 7, speed: 6, costEff: 6, decisiveness: 8 }],
  [/codex|gpt-5/i, { intelligence: 7, taste: 6, speed: 7, costEff: 5, decisiveness: 7 }],
  // GPT-6 Astra (openrouter/openai/gpt-6-astra, verified in local pi catalog):
  // flagship guidance-tier, provisional (vendor + operator doctrine only).
  // Effort-sensitive: medium burns tokens (rambles/retries); pin high/xhigh
  // on Astra lanes, never derive low/medium for it.
  [/astra|gpt-6/i, { intelligence: 9, taste: 8, speed: 6, costEff: 4, decisiveness: 7 }],
  // Muse Spark 1.3 contributor (opencode-go/muse-spark-1.3-contributor):
  // Meta's reasoning family (multimodal, tool-use, multi-agent orchestration).
  // AA 2026-09: "amongst the leading models in intelligence", fast, somewhat
  // verbose; #1 OpenCode usage rank (6.8%). FREE contributor channel —
  // prompts/completions may train Meta models, so keep sensitive work off it
  // (see preferences data note). Pi thinkingLevelMap caps at xhigh (max null),
  // so never pin max on spark lanes. Provisional ratings.
  [/muse-spark|spark/i, { intelligence: 8, taste: 8, speed: 6, costEff: 7, decisiveness: 7 }],
  // Fable 5: arena #1 both boards, SWE-Pro 80%+, tasteful co-1st; $8.75/task.
  [/fable/i, { intelligence: 10, taste: 10, speed: 5, costEff: 2, decisiveness: 7 }],
  // Opus 5: Verified 96%, basic-best + tasteful co-1st, tool-discipline autopsy;
  // slowest tok/s in class; $5.86/task.
  [/opus/i, { intelligence: 10, taste: 9, speed: 4, costEff: 4, decisiveness: 7 }],
  // Sonnet 5: value tier, 24pp migration gap to Opus; fastest Claude tok/s.
  [/sonnet/i, { intelligence: 7, taste: 7, speed: 6, costEff: 6, decisiveness: 7 }],
  // Unknown Claude id: midpoint of the spread, never silently top or bottom.
  [/claude/i, { intelligence: 8, taste: 8, speed: 5, costEff: 5, decisiveness: 7 }],
  // Gemini Flash: TB2.1 85.8, WebDev 1588, 292 tok/s #1; not an architect;
  // promo pricing doubles on expiry; decisiveness thin-evidence.
  [/gemini|google/i, { intelligence: 7, taste: 7, speed: 10, costEff: 8, decisiveness: 5 }],
  // DeepSeek V4.1 Flash (2026-09-10, api-docs changelog): vendor TB2.1 90.6,
  // DeepSWE 74.2 (was 54.4), AutomationBench 54.8 (was 25.1) — vendor-run,
  // independent numbers absent, so intelligence rises only to 6. Legacy
  // deepseek-v4-flash/-pro names route server-side to V4.1; pin deepseek-flash.
  // Decisiveness stays 3: repetition/stop pathologies are family traits with
  // no new trajectory data. Re-check on independent evals + post-train pushes.
  [/deepseek/i, { intelligence: 6, taste: 5, speed: 9, costEff: 10, decisiveness: 3 }],
];

export function familyModelRating(modelId) {
  const text = String(modelId || "");
  for (const [pattern, ratings] of FAMILY_RATINGS) {
    if (pattern.test(text)) return { ...ratings };
  }
  return { intelligence: 7, taste: null, speed: 7, costEff: 6, decisiveness: 6 };
}

// Harness loop modifiers (-5..+5): what the harness itself adds to or costs
// every run, independent of model. Evidence 2026-09-11 (local --version spawn
// medians: claude ~50ms, opencode ~220ms launcher-only, pi ~430ms,
// cursor ~1100ms; plus usability audit):
// - pi keeps +2/+1: only mid-run steerable surface, persistent RPC (no
//   respawn, minimal re-statement), real cost knobs (thinking, tool filter).
// - cursor 0/-1: slowest spawn every run, documented -p no-exit hangs, and
//   write-mode is full-auto --force with no budget cap or tool filter.
// - claude +1/0: fastest spawn, cheapest resume, best print-mode trace
//   (usage/cost/num_turns), only real budget enforcement. No-steer caps it.
// - opencode -2/-1: per-run MCP cold boot with the serve+attach mitigation
//   absent from stable OpenCode, thinnest trace, lower reliability.
const HARNESS_LOOP = {
  opencode: { speedMod: -2, efficiencyMod: -1 },
  pi: { speedMod: 2, efficiencyMod: 1 },
  cursor: { speedMod: 0, efficiencyMod: -1 },
  claude: { speedMod: 1, efficiencyMod: 0 },
  // codex exec: native binary spawn, JSONL streaming, resume support; one-shot
  // like cursor/claude but without the shim tax. Provisional until measured.
  codex: { speedMod: 1, efficiencyMod: 0 },
  // New prompt-only adapters remain neutral until measured independently.
  gemini: { speedMod: 0, efficiencyMod: 0 },
  amp: { speedMod: 0, efficiencyMod: 0 },
  acp: { speedMod: 0, efficiencyMod: 0 },
};

// Harness topology doctrine (verified 2026-09-11): Pi is the default home
// for anything portable — any provider model (including DeepSeek and
// Codex-CLI-reachable work via its tools), taskflow graphs, live steering,
// fastest effective loop. Route elsewhere only for what Pi lacks:
//   - claude: Claude models (nothing else runs them) + budget enforcement.
//   - opencode: OpenCode Go high-limit catalogs, v2 live control.
//   - cursor: NAMED cheap models only (grok-latest, composer); the default
//     Cursor model earns no lane — without a name it adds no value over Pi.
//   - dsh: NOT A TARGET. DSH-as-target has no subagent edge over Pi running
//     the same DeepSeek model, so it was removed from the routable set:
//     protocol rejects target "dsh" with a redirect. A DSH *lead* integration
//     stays possible in principle, but impossible in rc.7 (headless takes
//     only task text, no MCP surface).
const AUTO_CANDIDATES = [
  {
    id: "auto-claude",
    target: "claude",
    scores: { quality: 9, speed: 6, efficiency: 6, reliability: 9 },
    capabilities: { readOnly: true, write: true, taskflow: false, liveControl: false, maxContextTokens: 200000 },
    tags: ["deep", "review", "flagship"],
  },
  {
    id: "auto-pi",
    target: "pi",
    scores: { quality: 7, speed: 7, efficiency: 7, reliability: 8 },
    capabilities: { readOnly: true, write: true, taskflow: true, liveControl: true, maxContextTokens: 128000, thinking: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] },
    tags: ["balanced"],
  },
  {
    id: "auto-cursor",
    target: "cursor",
    requiresModel: true,
    scores: { quality: 6, speed: 10, efficiency: 9, reliability: 8 },
    capabilities: { readOnly: true, write: true, taskflow: false, liveControl: false, maxContextTokens: 128000 },
    tags: ["fast", "cheap"],
  },
  {
    id: "auto-codex",
    target: "codex",
    requiresModel: true,
    scores: { quality: 8, speed: 7, efficiency: 7, reliability: 8 },
    capabilities: { readOnly: true, write: true, taskflow: false, liveControl: false, maxContextTokens: 400000 },
    tags: ["balanced"],
  },
  {
    id: "auto-opencode",
    target: "opencode",
    requiresModel: true,
    scores: { quality: 9, speed: 5, efficiency: 5, reliability: 9 },
    capabilities: { readOnly: false, write: true, taskflow: true, liveControl: true, maxContextTokens: 200000 },
    tags: ["deep", "flagship"],
  },
  {
    id: "auto-gemini",
    target: "gemini",
    requiresModel: true,
    scores: { quality: 7, speed: 7, efficiency: 7, reliability: 7 },
    capabilities: { readOnly: true, write: true, taskflow: false, liveControl: false },
    tags: [],
  },
];

export function buildDefaultCandidates(models = {}) {
  const result = [];
  for (const template of AUTO_CANDIDATES) {
    const { requiresModel, ...base } = template;
    const withLoop = { ...base, harness: { ...(HARNESS_LOOP[template.target] || {}) } };
    const override = models[template.target];
    if (typeof override === "string" && override.trim()) {
      const text = override.trim();
      const route = (template.target === "opencode" || text.includes("/")) ? splitModel(text) : { model: text };
      result.push({ ...withLoop, route, model: familyModelRating(route.model) });
      continue;
    }
    if (requiresModel) continue;
    result.push({ ...withLoop, route: {} });
  }
  return result;
}

// Build one explicit named lane (e.g. a cheap grok lane + a flagship lane on
// the same harness) with family-default capability ratings. Both lanes share
// the harness loop; they differ on model capability, which is exactly the
// comparison the lead wants scored honestly.
export function buildNamedLane({ id, target, model, tags = [] }) {
  if (!id || !target || !model) throw new TypeError("lane requires id, target, and model");
  const route = textIncludesSlash(model) ? splitModel(model) : { model };
  return {
    id,
    target,
    route,
    model: familyModelRating(route.model),
    harness: { ...(HARNESS_LOOP[target] || {}) },
    scores: { reliability: 8 },
    capabilities: capabilitiesFor(target),
    tags: [...tags],
  };
}

function textIncludesSlash(value) {
  return String(value || "").indexOf("/") > 0;
}

function capabilitiesFor(target) {
  if (target === "gemini") return { readOnly: true, write: true, taskflow: false, liveControl: false };
  if (target === "amp") return { readOnly: false, write: true, taskflow: false, liveControl: false };
  if (target === "acp") return { readOnly: false, write: true, taskflow: false, liveControl: false };
  const base = { readOnly: true, write: true, taskflow: false, liveControl: false };
  if (target === "pi") {
    base.taskflow = true;
    base.liveControl = true;
    // Pi thinking levels are CLI-verified (pi --help); other harnesses use
    // unvalidated passthrough until their level sets are confirmed.
    base.thinking = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  }
  if (target === "opencode") {
    base.readOnly = false;
    base.taskflow = true;
    base.liveControl = true;
  }
  // NOTE: no computerUse anywhere. No one-shot CLI route in this set offers
  // usable computer-use (verified 2026-09-11: claude --chrome needs a visible
  // window, cursor browser is IDE-bound, pi/opencode have no browser tool).
  // require.computerUse therefore rejects every auto lane honestly.
  return base;
}

// Expand the sugar keys of a user policy file into engine-native policy.
// Generated candidates come FIRST so explicit same-id entries overlay them
// (candidate overlay preserves omitted fields). `models` and `subscriptions`
// are consumed here and stripped: they must never reach policy validation.
// `subscriptions` ({ target: { plan?, subsidy 0..1 } }) stamps a subsidy onto
// every candidate of that target that does not set its own — the plan absorbs
// that fraction of cost, so subsidy 1 pulls costEff to 10 (free). Absent
// targets default to 0 (API reality: dollars are real until covered).
// Returns the policy unchanged when no sugar keys are present.
export function expandUserPolicy(policy, requestedPreset) {
  policy = resolveUserPreset(policy, requestedPreset);
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return policy;
  const { models, subscriptions, ...rest } = policy;
  const targets = new Set(TARGETS);
  for (const key of ["models", "subscriptions"]) {
    if (!Object.hasOwn(policy, key)) continue;
    if (!policy[key] || typeof policy[key] !== "object" || Array.isArray(policy[key])) {
      throw new TypeError(`user policy ${key} must be an object keyed by harness`);
    }
    for (const target of Object.keys(policy[key])) {
      if (!targets.has(target)) throw new TypeError(`user policy ${key}.${target}: unknown harness; expected ${[...targets].join(", ")}`);
    }
  }
  if (Object.hasOwn(rest, "candidates") && !Array.isArray(rest.candidates)) throw new TypeError("user policy candidates must be an array");
  const hasModels = models && typeof models === "object" && !Array.isArray(models)
    && Object.keys(models).length > 0;
  const hasSubs = subscriptions && typeof subscriptions === "object" && !Array.isArray(subscriptions)
    && Object.keys(subscriptions).length > 0;
  if (hasModels) {
    for (const [target, model] of Object.entries(models)) {
      if (target === "amp") throw new TypeError("user policy models.amp is unsupported; configure an explicit Amp candidate route instead of treating --mode as a model pin");
      if (target === "acp") throw new TypeError("user policy models.acp is unsupported; configure an explicit ACP registration instead of treating it as a model pin");
      if (typeof model !== "string" || !model.trim()) {
        throw new TypeError(`user policy models.${target} must be a non-empty model string`);
      }
    }
  }
  const rates = {};
  if (hasSubs) {
    for (const [target, entry] of Object.entries(subscriptions)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new TypeError(`user policy subscriptions.${target} must be an object like { plan, subsidy }`);
      }
      const unknown = Object.keys(entry).filter((key) => !["plan", "subsidy"].includes(key));
      if (unknown.length) throw new TypeError(`user policy subscriptions.${target} contains unsupported fields: ${unknown.join(", ")}`);
      if (Object.hasOwn(entry, "plan") && (typeof entry.plan !== "string" || !entry.plan.trim())) throw new TypeError(`user policy subscriptions.${target}.plan must be a non-empty string`);
      const subsidy = entry.subsidy ?? 1;
      if (!Number.isFinite(subsidy) || subsidy < 0 || subsidy > 1) {
        throw new TypeError(`user policy subscriptions.${target}.subsidy must be between 0 and 1`);
      }
      rates[target] = subsidy;
    }
  }
  if (!hasModels && !hasSubs && !Array.isArray(rest.harnessOrder)) return rest;
  const generated = buildDefaultCandidates(hasModels ? models : {});
  const withRates = (list) => list.map((candidate) => (
    candidate?.subsidy == null && rates[candidate?.target] != null
      ? { ...candidate, subsidy: rates[candidate.target] }
      : candidate
  ));
  return {
    ...rest,
    candidates: [...withRates(generated), ...withRates(rest.candidates || [])],
  };
}
