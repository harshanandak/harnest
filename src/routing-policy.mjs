import { adapterPolicyRejectionReasons, adapterRouteRejectionReasons, assertAdapterPolicy, assertAdapterRoute } from "./model-policy.mjs";

const AXES = ["quality", "speed", "efficiency", "reliability"];
const DEFAULT_WEIGHTS = Object.freeze({ quality: 4, speed: 3, efficiency: 3, reliability: 4 });
const MAX_EXPLANATION_ITEMS = 20;
// Task tiers: one-word intent that expands to weights + tag preferences.
// Tiers never name a harness or model, so they stay valid as subscriptions,
// limits, and model catalogs change underneath. Explicit weights/prefer in the
// same directive object always win over the tier-implied values.
export const TIERS = Object.freeze({
  quick: Object.freeze({
    weights: Object.freeze({ quality: 3, speed: 10, efficiency: 8, reliability: 5 }),
    prefer: Object.freeze({ tags: ["fast"] }),
  }),
  balanced: Object.freeze({
    weights: Object.freeze({ quality: 5, speed: 5, efficiency: 5, reliability: 6 }),
    prefer: Object.freeze({}),
  }),
  deep: Object.freeze({
    weights: Object.freeze({ quality: 10, speed: 2, efficiency: 3, reliability: 8 }),
    prefer: Object.freeze({ tags: ["deep"] }),
  }),
  review: Object.freeze({
    weights: Object.freeze({ quality: 10, speed: 3, efficiency: 4, reliability: 9 }),
    prefer: Object.freeze({ tags: ["review", "deep"] }),
  }),
});
export const TIER_NAMES = Object.freeze(Object.keys(TIERS));
const POLICY_FIELDS = new Set(["defaults", "candidates", "rules", "mode", "weights", "route", "require", "prefer", "avoid", "target", "maxCostUsd", "deadlineMs", "contextTokens", "tier", "harnessOrder", "models", "difficulty", "allowOpenRouter", "allowTrainingEndpoints", "fallbacks", "modelVersion"]);
const DIRECTIVE_FIELDS = new Set(["mode", "weights", "route", "require", "prefer", "avoid", "target", "maxCostUsd", "deadlineMs", "contextTokens", "tier", "harnessOrder", "models", "difficulty", "allowOpenRouter", "allowTrainingEndpoints", "fallbacks", "modelVersion"]);
const RULE_FIELDS = new Set(["id", "priority", "when", "apply"]);
const WHEN_FIELDS = new Set(["taskAny", "taskAll", "target", "provider", "model", "write", "hasWorkflow", "sessionId", "minContextTokens", "maxContextTokens", "metadata", "tier", "difficulty"]);
export const DIFFICULTIES = Object.freeze(["trivial", "bounded", "hard"]);
// Free/contributor endpoints (e.g. *-contributor, *-free) may train vendor
// models on prompts/completions. Never matched by accident: only an explicit
// model id containing the marker counts — tags and descriptions don't.
export function isTrainingEndpoint(modelId) {
  const text = String(modelId || "");
  return /contributor/i.test(text) || /-free$/i.test(text);
}
// Thinking defaults: the reasoning effort a run should use when the caller
// does not name one. Derived from intent (tier) and work (difficulty),
// taking the HIGHER of the two, capped at "high" — defaults never exceed
// high; anything above (xhigh/max) must be an explicit route.thinking ask.
// Level names are harness-specific and NEVER translated here; each harness
// adapter passes route.thinking through verbatim.
const THINKING_RANK = Object.freeze({ off: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6 });
const TIER_THINKING = Object.freeze({ quick: "low", balanced: "medium", deep: "high", review: "high" });
const DIFFICULTY_THINKING = Object.freeze({ trivial: "low", bounded: "medium", hard: "high" });

export function defaultThinking(tier, difficulty) {
  const options = [TIER_THINKING[tier], DIFFICULTY_THINKING[difficulty]].filter(Boolean);
  if (!options.length) return null;
  return options.sort((a, b) => (THINKING_RANK[b] ?? 3) - (THINKING_RANK[a] ?? 3))[0];
}
const CANDIDATE_FIELDS = new Set(["id", "target", "route", "scores", "model", "harness", "subsidy", "capabilities", "health", "tags", "available", "costUsd", "latencyMs", "priority"]);
const ROUTE_FIELDS = new Set(["provider", "model", "agent", "variant", "thinking", "harnessVersion"]);
const REQUIRE_FIELDS = new Set(["liveControl", "taskflow", "provider", "minContextTokens", "computerUse"]);
const PREFERENCE_FIELDS = new Set(["ids", "targets", "providers", "models", "tags"]);
const CAPABILITY_FIELDS = new Set(["readOnly", "write", "taskflow", "liveControl", "maxContextTokens", "computerUse", "thinking"]);
const MODEL_FIELDS = new Set(["intelligence", "taste", "speed", "costEff", "decisiveness"]);
const HARNESS_MOD_FIELDS = new Set(["speedMod", "efficiencyMod"]);
const HEALTH_FIELDS = new Set(["status", "retryAfter", "headroom", "source"]);

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function number(value, fallback = 0) {
  return Number.isFinite(value) ? Number(value) : fallback;
}

function stringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()) : [];
}

