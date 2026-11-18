// RoutingSettings: file-backed get/configure/preview against temp files only.
// Never touches the live personal policy; no harness or model calls.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RoutingSettings } from "../src/routing-settings.mjs";
import { createRouteResolver } from "../src/routing.mjs";

async function tempSettings(extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), "routing-settings-"));
  const policyPath = join(dir, "routing.json");
  const settings = new RoutingSettings({ policyPath, config: {}, env: {}, ...extra });
  return { dir, policyPath, settings };
}

async function rawBytes(path) {
  return readFile(path, "utf8").catch((error) => (error?.code === "ENOENT" ? null : Promise.reject(error)));
}

test("get on a missing file reports the missing revision and defaults", async (t) => {
  const { dir, policyPath, settings } = await tempSettings();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const snapshot = await settings.get();
  assert.equal(snapshot.path, policyPath);
  assert.equal(snapshot.revision, "missing");
  assert.equal(snapshot.activePreset, null);
  assert.deepEqual(snapshot.presets, {});
  assert.deepEqual(snapshot.settings, { modelVersion: "latest" });
  assert.ok(snapshot.warnings.some((warning) => /no routing file/.test(warning)));
});

test("set merges base settings; null clears; models merge per harness", async (t) => {
  const { dir, settings } = await tempSettings();
  t.after(() => rm(dir, { recursive: true, force: true }));
  let snapshot = await settings.get();
  snapshot = await settings.configure({
    action: "set",
    settings: { tier: "quick", models: { pi: "test-model-a", claude: "test-claude" } },
    expectedRevision: snapshot.revision,
  });
  assert.equal(snapshot.settings.tier, "quick");
  assert.equal(snapshot.baseSettings.tier, "quick");

  snapshot = await settings.configure({
    action: "set",
    settings: { models: { pi: "test-model-b", claude: null } },
    expectedRevision: snapshot.revision,
  });
  assert.deepEqual(snapshot.settings.models, { pi: "test-model-b" });

  snapshot = await settings.configure({
    action: "set",
    settings: { tier: null },
    expectedRevision: snapshot.revision,
  });
  assert.ok(!("tier" in snapshot.settings));
});

test("presets save, activate, clear to base, and refuse to delete while active", async (t) => {
  const { dir, settings } = await tempSettings();
  t.after(() => rm(dir, { recursive: true, force: true }));
  let snapshot = await settings.get();
  snapshot = await settings.configure({
    action: "save-preset", preset: "deep-work", settings: { tier: "deep" }, expectedRevision: snapshot.revision,
  });
  assert.deepEqual(snapshot.presets["deep-work"], { tier: "deep" });
  assert.equal(snapshot.activePreset, null);

  snapshot = await settings.configure({ action: "use-preset", preset: "deep-work", expectedRevision: snapshot.revision });
  assert.equal(snapshot.activePreset, "deep-work");
  assert.equal(snapshot.settings.tier, "deep");

  await assert.rejects(
    settings.configure({ action: "delete-preset", preset: "deep-work", expectedRevision: snapshot.revision }),
    /active preset/,
  );
  snapshot = await settings.configure({ action: "use-preset", preset: null, expectedRevision: snapshot.revision });
  assert.equal(snapshot.activePreset, null);
  assert.ok(!("tier" in snapshot.settings));
  snapshot = await settings.configure({ action: "delete-preset", preset: "deep-work", expectedRevision: snapshot.revision });
  assert.deepEqual(snapshot.presets, {});
});

test("stale revisions and invalid edits are rejected with bytes unchanged", async (t) => {
  const { dir, policyPath, settings } = await tempSettings();
  t.after(() => rm(dir, { recursive: true, force: true }));
  let snapshot = await settings.get();
  snapshot = await settings.configure({
    action: "set", settings: { tier: "balanced" }, expectedRevision: snapshot.revision,
  });
  const goodBytes = await rawBytes(policyPath);

  await assert.rejects(
    settings.configure({ action: "set", settings: { tier: "quick" }, expectedRevision: "missing" }),
    /changed since revision/,
  );
  await assert.rejects(
    settings.configure({ action: "set", settings: { tier: "warp" }, expectedRevision: snapshot.revision }),
    /tier must be one of/,
  );
  await assert.rejects(
    settings.configure({ action: "set", settings: { quota: 1 }, expectedRevision: snapshot.revision }),
    /unsupported routing settings/,
  );
  assert.equal(await rawBytes(policyPath), goodBytes);
});

test("malformed files fail before any write", async (t) => {
  const { dir, policyPath, settings } = await tempSettings();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(policyPath, "{ not json");
  await assert.rejects(settings.get(), /malformed/);
  await assert.rejects(
    settings.configure({ action: "set", settings: { tier: "quick" }, expectedRevision: "anything" }),
    /malformed|Expected|Unexpected|JSON/,
  );
  assert.equal(await rawBytes(policyPath), "{ not json");
});

test("concurrent edits on one revision: one wins, the other is rejected", async (t) => {
  const { dir, policyPath, settings } = await tempSettings();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const snapshot = await settings.get();
  const attempts = await Promise.allSettled([
    settings.configure({ action: "set", settings: { tier: "quick" }, expectedRevision: snapshot.revision }),
    settings.configure({ action: "set", settings: { tier: "deep" }, expectedRevision: snapshot.revision }),
  ]);
  assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(attempts.filter((result) => result.status === "rejected").length, 1);
  assert.match(String(attempts.find((result) => result.status === "rejected").reason?.message), /changed since revision/);
  const final = await settings.get();
  assert.ok(["quick", "deep"].includes(final.settings.tier));
  assert.ok((await rawBytes(policyPath)).includes(final.settings.tier));
});

