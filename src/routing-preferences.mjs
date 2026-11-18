// User-facing routing preferences: named presets over the declarative engine.
//
// The user policy file keeps every existing advanced key (defaults,
// candidates, rules, ...) plus two container keys:
//
//   presets: { [name]: simpleSettings }   named simple setting bundles
//   activePreset: name | null             selected preset (null = base)
//
// Simple settings (the only keys a preset or chat "set" may carry):
//   harnessOrder, tier, models, thinking, fallbacks, allowTrainingEndpoints
//
// resolveUserPreset() strips the container keys, merges the selected preset
// OVER the base simple keys (models merge per harness), and translates the
// `thinking` sugar into defaults.route.thinking. The result is a plain policy
// the legacy engine validates and scores; no second scoring engine lives here.
// Model IDs are never invented and no cost/quota/subscription is inferred.

import { TARGETS } from "./protocol.mjs";

export const SIMPLE_KEYS = Object.freeze([
  "harnessOrder",
  "tier",
  "models",
  "thinking",
  "modelVersion",
  "fallbacks",
  "allowTrainingEndpoints",
]);

const SIMPLE_KEY_SET = new Set(SIMPLE_KEYS);

// Advanced/legacy top-level keys that pass through untouched. Mirrors the
// engine POLICY_FIELDS plus the legacy models/subscriptions sugar consumed by
// expandUserPolicy. Unknown top-level fields fail closed.
const ADVANCED_KEYS = new Set([
  "defaults",
  "candidates",
  "rules",
  "mode",
  "weights",
  "route",
  "require",
  "prefer",
  "avoid",
  "target",
  "maxCostUsd",
  "deadlineMs",
  "contextTokens",
  "difficulty",
  "allowOpenRouter",
  "subscriptions",
]);

const TIERS = new Set(["quick", "balanced", "deep", "review"]);
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