function mergeObject(base, next) {
  return { ...object(base), ...object(next) };
}

function mergePreference(base, next) {
  const merged = mergeObject(base, next);
  for (const key of ["ids", "targets", "providers", "models", "tags"]) {
    if (Object.prototype.hasOwnProperty.call(object(next), key)) merged[key] = stringList(next[key]);
  }
  return merged;
}

function mergeDirective(base, next) {
  const source = expandTier(object(next));
  return {
    ...base,
    ...source,
    weights: mergeObject(base.weights, source.weights),
    route: mergeObject(base.route, source.route),
    require: mergeObject(base.require, source.require),
    prefer: mergePreference(base.prefer, source.prefer),
    avoid: mergePreference(base.avoid, source.avoid),
  };
}

// Expand a tier into weights + tag preferences before merging, so explicit
// weights/prefer in the same object override the tier-implied values while
// the tier still fills in everything the author left out.
function expandTier(directive) {
  const tier = directive.tier;
  if (tier == null) return directive;
  const preset = TIERS[tier];
  if (!preset) return directive;
  const { weights, prefer, ...rest } = directive;
  return {
    ...rest,
    tier,
    weights: { ...preset.weights, ...object(weights) },
    prefer: prefer === undefined ? { ...preset.prefer } : mergePreference(preset.prefer, prefer),
  };
}

function has(value, key) {
  return Object.prototype.hasOwnProperty.call(object(value), key);
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
  return value.trim();
}

function requireNumber(value, label, { min = -Infinity, max = Infinity } = {}) {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new TypeError(`${label} must be a finite number between ${min} and ${max}`);
  }
  return Number(value);
}

function requireStringList(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new TypeError(`${label} must be an array of non-empty strings`);
  }
  return value.map((item) => item.trim());
}

function validateRoute(route, label) {
  requireObject(route, `${label}.route`);
  rejectUnknown(route, ROUTE_FIELDS, `${label}.route`);
  for (const key of ROUTE_FIELDS) {
    if (route[key] != null) requireString(route[key], `${label}.route.${key}`);
  }
}

function candidateId(raw, index) {
  if (has(raw, "id")) return requireString(raw.id, `candidate[${index}].id`);
  return `${raw.target || "route"}:${raw.route?.provider || "default"}:${raw.route?.model || index}`;
}

function normalizeCandidate(raw, scope, index, previous = null) {
  const label = `${scope}.candidates[${index}]`;
  requireObject(raw, label);
  rejectUnknown(raw, CANDIDATE_FIELDS, label);
  const id = candidateId(raw, index);
  const target = has(raw, "target") ? requireString(raw.target, `${label}.target`) : previous?.target;
  if (!target) throw new TypeError(`${label}.target is required for a new candidate`);

  if (has(raw, "route")) validateRoute(raw.route, label);
  if (has(raw, "scores")) {
    requireObject(raw.scores, `${label}.scores`);
    rejectUnknown(raw.scores, new Set(AXES), `${label}.scores`);
    for (const axis of Object.keys(raw.scores)) requireNumber(raw.scores[axis], `${label}.scores.${axis}`, { min: 0, max: 10 });
  }
  if (has(raw, "model")) {
    requireObject(raw.model, `${label}.model`);
    rejectUnknown(raw.model, MODEL_FIELDS, `${label}.model`);
    for (const axis of Object.keys(raw.model)) {
      if (axis === "taste" && raw.model[axis] === null) continue;
      requireNumber(raw.model[axis], `${label}.model.${axis}`, { min: 0, max: 10 });
    }
  }
  if (has(raw, "harness")) {
    requireObject(raw.harness, `${label}.harness`);
    rejectUnknown(raw.harness, HARNESS_MOD_FIELDS, `${label}.harness`);
    for (const axis of Object.keys(raw.harness)) requireNumber(raw.harness[axis], `${label}.harness.${axis}`, { min: -5, max: 5 });
  }
  if (has(raw, "capabilities")) {
    requireObject(raw.capabilities, `${label}.capabilities`);
    rejectUnknown(raw.capabilities, CAPABILITY_FIELDS, `${label}.capabilities`);
    for (const key of ["readOnly", "write", "taskflow", "liveControl", "computerUse"]) {
      if (has(raw.capabilities, key) && typeof raw.capabilities[key] !== "boolean") throw new TypeError(`${label}.capabilities.${key} must be a boolean`);
    }
    if (has(raw.capabilities, "maxContextTokens")) requireNumber(raw.capabilities.maxContextTokens, `${label}.capabilities.maxContextTokens`, { min: 0 });
    if (has(raw.capabilities, "thinking")) requireStringList(raw.capabilities.thinking, `${label}.capabilities.thinking`);
  }
  if (has(raw, "health")) {
    requireObject(raw.health, `${label}.health`);
    rejectUnknown(raw.health, HEALTH_FIELDS, `${label}.health`);
    if (has(raw.health, "status") && !["healthy", "degraded", "open"].includes(raw.health.status)) {
      throw new TypeError(`${label}.health.status must be healthy, degraded, or open`);
    }
    if (has(raw.health, "retryAfter")) requireNumber(raw.health.retryAfter, `${label}.health.retryAfter`, { min: 0 });
    if (has(raw.health, "headroom")) requireNumber(raw.health.headroom, `${label}.health.headroom`, { min: 0, max: 1 });
    // Provenance for the manual-wins rule: set-pressure stamps "manual",
    // detect-allowance stamps "auto" and never overwrites manual.
    if (has(raw.health, "source") && !["auto", "manual"].includes(raw.health.source)) {
      throw new TypeError(`${label}.health.source must be auto or manual`);
    }
  }
  if (has(raw, "tags")) requireStringList(raw.tags, `${label}.tags`);
  if (has(raw, "available") && typeof raw.available !== "boolean") throw new TypeError(`${label}.available must be a boolean`);
  if (has(raw, "costUsd") && raw.costUsd != null) requireNumber(raw.costUsd, `${label}.costUsd`, { min: 0 });
  if (has(raw, "subsidy") && raw.subsidy != null) requireNumber(raw.subsidy, `${label}.subsidy`, { min: 0, max: 1 });
  if (has(raw, "latencyMs") && raw.latencyMs != null) requireNumber(raw.latencyMs, `${label}.latencyMs`, { min: 0 });
  if (has(raw, "priority")) requireNumber(raw.priority, `${label}.priority`);

  return {
    id,
    target,
    route: has(raw, "route") ? mergeObject(previous?.route, raw.route) : { ...object(previous?.route) },
    scores: has(raw, "scores") ? mergeObject(previous?.scores, raw.scores) : { ...object(previous?.scores) },
    model: has(raw, "model") ? mergeObject(previous?.model, raw.model) : { ...object(previous?.model) },
    harness: has(raw, "harness") ? mergeObject(previous?.harness, raw.harness) : { ...object(previous?.harness) },
    capabilities: has(raw, "capabilities") ? mergeObject(previous?.capabilities, raw.capabilities) : { ...object(previous?.capabilities) },
    health: has(raw, "health") ? mergeObject(previous?.health, raw.health) : { ...object(previous?.health) },
    tags: has(raw, "tags") ? requireStringList(raw.tags, `${label}.tags`) : [...(previous?.tags ?? [])],
    available: has(raw, "available") ? raw.available : (previous?.available ?? true),
    costUsd: has(raw, "costUsd") ? raw.costUsd : (previous?.costUsd ?? null),
    subsidy: has(raw, "subsidy") && raw.subsidy != null ? raw.subsidy : (previous?.subsidy ?? 0),
    latencyMs: has(raw, "latencyMs") ? raw.latencyMs : (previous?.latencyMs ?? null),
    priority: has(raw, "priority") ? raw.priority : (previous?.priority ?? 0),
    scope,
  };
}

