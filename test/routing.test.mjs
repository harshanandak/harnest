import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";
import { createRouteResolver } from "../src/routing.mjs";
import { resolvePolicyRoute } from "../src/routing-policy.mjs";
import { normalizeRequest } from "../src/protocol.mjs";

function request(overrides = {}) {
  return normalizeRequest({
    requestId: "routing-test-request",
    target: "opencode",
    task: "implement the bounded change",
    cwd: process.cwd(),
    route: { provider: "explicit", model: "chosen" },
    ...overrides,
  });
}

test("routing remains pass-through when no local resolver is configured", async () => {
  const original = request();
  assert.deepEqual(await createRouteResolver({ config: {}, env: {}, policyFile: "/nonexistent.json" })(original), original);
});

test("a trusted local resolver can choose any supported harness, provider, and model", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harnest-routing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modulePath = join(root, "resolver.mjs");
  await writeFile(modulePath, `export default ({ request, options }) => ({ target: options.target, route: { provider: options.provider, model: request.task.includes("implement") ? options.model : "other" } });\n`);
  const resolveRoute = createRouteResolver({ config: { routing: { resolverModule: modulePath, options: { target: "pi", provider: "custom-gateway", model: "custom-model" } } }, env: {}, policyFile: "/nonexistent.json" });
  const routed = await resolveRoute(request({ route: {} }));
  assert.equal(routed.target, "pi");
  assert.deepEqual(routed.route, { provider: "custom-gateway", model: "custom-model" });
});

test("resolver diagnostics distinguish not-loaded, current, and stale executable policy", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harnest-routing-diagnostics-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modulePath = join(root, "resolver.mjs");
  await writeFile(modulePath, `export default () => ({ route: { provider: "first", model: "model" } });\n`);
  const resolveRoute = createRouteResolver({ resolverModule: modulePath, config: {}, env: {}, policyFile: "/nonexistent.json" });

  const notLoaded = await resolveRoute.diagnostics();
  assert.match(notLoaded.diskFingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(notLoaded, {
    configured: true,
    loadStatus: "not-loaded",
    sourceStatus: "not-loaded",
    loadedFingerprint: null,
    diskFingerprint: notLoaded.diskFingerprint,
    loadedAt: null,
    hint: "resolver policy has not been loaded by this MCP process yet",
  });

  await resolveRoute(request({ route: {} }));
  const current = await resolveRoute.diagnostics();
  assert.equal(current.loadStatus, "loaded");
  assert.equal(current.sourceStatus, "current");
  assert.equal(current.loadedFingerprint, current.diskFingerprint);
  assert.ok(current.loadedAt);

  await writeFile(modulePath, `export default () => ({ route: { provider: "second", model: "model" } });\n`);
  const stale = await resolveRoute.diagnostics();
  assert.equal(stale.loadStatus, "loaded");
  assert.equal(stale.sourceStatus, "stale");
  assert.notEqual(stale.loadedFingerprint, stale.diskFingerprint);
  assert.match(stale.hint, /restart the MCP process/i);
});

test("a trusted resolver route is a patch and preserves declarative route fields", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harnest-routing-patch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modulePath = join(root, "resolver.mjs");
  await writeFile(modulePath, `export default () => ({ route: { model: "patched-model" } });\n`);
  const routed = await createRouteResolver({ config: { routing: { resolverModule: modulePath } }, env: {}, userPolicy: {} })(request({ metadata: { routing: { mode: "auto" } } }));
  assert.deepEqual(routed.route, { provider: "explicit", model: "patched-model" });
});

test("an operator can point installed caches at a stable resolver with HARNEST_ROUTER", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harnest-routing-env-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modulePath = join(root, "resolver.mjs");
  await writeFile(modulePath, `export const resolveRoute = () => ({ route: { provider: "portable-gateway", model: "portable-model" } });\n`);
  const resolveRoute = createRouteResolver({ config: {}, env: { HARNEST_ROUTER: modulePath }, policyFile: "/nonexistent.json" });
  assert.deepEqual((await resolveRoute(request({ route: {} }))).route, { provider: "portable-gateway", model: "portable-model" });
});

test("a resolver import can recover after the configured module appears", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harnest-routing-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modulePath = join(root, "resolver.mjs");
  const resolveRoute = createRouteResolver({ resolverModule: modulePath, config: {}, policyFile: "/nonexistent.json" });

  await assert.rejects(resolveRoute(request()), /local routing resolver failed/);
  await writeFile(modulePath, `export default () => ({ route: { provider: "recovered-gateway", model: "recovered-model" } });\n`);

  assert.deepEqual((await resolveRoute(request({ route: {} }))).route, {
    provider: "recovered-gateway",
    model: "recovered-model",
  });
});

