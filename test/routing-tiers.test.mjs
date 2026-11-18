// Simple preference layer: tiers, harness order, and model catalog expansion.
// Uses zero-token deterministic routing only.
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRouteResolver } from "../src/routing.mjs";
import { normalizeRequest } from "../src/protocol.mjs";
import { buildDefaultCandidates, expandUserPolicy } from "../src/routing-presets.mjs";
import { TIERS, resolvePolicyRoute } from "../src/routing-policy.mjs";

const execFileAsync = promisify(execFile);

function request(overrides = {}) {
  return normalizeRequest({
    requestId: "tier-test",
    target: "pi",
    task: "do the thing",
    cwd: process.cwd(),
    ...overrides,
  });
}

// resolvePolicyRoute takes explicit scopes; the request scope (metadata.routing)
// is normally added by routing.mjs policyScopes(). Include it here.
function scopesFor(req, globalPolicy) {
  return [
    { name: "global", policy: globalPolicy },
    ...(req.metadata?.routing ? [{ name: "request", policy: req.metadata.routing }] : []),
  ];
}

function twinCandidates() {
  return [
    { id: "slow-deep", target: "pi", route: { provider: "p", model: "deep" }, scores: { quality: 5, speed: 5, efficiency: 5, reliability: 5 }, capabilities: { readOnly: true, write: true }, tags: ["deep"] },
    { id: "fast-shallow", target: "cursor", route: { provider: "c", model: "fast" }, scores: { quality: 5, speed: 5, efficiency: 5, reliability: 5 }, capabilities: { readOnly: true, write: true }, tags: ["fast"] },
  ];
}

test("tier quick selects the fast lane, tier deep selects the deep lane", () => {
  const quickReq = request({ metadata: { routing: { mode: "auto", tier: "quick" } } });
  const quick = resolvePolicyRoute(quickReq, scopesFor(quickReq, { candidates: twinCandidates() }), { now: () => 0 });
  assert.equal(quick.explanation.selected, "fast-shallow");
  assert.equal(quick.explanation.tier, "quick");
  const deepReq = request({ metadata: { routing: { mode: "auto", tier: "deep" } } });
  const deep = resolvePolicyRoute(deepReq, scopesFor(deepReq, { candidates: twinCandidates() }), { now: () => 0 });
  assert.equal(deep.explanation.selected, "slow-deep");
  assert.equal(deep.explanation.tier, "deep");
});

test("explicit prefer in the same scope overrides the tier-implied prefer", () => {
  const req = request({ metadata: { routing: { mode: "auto", tier: "quick", prefer: { tags: ["deep"] } } } });
  const decided = resolvePolicyRoute(req, scopesFor(req, { candidates: twinCandidates() }), { now: () => 0 });
  assert.equal(decided.explanation.selected, "slow-deep");
});

test("tier-implied prefer still applies when only weights are overridden", () => {
  const req = request({ metadata: { routing: { mode: "auto", tier: "quick", weights: { quality: 10, speed: 1 } } } });
  const decided = resolvePolicyRoute(req, scopesFor(req, { candidates: twinCandidates() }), { now: () => 0 });
  assert.equal(decided.explanation.selected, "fast-shallow");
});

test("unknown tier and duplicate harness order fail closed", () => {
  const badTier = request({ metadata: { routing: { mode: "auto", tier: "warp" } } });
  assert.throws(() => resolvePolicyRoute(badTier, scopesFor(badTier, { candidates: twinCandidates() }), { now: () => 0 }), /tier must be one of/);
  assert.throws(() => resolvePolicyRoute(request(),
    [{ name: "global", policy: { candidates: twinCandidates(), harnessOrder: ["pi", "pi"] } }], { now: () => 0 }), /must not repeat/);
});