function candidateMap(scopes) {
  const candidates = new Map();
  for (const { name, policy } of scopes) {
    for (const [index, raw] of (policy?.candidates ?? []).entries()) {
      const id = candidateId(raw, index);
      const next = normalizeCandidate(raw, name, index, candidates.get(id));
      candidates.set(next.id, next);
    }
  }
  return [...candidates.values()];
}

export function validatePolicyScopes(scopes) {
  for (const { name, policy } of scopes) validatePolicy(policy, name);
  candidateMap(scopes);
}

function estimateContextTokens(request) {
  const declared = request.metadata?.routing?.contextTokens;
  if (Number.isFinite(declared) && declared >= 0) return declared;
  try {
    return Math.ceil(JSON.stringify(request.context ?? null).length / 4);
  } catch {
    return 0;
  }
}

function exactMetadataMatches(expected, metadata) {
  return Object.entries(object(expected)).every(([key, value]) => metadata?.[key] === value);
}

function ruleMatches(rule, request, contextTokens) {
  const when = object(rule.when);
  const task = request.task.toLowerCase();
  const any = stringList(when.taskAny).map((term) => term.toLowerCase());
  const all = stringList(when.taskAll).map((term) => term.toLowerCase());
  if (any.length && !any.some((term) => task.includes(term))) return false;
  if (all.length && !all.every((term) => task.includes(term))) return false;
  if (when.target != null && when.target !== request.target) return false;
  if (when.provider != null && when.provider !== request.route?.provider) return false;
  if (when.model != null && when.model !== request.route?.model) return false;
  if (when.write != null && Boolean(when.write) !== request.policy.write) return false;
  if (when.hasWorkflow != null && Boolean(when.hasWorkflow) !== Boolean(request.workflow)) return false;
  if (when.sessionId != null && when.sessionId !== request.execution.sessionId) return false;
  if (when.tier != null && when.tier !== request.metadata?.routing?.tier) return false;
  if (when.difficulty != null && when.difficulty !== request.metadata?.routing?.difficulty) return false;
  if (when.minContextTokens != null && contextTokens < number(when.minContextTokens, 0)) return false;
  if (when.maxContextTokens != null && contextTokens > number(when.maxContextTokens, Infinity)) return false;
  if (!exactMetadataMatches(when.metadata, request.metadata)) return false;
  return true;
}

function rejectUnknown(value, allowed, label) {
  const unknown = Object.keys(object(value)).filter((key) => !allowed.has(key));
  if (unknown.length) throw new TypeError(`${label} contains unsupported fields: ${unknown.join(", ")}`);
}

