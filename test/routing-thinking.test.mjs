// Thinking levels: tier/difficulty defaults (capped at high), explicit wins,
// declared-support gate.
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRequest } from "../src/protocol.mjs";
import { defaultThinking, resolvePolicyRoute } from "../src/routing-policy.mjs";

function request(overrides = {}) {
  return normalizeRequest({
    requestId: "thinking-test",
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

function lane(id, extra = {}) {
  return {
    id, target: "pi", route: {},
    scores: { quality: 5, speed: 5, efficiency: 5, reliability: 5 },
    capabilities: { readOnly: true, write: true },
    ...extra,
  };
}

test("derived thinking is skipped for cursor lanes while explicit thinking still fails closed", () => {
  const cursorLane = {
    id: "cursor-lane", target: "cursor", route: { model: "composer" },
    scores: { quality: 5, speed: 5, efficiency: 5, reliability: 5 },
    capabilities: { readOnly: true, write: true },
  };
  const derived = request({ target: "cursor", metadata: { routing: { tier: "balanced" } } });
  const decided = resolvePolicyRoute(derived, scopesFor(derived, { candidates: [cursorLane] }), { now: () => 0 });
  assert.equal(decided.target, "cursor");
  assert.equal(decided.route.model, "composer");
  assert.equal(decided.route.thinking, undefined, "a derived default must not be injected where the adapter rejects it");
  assert.equal(decided.explanation.thinking, undefined);

  const explicit = request({ target: "cursor", route: { model: "composer", thinking: "high" } });
  assert.throws(() => resolvePolicyRoute(explicit, scopesFor(explicit, { candidates: [cursorLane] })), /thinking.*not supported/);
});

test("ranked alternatives preserve required thinking over candidate and derived levels", () => {
  for (const explicit of [true, false]) {
    const req = request({ route: explicit ? { thinking: "high" } : {}, metadata: { routing: { mode: "auto", tier: "quick" } } });
    const decided = resolvePolicyRoute(req, scopesFor(req, {
      ...(!explicit ? { route: { thinking: "high" } } : {}),
      candidates: [lane("a", { route: { model: "first", thinking: "medium" } }), lane("b", { route: { model: "backup", thinking: "max" } })],
    }));
    assert.equal(decided.route.thinking, "high");
    assert.deepEqual(decided.explanation.rankedRoutes.map((entry) => entry.route.thinking), ["high", "high"]);
  }
});

test("ranked alternatives derive defaults only for supporting targets", () => {
  const req = request({ metadata: { routing: { mode: "auto", tier: "deep" } } });
  const decided = resolvePolicyRoute(req, scopesFor(req, { candidates: [
    lane("a"), lane("b", { target: "cursor", route: { model: "composer" } }),
    lane("c", { capabilities: { thinking: ["low"] } }),
  ] }));
  assert.deepEqual(decided.explanation.rankedRoutes.map((entry) => entry.route.thinking), ["high", undefined, undefined]);
});

test("tier derives thinking when the caller names none", () => {
  for (const [tier, level] of [["quick", "low"], ["balanced", "medium"], ["deep", "high"], ["review", "high"]]) {
    const req = request({ metadata: { routing: { mode: "auto", tier } } });
    const decided = resolvePolicyRoute(req, scopesFor(req, { candidates: [lane("a")] }), { now: () => 0 });
    assert.equal(decided.route.thinking, level, tier);
    assert.equal(decided.explanation.thinking, level, tier);
    assert.equal(decided.explanation.thinkingSource, "tier/difficulty default", tier);
  }
});

test("difficulty derives thinking; higher of tier/difficulty wins, capped at high", () => {
  const trivial = request({ metadata: { routing: { mode: "auto", difficulty: "trivial" } } });
  assert.equal(resolvePolicyRoute(trivial, scopesFor(trivial, { candidates: [lane("a")] }), { now: () => 0 }).route.thinking, "low");
  const mixed = request({ metadata: { routing: { mode: "auto", tier: "quick", difficulty: "hard" } } });
  const decided = resolvePolicyRoute(mixed, scopesFor(mixed, { candidates: [lane("a")] }), { now: () => 0 });
  assert.equal(decided.route.thinking, "high");
  assert.equal(decided.explanation.thinkingSource, "tier/difficulty default");
});

test("explicit thinking always wins, even above the ceiling", () => {
  const req = request({
    route: { model: "m", thinking: "max" },
    metadata: { routing: { mode: "auto", tier: "quick", difficulty: "trivial" } },
  });
  const decided = resolvePolicyRoute(req, scopesFor(req, { candidates: [lane("a")] }), { now: () => 0 });
  assert.equal(decided.route.thinking, "max");
  assert.equal(decided.explanation.thinkingSource, "explicit");
});

test("policy-set thinking beats the derived default", () => {
  const req = request({ metadata: { routing: { mode: "auto", tier: "deep" } } });
  const decided = resolvePolicyRoute(req, scopesFor(req, {
    candidates: [lane("a")],
    defaults: { route: { thinking: "medium" } },
  }), { now: () => 0 });
  assert.equal(decided.route.thinking, "medium");
  assert.equal(decided.explanation.thinkingSource, "policy");
});

test("no tier or difficulty means no thinking default", () => {
  const req = request({ metadata: { routing: { mode: "auto" } } });
  const decided = resolvePolicyRoute(req, scopesFor(req, { candidates: [lane("a")] }), { now: () => 0 });
  assert.equal(decided.route.thinking, undefined);
  assert.ok(!("thinking" in decided.explanation));
  assert.ok(!("thinkingSource" in decided.explanation));
});

test("declared levels gate; undeclared lists accept anything", () => {
  const req = request({ route: { model: "m", thinking: "high" }, metadata: { routing: { mode: "auto" } } });
  const gated = resolvePolicyRoute(req, scopesFor(req, {
    candidates: [lane("narrow", { capabilities: { readOnly: true, write: true, thinking: ["low", "medium"] } })],
  }), { now: () => 0 });
  assert.deepEqual(gated.explanation.rejected, [{ id: "narrow", reasons: ["thinking-level"] }]);
  const open = resolvePolicyRoute(req, scopesFor(req, { candidates: [lane("open")] }), { now: () => 0 });
  assert.equal(open.explanation.selected, "open");
});

test("derived defaults are advisory: deep tier does not reject a low-only lane", () => {
  const req = request({ metadata: { routing: { mode: "auto", tier: "deep" } } });
  const decided = resolvePolicyRoute(req, scopesFor(req, {
    candidates: [lane("low-only", { capabilities: { readOnly: true, write: true, thinking: ["low"] } })],
  }), { now: () => 0 });
  assert.equal(decided.explanation.selected, "low-only");
  assert.equal(decided.route.thinking, undefined, "the low-only lane keeps its own default instead of being rejected");
  assert.ok(!("thinking" in decided.explanation));
  const admitted = resolvePolicyRoute(req, scopesFor(req, {
    candidates: [lane("wide", { capabilities: { readOnly: true, write: true, thinking: ["low", "high"] } })],
  }), { now: () => 0 });
  assert.equal(admitted.route.thinking, "high", "a lane that declares the derived level still receives it");
});

test("defaultThinking unit behavior", () => {
  assert.equal(defaultThinking("quick", undefined), "low");
  assert.equal(defaultThinking(undefined, "hard"), "high");
  assert.equal(defaultThinking("quick", "hard"), "high");
  assert.equal(defaultThinking(undefined, undefined), null);
  assert.equal(defaultThinking("balanced", "bounded"), "medium");
});