test("resolver output is validated and request content cannot nominate executable routing code", async (t) => {
  const original = request({ routing: { resolverModule: "attacker.mjs" } });
  assert.deepEqual(await createRouteResolver({ config: {}, env: {}, policyFile: "/nonexistent.json" })(original), original);
  await assert.rejects(
    createRouteResolver({ config: { routing: { global: { candidates: CANDIDATES } } }, env: {}, userPolicy: {} })(
      request({ route: {}, metadata: { routing: { mode: "auto", resolverModule: "attacker.mjs" } } }),
    ),
    /request routing policy contains unsupported fields: resolverModule/,
  );
  const root = await mkdtemp(join(tmpdir(), "harnest-routing-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modulePath = join(root, "invalid-resolver.mjs");
  await writeFile(modulePath, `export default () => ({ route: { model: "" } });\n`);
  const invalid = createRouteResolver({ config: { routing: { resolverModule: modulePath } }, env: {}, policyFile: "/nonexistent.json" });
  await assert.rejects(invalid(request()), /route\.model must be a non-empty string/);
});

const CANDIDATES = [
  {
    id: "fast",
    target: "pi",
    route: { provider: "gateway", model: "fast-model" },
    scores: { quality: 4, speed: 10, efficiency: 9, reliability: 7 },
    capabilities: { readOnly: true, write: true, taskflow: true, liveControl: true, maxContextTokens: 64_000 },
    costUsd: 0.1,
    latencyMs: 500,
  },
  {
    id: "strong",
    target: "opencode",
    route: { provider: "gateway", model: "strong-model" },
    scores: { quality: 10, speed: 4, efficiency: 4, reliability: 9 },
    capabilities: { readOnly: true, write: true, taskflow: true, liveControl: true, maxContextTokens: 256_000 },
    costUsd: 1,
    latencyMs: 2_000,
  },
];

test("declarative routing merges global user project session and request scopes in precedence order", async () => {
  const resolveRoute = createRouteResolver({
    config: {
      routing: {
        global: { candidates: CANDIDATES, defaults: { weights: { speed: 10, quality: 0 }, route: { thinking: "low" } } },
        project: { defaults: { route: { thinking: "high" } } },
        sessions: { sessionA: { defaults: { route: { thinking: "xhigh" } } } },
      },
    },
    env: {},
    userPolicy: { defaults: { route: { thinking: "medium" } } },
  });
  const routed = await resolveRoute(request({
    route: {},
    execution: { sessionId: "sessionA" },
    metadata: { routing: { mode: "auto", weights: { quality: 10, speed: 0 }, route: { thinking: "max" } } },
  }));
  assert.equal(routed.target, "opencode");
  assert.deepEqual(routed.route, { provider: "gateway", model: "strong-model", thinking: "max" });
  assert.deepEqual(routed.metadata.harnest.routingDecision.scopes, ["global", "user", "project", "session", "request"]);
  assert.equal(routed.metadata.harnest.routingDecision.selected, "strong");
});

test("an explicit route pins by default and request mode auto opts into policy selection", async () => {
  const config = { routing: { global: { candidates: CANDIDATES } } };
  const pinned = await createRouteResolver({ config, env: {}, userPolicy: {} })(request());
  assert.deepEqual(pinned.route, { provider: "explicit", model: "chosen" });
  assert.equal(pinned.metadata.harnest.routingDecision.selected, "explicit-route");

  const automatic = await createRouteResolver({ config, env: {}, userPolicy: {} })(request({
    metadata: { routing: { mode: "auto", weights: { quality: 10, speed: 0 } } },
  }));
  assert.equal(automatic.route.model, "strong-model");
});

test("prompt rules, capability filters, budgets, deadlines, and health circuits are explainable", () => {
  const routed = resolvePolicyRoute(request({
    task: "security review with live steering",
    route: {},
    policy: { write: false, maxCostUsd: 0.5 },
    execution: { timeoutMs: 1_000 },
    metadata: { routing: { mode: "auto" } },
  }), [{
    name: "global",
    policy: {
      candidates: [
        ...CANDIDATES,
        { ...CANDIDATES[0], id: "open", health: { status: "open", retryAfter: 2_000 } },
      ],
      rules: [{ id: "security", when: { taskAny: ["security"] }, apply: { require: { liveControl: true }, prefer: { ids: ["strong"] } } }],
    },
  }], { now: 1_000 });
  assert.equal(routed.route.model, "fast-model");
  assert.deepEqual(routed.explanation.matchedRules, ["global:security"]);
  const rejected = Object.fromEntries(routed.explanation.rejected.map((item) => [item.id, item.reasons]));
  assert.ok(rejected.strong.includes("budget"));
  assert.ok(rejected.strong.includes("deadline"));
  assert.ok(rejected.open.includes("circuit-open"));
});

test("operator rules cannot change an explicit provider or endpoint class during latest selection", async () => {
  const routed = await createRouteResolver({
    config: {
      routing: {
        global: {
          rules: [{
            id: "muse-contributor",
            when: { target: "pi", provider: "opencode", model: "muse-spark-1.2" },
            apply: { route: { provider: "opencode-go", model: "muse-spark-1.2-contributor" } },
          }],
        },
      },
    },
    env: {},
    userPolicy: {},
    modelCatalog: async () => ({ models: [{ provider: "opencode", id: "muse-spark-1.3" }, { provider: "opencode-go", id: "muse-spark-1.4-contributor" }] }),
  })(request({ target: "pi", route: { provider: "opencode", model: "muse-spark-1.2" } }));
  assert.deepEqual(routed.route, { provider: "opencode", model: "muse-spark-1.3" });
  assert.deepEqual(routed.metadata.harnest.routingDecision.matchedRules, ["global:muse-contributor"]);
});

test("engine freshness uses discovered releases and leaves pinned or untracked models alone", async () => {
  let probes = 0;
  const resolve = createRouteResolver({ config: { routing: {} }, env: {}, userPolicy: {}, modelCatalog: async () => {
    probes++;
    return { models: [{ provider: "opencode", id: "deepseek-v4.1-flash" }, { provider: "opencode-go", id: "deepseek-v4.1-flash" }] };
  } });
  const upgraded = await resolve(request({ route: { provider: "opencode", model: "deepseek-v4-flash" } }));
  assert.equal(upgraded.route.model, "deepseek-v4.1-flash");
  assert.equal(upgraded.route.provider, "opencode", "freshness touches only the model name");
  const prefixed = await resolve(request({ route: { model: "opencode-go/deepseek-v4-flash" } }));
  assert.deepEqual(prefixed.route, { model: "opencode-go/deepseek-v4.1-flash" }, "an embedded provider prefix survives the upgrade");
  const untouched = await resolve(request({ route: { provider: "custom", model: "my-private-model" } }));
  assert.deepEqual(untouched.route, { provider: "custom", model: "my-private-model" });
  const before = probes;
  const pinned = await resolve(request({ route: { provider: "opencode", model: "deepseek-v4-flash" }, metadata: { routing: { modelVersion: "pin" } } }));
  assert.equal(pinned.route.model, "deepseek-v4-flash");
  assert.equal(pinned.metadata.harnest.routingDecision.modelFreshness.status, "pinned");
  assert.equal(probes, before, "pin must not query a catalog or auto-upgrade");
  await assert.rejects(resolve(request({ target: "claude", route: { model: "sonnet" }, metadata: { routing: { modelVersion: "pin" } } })), /exact model ID/);
  await assert.rejects(resolve(request({ route: {}, metadata: { routing: { modelVersion: "pin" } } })), /exact model ID/);
});

test("a configured route works without requiring a candidate catalog", () => {
  const routed = resolvePolicyRoute(request({ route: {}, metadata: { routing: { mode: "auto" } } }), [{
    name: "global",
    policy: {
      route: { provider: "configured-provider" },
      defaults: { route: { model: "configured-model" } },
    },
  }]);
  assert.equal(routed.target, "opencode");
  assert.deepEqual(routed.route, { provider: "configured-provider", model: "configured-model" });
  assert.equal(routed.explanation.selected, "configured-route");
});

test("latest selection retains version avoid-lists and cannot bypass a bounded budget", async () => {
  const catalog = async () => ({ models: [{ provider: "openai", id: "gpt-5.6-sol" }, { provider: "openai", id: "gpt-6-sol" }] });
  const resolve = createRouteResolver({ config: {}, env: {}, userPolicy: {}, modelCatalog: catalog });
  const input = request({ route: { provider: "openai", model: "gpt-5.6-sol" }, metadata: { routing: { avoid: { models: ["gpt-6-sol"] } } } });
  assert.equal((await resolve(input)).route.model, "gpt-5.6-sol");
  const bounded = await resolve(request({ route: input.route, metadata: { routing: { maxCostUsd: 1 } } }));
  assert.equal(bounded.route.model, "gpt-5.6-sol");
  assert.match(bounded.metadata.harnest.routingDecision.modelFreshness.warning, /budget/);
});

test("candidate overlays preserve omitted availability cost latency and priority", () => {
  const routed = resolvePolicyRoute(request({
    route: {},
    policy: { write: false, maxCostUsd: 1 },
    execution: { timeoutMs: 1_000 },
    metadata: { routing: { mode: "auto" } },
  }), [
    { name: "global", policy: { candidates: [{
      ...CANDIDATES[0],
      id: "overlay",
      available: false,
      costUsd: 2,
      latencyMs: 2_000,
      priority: 9,
    }] } },
    { name: "project", policy: { candidates: [{ id: "overlay", scores: { quality: 10 } }] } },
  ]);
  assert.equal(routed.explanation.selected, null);
  assert.deepEqual(routed.explanation.rejected, [{ id: "overlay", reasons: ["unavailable", "budget", "deadline"] }]);
});

test("declarative policies reject malformed directives rules and candidates", () => {
  const invalid = [
    { defaults: { mode: "roulette" } },
    { defaults: { weights: { quality: -1 } } },
    { candidates: [{ ...CANDIDATES[0], available: "yes" }] },
    { candidates: [{ ...CANDIDATES[0], scores: { quality: "10" } }] },
    { candidates: [{ ...CANDIDATES[0], route: { model: "x", apiKey: "forbidden" } }] },
    { rules: [{ when: { write: "yes" }, apply: {} }] },
    { rules: [{ when: { metadata: { risk: { nested: true } } }, apply: {} }] },
  ];
  for (const policy of invalid) {
    assert.throws(
      () => resolvePolicyRoute(request({ route: {}, metadata: { routing: { mode: "auto" } } }), [{ name: "global", policy }]),
      TypeError,
    );
  }
});

test("declarative ties use candidate priority then lexical id deterministically", () => {
  const candidates = [
    { ...CANDIDATES[0], id: "beta", priority: 0 },
    { ...CANDIDATES[0], id: "alpha", priority: 0 },
  ];
  const routed = resolvePolicyRoute(request({ route: {}, metadata: { routing: { mode: "auto" } } }), [
    { name: "global", policy: { candidates } },
  ]);
  assert.equal(routed.explanation.selected, "alpha");
});

test("resolver timeouts fail closed by default and can degrade to declarative passthrough", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harnest-routing-timeout-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modulePath = join(root, "slow.mjs");
  await writeFile(modulePath, `export default () => new Promise(() => {});\n`);
  const config = { routing: { resolverModule: modulePath, global: { candidates: CANDIDATES }, resolverTimeoutMs: 20 } };
  await assert.rejects(
    createRouteResolver({ config, env: {}, userPolicy: {} })(request({ route: {}, metadata: { routing: { mode: "auto", weights: { quality: 10, speed: 0, efficiency: 0, reliability: 0 } } } })),
    /timed out after 20ms/,
  );
  const degraded = await createRouteResolver({ config: { routing: { ...config.routing, resolverFailureMode: "passthrough" } }, env: {}, userPolicy: {} })(
    request({ route: {}, metadata: { routing: { mode: "auto", weights: { quality: 10, speed: 0, efficiency: 0, reliability: 0 } } } }),
  );
  assert.equal(degraded.route.model, "strong-model");
  assert.equal(degraded.metadata.harnest.routingDecision.resolver.status, "failed");
});

test("resolver circuit breaker opens deterministically after the configured failure budget", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harnest-routing-breaker-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modulePath = join(root, "broken.mjs");
  await writeFile(modulePath, `export default () => { throw new Error("boom"); };\n`);
  let now = 1_000;
  const resolveRoute = createRouteResolver({
    config: { routing: { resolverModule: modulePath, circuitBreaker: { failureThreshold: 2, cooldownMs: 30_000 } } },
    env: {},
    userPolicy: {},
    now: () => now,
  });
  await assert.rejects(resolveRoute(request()), /boom/);
  await assert.rejects(resolveRoute(request()), /boom/);
  await assert.rejects(resolveRoute(request()), /circuit is open/);
  now += 31_000;
  await assert.rejects(resolveRoute(request()), /boom/);
});