test("harnessOrder breaks ties but never beats an explicit prefer", () => {
  const ordered = resolvePolicyRoute(request({ metadata: { routing: { mode: "auto" } } }),
    [{ name: "global", policy: { candidates: twinCandidates(), harnessOrder: ["cursor", "pi"] } }], { now: () => 0 });
  assert.equal(ordered.explanation.selected, "fast-shallow");
  assert.ok(ordered.explanation.orderBonus > 0);
  assert.deepEqual(ordered.explanation.harnessOrder, ["cursor", "pi"]);
  const preferred = resolvePolicyRoute(request({ metadata: { routing: { mode: "auto" } } }),
    [{
      name: "global",
      policy: { candidates: twinCandidates(), harnessOrder: ["cursor", "pi"], prefer: { tags: ["deep"] } },
    }], { now: () => 0 });
  assert.equal(preferred.explanation.selected, "slow-deep");
});

test("review prefers codex, but UI-flavored review keeps claude", () => {
  const lanes = [
    { id: "codex-lane", target: "codex", route: { model: "sol" }, scores: { quality: 5, speed: 5, efficiency: 5, reliability: 5 }, capabilities: { readOnly: true, write: true }, tags: [] },
    { id: "claude-lane", target: "claude", route: { model: "sonnet" }, scores: { quality: 5, speed: 5, efficiency: 5, reliability: 5 }, capabilities: { readOnly: true, write: true }, tags: [] },
  ];
  const policy = {
    candidates: lanes,
    rules: [
      { id: "review-codex", priority: 11, when: { taskAny: ["review"] }, apply: { target: "codex" } },
      { id: "ui-claude", priority: 12, when: { taskAny: ["ui", "design"] }, apply: { tier: "review", target: "claude" } },
    ],
  };
  const plain = request({ metadata: { routing: { mode: "auto" } }, task: "Review this PR for correctness" });
  assert.equal(resolvePolicyRoute(plain, scopesFor(plain, policy), { now: () => 0 }).explanation.selected, "codex-lane");
  const ui = request({ metadata: { routing: { mode: "auto" } }, task: "Review the settings page UI" });
  const uiDecision = resolvePolicyRoute(ui, scopesFor(ui, policy), { now: () => 0 });
  assert.equal(uiDecision.explanation.selected, "claude-lane");
  assert.deepEqual(uiDecision.explanation.rejected, [{ id: "codex-lane", reasons: ["target"] }]);
});

test("explicit pins keep their target against rule-set directive targets", () => {
  const req = request({
    route: { provider: "p", model: "m" },
    metadata: { routing: { mode: "pin" } },
  });
  const decided = resolvePolicyRoute(req, scopesFor(req, {
    candidates: [
      { id: "a", target: "pi", route: { provider: "p", model: "m" }, scores: { quality: 5, speed: 5, efficiency: 5, reliability: 5 } },
    ],
    rules: [{ id: "force", priority: 1, when: { taskAny: ["do"] }, apply: { target: "codex" } }],
  }), { now: () => 0 });
  assert.equal(decided.target, "pi");
  assert.equal(decided.explanation.selected, "explicit-route");
});

test("rules can match on tier", () => {
  const req = request({ metadata: { routing: { mode: "auto", tier: "review" } } });
  const decided = resolvePolicyRoute(req, scopesFor(req, {
    candidates: twinCandidates(),
    rules: [{ id: "review-needs-depth", priority: 1, when: { tier: "review" }, apply: { prefer: { tags: ["deep"] } } }],
  }), { now: () => 0 });
  assert.equal(decided.explanation.selected, "slow-deep");
  assert.deepEqual(decided.explanation.matchedRules, ["global:review-needs-depth"]);
});

