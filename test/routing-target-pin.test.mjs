// Target-pin semantics: naming a target without naming a model is a harness
// pin. Policy selects the best qualified model WITHIN that target and never
// changes it; target "auto" (or request metadata.routing.mode auto) keeps
// full cross-target selection; an explicit route model/provider stays a pin.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Companion } from "../src/companion.mjs";
import { GraphRunner } from "../src/graph.mjs";
import { JobStore } from "../src/job-store.mjs";
import { normalizeRequest } from "../src/protocol.mjs";
import { createRouteResolver } from "../src/routing.mjs";
import { resolvePolicyRoute } from "../src/routing-policy.mjs";

// claude-lane out-scores every other lane on purpose: a target pin must still
// refuse it when the caller named a different harness. Quality weight 10
// isolates the comparison.
const WEIGHTS = { quality: 10, speed: 0, efficiency: 0, reliability: 0 };
const CANDIDATES = [
  { id: "pi-lane", target: "pi", route: { model: "pi-model" }, scores: { quality: 1, speed: 1, efficiency: 1, reliability: 1 }, capabilities: { readOnly: true, write: true } },
  { id: "cursor-lane", target: "cursor", route: { model: "cursor-model" }, scores: { quality: 1, speed: 1, efficiency: 1, reliability: 1 }, capabilities: { readOnly: true, write: true } },
  { id: "opencode-lane", target: "opencode", route: { model: "opencode-model" }, scores: { quality: 1, speed: 1, efficiency: 1, reliability: 1 }, capabilities: { readOnly: true, write: true } },
  { id: "claude-lane", target: "claude", route: { model: "claude-model" }, scores: { quality: 10, speed: 10, efficiency: 10, reliability: 10 }, capabilities: { readOnly: true, write: true } },
];

