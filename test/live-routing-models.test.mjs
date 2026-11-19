import assert from "node:assert/strict";
import test from "node:test";

import { previewRoutingCase } from "../scripts/live-routing-models.mjs";

test("Amp routing metadata preview stays model-free and reports native catalog state", async () => {
  const calls = [];
  const settings = {
    async preview({ request }) {
      calls.push(request);
      return { route: {}, decision: {} };
    },
  };
  const result = await previewRoutingCase({ settings, target: "amp", route: {}, cwd: process.cwd() });
  assert.equal(calls.length, 1, "Amp must not run a modelVersion=pin preview");
  assert.equal(calls[0].policy.write, true);
  assert.equal(calls[0].metadata?.routing?.modelVersion, undefined);
  assert.deepEqual(result, {
    target: "amp",
    nativeMode: "default",
    catalog: "unknown",
    status: null,
    source: "amp:native-mode",
  });
});

test("latest and pinned previews describe each target's supported write policy", async () => {
  for (const target of ["opencode", "pi", "cursor", "codex", "claude", "gemini"]) {
    const calls = [];
    const settings = {
      async preview({ request }) {
        calls.push(request);
        return { route: request.route };
      },
    };
    await previewRoutingCase({ settings, target, route: { model: "fixture" } });
    assert.deepEqual(calls.map(request => request.metadata?.routing?.modelVersion), [undefined, "pin"]);
    for (const request of calls) assert.equal(request.policy.write, target === "opencode", target);
  }
});