function validateDirective(value, label) {
  requireObject(value, label);
  rejectUnknown(value, DIRECTIVE_FIELDS, label);
  if (has(value, "mode") && !["auto", "pin", "prefer"].includes(value.mode)) throw new TypeError(`${label}.mode must be auto, pin, or prefer`);
  if (has(value, "target")) requireString(value.target, `${label}.target`);
  if (has(value, "tier") && !TIER_NAMES.includes(value.tier)) throw new TypeError(`${label}.tier must be one of ${TIER_NAMES.join(", ")}`);
  if (has(value, "difficulty") && !DIFFICULTIES.includes(value.difficulty)) throw new TypeError(`${label}.difficulty must be one of ${DIFFICULTIES.join(", ")}`);
  if (has(value, "allowOpenRouter") && typeof value.allowOpenRouter !== "boolean") throw new TypeError(`${label}.allowOpenRouter must be a boolean`);
  if (has(value, "allowTrainingEndpoints") && typeof value.allowTrainingEndpoints !== "boolean") throw new TypeError(`${label}.allowTrainingEndpoints must be a boolean`);
  if (has(value, "fallbacks") && typeof value.fallbacks !== "boolean") throw new TypeError(`${label}.fallbacks must be a boolean`);
  if (has(value, "modelVersion") && !["latest", "pin"].includes(value.modelVersion)) throw new TypeError(`${label}.modelVersion must be latest or pin`);
  if (has(value, "harnessOrder")) {
    requireStringList(value.harnessOrder, `${label}.harnessOrder`);
    if (new Set(value.harnessOrder.map((name) => name.trim())).size !== value.harnessOrder.length) {
      throw new TypeError(`${label}.harnessOrder must not repeat a harness`);
    }
  }
  if (has(value, "models")) {
    requireObject(value.models, `${label}.models`);
    for (const [target, model] of Object.entries(value.models)) {
      if (typeof model !== "string" || !model.trim()) throw new TypeError(`${label}.models.${target} must be a non-empty model string`);
    }
  }
  for (const key of ["maxCostUsd", "deadlineMs", "contextTokens"]) {
    if (has(value, key) && value[key] != null) requireNumber(value[key], `${label}.${key}`, { min: 0 });
  }
  if (has(value, "weights")) {
    requireObject(value.weights, `${label}.weights`);
    rejectUnknown(value.weights, new Set(AXES), `${label}.weights`);
    for (const [axis, weight] of Object.entries(value.weights)) requireNumber(weight, `${label}.weights.${axis}`, { min: 0 });
  }
  if (has(value, "route")) validateRoute(value.route, label);
  if (has(value, "require")) {
    requireObject(value.require, `${label}.require`);
    rejectUnknown(value.require, REQUIRE_FIELDS, `${label}.require`);
    for (const key of ["liveControl", "taskflow", "computerUse"]) {
      if (has(value.require, key) && typeof value.require[key] !== "boolean") throw new TypeError(`${label}.require.${key} must be a boolean`);
    }
    if (has(value.require, "provider")) requireString(value.require.provider, `${label}.require.provider`);
    if (has(value.require, "minContextTokens")) requireNumber(value.require.minContextTokens, `${label}.require.minContextTokens`, { min: 0 });
  }
  for (const key of ["prefer", "avoid"]) {
    if (!has(value, key)) continue;
    requireObject(value[key], `${label}.${key}`);
    rejectUnknown(value[key], PREFERENCE_FIELDS, `${label}.${key}`);
    for (const [field, list] of Object.entries(value[key])) requireStringList(list, `${label}.${key}.${field}`);
  }
}

function validateWhen(value, label) {
  requireObject(value, label);
  rejectUnknown(value, WHEN_FIELDS, label);
  for (const key of ["taskAny", "taskAll"]) if (has(value, key)) requireStringList(value[key], `${label}.${key}`);
  for (const key of ["target", "provider", "model", "sessionId"]) if (has(value, key)) requireString(value[key], `${label}.${key}`);
  if (has(value, "tier") && !TIER_NAMES.includes(value.tier)) throw new TypeError(`${label}.tier must be one of ${TIER_NAMES.join(", ")}`);
  if (has(value, "difficulty") && !DIFFICULTIES.includes(value.difficulty)) throw new TypeError(`${label}.difficulty must be one of ${DIFFICULTIES.join(", ")}`);
  for (const key of ["write", "hasWorkflow"]) {
    if (has(value, key) && typeof value[key] !== "boolean") throw new TypeError(`${label}.${key} must be a boolean`);
  }
  for (const key of ["minContextTokens", "maxContextTokens"]) if (has(value, key)) requireNumber(value[key], `${label}.${key}`, { min: 0 });
  if (has(value, "metadata")) {
    requireObject(value.metadata, `${label}.metadata`);
    for (const [key, item] of Object.entries(value.metadata)) {
      if ((item !== null && typeof item === "object") || (typeof item === "number" && !Number.isFinite(item))) {
        throw new TypeError(`${label}.metadata.${key} must be an exact scalar`);
      }
    }
  }
}