const MAX_PRESET_NAME_LENGTH = 64;
const PRESET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const FORBIDDEN_NAMES = new Set(["__proto__", "constructor", "prototype"]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validatePresetName(name) {
  if (typeof name !== "string" || !name) throw new TypeError("preset name must be a non-empty string");
  if (name.length > MAX_PRESET_NAME_LENGTH) {
    throw new TypeError(`preset name must be at most ${MAX_PRESET_NAME_LENGTH} characters`);
  }
  if (FORBIDDEN_NAMES.has(name)) throw new TypeError(`preset name is reserved: ${name}`);
  if (!PRESET_NAME_PATTERN.test(name)) {
    throw new TypeError('preset name may only contain letters, digits, "-" and "_"');
  }
  return name;
}

// Validate one simple-settings object. Keys are optional (base policies and
// presets are partial); present values are strictly checked. patch=true
// additionally allows null, which means "clear this setting".
export function validateRoutingSettings(settings, { patch = false } = {}) {
  if (!isObject(settings)) throw new TypeError("routing settings must be an object");
  const unknown = Object.keys(settings).filter((key) => !SIMPLE_KEY_SET.has(key));
  if (unknown.length) throw new TypeError(`unsupported routing settings: ${unknown.join(", ")}`);

  if (Object.hasOwn(settings, "harnessOrder") && settings.harnessOrder != null) {
    const order = settings.harnessOrder;
    if (!Array.isArray(order) || order.length === 0
      || order.some((name) => typeof name !== "string" || !name.trim())) {
      throw new TypeError("harnessOrder must be a non-empty array of harness names");
    }
    for (const name of order) {
      if (!TARGETS.has(name.trim())) {
        throw new TypeError(`harnessOrder.${name}: unknown harness; expected ${[...TARGETS].join(", ")}`);
      }
    }
    if (new Set(order.map((name) => name.trim())).size !== order.length) {
      throw new TypeError("harnessOrder must not repeat a harness");
    }
  } else if (Object.hasOwn(settings, "harnessOrder") && !patch) {
    throw new TypeError("harnessOrder must be a non-empty array of harness names");
  }

  if (Object.hasOwn(settings, "tier") && settings.tier != null) {
    if (typeof settings.tier !== "string" || !TIERS.has(settings.tier)) {
      throw new TypeError(`tier must be one of ${[...TIERS].join(", ")}`);
    }
  } else if (Object.hasOwn(settings, "tier") && !patch) {
    throw new TypeError(`tier must be one of ${[...TIERS].join(", ")}`);
  }

  if (Object.hasOwn(settings, "models") && settings.models != null) {
    if (!isObject(settings.models)) throw new TypeError("models must be an object keyed by harness");
    for (const [target, model] of Object.entries(settings.models)) {
      if (!TARGETS.has(target)) {
        throw new TypeError(`models.${target}: unknown harness; expected ${[...TARGETS].join(", ")}`);
      }
      if (model == null) {
        if (!patch) throw new TypeError(`models.${target} must be a non-empty model string`);
        continue; // patch null clears one harness override
      }
      if (typeof model !== "string" || !model.trim()) {
        throw new TypeError(`models.${target} must be a non-empty model string`);
      }
    }
  } else if (Object.hasOwn(settings, "models") && !patch) {
    throw new TypeError("models must be an object keyed by harness");
  }

  if (Object.hasOwn(settings, "thinking") && settings.thinking != null) {
    if (typeof settings.thinking !== "string" || !THINKING_LEVELS.has(settings.thinking)) {
      throw new TypeError(`thinking must be one of ${[...THINKING_LEVELS].join(", ")}`);
    }
  } else if (Object.hasOwn(settings, "thinking") && !patch) {
    throw new TypeError(`thinking must be one of ${[...THINKING_LEVELS].join(", ")}`);
  }

  for (const key of ["fallbacks", "allowTrainingEndpoints"]) {
    if (Object.hasOwn(settings, key) && settings[key] != null && typeof settings[key] !== "boolean") {
      throw new TypeError(`${key} must be a boolean`);
    }
    if (Object.hasOwn(settings, key) && settings[key] == null && !patch) {
      throw new TypeError(`${key} must be a boolean`);
    }
  }
  if (Object.hasOwn(settings, "modelVersion") && !(patch && settings.modelVersion == null)
    && !["latest", "pin"].includes(settings.modelVersion)) {
    throw new TypeError("modelVersion must be latest or pin");
  }
  return settings;
}

function pickSimple(source) {
  const picked = {};
  for (const key of SIMPLE_KEYS) {
    if (Object.hasOwn(source ?? {}, key)) picked[key] = source[key];
  }
  return picked;
}

// Resolve the effective plain policy: strip presets/activePreset, merge the
// selected preset OVER the base simple keys (models merge per harness), and
// translate the `thinking` sugar into defaults.route.thinking.
//
// requestedPreset: undefined => stored activePreset; null => base policy;
// string => that named preset (nonexistent names fail closed).
// Returns the policy only, no extra metadata.
export function resolveUserPreset(policy, requestedPreset = undefined) {
  if (policy == null) {
    if (requestedPreset != null) throw new TypeError(`unknown routing preset: "${requestedPreset}"`);
    return policy;
  }
  if (!isObject(policy)) throw new TypeError("user policy must be an object");

  const { presets: rawPresets, activePreset: rawActive, thinking: baseThinking, ...rest } = policy;

  const unknown = Object.keys(rest).filter((key) => !SIMPLE_KEY_SET.has(key) && !ADVANCED_KEYS.has(key));
  if (unknown.length) throw new TypeError(`user policy contains unsupported fields: ${unknown.join(", ")}`);

  const presets = rawPresets === undefined ? {} : rawPresets;
  if (!isObject(presets)) throw new TypeError("user policy presets must be an object keyed by preset name");
  for (const name of Object.keys(presets)) {
    validatePresetName(name);
    if (!isObject(presets[name])) throw new TypeError(`preset "${name}" must be an object of routing settings`);
    validateRoutingSettings(presets[name]);
  }

  let activePreset = null;
  if (rawActive !== undefined && rawActive !== null) {
    if (typeof rawActive !== "string") throw new TypeError("activePreset must be a preset name or null");
    if (!Object.hasOwn(presets, rawActive)) throw new TypeError(`activePreset "${rawActive}" does not match a saved preset`);
    activePreset = rawActive;
  }

  let selected = null;
  let selectedName = null;
  if (requestedPreset === undefined) {
    selectedName = activePreset;
  } else if (requestedPreset === null) {
    selectedName = null;
  } else if (typeof requestedPreset === "string") {
    selectedName = requestedPreset;
  } else {
    throw new TypeError("requested preset must be a preset name, null, or undefined");
  }
  if (selectedName !== null) {
    if (!Object.hasOwn(presets, selectedName)) throw new TypeError(`unknown routing preset: "${selectedName}"`);
    selected = presets[selectedName];
  }

  // Base simple keys may be absent (partial file); validate what is present.
  validateRoutingSettings({ ...pickSimple(rest), ...(baseThinking == null ? {} : { thinking: baseThinking }) }, { patch: true });

  const merged = pickSimple(rest);
  if (baseThinking != null) merged.thinking = baseThinking;
  if (selected) {
    for (const key of SIMPLE_KEYS) {
      if (key === "models") continue;
      if (Object.hasOwn(selected, key)) merged[key] = selected[key];
    }
    if (Object.hasOwn(selected, "models")) {
      merged.models = { ...(merged.models ?? {}), ...selected.models };
    }
  }

  const { thinking, ...resolved } = { ...rest, ...merged };
  if (thinking != null) {
    // The sugar takes precedence over base defaults, while an explicit
    // request-level route.thinking still wins inside the engine.
    resolved.defaults = {
      ...(isObject(resolved.defaults) ? resolved.defaults : {}),
      route: { ...(isObject(resolved.defaults?.route) ? resolved.defaults.route : {}), thinking },
    };
  }
  return resolved;
}