function request(overrides = {}) {
  return normalizeRequest({
    requestId: "target-pin-test",
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

function decide(req, policy = {}) {
  return resolvePolicyRoute(req, scopesFor(req, { candidates: CANDIDATES, weights: WEIGHTS, ...policy }), { now: () => 0 });
}

test("a bare target is a harness pin: policy picks a model within it and never changes it", () => {
  for (const target of ["pi", "cursor", "opencode", "claude"]) {
    const decision = decide(request({ target }));
    assert.equal(decision.target, target, target);
    assert.equal(decision.route.model, `${target}-model`, target);
    assert.equal(decision.explanation.selected, `${target}-lane`, target);
    for (const item of decision.explanation.rejected) {
      assert.ok(item.reasons.includes("target"), `${item.id} must be rejected for target`);
    }
    assert.deepEqual(decision.explanation.rankedRoutes.map((entry) => entry.id), [`${target}-lane`], `${target} failover stays in target`);
  }
});

test("auto still selects across targets", () => {
  const automatic = request({ target: "pi", metadata: { routing: { mode: "auto" } } });
  const decision = decide(automatic);
  assert.equal(decision.target, "claude");
  assert.equal(decision.explanation.selected, "claude-lane");
});

test("a matching rule that names another target cannot move a pinned target", () => {
  const req = request({ target: "pi", task: "review the change" });
  const decision = decide(req, {
    rules: [{ id: "review-claude", when: { taskAny: ["review"] }, apply: { target: "claude" } }],
  });
  assert.equal(decision.target, "pi");
  assert.equal(decision.route.model, "pi-model");
  assert.deepEqual(decision.explanation.matchedRules, ["global:review-claude"]);
  assert.deepEqual(decision.explanation.rejected.find((item) => item.id === "claude-lane"), { id: "claude-lane", reasons: ["target"] });
});

test("an explicit route model/provider remains a full pin", () => {
  const decision = decide(request({ target: "pi", route: { provider: "hand-picked", model: "explicit" } }));
  assert.equal(decision.target, "pi");
  assert.deepEqual(decision.route, { provider: "hand-picked", model: "explicit" });
  assert.equal(decision.explanation.selected, "explicit-route");
});

test("explicit thinking survives the target pin", () => {
  const decision = decide(request({ target: "pi", route: { thinking: "high" } }));
  assert.equal(decision.target, "pi");
  assert.equal(decision.route.thinking, "high");
  assert.equal(decision.explanation.thinkingSource, "explicit");
  assert.equal(decision.route.model, "pi-model");
});

test("graph nodes: target-only resolves within target, auto resolves across, pins survive", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harnest-target-pin-"));
  const seen = [];
  const routeResolver = createRouteResolver({
    config: {
      routing: {
        global: {
          candidates: CANDIDATES,
          weights: WEIGHTS,
          rules: [{ id: "review-claude", when: { taskAny: ["review"] }, apply: { target: "claude" } }],
        },
      },
    },
    env: {},
    userPolicy: {},
    policyFile: join(root, "routing.json"),
  });
  const companion = new Companion({
    store: new JobStore(join(root, "jobs")),
    routeResolver,
    adapterFactory: () => ({
      run: async (r) => {
        seen.push(r);
        return { result: { finalText: `${r.target}:${r.route.model}` } };
      },
    }),
    heartbeatIntervalMs: 10,
    cancelAckTimeoutMs: 30,
  });
  const runner = new GraphRunner({ companion, pollIntervalMs: 10, heartbeatIntervalMs: 20, leaseTimeoutMs: 2000 });
  t.after(async () => {
    await Promise.all([...runner.running.values()]);
    await Promise.all([...companion.running.values()].map((v) => v.promise));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const spec = {
    requestId: "target-pin-graph",
    cwd: root,
    nodes: [
      // Before the fix, validate() rejected this node at graph.mjs with
      // "resolved node cursor-only changed an explicit target".
      { id: "cursor-only", target: "cursor", task: "implement the change" },
      { id: "opencode-only", target: "opencode", task: "implement the change" },
      { id: "auto-pick", target: "auto", task: "implement the change" },
      { id: "explicit", target: "pi", task: "implement the change", route: { model: "explicit", thinking: "high" } },
      { id: "pinned-rule", target: "pi", task: "review the change" },
    ],
    execution: { background: false },
  };
  const validation = await runner.validate(spec);
  const routes = Object.fromEntries(validation.nodes.map((node) => [node.id, node]));
  assert.equal(routes["cursor-only"].target, "cursor");
  assert.equal(routes["cursor-only"].route.model, "cursor-model");
  assert.equal(routes["opencode-only"].target, "opencode");
  assert.equal(routes["opencode-only"].route.model, "opencode-model");
  assert.equal(routes["auto-pick"].target, "claude");
  assert.equal(routes["auto-pick"].route.model, "claude-model");
  assert.equal(routes.explicit.target, "pi");
  assert.deepEqual(routes.explicit.route, { model: "explicit", thinking: "high" });
  assert.equal(routes["pinned-rule"].target, "pi");
  assert.equal(routes["pinned-rule"].route.model, "pi-model");

  const result = await runner.start(spec);
  assert.equal(result.state, "completed");
  assert.equal(seen.length, 5);
  const dispatched = Object.fromEntries(seen.map((r) => [r.context.graph.nodeId, r]));
  assert.deepEqual(
    { target: dispatched["cursor-only"].target, model: dispatched["cursor-only"].route.model },
    { target: "cursor", model: "cursor-model" },
  );
  assert.deepEqual(
    { target: dispatched["opencode-only"].target, model: dispatched["opencode-only"].route.model },
    { target: "opencode", model: "opencode-model" },
  );
  assert.deepEqual(
    { target: dispatched["auto-pick"].target, model: dispatched["auto-pick"].route.model },
    { target: "claude", model: "claude-model" },
  );
  assert.equal(dispatched.explicit.target, "pi");
  assert.equal(dispatched.explicit.route.model, "explicit");
  assert.equal(dispatched.explicit.route.thinking, "high");
  assert.deepEqual(
    { target: dispatched["pinned-rule"].target, model: dispatched["pinned-rule"].route.model },
    { target: "pi", model: "pi-model" },
  );
});