test("catalog builds honest defaults: pi+claude auto, rest need names", () => {
  const bare = buildDefaultCandidates({});
  const ids = bare.map((c) => c.id);
  assert.deepEqual(ids, ["auto-claude", "auto-pi"]);
  const withModels = buildDefaultCandidates({ opencode: "anthropic/sonnet", claude: "sonnet", cursor: "composer-2.5", codex: "gpt-6.1-terra" });
  assert.deepEqual(withModels.map((c) => c.id), ["auto-claude", "auto-pi", "auto-cursor", "auto-codex", "auto-opencode"]);
  assert.deepEqual(withModels.find((c) => c.id === "auto-opencode").route, { provider: "anthropic", model: "sonnet" });
  assert.deepEqual(withModels.find((c) => c.id === "auto-claude").route, { model: "sonnet" });
  assert.deepEqual(withModels.find((c) => c.id === "auto-cursor").route, { model: "composer-2.5" });
  assert.deepEqual(withModels.find((c) => c.id === "auto-codex").route, { model: "gpt-6.1-terra" });
  assert.deepEqual(withModels.find((c) => c.id === "auto-codex").model, { intelligence: 7, taste: 7, speed: 8, costEff: 8, decisiveness: 7 });
});

test("Gemini, Amp, and ACP are excluded from built-in auto routes while explicit candidates stay honest", () => {
  const defaults = buildDefaultCandidates({});
  assert.equal(defaults.some((candidate) => ["gemini", "amp", "acp"].includes(candidate.target)), false);

  const gemini = buildDefaultCandidates({ gemini: "gemini-3-pro" }).find((candidate) => candidate.target === "gemini");
  assert.deepEqual(gemini.route, { model: "gemini-3-pro" });
  assert.equal(gemini.capabilities.readOnly, true);
  assert.equal(gemini.capabilities.write, true);

  assert.throws(
    () => expandUserPolicy({ models: { amp: "smart" } }),
    /models\.amp is unsupported.*--mode.*model pin/i,
  );
  assert.throws(
    () => expandUserPolicy({ models: { acp: "not-a-model" } }),
    /models\.acp is unsupported.*ACP registration/i,
  );

  const ampRequest = request({ target: "amp", policy: { write: true } });
  const amp = resolvePolicyRoute(ampRequest, scopesFor(ampRequest, {
    candidates: [{
      id: "manual-amp",
      target: "amp",
      route: { variant: "medium" },
      scores: { quality: 5, speed: 5, efficiency: 5, reliability: 5 },
      capabilities: { readOnly: false, write: true, taskflow: false, liveControl: false },
    }],
  }), { now: () => 0 });
  assert.equal(amp.explanation.selected, "manual-amp");
  assert.deepEqual(amp.route, { variant: "medium" });

  const readOnlyAmpRequest = request({ target: "amp", policy: { write: false } });
  assert.throws(() => resolvePolicyRoute(readOnlyAmpRequest, scopesFor(readOnlyAmpRequest, {
    candidates: [{
      id: "manual-amp",
      target: "amp",
      route: { variant: "medium" },
      scores: { quality: 5, speed: 5, efficiency: 5, reliability: 5 },
      capabilities: { readOnly: false, write: true, taskflow: false, liveControl: false },
    }],
  }), { now: () => 0 }), /Amp cannot enforce a read-only request/);
});