test("preview runs the real resolver without execution and honors presets", async (t) => {
  const { dir, settings } = await tempSettings();
  t.after(() => rm(dir, { recursive: true, force: true }));
  let snapshot = await settings.get();
  snapshot = await settings.configure({
    action: "set",
    settings: { harnessOrder: ["pi"], models: { pi: "preview-basic" } },
    expectedRevision: snapshot.revision,
  });
  snapshot = await settings.configure({
    action: "save-preset", preset: "deepdive", settings: { tier: "deep" }, expectedRevision: snapshot.revision,
  });

  const request = { target: "pi", task: "summarize this file", cwd: dir };
  const base = await settings.preview({ request });
  assert.equal(base.target, "pi");
  assert.equal(base.route.model, "preview-basic");
  assert.ok(base.decision && typeof base.decision === "object");
  assert.equal(base.policy.preset, null);
  assert.ok(!("task" in base) && !("context" in base));
  assert.ok(Array.isArray(base.warnings));

  const withPreset = await settings.preview({ request, preset: "deepdive" });
  assert.equal(withPreset.policy.preset, "deepdive");
  assert.equal(withPreset.decision.tier, "deep");

  const cleared = await settings.preview({ request, preset: null });
  assert.equal(cleared.policy.preset, null);
  assert.equal(cleared.decision.tier, null);
});

test("preview reports custom resolver provenance without invoking it as a job", async (t) => {
  const { dir, settings } = await tempSettings();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const hookPath = join(dir, "resolver-hook.mjs");
  await writeFile(hookPath, "export function resolveRoute() { return null; }\n");
  const hooked = new RoutingSettings({
    policyPath: join(dir, "routing.json"),
    config: {},
    env: { HARNEST_ROUTER: hookPath },
  });
  const result = await hooked.preview({ request: { target: "pi", task: "hello", cwd: dir } });
  assert.equal(result.target, "pi");
  assert.equal(result.decision?.resolver?.status, "no-decision");
  assert.ok(result.warnings.some((warning) => /custom resolver/.test(warning)));
  const snapshot = await hooked.get();
  assert.equal(snapshot.advanced.resolverConfigured, true);
});

test("one live resolver picks up preset edits and removals without accumulating routes", async (t) => {
  const { dir, policyPath, settings } = await tempSettings();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const resolver = createRouteResolver({ config: {}, env: {}, policyFile: policyPath });
  const request = { requestId: "reload-fixture", target: "pi", task: "Review the change", cwd: dir };
  let snapshot = await settings.get();
  const edit = async (change) => {
    snapshot = await settings.configure({ ...change, expectedRevision: snapshot.revision });
  };
  const check = async (model, thinking) => {
    const actual = await resolver(request);
    assert.equal(actual.route.model, model);
    assert.equal(actual.route.thinking, thinking);
    const preview = await settings.preview({ request });
    assert.deepEqual(actual.route, preview.route);
    assert.equal(preview.policy.revision, snapshot.revision);
    assert.deepEqual((await resolver(request)).metadata.harnest.routingDecision, actual.metadata.harnest.routingDecision);
    return actual;
  };
  await edit({ action: "set", settings: { models: { pi: "test-provider/base" }, thinking: "low" } });
  const base = await check("base", "low");
  await edit({ action: "save-preset", preset: "review", settings: { models: { pi: "test-provider/reviewer" }, thinking: "high" } });
  await check("base", "low");
  await edit({ action: "use-preset", preset: "review" });
  await check("reviewer", "high");
  await edit({ action: "save-preset", preset: "review", settings: { models: { pi: "test-provider/revised" }, thinking: "medium" } });
  await check("revised", "medium");
  await edit({ action: "use-preset", preset: null });
  await check("base", "low");
  await edit({ action: "delete-preset", preset: "review" });
  const restored = await check("base", "low");
  assert.deepEqual(restored.metadata.harnest.routingDecision, base.metadata.harnest.routingDecision);

  await writeFile(policyPath, "{ malformed");
  const stale = await resolver(request);
  assert.equal(stale.route.model, "base");
  assert.equal(stale.metadata.harnest.routingDecision.warning, "using last-known-good user policy");
  await assert.rejects(settings.preview({ request }), /preview requires a valid saved policy.*last-known-good/);
});

test("preview identifies its independent circuit breaker when runtime and snapshot differ", async (t) => {
  const { dir, policyPath } = await tempSettings();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const hookPath = join(dir, "recovering-hook.mjs");
  await writeFile(hookPath, "let calls = 0; export function resolveRoute() { if (++calls === 1) throw new Error('offline'); return { route: { model: 'recovered' } }; }\n");
  const config = { routing: { resolverModule: hookPath, resolverFailureMode: "passthrough", circuitBreaker: { failureThreshold: 1 } } };
  const runtime = createRouteResolver({ config, env: {}, policyFile: policyPath, now: () => 0 });
  const settings = new RoutingSettings({ config, env: {}, policyPath });
  const request = { requestId: "breaker-fixture", target: "pi", task: "Check route", cwd: dir };
  assert.equal((await runtime(request)).metadata.harnest.routingDecision.resolver.status, "circuit-open");
  const preview = await settings.preview({ request });
  assert.equal(preview.route.model, "recovered");
  assert.equal((await runtime(request)).metadata.harnest.routingDecision.resolver.status, "circuit-open");
  assert.equal(preview.evaluation.runtimeStateShared, false);
  assert.equal(preview.evaluation.mode, "saved-policy-snapshot");
  assert.match(preview.evaluation.configRevision, /^[a-f0-9]{64}$/);
  assert.ok(preview.warnings.some((warning) => /independent circuit breaker/.test(warning)));
});
