// Metadata-only native discovery. No model turns, jobs or personal policy edits.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createModelCatalog } from "../src/model-catalog.mjs";
import { RoutingSettings } from "../src/routing-settings.mjs";

// These route references exercise discovery without sending them to inference.
const cases = [
  ["opencode", { provider: "opencode", model: "muse-spark-1.2-contributor-free", thinking: "high", harnessVersion: "v2" }],
  ["pi", { provider: "openai-codex", model: "gpt-6.1-terra", thinking: "high" }],
  ["cursor", { model: "gpt-6.1-sol-high" }],
  ["codex", { model: "gpt-6.2-sol", thinking: "high" }],
  ["claude", { model: "claude-sonnet-4-5" }],
  ["gemini", { model: "gemini-3-pro" }],
  ["amp", {}],
];

export async function previewRoutingCase({ settings, target, route, cwd = process.cwd() }) {
  const request = { target, task: "Preview version selection only", cwd, route, policy: { write: target === "amp" } };
  const latest = await settings.preview({ request });
  if (target === "amp") {
    assert.deepEqual(latest.route, route);
    return {
      target,
      nativeMode: latest.route.variant ?? "default",
      catalog: "unknown",
      status: null,
      source: "amp:native-mode",
    };
  }
  const pin = await settings.preview({ request: { ...request, metadata: { routing: { modelVersion: "pin" } } } });
  assert.deepEqual(pin.route, route);
  const status = latest.decision?.modelFreshness?.status;
  return { target, latest: latest.route.model, status, source: latest.decision?.modelFreshness?.source, pin: pin.route.model };
}

export async function main() {
  const directory = await mkdtemp(join(tmpdir(), "harnest-live-routing-models-"));
  const settings = new RoutingSettings({ policyPath: join(directory, "missing.json"), config: {}, env: {}, modelCatalog: createModelCatalog() });
  try {
  for (const [target, route] of cases) {
    const result = await previewRoutingCase({ settings, target, route });
    console.log(JSON.stringify(result));
    if (target !== "amp") {
      const expected = target === "gemini" ? ["unavailable"] : ["current", "updated", "managed-latest"];
      if (!expected.includes(result.status)) process.exitCode = 1;
    }
  }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