test("automatic routing rejects unsupported Gemini and Amp policy without hiding a compatible lane", () => {
  const candidates = [
    { id: "gemini-high", target: "gemini", route: { model: "gemini-3-pro" }, scores: { quality: 10, speed: 10, efficiency: 10, reliability: 10 }, capabilities: { readOnly: true, write: true } },
    { id: "amp-high", target: "amp", route: { variant: "high" }, scores: { quality: 10, speed: 10, efficiency: 10, reliability: 10 }, capabilities: { readOnly: false, write: true } },
    { id: "pi-compatible", target: "pi", route: { model: "fixture" }, scores: { quality: 1, speed: 1, efficiency: 1, reliability: 1 }, capabilities: { readOnly: true, write: true } },
  ];
  const toolsRequest = request({ metadata: { routing: { mode: "auto" } }, policy: { tools: ["read"] } });
  const toolsDecision = resolvePolicyRoute(toolsRequest, scopesFor(toolsRequest, { candidates }), { now: () => 0 });
  assert.equal(toolsDecision.explanation.selected, "pi-compatible");
  assert.deepEqual(toolsDecision.explanation.rejected, [
    { id: "gemini-high", reasons: ["granular-tools"] },
    { id: "amp-high", reasons: ["read-only", "granular-tools"] },
  ]);

  const budgetRequest = request({ metadata: { routing: { mode: "auto" } }, policy: { maxCostUsd: 1 } });
  const budgetDecision = resolvePolicyRoute(budgetRequest, scopesFor(budgetRequest, { candidates }), { now: () => 0 });
  assert.equal(budgetDecision.explanation.selected, "pi-compatible");
  assert.deepEqual(budgetDecision.explanation.rejected, [
    { id: "gemini-high", reasons: ["cost-budget"] },
    { id: "amp-high", reasons: ["read-only", "cost-budget"] },
  ]);
});

test("automatic routing rejects every adapter-invalid Gemini candidate route and keeps a compatible fallback", () => {
  const invalidRoutes = [
    [{ provider: "openai" }, "gemini-provider"],
    [{ model: "gpt-6" }, "gemini-model"],
    [{ agent: "reviewer" }, "gemini-route-control"],
    [{ variant: "high" }, "gemini-route-control"],
    [{ harnessVersion: "v2" }, "gemini-route-control"],
  ];
  for (const [route, reason] of invalidRoutes) {
    const automatic = request({ metadata: { routing: { mode: "auto" } } });
    const decision = resolvePolicyRoute(automatic, scopesFor(automatic, { candidates: [
      { id: "gemini-invalid", target: "gemini", route, scores: { quality: 10, speed: 10, efficiency: 10, reliability: 10 }, capabilities: { readOnly: true, write: true } },
      { id: "pi-compatible", target: "pi", route: { model: "fixture" }, scores: { quality: 1, speed: 1, efficiency: 1, reliability: 1 }, capabilities: { readOnly: true, write: true } },
    ] }), { now: () => 0 });
    assert.equal(decision.explanation.selected, "pi-compatible", JSON.stringify(route));
    assert.deepEqual(decision.explanation.rejected, [{ id: "gemini-invalid", reasons: [reason] }]);
  }

  const valid = request({ metadata: { routing: { mode: "auto" } } });
  const selected = resolvePolicyRoute(valid, scopesFor(valid, { candidates: [
    { id: "gemini-valid", target: "gemini", route: { provider: "google", model: "gemini-3-pro" }, scores: { quality: 10, speed: 10, efficiency: 10, reliability: 10 }, capabilities: { readOnly: true, write: true } },
    { id: "pi-compatible", target: "pi", route: { model: "fixture" }, scores: { quality: 1, speed: 1, efficiency: 1, reliability: 1 }, capabilities: { readOnly: true, write: true } },
  ] }), { now: () => 0 });
  assert.equal(selected.explanation.selected, "gemini-valid");

  const slashAlias = request({ metadata: { routing: { mode: "auto" } } });
  const slashAliasSelected = resolvePolicyRoute(slashAlias, scopesFor(slashAlias, { candidates: [
    { id: "gemini-slash-alias", target: "gemini", route: { provider: "google/gemini", model: "gemini-3-pro" }, scores: { quality: 10, speed: 10, efficiency: 10, reliability: 10 }, capabilities: { readOnly: true, write: true } },
    { id: "pi-compatible", target: "pi", route: { model: "fixture" }, scores: { quality: 1, speed: 1, efficiency: 1, reliability: 1 }, capabilities: { readOnly: true, write: true } },
  ] }), { now: () => 0 });
  assert.equal(slashAliasSelected.explanation.selected, "gemini-slash-alias");
});

