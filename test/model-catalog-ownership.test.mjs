import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Companion } from "../src/companion.mjs";
import { routingToolDefinitions } from "../src/routing-tools.mjs";

test("a custom adapter owns its catalog; preview and execution share the supplied source", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "harnest-catalog-owner-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const marker = join(directory, "unexpected-probe");
  const config = { executables: { codex: { command: process.execPath, args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'queried')`] } } };
  const options = { stateDir: join(directory, "jobs"), adapterFactory: () => { throw new Error("no jobs in this test"); }, routing: { config, env: {}, userPolicy: {} } };
  const custom = new Companion(options);
  const request = { requestId: "ownership", target: "codex", task: "Check version", cwd: directory, route: { model: "gpt-5.6-sol" } };
  const unverified = await custom.routeResolver(request);
  assert.equal(unverified.route.model, "gpt-5.6-sol");
  assert.equal(unverified.metadata.harnest.routingDecision.modelFreshness.warning, "custom adapter has no model catalog");
  assert.equal(existsSync(marker), false, "custom adapters must not launch native catalog probes");

  let lookups = 0;
  const modelCatalog = async () => { lookups++; return { source: "custom-catalog", models: [{ id: "gpt-6-sol" }] }; };
  const configured = new Companion({ ...options, routing: { ...options.routing, modelCatalog } });
  const routed = await configured.routeResolver(request);
  const previewTool = routingToolDefinitions(undefined, { policyPath: join(directory, "missing.json"), config, env: {}, modelCatalog: configured.modelCatalog }).find((tool) => tool.name === "handoff_routing_preview");
  const preview = await previewTool.run({ request });
  assert.equal(routed.route.model, "gpt-6-sol");
  assert.deepEqual(preview.route, routed.route);
  assert.equal(preview.decision.modelFreshness.source, "custom-catalog");
  assert.equal(lookups, 2);
  assert.equal(existsSync(marker), false);
});