function validatePolicy(policy, scope) {
  requireObject(policy, `${scope} routing policy`);
  rejectUnknown(policy, POLICY_FIELDS, `${scope} routing policy`);
  const direct = Object.fromEntries(Object.entries(policy).filter(([key]) => DIRECTIVE_FIELDS.has(key)));
  validateDirective(direct, `${scope} routing policy`);
  if (has(policy, "defaults")) validateDirective(policy.defaults, `${scope}.defaults`);
  if (has(policy, "candidates") && !Array.isArray(policy.candidates)) throw new TypeError(`${scope}.candidates must be an array`);
  if (has(policy, "rules") && !Array.isArray(policy.rules)) throw new TypeError(`${scope}.rules must be an array`);
  for (const [index, rule] of (policy.rules ?? []).entries()) {
    const label = `${scope}.rules[${index}]`;
    requireObject(rule, label);
    rejectUnknown(rule, RULE_FIELDS, label);
    if (has(rule, "id")) requireString(rule.id, `${label}.id`);
    if (has(rule, "priority")) requireNumber(rule.priority, `${label}.priority`);
    validateWhen(rule.when ?? {}, `${label}.when`);
    validateDirective(rule.apply ?? {}, `${label}.apply`);
  }
}

function scopedDirective(scopes, request, contextTokens) {
  let directive = {
    mode: "auto",
    weights: { ...DEFAULT_WEIGHTS },
    route: {},
    require: {},
    prefer: {},
    avoid: {},
  };
  const matchedRules = [];
  const appliedScopes = [];
  for (const { name, policy } of scopes) {
    if (!policy || typeof policy !== "object" || Array.isArray(policy)) continue;
    validatePolicy(policy, name);
    appliedScopes.push(name);
    const direct = Object.fromEntries(Object.entries(policy).filter(([key]) => DIRECTIVE_FIELDS.has(key)));
    directive = mergeDirective(directive, direct);
    if (policy.defaults) directive = mergeDirective(directive, policy.defaults);
    const rules = (Array.isArray(policy.rules) ? policy.rules : [])
      .map((rule, index) => ({ rule, index }))
      .sort((a, b) => number(a.rule.priority, 0) - number(b.rule.priority, 0) || a.index - b.index);
    for (const { rule, index } of rules) {
      if (!rule || typeof rule !== "object" || Array.isArray(rule)) throw new TypeError(`${name}.rules[${index}] must be an object`);
      if (!ruleMatches(rule, request, contextTokens)) continue;
      const id = typeof rule.id === "string" && rule.id.trim() ? rule.id.trim() : `rule-${index}`;
      matchedRules.push(`${name}:${id}`);
      directive = mergeDirective(directive, rule.apply);
    }
  }
  return { directive, matchedRules, appliedScopes };
}

function includesPreference(preference, candidate) {
  const p = object(preference);
  return stringList(p.ids).includes(candidate.id)
    || stringList(p.targets).includes(candidate.target)
    || stringList(p.providers).includes(candidate.route.provider)
    || stringList(p.models).includes(candidate.route.model)
    || candidate.tags.some((tag) => stringList(p.tags).includes(tag));
}

function explicitMatches(requestRoute, candidate) {
  const entries = Object.entries(object(requestRoute)).filter(([, value]) => value != null && value !== "");
  return entries.length > 0 && entries.every(([key, value]) => candidate.route[key] === value);
}

function rejectionReasons(candidate, request, directive, contextTokens, now) {
  const reasons = [
    ...adapterRouteRejectionReasons(candidate.target, candidate.route),
    ...adapterPolicyRejectionReasons(candidate.target, request.policy),
  ];
  const capabilities = candidate.capabilities;
  const health = candidate.health;
  const maxCost = Math.min(
    request.policy.maxCostUsd == null ? Infinity : request.policy.maxCostUsd,
    directive.maxCostUsd == null ? Infinity : number(directive.maxCostUsd, Infinity),
  );
  const timeoutMs = Math.min(request.execution.timeoutMs, directive.deadlineMs == null ? Infinity : number(directive.deadlineMs, Infinity));
  if (!candidate.available) reasons.push("unavailable");
  if (health.status === "open" && number(health.retryAfter, Infinity) > now) reasons.push("circuit-open");
  if (directive.target && candidate.target !== directive.target) reasons.push("target");
  if (request.policy.write && capabilities.write !== true) reasons.push("write");
  if (!request.policy.write && capabilities.readOnly === false) reasons.push("read-only");
  if (request.workflow && capabilities.taskflow === false) reasons.push("taskflow");
  if (directive.require.liveControl === true && capabilities.liveControl !== true) reasons.push("live-control");
  if (directive.require.computerUse === true && capabilities.computerUse !== true) reasons.push("computer-use");
  // Thinking gate: a named effort level the candidate does not declare is a
  // hard reject — the wrong reasoning depth ruins the run regardless of
  // model. Candidates that declare no list accept any level (unknown = open).
  const wantedThinking = request.route?.thinking;
  if (typeof wantedThinking === "string" && wantedThinking
    && Array.isArray(capabilities.thinking) && !capabilities.thinking.includes(wantedThinking)) {
    reasons.push("thinking-level");
  }
  if (directive.require.taskflow === true && capabilities.taskflow !== true) reasons.push("taskflow-required");
  if (directive.require.provider && candidate.route.provider !== directive.require.provider) reasons.push("provider");
  // OpenRouter billing gate: subscriptions are always cheaper than OpenRouter
  // API billing, so an OpenRouter-backed lane is eligible ONLY on explicit
  // per-request opt-in — never by default, and never persisted. Opt-in takes
  // three equivalent forms (use whichever the call has):
  //   metadata.routing.allowOpenRouter: true,
  //   require.provider: "openrouter", or an explicit request route.provider.
  // A new session must request again: nothing about this carries over,
  // because there is deliberately no stored "openrouter allowed" state.
  if (typeof candidate.route?.provider === "string"
    && candidate.route.provider.toLowerCase() === "openrouter"
    && request.metadata?.routing?.allowOpenRouter !== true
    && !(typeof directive.require?.provider === "string" && directive.require.provider.toLowerCase() === "openrouter")
    && !(typeof request.route?.provider === "string" && request.route.provider.toLowerCase() === "openrouter")) {
    reasons.push("openrouter-gated");
  }
  // Training-data gate: contributor/free endpoints may train vendor models,
  // so they route only on explicit user opt-in (allowTrainingEndpoints at any
  // scope, default closed). Private/customer/unreleased work stays off them
  // unless the operator says otherwise — this is a user preference, not a
  // model capability judgment.
  if (isTrainingEndpoint(candidate.route?.model) && directive.allowTrainingEndpoints !== true) {
    reasons.push("training-data");
  }
  if (directive.require.minContextTokens != null && number(capabilities.maxContextTokens, 0) < number(directive.require.minContextTokens, 0)) reasons.push("context-capacity");
  if (capabilities.maxContextTokens != null && contextTokens > number(capabilities.maxContextTokens, 0)) reasons.push("context-too-large");
  if (candidate.costUsd != null && candidate.costUsd > maxCost) reasons.push("budget");
  if (candidate.latencyMs != null && candidate.latencyMs > timeoutMs) reasons.push("deadline");
  if (includesPreference(directive.avoid, candidate)) reasons.push("avoided");
  return [...new Set(reasons)];
}