test("explicit same-id candidates overlay generated ones", async () => {
  const resolver = createRouteResolver({
    config: {},
    env: {},
    policyFile: "/nonexistent.json",
    userPolicy: {
      harnessOrder: ["cursor", "pi"],
      models: { cursor: "composer-2.5" },
      candidates: [{ id: "auto-cursor", tags: ["fast", "mine"] }],
    },
  });
  const routed = await resolver(request({ metadata: { routing: { mode: "auto" } } }));
  const decision = routed.metadata.harnest.routingDecision;
  assert.ok(decision.matchedRules !== undefined);
  // Overlay kept the generated route but replaced tags.
  const cursorLane = decision.rankedRoutes.find((r) => r.id === "auto-cursor");
  assert.deepEqual(cursorLane.route, { model: "composer-2.5" });
});

test("user file with only harnessOrder selects in that order", async () => {
  const resolver = createRouteResolver({
    config: {},
    env: {},
    policyFile: "/nonexistent.json",
    userPolicy: { harnessOrder: ["pi", "claude", "codex", "cursor"] },
  });
  const routed = await resolver(request({ metadata: { routing: { mode: "auto" } } }));
  assert.equal(routed.target, "pi");
  assert.deepEqual(routed.metadata.harnest.routingDecision.harnessOrder, ["pi", "claude", "codex", "cursor"]);
});

test("malformed models fail closed with a clear error", async () => {
  const resolver = createRouteResolver({
    config: {},
    env: {},
    policyFile: "/nonexistent.json",
    userPolicy: { models: { cursor: "" } },
  });
  await assert.rejects(resolver(request({ metadata: { routing: { mode: "auto" } } })), /models\.cursor must be a non-empty model string/);
});

test("setup wizard writes a valid minimal policy non-interactively", { timeout: 60000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "harnest-setup-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const out = join(dir, "routing.json");
  const { stderr } = await execFileAsync(process.execPath, [
    "scripts/setup-routing.mjs", "--order", "claude,cursor,pi", "--tier", "balanced",
    "--model", "cursor=cursor-grok-4.6-high-fast", "--cheap-lane", "cursor-grok-4.6-high-fast",
    "--flagship-lane", "composer-2.5", "--sub", "cursor=1", "--sub", "pi=0.5", "--yes", "--out", out,
  ], { cwd: join(import.meta.dirname, "..") }).catch((error) => {
    throw new Error(`wizard failed: ${error.stderr || error.message}`);
  });
  void stderr;
  const written = JSON.parse(await readFile(out, "utf8"));
  assert.deepEqual(written.harnessOrder, ["claude", "cursor", "pi", "codex", "opencode", "gemini", "amp"]);
  assert.equal(written.tier, "balanced");
  assert.deepEqual(written.models, { cursor: "cursor-grok-4.6-high-fast" });
  assert.deepEqual(written.subscriptions, {
    cursor: { plan: "sub", subsidy: 1 },
    pi: { plan: "sub", subsidy: 0.5 },
  });
  assert.deepEqual(written.rules.map((r) => r.id), ["starter-urgent-quick", "starter-security-deep", "starter-trivial-cheap", "starter-hard-deep", "starter-review-codex", "starter-ui-claude", "starter-computer-codex"]);
  assert.deepEqual(written.candidates.map((c) => c.id), ["cursor-cheap", "cursor-flagship"]);
  assert.deepEqual(written.candidates[0].model, { intelligence: 8, taste: 6, speed: 5, costEff: 7, decisiveness: 8 });
  // The written file must load through the real resolver.
  const resolver = createRouteResolver({ config: {}, env: {}, policyFile: out });
  const routed = await resolver(request({ metadata: { routing: { mode: "auto" } } }));
  assert.equal(routed.target, "claude");
});

test("tiers cover the documented names", () => {
  assert.deepEqual([...Object.keys(TIERS)].sort(), ["balanced", "deep", "quick", "review"]);
});

