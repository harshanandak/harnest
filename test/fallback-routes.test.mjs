
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Companion } from "../src/companion.mjs";
import { JobStore } from "../src/job-store.mjs";
import { normalizeRequest } from "../src/protocol.mjs";
import { resolvePolicyRoute } from "../src/routing-policy.mjs";

test("rankedRoutes carry directive-merged routes for faithful failover", () => {
  // Cross-target ranked routes are an automatic-selection input now: a bare
  // target is a harness pin, so opt in explicitly to keep both lanes ranked.
  const request = normalizeRequest({
    requestId: "ranked-merged", target: "pi", task: "t", cwd: process.cwd(),
    metadata: { routing: { mode: "auto" } },
  });
  const decision = resolvePolicyRoute(request, [{
    name: "global",
    policy: {
      candidates: [
        { id: "a", target: "pi", route: { provider: "p", model: "m" } },
        { id: "b", target: "cursor", route: { provider: "c", model: "n" } },
      ],
      defaults: { route: { harnessVersion: "v2" } },
    },
  }], { now: () => 0 });
  assert.equal(decision.route.harnessVersion, "v2");
  for (const entry of decision.explanation.rankedRoutes) {
    assert.equal(entry.route.harnessVersion, "v2", `${entry.id} must carry the merged route`);
  }
  assert.equal(decision.explanation.rankedRoutes[0].id, decision.explanation.selected);
});

