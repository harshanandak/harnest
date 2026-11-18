import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RoutingSettings } from "../src/routing-settings.mjs";
import { registerRoutingTools, routingToolDefinitions } from "../src/routing-tools.mjs";

test("chat tools save, select and preview a preset without losing an explicit route", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harnest-routing-chat-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const policyPath = join(root, "routing.json");
  const settings = new RoutingSettings({ policyPath, config: {}, env: {} });
  const handlers = new Map();
  registerRoutingTools({ registerTool(name, _schema, handler) { handlers.set(name, handler); } }, {
    settings, dataResponse: (_key, data) => data, failure: (error) => ({ error: error.message }),
  });
  const get = handlers.get("handoff_routing_get");
  const configure = handlers.get("handoff_routing_configure");
  const preview = handlers.get("handoff_routing_preview");
  const initial = await get({});
  const saved = await configure({ action: "save-preset", preset: "review", expectedRevision: initial.revision, settings: { tier: "review", models: { pi: "test-provider/reviewer" }, thinking: "high" } });
  assert.equal(saved.activePreset, null);
  const selected = await configure({ action: "use-preset", preset: "review", expectedRevision: saved.revision });
  assert.equal(selected.settings.thinking, "high");
  const before = await readFile(policyPath, "utf8");
  const result = await preview({ request: { target: "pi", task: "Review the change", cwd: root } });
  assert.equal(result.route.model, "reviewer");
  assert.equal(result.route.thinking, "high");
  assert.equal(result.decision.preset, "review");
  assert.deepEqual(result.warnings, [], "qualified model IDs should not look like overrides");
  const basePreview = await preview({ request: { target: "pi", task: "Use base", metadata: { routing: { preset: null } } } });
  assert.equal(basePreview.policy.preset, null);
  const pin = await preview({ request: { target: "pi", task: "Review the change", cwd: root, route: { provider: "test-provider", model: "specific", thinking: "low" } } });
  assert.equal(pin.route.model, "specific");
  assert.equal(pin.route.thinking, "low");
  assert.equal(await readFile(policyPath, "utf8"), before);
  const stale = await configure({ action: "set", expectedRevision: initial.revision, settings: { tier: "quick" } });
  assert.match(stale.error, /changed/);
  assert.equal(await readFile(policyPath, "utf8"), before);
  assert.match((await configure({ action: "set", expectedRevision: selected.revision, settings: { resolverModule: "untrusted.mjs" } })).error, /[Uu]nrecognized/);
  assert.match((await configure({ action: "use-preset", expectedRevision: selected.revision })).error, /explicit null/);
  assert.equal(await readFile(policyPath, "utf8"), before);
});

test("routing tools distinguish reads from writes and validate their public inputs", () => {
  const tools = routingToolDefinitions({});
  assert.deepEqual(tools.map(({ name, readOnlyHint }) => [name, readOnlyHint]), [
    ["handoff_routing_get", true], ["handoff_routing_configure", false], ["handoff_routing_preview", true],
  ]);
  for (const tool of tools) assert.equal(tool.parameters.type, "object");
  assert.throws(() => tools[1].inputSchema.parse({ action: "set", settings: { tier: "quick" } }));
  assert.throws(() => tools[2].inputSchema.parse({ request: { task: "preview" }, policyPath: "elsewhere" }));
  const revision = "a".repeat(64);
  assert.doesNotThrow(() => tools[1].inputSchema.parse({
    action: "set",
    expectedRevision: revision,
    settings: { harnessOrder: ["pi", "opencode", "claude", "codex", "cursor", "gemini", "amp", "acp"] },
  }));
  assert.doesNotThrow(() => tools[2].inputSchema.parse({ request: { target: "gemini", task: "preview" } }));
  assert.doesNotThrow(() => tools[2].inputSchema.parse({ request: { target: "amp", task: "preview" } }));
  assert.doesNotThrow(() => tools[2].inputSchema.parse({ request: { target: "acp", task: "preview", route: { agent: "fixture" }, policy: { write: true } } }));
});
