// resolveUserPreset / validateRoutingSettings: pure preset front end.
// Deterministic, no harness or model calls.
import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveUserPreset,
  validateRoutingSettings,
} from "../src/routing-preferences.mjs";

test("base policy without presets passes through with advanced keys retained", () => {
  const policy = { tier: "quick", rules: [{ when: {}, apply: {} }], candidates: [] };
  assert.deepEqual(resolveUserPreset(policy), policy);
  assert.equal(resolveUserPreset(null), null);
});

test("undefined uses activePreset, null restores base, string selects named", () => {
  const policy = {
    tier: "balanced",
    harnessOrder: ["pi", "claude"],
    models: { pi: "base-pi" },
    presets: { fast: { tier: "quick", models: { pi: "fast-pi" } } },
    activePreset: "fast",
  };
  const active = resolveUserPreset(policy);
  assert.equal(active.tier, "quick");
  assert.equal(active.models.pi, "fast-pi");
  assert.deepEqual(active.harnessOrder, ["pi", "claude"]);
  assert.ok(!("presets" in active) && !("activePreset" in active));

  const base = resolveUserPreset(policy, null);
  assert.equal(base.tier, "balanced");
  assert.equal(base.models.pi, "base-pi");

  assert.equal(resolveUserPreset(policy, "fast").tier, "quick");
  assert.throws(() => resolveUserPreset(policy, "nope"), /unknown routing preset/);
});

test("models merge per harness; preset scalars override base", () => {
  const policy = {
    models: { pi: "base-pi", claude: "base-claude" },
    presets: { mix: { models: { pi: "fast-pi" } } },
  };
  const resolved = resolveUserPreset({ ...policy, activePreset: "mix" });
  assert.deepEqual(resolved.models, { pi: "fast-pi", claude: "base-claude" });
});

test("thinking sugar moves to defaults.route.thinking with preset precedence", () => {
  const policy = {
    thinking: "low",
    defaults: { route: { variant: "v" } },
    presets: { deep: { thinking: "high" } },
    activePreset: "deep",
  };
  const resolved = resolveUserPreset(policy);
  assert.ok(!("thinking" in resolved));
  assert.deepEqual(resolved.defaults, { route: { variant: "v", thinking: "high" } });
  const base = resolveUserPreset(policy, null);
  assert.equal(base.defaults.route.thinking, "low");
});

test("invalid presets, names, and unknown fields fail closed", () => {
  assert.throws(() => resolveUserPreset(JSON.parse('{"presets":{"__proto__":{}}}')), /reserved/);
  assert.throws(() => resolveUserPreset({ presets: { "bad name!": {} } }), /preset name/);
  assert.throws(() => resolveUserPreset({ presets: { ok: { tier: "warp" } } }), /tier must be one of/);
  assert.throws(() => resolveUserPreset({ presets: { ok: {} }, activePreset: "gone" }), /does not match/);
  assert.throws(() => resolveUserPreset({ quotas: {} }), /unsupported fields/);
  assert.throws(() => resolveUserPreset({ harnessOrder: ["pi", "pi"] }), /must not repeat/);
  assert.throws(() => resolveUserPreset({ models: { dsh: "x" } }), /unknown harness/);
});

test("validateRoutingSettings patch mode allows null clears, strict mode rejects them", () => {
  validateRoutingSettings({ tier: null, models: { pi: null } }, { patch: true });
  assert.throws(() => validateRoutingSettings({ tier: null }), /tier must be/);
  assert.throws(() => validateRoutingSettings({ models: { pi: null } }), /non-empty model string/);
  assert.throws(() => validateRoutingSettings({ invented: 1 }), /unsupported routing settings/);
  assert.throws(() => validateRoutingSettings({ thinking: "ultra" }), /thinking must be one of/);
  assert.throws(() => validateRoutingSettings({ fallbacks: "yes" }), /fallbacks must be a boolean/);
});
