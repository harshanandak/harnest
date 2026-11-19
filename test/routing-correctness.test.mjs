import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRouteResolver, validateRoutingConfiguration } from "../src/routing.mjs";
import { expandUserPolicy } from "../src/routing-presets.mjs";
import { updatePolicyJson } from "../scripts/policy-store.mjs";

const exec = promisify(execFile);
const cwd = join(import.meta.dirname, "..");
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "routing-correctness-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const request = (route = {}) => ({ requestId: "correctness", target: "pi", task: "test", cwd, route });

test("doctor validates expanded sugar, candidates, and sessions without a user file", () => {
  assert.throws(() => validateRoutingConfiguration({}, { models: [] }), /models/);
  assert.throws(() => validateRoutingConfiguration({}, { candidates: [{ id: "bad", target: "pi", scores: { quality: 99 } }] }), /quality/);
  assert.throws(() => validateRoutingConfiguration({ sessions: { hidden: { tier: "typo" } } }), /tier/);
  assert.throws(() => validateRoutingConfiguration({ global: [] }), /object/);
  assert.doesNotThrow(() => validateRoutingConfiguration({}, { models: { pi: "provider/unknown-model" } }));
  assert.doesNotThrow(() => validateRoutingConfiguration({}, { harnessOrder: ["pi", "claude"], models: { pi: "gpt-5.6" }, subscriptions: { pi: { subsidy: 1 } } }));
});

test("explicit fields survive policy and trusted hook, including thinking", async (t) => {
  const dir = await fixture(t);
  const hook = join(dir, "hook.mjs");
  await writeFile(hook, 'export default () => ({target:"cursor",route:{provider:"other",model:"other",thinking:"low"}})');
  const resolve = createRouteResolver({ config: {}, env: {}, resolverModule: hook,
    userPolicy: { route: { model: "policy", thinking: "medium" } } });
  const actual = await resolve(request({ provider: "chosen", model: "chosen", thinking: "high" }));
  assert.equal(actual.target, "pi");
  assert.deepEqual(actual.route, { provider: "chosen", model: "chosen", thinking: "high" });
});

test("a trusted hook cannot move live-control work onto a shared-service OpenCode node", async (t) => {
  const dir = await fixture(t);
  const hook = join(dir, "hook.mjs");
  await writeFile(hook, 'export default () => ({target:"opencode",route:{model:"fixture/model"}})');
  const graphRequest = () => ({ ...request(), context: { graph: { graphId: "fixture" } }, metadata: { routing: { mode: "auto" } } });
  const userPolicy = { require: { liveControl: true } };
  const shared = createRouteResolver({ config: {}, env: {}, resolverModule: hook, userPolicy });
  await assert.rejects(shared(graphRequest()), /Shared-service OpenCode graph nodes/);
  const attached = createRouteResolver({ config: {}, env: {}, resolverModule: hook, userPolicy, openCodeServerUrl: "http://127.0.0.1:43991" });
  const routed = await attached(graphRequest());
  assert.equal(routed.target, "opencode");
  assert.equal(routed.metadata.harnest.routingDecision.requireLiveControl, true);
});

test("malformed sugar reports its field instead of disappearing", () => {
  for (const policy of [{ models: [] }, { models: null }, { subscriptions: "yes" },
    { subscriptions: { pi: { subsdy: 1 } } }, { models: { typo: "model" } }]) {
    assert.throws(() => expandUserPolicy(policy), /models|subscriptions/);
  }
});

test("semantic invalid reload retains the last valid policy", async (t) => {
  const dir = await fixture(t);
  const path = join(dir, "routing.json");
  await writeFile(path, JSON.stringify({ target: "claude" }));
  const resolve = createRouteResolver({ config: {}, env: {}, policyFile: path });
  // A bare request target is a harness pin now, so a policy target directive
  // applies only on the explicit automatic path (metadata.routing.mode auto).
  const automatic = () => ({ ...request(), metadata: { routing: { mode: "auto" } } });
  assert.equal((await resolve(automatic())).target, "claude");
  await writeFile(path, JSON.stringify({ tier: "not-a-tier", candidates: [] }));
  const actual = await resolve(automatic());
  assert.equal(actual.target, "claude");
  assert.match(actual.metadata.harnest.routingDecision.warning, /last-known-good/);
});

test("manual update of an existing auto overlay stamps manual and exhausted", async (t) => {
  const dir = await fixture(t);
  const path = join(dir, "routing.json");
  await writeFile(path, JSON.stringify({ candidates: [{ id: "auto-pi", target: "pi", health: { source: "auto", headroom: 1 } }] }));
  await exec(process.execPath, ["scripts/set-pressure.mjs", "--pressure", "pi=0", "--out", path, "--yes"], { cwd });
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")).candidates[0].health,
    { source: "manual", headroom: 0, status: "degraded" });
});

test("transaction lock spans read and update, preserving independent overlays", async (t) => {
  const dir = await fixture(t);
  const path = join(dir, "routing.json");
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let entered;
  const firstEntered = new Promise((resolve) => { entered = resolve; });
  const first = updatePolicyJson(path, async (policy) => {
    entered();
    await held;
    policy.candidates = [{ id: "auto-claude", target: "claude", health: { source: "auto", headroom: 0.3 } }];
  });
  await firstEntered;
  await assert.rejects(updatePolicyJson(path, () => assert.fail("entered locked transaction"), { timeoutMs: 0 }), /locked/);
  const second = exec(process.execPath, ["scripts/set-pressure.mjs", "--pressure", "pi=0.2", "--out", path, "--yes"], { cwd });
  release();
  await Promise.all([first, second]);
  const result = JSON.parse(await readFile(path, "utf8"));
  assert.equal(result.candidates.length, 2);
  assert.equal(result.candidates.find((c) => c.id === "auto-claude").health.headroom, 0.3);
  assert.equal(result.candidates.find((c) => c.id === "auto-pi").health.source, "manual");
});

test("wizard preserves both training answers through expansion and routing", async () => {
  const { interactive } = await import("../scripts/setup-routing.mjs");
  for (const answer of ["yes", "no"]) {
    const answers = [...Array(8).fill(""), "n", "pi", answer];
    const selected = await interactive({}, { rl: { question: async () => answers.shift(), close() {} }, pickLanes: async () => [] });
    assert.equal(answers.length, 0, "fixture must answer every seven-target wizard prompt");
    const policy = JSON.parse(JSON.stringify({ allowTrainingEndpoints: selected.allowTrainingEndpoints }));
    assert.equal(expandUserPolicy(policy).allowTrainingEndpoints, answer === "yes");
  }
});