test("resolver-overridden routes fall back by candidate id, not route JSON", async (t) => {
  // The resolver adds variant:"z" after the policy decision, so route-JSON
  // equality alone would misidentify the current lane as "different" and
  // retry it. Id position must win.
  const seen = [];
  const root = await mkdtemp(join(tmpdir(), "harnest-fallback-id-"));
  const companion = new Companion({
    store: new JobStore(root),
    routeResolver: async (request) => ({
      ...request,
      route: { ...request.route, variant: "z" },
      metadata: {
        ...request.metadata,
        harnest: {
          routingDecision: {
            version: 2,
            mode: "auto",
            selected: "first",
            rankedRoutes: [
              { id: "first", target: "pi", score: 100, route: { provider: "one", model: "works" } },
              { id: "second", target: "cursor", score: 50, route: { provider: "cursor", model: "backup" } },
            ],
          },
        },
      },
    }),
    adapterFactory: (target) => ({
      async run(request) {
        seen.push(target);
        if (target === "pi") throw Object.assign(new Error("spawn pi ENOENT"), { details: { kind: "transport" } });
        return { result: { finalText: "id-position fallback" }, route: request.route };
      },
    }),
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  const receipt = await companion.start({
    requestId: "fallback-id",
    target: "pi",
    task: "research quietly",
    cwd: process.cwd(),
    policy: { write: false },
  });
  assert.deepEqual(seen, ["pi", "cursor"]);
  assert.equal(receipt.state, "completed");
  assert.equal(receipt.target, "cursor");
});

test("same-target fallback keeps the session; cross-target clears it", async (t) => {
  const seenRequests = [];
  const root = await mkdtemp(join(tmpdir(), "harnest-fallback-session-"));
  const companion = new Companion({
    store: new JobStore(root),
    routeResolver: async (request) => ({
      ...request,
      route: { provider: "one", model: "a" },
      metadata: {
        ...request.metadata,
        harnest: {
          routingDecision: {
            version: 2,
            mode: "auto",
            selected: "first",
            rankedRoutes: [
              { id: "first", target: "pi", score: 100, route: { provider: "one", model: "a" } },
              { id: "second", target: "pi", score: 90, route: { provider: "one", model: "b" } },
            ],
          },
        },
      },
    }),
    adapterFactory: () => ({
      async run(request) {
        seenRequests.push(request);
        if (request.route.model === "a") {
          throw Object.assign(new Error("pi transport down"), { details: { kind: "transport" } });
        }
        return { result: { finalText: "same-target retry" }, route: request.route };
      },
    }),
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  const receipt = await companion.start({
    requestId: "fallback-session",
    target: "pi",
    task: "research quietly",
    cwd: process.cwd(),
    policy: { write: false },
    execution: { sessionId: "sess-1" },
  });
  assert.equal(receipt.state, "completed");
  assert.equal(seenRequests.length, 2);
  assert.equal(seenRequests[1].execution.sessionId, "sess-1");
  assert.equal(receipt.routingFallbacks.length, 1);
  assert.equal(receipt.routingFallbacks[0].keptSession, true);
  assert.equal(receipt.routingFallbacks[0].from.target, "pi");
  assert.equal(receipt.routingFallbacks[0].to.target, "pi");
});

// Adapter-classified provider failures join the eligible failover kinds: a
// read-only auto run retries once on the next ranked route exactly like a
// transport failure. Write-capable runs, cancellations, policy/validation
// rejections, and runs without a ranked alternative keep today's behavior.
async function providerFailureFixture(t, kind, { rankedRoutes } = {}) {
  const root = await mkdtemp(join(tmpdir(), `harnest-fallback-${kind}-`));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const seen = [];
  const companion = new Companion({
    store: new JobStore(root),
    routeResolver: async (request) => ({
      ...request,
      route: { provider: "one", model: "primary" },
      metadata: {
        ...request.metadata,
        harnest: {
          routingDecision: {
            version: 2,
            mode: "auto",
            selected: "primary",
            rankedRoutes: rankedRoutes ?? [
              { id: "primary", target: "pi", score: 100, route: { provider: "one", model: "primary" } },
              { id: "backup", target: "cursor", score: 50, route: { provider: "two", model: "backup" } },
            ],
          },
        },
      },
    }),
    adapterFactory: (target) => ({
      async run(request) {
        seen.push(target);
        if (target === "pi") {
          throw Object.assign(new Error(`provider ${kind} rejection from the first lane`), {
            name: "ProviderFailure",
            details: { kind, category: kind === "provider-auth" ? "billing" : "not-found" },
          });
        }
        return { result: { finalText: `recovered via ${kind}` }, route: request.route };
      },
    }),
  });
  return { companion, seen };
}

for (const kind of ["provider-auth", "unavailable"]) {
  test(`a read-only auto run fails over to the next ranked route on ${kind}`, async (t) => {
    const { companion, seen } = await providerFailureFixture(t, kind);
    const receipt = await companion.start({
      requestId: `fallback-${kind}`,
      target: "pi",
      task: "research quietly",
      cwd: process.cwd(),
      policy: { write: false },
      metadata: { routing: { mode: "auto" } },
    });
    assert.deepEqual(seen, ["pi", "cursor"], "the second ranked lane must run once");
    assert.equal(receipt.state, "completed");
    assert.equal(receipt.target, "cursor");
    assert.equal(receipt.result.finalText, `recovered via ${kind}`);
    assert.equal(receipt.routingFallbacks.length, 1);
    const fallback = receipt.routingFallbacks[0];
    assert.equal(fallback.errorKind, kind);
    assert.equal(fallback.from.target, "pi");
    assert.deepEqual(fallback.from.route, { provider: "one", model: "primary" });
    assert.equal(fallback.to.target, "cursor");
    assert.deepEqual(fallback.to.route, { provider: "two", model: "backup" });
  });
}

test("a write-capable run with provider-auth does not fall back", async (t) => {
  const { companion, seen } = await providerFailureFixture(t, "provider-auth", { write: true });
  const receipt = await companion.start({
    requestId: "no-fallback-write-provider-auth",
    target: "pi",
    task: "edit the repository",
    cwd: process.cwd(),
    policy: { write: true },
    metadata: { routing: { mode: "auto" } },
  });
  assert.deepEqual(seen, ["pi"], "a write-capable retry could duplicate side effects");
  assert.equal(receipt.state, "failed");
  assert.equal(receipt.error.details.kind, "provider-auth");
  assert.equal(receipt.routingFallbacks, undefined);
});

test("a read-only run with no ranked alternative fails with the provider class intact", async (t) => {
  const { companion, seen } = await providerFailureFixture(t, "provider-auth", {
    rankedRoutes: [{ id: "primary", target: "pi", score: 100, route: { provider: "one", model: "primary" } }],
  });
  const receipt = await companion.start({
    requestId: "no-alternative-provider-auth",
    target: "pi",
    task: "research quietly",
    cwd: process.cwd(),
    policy: { write: false },
    metadata: { routing: { mode: "auto" } },
  });
  assert.deepEqual(seen, ["pi"]);
  assert.equal(receipt.state, "failed");
  assert.equal(receipt.error.details.kind, "provider-auth");
  assert.equal(receipt.routingFallbacks, undefined);
});
