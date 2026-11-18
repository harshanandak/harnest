import assert from "node:assert/strict";
import test from "node:test";
import { preflight } from "../src/preflight.mjs";

const request = (target) => ({ requestId: `preflight-${target}`, target, task: "synthetic routing check", cwd: process.cwd(), context: { requiredResultFields: ["finalText"] }, policy: { write: target === "amp" } });
const routing = { config: { routing: {} }, env: {}, userPolicy: {
  harnessOrder: ["pi", "claude", "codex", "opencode", "cursor"],
  tier: "balanced", allowTrainingEndpoints: false,
  models: { codex: "gpt-6.1-sol" }, subscriptions: { codex: { subsidy: 1 } },
} };

test("preflight resolves all seven targets with the extended user policy without adapters or job storage", async () => {
  for (const target of ["pi", "claude", "codex", "opencode", "cursor", "gemini", "amp"]) {
    const route = target === "amp" ? { variant: "medium" } : { model: target === "gemini" ? "gemini-synthetic" : "synthetic-model" };
    const result = await preflight({ ...request(target), route }, { routing });
    assert.equal(result.target, target);
    for (const [key, value] of Object.entries(route)) assert.equal(result.route[key], value);
    assert.equal(result.inferenceStarted, false);
    assert.equal(result.jobId, undefined);
    assert.deepEqual(result.checks, ["request", "routing-policy", "cwd"]);
  }
});

test("preflight names schema failures and rejects nonexistent cwd", async () => {
  await assert.rejects(preflight(request("codex"), { routing: { ...routing, userPolicy: { unsupported: true } } }), /unsupported/);
  await assert.rejects(preflight({ ...request("codex"), cwd: `${process.cwd()}/nonexistent-preflight-directory` }, { routeResolver: async (value) => value }), /cwd/);
  await assert.rejects(preflight(request("dsh"), { routing }), /not a downstream target/);
  await assert.rejects(preflight({ ...request("amp"), policy: { write: false }, route: { variant: "medium" } }, { routing }), /cannot enforce a read-only request/);
});
