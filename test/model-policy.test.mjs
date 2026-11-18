import assert from "node:assert/strict";
import test from "node:test";
import { createAdapter } from "../src/adapters/index.mjs";
import { assertAdapterRoute, assertNoClaudeWorkflow, isClaudeRoute } from "../src/model-policy.mjs";

test("non-Claude adapters reject named Claude routes before spawning", async () => {
  for (const target of ["pi", "opencode", "cursor", "codex"]) {
    let spawned = false;
    const adapter = createAdapter(target, { [target]: { command: "synthetic", spawnFn: () => { spawned = true; throw new Error("must not spawn"); } } });
    await assert.rejects(adapter.run({ route: { model: "anthropic/opus" } }), (error) => error.details?.kind === "policy");
    assert.equal(spawned, false);
  }
});

test("nested Taskflow phases cannot name Claude through qualified aliases", () => {
  assert.equal(isClaudeRoute({ model: "fable" }), true);
  assert.equal(isClaudeRoute({ model: "openai/gpt-5.6-sol" }), false);
  assert.throws(() => assertNoClaudeWorkflow("pi", { spec: { phases: [{ type: "parallel", phases: [{ model: "gateway/opus" }] }] } }), /Claude/);
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

test("Gemini routing accepts native Google model pins and rejects every unsupported route control", () => {
  for (const route of [
    {},
    { provider: "google" },
    { provider: "gemini", model: "gemini-3-pro" },
    { provider: "google-gemini", model: "gemini-3-flash-preview" },
    { provider: "google/gemini", model: "gemini-3-pro" },
  ]) assert.doesNotThrow(() => assertAdapterRoute("gemini", route));

  for (const route of [
    { provider: "openai" },
    { model: "gpt-6" },
    { agent: "reviewer" },
    { variant: "high" },
    { harnessVersion: "v2" },
    { serverUrl: "http://localhost" },
  ]) assert.throws(() => assertAdapterRoute("gemini", route), /Gemini route/i);
});

test("one-shot adapters reject structured workflows instead of silently dropping nodes", async () => {
  for (const target of ["claude", "cursor", "codex"]) {
    for (const workflow of [{ nodes: [{ id: "work", task: "do work" }] }, { spec: { phases: [] } }]) {
      let spawned = false;
      const adapter = createAdapter(target, { [target]: { command: "synthetic", spawnFn: () => { spawned = true; throw new Error("must not spawn"); } } });
      await assert.rejects(adapter.run({ workflow }), (error) => error.details?.kind === "policy" && /Taskflow/.test(error.message));
      assert.equal(spawned, false);
    }
  }
});