function clampAxis(value) {
  return Math.max(0, Math.min(10, number(value, 0)));
}

function clampUnit(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

// Axis composition: model capability and harness loop characteristics score
// separately, then combine. A cheap-but-capable model (grok-class) wins on
// cost-efficiency + intelligence without pretending the harness loop is free:
// Pi's fast loop adds speed, a cold OpenCode hop subtracts it. Candidates
// without a model block keep the legacy flat scores verbatim.
function composedAxes(candidate) {
  const flat = object(candidate.scores);
  const model = object(candidate.model);
  const harness = object(candidate.harness);
  const hasModel = ["intelligence", "taste", "speed", "costEff", "decisiveness"].some((key) => model[key] != null);
  if (!hasModel) {
    return {
      quality: number(flat.quality, 0),
      speed: number(flat.speed, 0),
      efficiency: number(flat.efficiency, 0),
      reliability: number(flat.reliability, 0),
      basis: "flat",
    };
  }
  // Taste is often TBD (no indexed benchmark measures it). A missing taste
  // must not zero out quality — fall back to intelligence alone.
  const taste = model.taste;
  const intelligence = model.intelligence != null ? number(model.intelligence, 0) : number(flat.quality, 0);
  const quality = taste == null
    ? intelligence
    : 0.7 * intelligence + 0.3 * number(taste, 0);
  // Efficiency blends cost-per-token with turns-to-done: cheap-per-token means
  // little when a model needs 4x the turns (wall-clock AND tokens multiply by
  // turns). Missing decisiveness keeps the old cost-only behavior.
  // Subsidy (0-1, per-harness plan coverage, default 0 = API reality) pulls
  // costEff toward 10 (free): a fully covered sub makes even a pricey model
  // maximally cost-efficient, while 0 keeps sticker economics. Pressure
  // (remaining allowance) is applied later in scoring, not here.
  const rawCostEff = number(model.costEff, flat.efficiency ?? 0);
  const subsidy = clampUnit(candidate.subsidy);
  const costEff = rawCostEff + subsidy * (10 - rawCostEff);
  const efficiencyBase = model.decisiveness != null
    ? 0.6 * costEff + 0.4 * number(model.decisiveness, 0)
    : costEff;
  return {
    quality,
    speed: clampAxis(number(model.speed, flat.speed ?? 0) + number(harness.speedMod, 0)),
    efficiency: clampAxis(efficiencyBase + number(harness.efficiencyMod, 0)),
    reliability: number(flat.reliability, 0),
    basis: "model+harness",
  };
}

function scoreCandidate(candidate, request, directive) {
  const weights = Object.fromEntries(AXES.map((axis) => [axis, Math.max(0, number(directive.weights?.[axis], DEFAULT_WEIGHTS[axis]))]));
  const axes = composedAxes(candidate);
  const components = Object.fromEntries(AXES.map((axis) => [axis, weights[axis] * axes[axis]]));
  // Subscription pressure: health.headroom (0-1 remaining allowance, maintained
  // by the operator via scripts/set-pressure.mjs) scales the efficiency axis.
  // Exhausted sub (0.0) halves efficiency; fresh (1.0) keeps it whole; unknown
  // skips the factor entirely. Dollars never enter: on subs the marginal cost
  // is $0, so what matters is how much of YOUR plan this burn consumes.
  // (The reliability headroom bonus below stays: constrained subs also fail more.)
  const headroom = candidate.health.headroom;
  if (Number.isFinite(headroom)) {
    const clamped = Math.max(0, Math.min(1, headroom));
    components.efficiency *= 0.5 + 0.5 * clamped;
  }
  let score = Object.values(components).reduce((sum, value) => sum + value, 0);
  if (includesPreference(directive.prefer, candidate)) score += 100;
  if (directive.mode === "prefer" && explicitMatches(request.route, candidate)) score += 1_000;
  // Harness order is the user's stated default ranking. Position 1 earns just
  // over an explicit prefer bonus (+100), so a deliberate first choice wins;
  // deeper positions step down by 20 and yield to explicit prefer rules.
  // Explicit route pins (+1000) still top everything. Unknown targets in the
  // list simply never match.
  let orderBonus = 0;
  const order = Array.isArray(directive.harnessOrder) ? directive.harnessOrder : [];
  const orderIndex = order.indexOf(candidate.target);
  if (orderIndex >= 0) {
    orderBonus = (order.length - orderIndex) * 20 + (orderIndex === 0 ? 1 : 0);
    score += orderBonus;
  }
  if (candidate.health.status === "degraded") score -= 50;
  if (Number.isFinite(candidate.health.headroom)) score += Math.max(0, Math.min(1, candidate.health.headroom)) * weights.reliability * 10;
  return { score, components, orderBonus };
}

function hasExplicitRoute(request) {
  return typeof request.route?.model === "string" && request.route.model.trim()
    || typeof request.route?.provider === "string" && request.route.provider.trim()
    || request.target === "acp" && typeof request.route?.agent === "string" && request.route.agent.trim();
}

function explanationBase(mode, appliedScopes, matchedRules, contextTokens) {
  return {
    version: 2,
    mode,
    scopes: appliedScopes.slice(-MAX_EXPLANATION_ITEMS),
    matchedRules: matchedRules.slice(-MAX_EXPLANATION_ITEMS),
    contextTokens,
  };
}

export function resolvePolicyRoute(request, policyScopes = [], options = {}) {
  const scopes = policyScopes.filter((entry) => entry?.policy && typeof entry.name === "string");
  validatePolicyScopes(scopes);
  const contextTokens = estimateContextTokens(request);
  const { directive, matchedRules, appliedScopes } = scopedDirective(scopes, request, contextTokens);
  const mode = ["auto", "pin", "prefer"].includes(directive.mode) ? directive.mode : "auto";
  // A caller who names a target without naming a model owns the harness: that
  // target is a pin, and policy may only choose the best qualified model
  // WITHIN it. Request metadata mode auto is the explicit opt-in to
  // cross-target selection (graph nodes with target "auto" set it); an
  // explicit route provider/model is already a full pin, handled above.
  const targetPin = !hasExplicitRoute(request) && request.target !== "auto"
    && request.metadata?.routing?.mode !== "auto" ? request.target : null;
  const preferredTarget = targetPin ?? directive.target;
  // Thinking default: explicit route.thinking always wins, then policy-set
  // directive.route.thinking, then the tier/difficulty derivation (capped at
  // high). Only the derived level is candidate-aware: explicit and policy
  // levels stay hard requirements, while a derived default must never brick a
  // lane whose adapter has no thinking control (Cursor encodes effort in
  // route.model and rejects route.thinking).
  const thinkingDefault = request.route?.thinking == null && directive.route?.thinking == null
    ? defaultThinking(directive.tier, directive.difficulty)
    : null;
  const derivedThinkingAllowed = (target, capabilities) =>
    !["cursor", "gemini", "amp", "acp"].includes(target)
    && (!Array.isArray(capabilities?.thinking) || capabilities.thinking.includes(thinkingDefault));
  const withThinking = (route, target, capabilities) =>
    thinkingDefault && route.thinking == null && derivedThinkingAllowed(target, capabilities)
      ? { ...route, thinking: thinkingDefault }
      : route;
  const thinkingSourceFor = (route) => route.thinking == null ? null
    : route.thinking === request.route?.thinking ? "explicit"
    : route.thinking === directive.route?.thinking ? "policy"
    : "tier/difficulty default";
  const thinkingFields = (route) => {
    const source = thinkingSourceFor(route);
    return source ? { thinking: route.thinking, thinkingSource: source } : {};
  };
  // Gate and score against explicit and policy levels only, so a derived
  // default cannot disqualify a candidate whose adapter could otherwise run it.
  const requiredThinking = request.route?.thinking ?? directive.route?.thinking ?? null;
  const effective = requiredThinking != null
    ? { ...request, route: { ...request.route, thinking: requiredThinking } }
    : request;
  const base = {
    ...explanationBase(mode, appliedScopes, matchedRules, contextTokens),
    ...(has(directive, "fallbacks") ? { fallbacks: directive.fallbacks } : {}),
    modelVersion: directive.modelVersion ?? "latest",
    ...(stringList(directive.avoid?.models).length ? { versionAvoidModels: stringList(directive.avoid.models) } : {}),
    ...(directive.maxCostUsd != null || request.policy.maxCostUsd != null || directive.require?.minContextTokens != null || directive.require?.computerUse === true
      ? { versionUpgradeRestricted: true } : {}),
  };
  const pinTarget = hasExplicitRoute(request) ? request.target : (preferredTarget || request.target);
  if (mode === "pin" || (hasExplicitRoute(request) && mode !== "auto" && mode !== "prefer")) {
    const route = withThinking(mergeObject(directive.route, request.route), pinTarget);
    assertAdapterRoute(pinTarget, route);
    assertAdapterPolicy(pinTarget, request.policy);
    return { target: pinTarget, route, explanation: { ...base, ...thinkingFields(route), selected: "explicit-route", rejected: [], alternatives: [] } };
  }
  if (hasExplicitRoute(request) && request.metadata?.routing?.mode == null) {
    const route = withThinking(mergeObject(directive.route, request.route), pinTarget);
    assertAdapterRoute(pinTarget, route);
    assertAdapterPolicy(pinTarget, request.policy);
    return { target: pinTarget, route, explanation: { ...base, ...thinkingFields(route), mode: "pin", selected: "explicit-route", rejected: [], alternatives: [] } };
  }

  const rejected = [];
  const ranked = [];
  // The named target is enforced like a directive target for the whole scan,
  // so out-of-target candidates are rejected with reason "target" instead of
  // silently winning the score.
  const selectionDirective = preferredTarget !== directive.target ? { ...directive, target: preferredTarget } : directive;
  for (const rawCandidate of candidateMap(scopes)) {
    // Eligibility, dispatch and fallback must use the same effective route.
    // Explicit effort survives automatic model selection and every retry.
    const candidate = {
      ...rawCandidate,
      route: withThinking({
        ...rawCandidate.route,
        ...directive.route,
        ...(request.route?.thinking != null ? { thinking: request.route.thinking } : {}),
      }, rawCandidate.target, rawCandidate.capabilities),
    };
    const reasons = rejectionReasons(candidate, effective, selectionDirective, contextTokens, options.now ?? Date.now());
    if (reasons.length) {
      rejected.push({ id: candidate.id, reasons });
      continue;
    }
    const scored = scoreCandidate(candidate, request, directive);
    ranked.push({ candidate, ...scored });
  }
  ranked.sort((a, b) => b.score - a.score || b.candidate.priority - a.candidate.priority || a.candidate.id.localeCompare(b.candidate.id));
  const selected = ranked[0];
  if (!selected) {
    const configured = Object.keys(object(directive.route)).length > 0;
    const fallbackTarget = preferredTarget || request.target;
    const route = withThinking({
      ...request.route,
      ...directive.route,
      ...(request.route?.thinking != null ? { thinking: request.route.thinking } : {}),
    }, fallbackTarget);
    assertAdapterRoute(fallbackTarget, route);
    assertAdapterPolicy(fallbackTarget, request.policy);
    const incompatible = rejected.filter((entry) => !entry.reasons.includes("target")
      && entry.reasons.some((reason) => [
        "claude-model", "thinking-control", "gemini-provider", "gemini-model", "gemini-route-control",
        "amp-route-control", "amp-variant", "acp-route-control", "granular-tools", "cost-budget", "read-only",
      ].includes(reason)));
    if (incompatible.length) {
      throw Object.assign(new Error(`no adapter-compatible routing candidate: ${[...new Set(incompatible.flatMap((entry) => entry.reasons))].join(", ")}`), {
        details: { kind: "policy", hint: "configure a compatible model or remove unsupported thinking controls" },
      });
    }
    return {
      target: fallbackTarget,
      route,
      explanation: { ...base, ...thinkingFields(route), selected: configured ? "configured-route" : null, rejected: rejected.slice(0, MAX_EXPLANATION_ITEMS), alternatives: [] },
    };
  }
  const finalTarget = preferredTarget || selected.candidate.target;
  const configuredRoute = selected.candidate.route;
  assertAdapterPolicy(finalTarget, request.policy);
  return {
    target: finalTarget,
    route: configuredRoute,
    explanation: {
      ...base,
      ...thinkingFields(configuredRoute),
      selected: selected.candidate.id,
      score: selected.score,
      scoreBreakdown: selected.components,
      orderBonus: selected.orderBonus || 0,
      harnessOrder: Array.isArray(directive.harnessOrder) ? [...directive.harnessOrder] : null,
      tier: typeof directive.tier === "string" ? directive.tier : null,
      rejected: rejected.slice(0, MAX_EXPLANATION_ITEMS),
      alternatives: ranked.slice(1, 4).map((entry) => ({ id: entry.candidate.id, score: entry.score })),
      // Ordered failover input: each entry carries the FULL effective
      // target/route (candidate merged with directive overrides), so a
      // read-only retry runs exactly what policy implied — never a raw
      // candidate missing harnessVersion/variant/thinking. IDs/reasons only.
      rankedRoutes: ranked.slice(0, 4).map((entry) => ({
        id: entry.candidate.id,
        target: preferredTarget || entry.candidate.target,
        score: entry.score,
        route: entry.candidate.route,
      })),
    },
  };
}

export function attachRoutingDecision(request, decision) {
  const metadata = object(request.metadata);
  const harnest = object(metadata.harnest);
  return {
    ...request,
    metadata: {
      ...metadata,
      harnest: {
        ...harnest,
        routingDecision: decision,
      },
    },
  };
}
