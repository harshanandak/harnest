// Model/harness score composition: capability and loop cost score separately.
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRequest } from "../src/protocol.mjs";
import { resolvePolicyRoute } from "../src/routing-policy.mjs";
import { buildNamedLane, familyModelRating } from "../src/routing-presets.mjs";

function request(overrides = {}) {
  return normalizeRequest({
    requestId: "compose-test",
    target: "pi",
    task: "do the thing",
    cwd: process.cwd(),
    ...overrides,
  });
}

function scopesFor(req, globalPolicy) {
  return [
    { name: "global", policy: globalPolicy },
    ...(req.metadata?.routing ? [{ name: "request", policy: req.metadata.routing }] : []),
  ];
}

test("model block composes quality from intelligence/taste", () => {
  const req = request({ metadata: { routing: { mode: "auto" } } });
  const decided = resolvePolicyRoute(req, scopesFor(req, {
    weights: { quality: 10, speed: 0, efficiency: 0, reliability: 0 },
    candidates: [{
      id: "grok-lane", target: "cursor", route: { model: "cursor-grok-4.6-high-fast" },
      model: { intelligence: 8, taste: 6, speed: 5, costEff: 7, decisiveness: 8 },
      scores: { reliability: 8 },
    }],
  }), { now: () => 0 });
  // quality = 0.7*8 + 0.3*6 = 7.4; x10 weight = 74
  assert.equal(decided.explanation.scoreBreakdown.quality, 74);
  assert.equal(decided.explanation.selected, "grok-lane");
});

test("harness loop modifiers shift speed/efficiency, clamped 0..10", () => {
  const req = request({ metadata: { routing: { mode: "auto" } } });
  const decided = resolvePolicyRoute(req, scopesFor(req, {
    weights: { quality: 0, speed: 10, efficiency: 10, reliability: 0 },
    candidates: [{
      id: "pi-lane", target: "pi", route: {},
      model: { intelligence: 7, taste: 7, speed: 9, costEff: 9 },
      harness: { speedMod: 2, efficiencyMod: 1 },
      scores: { reliability: 8 },
    }],
  }), { now: () => 0 });
  // speed = min(10, 9+2) = 10 -> 100; efficiency = min(10, 9+1) = 10 -> 100
  assert.equal(decided.explanation.scoreBreakdown.speed, 100);
  assert.equal(decided.explanation.scoreBreakdown.efficiency, 100);
});

test("flat candidates score exactly as before (backward compatible)", () => {
  const req = request({ metadata: { routing: { mode: "auto" } } });
  const decided = resolvePolicyRoute(req, scopesFor(req, {
    weights: { quality: 4, speed: 3, efficiency: 3, reliability: 4 },
    candidates: [{
      id: "flat", target: "pi", route: {},
      scores: { quality: 6, speed: 8, efficiency: 7, reliability: 9 },
    }],
  }), { now: () => 0 });
  assert.deepEqual(decided.explanation.scoreBreakdown, { quality: 24, speed: 24, efficiency: 21, reliability: 36 });
});

test("cheap-capable grok beats flagship on quick; flagship wins on deep+review tags", () => {
  const lanes = [
    { ...buildNamedLane({ id: "cursor-cheap", target: "cursor", model: "cursor-grok-4.6-high-fast", tags: ["cheap", "fast"] }) },
    {
      id: "claude-flagship", target: "claude", route: { model: "opus" },
      model: { intelligence: 9, taste: 9, speed: 6, costEff: 5 },
      scores: { reliability: 9 }, tags: ["flagship", "deep"],
    },
  ];
  const quick = request({ metadata: { routing: { mode: "auto", tier: "quick" } } });
  assert.equal(resolvePolicyRoute(quick, scopesFor(quick, { candidates: lanes }), { now: () => 0 }).explanation.selected, "cursor-cheap");
  const deep = request({ metadata: { routing: { mode: "auto", tier: "deep" } } });
  assert.equal(resolvePolicyRoute(deep, scopesFor(deep, { candidates: lanes }), { now: () => 0 }).explanation.selected, "claude-flagship");
});

test("require.computerUse gates lanes without it", () => {
  const lanes = [
    { id: "plain", target: "pi", route: {}, scores: { quality: 10, speed: 10, efficiency: 10, reliability: 10 }, capabilities: { readOnly: true, write: true } },
    { id: "driver", target: "claude", route: {}, scores: { quality: 1, speed: 1, efficiency: 1, reliability: 1 }, capabilities: { readOnly: true, write: true, computerUse: true } },
  ];
  const req = request({ metadata: { routing: { mode: "auto", require: { computerUse: true } } } });
  const decided = resolvePolicyRoute(req, scopesFor(req, { candidates: lanes }), { now: () => 0 });
  assert.equal(decided.explanation.selected, "driver");
  assert.deepEqual(decided.explanation.rejected, [{ id: "plain", reasons: ["computer-use"] }]);
});

test("model/harness validation fails closed on bad ranges and unknown fields", () => {
  const bad = (candidates) => () => resolvePolicyRoute(request({ metadata: { routing: { mode: "auto" } } }),
    scopesFor(request({ metadata: { routing: { mode: "auto" } } }), { candidates }), { now: () => 0 });
  assert.throws(bad([{ id: "x", target: "pi", route: {}, model: { intelligence: 11 } }]), /model\.intelligence/);
  assert.throws(bad([{ id: "x", target: "pi", route: {}, harness: { speedMod: 6 } }]), /harness\.speedMod/);
  assert.throws(bad([{ id: "x", target: "pi", route: {}, model: { smarts: 5 } }]), /unsupported fields/);
  assert.throws(bad([{ id: "x", target: "pi", route: {}, capabilities: { computerUse: "yes" } }]), /computerUse.*boolean/);
});

test("family ratings key cheap grok/composer without version lock", () => {
  assert.deepEqual(familyModelRating("cursor-grok-4.6-high-fast"), { intelligence: 8, taste: 6, speed: 5, costEff: 7, decisiveness: 8 });
  assert.deepEqual(familyModelRating("composer-2.5"), { intelligence: 6, taste: 6, speed: 7, costEff: 10, decisiveness: 8 });
  assert.deepEqual(familyModelRating("something-entirely-new"), { intelligence: 7, taste: null, speed: 7, costEff: 6, decisiveness: 6 });
});

test("named lanes carry harness loop, reliability floor, and capabilities", () => {
  const lane = buildNamedLane({ id: "cursor-cheap", target: "cursor", model: "cursor-grok-4.6-high-fast", tags: ["cheap"] });
  assert.deepEqual(lane.route, { model: "cursor-grok-4.6-high-fast" });
  assert.deepEqual(lane.model, { intelligence: 8, taste: 6, speed: 5, costEff: 7, decisiveness: 8 });
  assert.deepEqual(lane.harness, { speedMod: 0, efficiencyMod: -1 });
  assert.equal(lane.scores.reliability, 8);
  assert.equal(lane.capabilities.write, true);
  assert.throws(() => buildNamedLane({ id: "x", target: "cursor" }), /requires id, target, and model/);
});
