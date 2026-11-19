import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Companion } from "../src/companion.mjs";
import { JobStore } from "../src/job-store.mjs";
import { createRouteResolver } from "../src/routing.mjs";
import { preflight } from "../src/preflight.mjs";

const request = (target, extra = {}) => ({ requestId: "compatibility", target, task: "review", cwd: process.cwd(), ...extra });
const lane = (id, target, route, quality) => ({ id, target, route, scores: { quality }, capabilities: { write: true } });
const options = (candidates = [], extra = {}) => ({
  config: { routing: { global: { candidates }, ...extra } }, env: {}, userPolicy: {},
});

test("auto selection rejects highest-score Claude routes for every non-Claude target", async () => {
  for (const target of ["pi", "opencode", "codex", "cursor"]) {
    for (const route of [{ model: "claude-opus-5-thinking-high" }, { model: "gateway/sonnet" }, { provider: "anthropic", model: "private" }]) {
      const resolved = await createRouteResolver(options([
        lane("incompatible", target, route, 10), lane("compatible", target, { model: "works" }, 1),
      ]))(request(target, { policy: { write: target === "opencode" } }));
      assert.equal(resolved.route.model, "works");
      const decision = resolved.metadata.harnest.routingDecision;
      assert.deepEqual(decision.rankedRoutes.map((entry) => entry.id), ["compatible"]);
      assert.deepEqual(decision.rejected, [{ id: "incompatible", reasons: ["claude-model"] }]);
    }
  }
});

test("Cursor explicit thinking is ineligible even with declared support", async () => {
  const routing = options([
    { ...lane("incompatible", "cursor", { model: "grok", thinking: "xhigh" }, 10), capabilities: { thinking: ["xhigh"] } },
    lane("compatible", "cursor", { model: "composer-2.5" }, 1),
  ]);
  const result = await preflight(request("cursor"), { routing });
  assert.equal(result.route.model, "composer-2.5");
  assert.deepEqual(result.routingDecision.rejected, [{ id: "incompatible", reasons: ["thinking-control"] }]);
  assert.deepEqual(result.routingDecision.rankedRoutes.map((entry) => entry.id), ["compatible"]);
  for (const thinking of ["off", "minimal", "low", "medium", "high", "xhigh", "max", true, false]) {
    await assert.rejects(preflight(request("cursor", { route: { thinking } }), { routing }), /thinking.*not supported/);
  }
});

test("incompatible pins and exhausted catalogs fail before job allocation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harnest-routing-policy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new JobStore(root);
  const companion = new Companion({ store, routing: options([
    lane("bad", "cursor", { model: "opus" }, 10),
    lane("other-target", "claude", { model: "opus" }, 1),
  ]), adapterFactory: () => assert.fail("policy rejection must precede dispatch") });
  for (const input of [
    request("cursor"),
    request("cursor", { route: { model: "opus" } }),
    request("pi", { route: { model: "sonnet" } }),
    request("cursor", { route: { model: "composer", thinking: "high" } }),
  ]) {
    await assert.rejects(companion.start(input), (error) => error.details?.kind === "policy");
  }
  assert.deepEqual(await store.listAllReceipts(), []);
});

test("an exhausted incompatible catalog cannot silently use a harness default", async () => {
  const resolve = createRouteResolver(options([lane("bad", "cursor", { model: "opus" }, 10)], {
    project: { route: { provider: "cursor" } },
  }));
  await assert.rejects(resolve(request("cursor")), /no adapter-compatible routing candidate: claude-model/);
});

test("effective routes include rule and scope overlays before compatibility filtering", async () => {
  for (const patch of [{ model: "opus" }, { provider: "anthropic" }, { thinking: "high" }]) {
    const resolved = await createRouteResolver(options([
      lane("cursor", "cursor", { model: "composer" }, 10),
      lane("claude", "claude", { model: "opus" }, 1),
    ], { project: { rules: [{ when: { taskAny: ["review"] }, apply: { route: patch } }] } }))(
      request("cursor", { metadata: { routing: { mode: "auto" } } }),
    );
    assert.equal(resolved.target, "claude");
    assert.deepEqual(resolved.metadata.harnest.routingDecision.rankedRoutes.map((entry) => entry.id), ["claude"]);
  }
  const resolved = await createRouteResolver(options([lane("cursor", "cursor", { model: "opus" }, 10)], {
    project: { route: { model: "composer" } },
  }))(request("cursor"));
  assert.equal(resolved.route.model, "composer", "a compatible effective overlay repairs a stale candidate");
});

test("session and request route overrides cannot reintroduce incompatible alternatives", async () => {
  const routing = options([
    lane("cursor", "cursor", { model: "composer" }, 10),
    lane("claude", "claude", { model: "opus" }, 1),
  ], { sessions: { review: { route: { model: "opus" } } } });
  for (const extra of [
    { execution: { sessionId: "review" }, metadata: { routing: { mode: "auto" } } },
    { metadata: { routing: { mode: "auto", route: { thinking: "high" } } } },
  ]) {
    const resolved = await createRouteResolver(routing)(request("cursor", extra));
    assert.equal(resolved.target, "claude");
    assert.deepEqual(resolved.metadata.harnest.routingDecision.rankedRoutes.map((entry) => entry.id), ["claude"]);
  }
});

test("fallback directives preserve scope precedence in the resolved request", async () => {
  const resolve = createRouteResolver(options([], { project: { defaults: { fallbacks: false } } }));
  assert.equal((await resolve(request("pi"))).metadata.routing.fallbacks, false);
  assert.equal((await resolve(request("pi", { metadata: { routing: { fallbacks: true } } }))).metadata.routing.fallbacks, true);
});

test("preflight validates pins and configured routes even without candidates", async () => {
  for (const target of ["pi", "opencode", "codex", "cursor"]) {
    await assert.rejects(preflight(request(target, { route: { model: "opus" } }), { routing: options() }), /cannot run Claude/);
    await assert.rejects(preflight(request(target), { routing: options([], { project: { route: { model: "opus" } } }) }), /cannot run Claude/);
  }
  assert.equal((await preflight(request("claude", { route: { model: "opus" } }), { routing: options() })).route.model, "opus");
  await assert.rejects(preflight(request("cursor", { route: { model: "composer", thinking: "high" } }), {
    routing: { config: {}, env: {}, loadUserPolicy: async () => ({ policy: null }) },
  }), /thinking.*not supported/);
});

test("trusted resolver overrides cannot return an adapter-incompatible route", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harnest-routing-override-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [index, decision] of [
    { target: "cursor", route: { model: "opus" } },
    { target: "cursor", route: { model: "composer", thinking: "high" } },
    { target: "pi", route: { provider: "anthropic", model: "private" } },
  ].entries()) {
    const resolverModule = join(root, `resolver-${index}.mjs`);
    await writeFile(resolverModule, `export default () => (${JSON.stringify(decision)});`);
    for (const resolverFailureMode of ["closed", "passthrough"]) {
      await assert.rejects(createRouteResolver(options([], { resolverModule, resolverFailureMode }))(
        request("pi", { metadata: { routing: { mode: "auto" } } }),
      ), (error) => error.details?.kind === "policy");
    }
  }
});
