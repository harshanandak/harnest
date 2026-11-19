import assert from "node:assert/strict";
import test from "node:test";
import { createAdapter } from "../src/adapters/index.mjs";
import { assertAdapterRoute, isClaudeRoute } from "../src/model-policy.mjs";

test("non-Claude adapters reject named Claude routes before spawning", async () => {
  for (const target of ["pi", "opencode", "cursor", "codex"]) {
    let spawned = false;
    const adapter = createAdapter(target, { [target]: { command: "synthetic", spawnFn: () => { spawned = true; throw new Error("must not spawn"); } } });
    await assert.rejects(adapter.run({ route: { model: "anthropic/opus" } }), (error) => error.details?.kind === "policy");
    assert.equal(spawned, false);
  }
});

test("Claude aliases are recognized", () => {
  assert.equal(isClaudeRoute({ model: "fable" }), true);
  assert.equal(isClaudeRoute({ model: "gateway/opus" }), true);
  assert.equal(isClaudeRoute({ model: "openai/gpt-5.6-sol" }), false);
});

test("Amp routing admits only native modes and rejects model-style controls before launch", () => {
  for (const variant of ["low", "medium", "high", "ultra"]) {
    assert.doesNotThrow(() => assertAdapterRoute("amp", { variant }));
  }
  assert.throws(() => assertAdapterRoute("amp", { variant: "smart" }), /variant.*low.*medium.*high.*ultra/i);
  for (const route of [{ model: "smart" }, { provider: "sourcegraph" }, { thinking: "high" }, { agent: "reviewer" }, { harnessVersion: "v2" }, { serverUrl: "http://localhost" }]) {
    assert.throws(() => assertAdapterRoute("amp", route), /Amp route.*supports only route\.variant/i);
  }
});

test("one-shot adapters reject structured workflows instead of silently dropping nodes", async () => {
  for (const target of ["claude", "cursor", "codex", "pi", "opencode", "amp"]) {
    for (const workflow of [{ nodes: [{ id: "work", task: "do work" }] }, { spec: { phases: [] } }]) {
      let spawned = false;
      const adapter = createAdapter(target, { [target]: { command: "synthetic", spawnFn: () => { spawned = true; throw new Error("must not spawn"); } } });
      await assert.rejects(adapter.run({ workflow }), (error) => error.details?.kind === "policy" && error.details.field === "workflow");
      assert.equal(spawned, false);
    }
  }
});