test("difficulty gates cheap vs flagship lanes", () => {
  const lanes = [
    { id: "cheap-lane", target: "cursor", route: { provider: "c", model: "grok" }, scores: { quality: 5, speed: 5, efficiency: 5, reliability: 5 }, capabilities: { readOnly: true, write: true }, tags: ["cheap", "fast"] },
    { id: "flagship-lane", target: "claude", route: { provider: "a", model: "opus" }, scores: { quality: 5, speed: 5, efficiency: 5, reliability: 5 }, capabilities: { readOnly: true, write: true }, tags: ["flagship", "deep"] },
  ];
  const policy = {
    candidates: lanes,
    rules: [
      { id: "trivial-cheap", priority: 1, when: { difficulty: "trivial" }, apply: { prefer: { tags: ["cheap"] } } },
      { id: "hard-flagship", priority: 1, when: { difficulty: "hard" }, apply: { prefer: { tags: ["flagship"] } } },
    ],
  };
  const trivial = request({ metadata: { routing: { mode: "auto", difficulty: "trivial" } } });
  assert.equal(resolvePolicyRoute(trivial, scopesFor(trivial, policy), { now: () => 0 }).explanation.selected, "cheap-lane");
  const hard = request({ metadata: { routing: { mode: "auto", difficulty: "hard" } } });
  assert.equal(resolvePolicyRoute(hard, scopesFor(hard, policy), { now: () => 0 }).explanation.selected, "flagship-lane");
  const plain = request({ metadata: { routing: { mode: "auto" } } });
  assert.deepEqual(resolvePolicyRoute(plain, scopesFor(plain, policy), { now: () => 0 }).explanation.matchedRules, []);
});

test("openrouter lanes gate without opt-in, pass with flag, require, or pin", () => {
  const lanes = [
    { id: "or-lane", target: "pi", route: { provider: "openrouter", model: "x/y" }, scores: { quality: 10, speed: 10, efficiency: 10, reliability: 10 }, capabilities: { readOnly: true, write: true } },
    { id: "plain-lane", target: "pi", route: { provider: "p", model: "m" }, scores: { quality: 1, speed: 1, efficiency: 1, reliability: 1 }, capabilities: { readOnly: true, write: true } },
  ];
  const base = { mode: "auto" };
  const gated = request({ metadata: { routing: { ...base } } });
  const gatedDecision = resolvePolicyRoute(gated, scopesFor(gated, { candidates: lanes }), { now: () => 0 });
  assert.equal(gatedDecision.explanation.selected, "plain-lane");
  assert.deepEqual(gatedDecision.explanation.rejected, [{ id: "or-lane", reasons: ["openrouter-gated"] }]);
  const allowed = request({ metadata: { routing: { ...base, allowOpenRouter: true } } });
  assert.equal(resolvePolicyRoute(allowed, scopesFor(allowed, { candidates: lanes }), { now: () => 0 }).explanation.selected, "or-lane");
  const required = request({ metadata: { routing: { ...base, require: { provider: "openrouter" } } } });
  assert.equal(resolvePolicyRoute(required, scopesFor(required, { candidates: lanes }), { now: () => 0 }).explanation.selected, "or-lane");
});

test("allowOpenRouter validates as boolean", () => {
  const bad = request({ metadata: { routing: { mode: "auto", allowOpenRouter: "yes" } } });
  assert.throws(() => resolvePolicyRoute(bad, scopesFor(bad, { candidates: [] }), { now: () => 0 }), /allowOpenRouter must be a boolean/);
});
test("unknown difficulty fails closed", () => {
  const bad = request({ metadata: { routing: { mode: "auto" } } });
  assert.throws(() => resolvePolicyRoute(bad, [
    { name: "global", policy: { candidates: twinCandidates(), rules: [{ id: "x", when: { difficulty: "extreme" }, apply: {} }] } },
  ], { now: () => 0 }), /difficulty must be one of/);
});
