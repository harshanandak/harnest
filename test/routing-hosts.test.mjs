import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { startDaemon } from "../src/daemon.mjs";
import { createRuntimeServices } from "../src/runtime-services.mjs";
import { RoutingSettings } from "../src/routing-settings.mjs";
import { JobStore } from "../src/job-store.mjs";

const root = join(import.meta.dirname, "..");
const asModule = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const targets = ["claude", "codex", "opencode", "pi", "cursor"];

const modelCatalog = async ({ target }) => ({
  source: "fixture-native-catalog", at: "2026-09-22T00:00:00Z",
  models: ["5.6", "6"].map((version) => ({
    id: `gpt-${version}-sol${target === "cursor" ? "-high" : ""}`,
    ...(["pi", "opencode"].includes(target) ? { provider: "test-provider" } : {}),
    thinking: ["low", "high"],
  })),
});

async function piRoutingTools(t, directory, policyPath, { recover = false } = {}) {
  const daemonDirectory = join(directory, "daemon");
  const daemon = await startDaemon({ port: 0, directory: daemonDirectory,
    buildServices: () => createRuntimeServices({
      stateDir: join(directory, "jobs"),
      routingSettings: new RoutingSettings({ policyPath, config: {}, env: {}, modelCatalog }),
      adapterFactory: () => { throw new Error("routing preview must not start an adapter"); },
    }),
  });
  t.after(() => daemon.close());
  const clientUrl = asModule(`
    import { createDaemonClient as create } from ${JSON.stringify(new URL("../src/daemon-client.mjs", import.meta.url).href)};
    export const createDaemonClient = () => create({ port: ${daemon.port}, directory: ${JSON.stringify(daemonDirectory)} });
    let attempts = 0;
    export const ensureDaemon = async () => {
      if (${recover} && attempts++ === 0) throw new Error("startup fixture unavailable");
      return { ready: true };
    };
  `);
  let source = await readFile(join(root, "pi-extension", "harnest.mjs"), "utf8");
  for (const [placeholder, relative] of Object.entries({
    __HARNEST_DAEMON_SETTINGS_URL__: "../src/daemon-settings.mjs",
    __HARNEST_DYNAMIC_VIEW_URL__: "../src/dynamic-view.mjs",
    __HARNEST_LAUNCH_COMMAND_URL__: "../src/launch-command.mjs",
    __HARNEST_GRAPH_VIEW_URL__: "../scripts/graph-view.mjs",
  })) source = source.replace(placeholder, new URL(relative, import.meta.url).href);
  source = source.replace("__HARNEST_DAEMON_CLIENT_URL__", clientUrl)
    .replace('"@earendil-works/pi-ai"', JSON.stringify(import.meta.resolve("@earendil-works/pi-ai")))
    .replace('"typebox"', JSON.stringify(import.meta.resolve("typebox")));
  const { default: extension } = await import(asModule(source));
  const tools = new Map();
  const events = new Map();
  const warnings = [];
  let failRegistration = recover;
  const registerTool = (tool) => {
    assert.ok(!tools.has(tool.name), "duplicate registration: " + tool.name);
    if (tool.name === "handoff_routing_configure" && failRegistration) {
      failRegistration = false;
      throw new Error("partial discovery fixture");
    }
    tools.set(tool.name, tool);
  };
  extension({ registerTool, registerCommand() {}, on: (event, callback) => events.set(event, callback), appendEntry() {} });
  await events.get("session_start")({}, { hasUI: false, ui: { notify: (message) => warnings.push(message) } });
  return {
    tools, warnings,
    async call(name, args) {
      return (await tools.get(name).execute("fixture", args, undefined, undefined, { hasUI: false })).details;
    },
  };
}

test("Pi retries startup discovery and completes a partial registration without duplicating tools", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "harnest-pi-reconnect-"));
  try {
    const pi = await piRoutingTools(t, directory, join(directory, "routing.json"), { recover: true });
    assert.deepEqual(pi.warnings, ["Harnest daemon unavailable"]);
    assert.ok(!pi.tools.has("handoff_dynamic_list"));
    await pi.call("handoff_host_info", {});
    assert.ok(!pi.tools.has("handoff_routing_configure"));
    await Promise.all([pi.call("handoff_host_info", {}), pi.call("handoff_host_info", {})]);
    for (const name of ["handoff_dynamic_list", "handoff_routing_get", "handoff_routing_configure", "handoff_routing_preview"]) {
      assert.ok(pi.tools.has(name), name);
    }
  } finally {
    t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  }
});

for (const modern of [false, true]) {
  test(`routing preferences are shared across MCP and native Pi for every target (${modern ? "modern" : "legacy"})`, { timeout: 30_000 }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "harnest-routing-hosts-"));
    const policyPath = join(directory, "routing.json");
    const client = new Client({ name: "routing-host-contract", version: "1" }, modern ? { versionNegotiation: { mode: "auto" } } : {});
    t.after(async () => {
      await client.close();
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    });
    const script = `
      import { serveStdio } from "@modelcontextprotocol/server/stdio";
      import { createServer } from "./src/mcp-server.mjs";
      import { RoutingSettings } from "./src/routing-settings.mjs";
      await serveStdio(() => createServer({
        stateDir: ${JSON.stringify(join(directory, "jobs"))},
        boardDir: ${JSON.stringify(join(directory, "boards"))},
        graphDir: ${JSON.stringify(join(directory, "graphs"))},
        routing: { config: {}, env: {}, policyFile: ${JSON.stringify(policyPath)} },
        routingSettings: new RoutingSettings({ policyPath: ${JSON.stringify(policyPath)}, config: {}, env: {}, modelCatalog: ${modelCatalog.toString()} }),
        adapterFactory: () => { throw new Error("routing preview must not start an adapter"); },
      }), { legacy: "serve" });
    `;
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ["--input-type=module", "-e", script], cwd: root, stderr: "pipe" }));
    const call = async (name, args) => {
      const response = await client.callTool({ name, arguments: args });
      assert.equal(Boolean(response.isError), false, response.content[0].text);
      return JSON.parse(response.content[0].text);
    };
    const pi = await piRoutingTools(t, directory, policyPath);
    const catalog = await client.listTools();
    for (const name of ["handoff_routing_get", "handoff_routing_configure", "handoff_routing_preview"]) {
      assert.deepEqual(catalog.tools.find((tool) => tool.name === name).inputSchema, pi.tools.get(name).parameters);
    }
    let snapshot = await call("handoff_routing_get", {});
    snapshot = await call("handoff_routing_configure", {
      action: "save-preset", preset: "all-hosts", expectedRevision: snapshot.revision,
      settings: { tier: "quick", models: Object.fromEntries(targets.map((target) => [target, target === "opencode" ? "test-provider/synthetic-opencode" : `synthetic-${target}`])) },
    });
    assert.equal((await pi.call("handoff_routing_get", {})).revision, snapshot.revision);
    snapshot = await pi.call("handoff_routing_configure", { action: "use-preset", preset: "all-hosts", expectedRevision: snapshot.revision });
    assert.equal((await call("handoff_routing_get", {})).activePreset, "all-hosts");
    for (const target of targets) {
      const args = { request: { target, task: "Check the route", cwd: directory, policy: { write: target === "opencode" } } };
      const mcp = await call("handoff_routing_preview", args);
      const native = await pi.call("handoff_routing_preview", args);
      assert.deepEqual(native, mcp, `${target}: transport must not change the routing result`);
      assert.equal(mcp.target, target);
      assert.equal(mcp.route.model, `synthetic-${target}`);
      assert.equal(mcp.policy.revision, snapshot.revision);
    }
    const oldRevision = snapshot.revision;
    snapshot = await pi.call("handoff_routing_configure", { action: "use-preset", preset: null, expectedRevision: snapshot.revision });
    const conflict = await client.callTool({ name: "handoff_routing_configure", arguments: { action: "set", settings: { tier: "deep" }, expectedRevision: oldRevision } });
    assert.equal(conflict.isError, true);
    assert.match(conflict.content[0].text, /changed since revision/);
    assert.equal((await call("handoff_routing_get", {})).revision, snapshot.revision);
    const models = { claude: "claude-sonnet-4-5", codex: "gpt-5.6-sol", pi: "test-provider/gpt-5.6-sol", opencode: "test-provider/gpt-5.6-sol", cursor: "gpt-5.6-sol-high" };
    snapshot = await call("handoff_routing_configure", { action: "set", settings: { models, modelVersion: "latest" }, expectedRevision: snapshot.revision });
    for (const target of targets) {
      const args = { request: { target, task: "Check version preference", cwd: directory, policy: { write: target === "opencode" } } };
      const latest = await call("handoff_routing_preview", args);
      assert.deepEqual(await pi.call("handoff_routing_preview", args), latest);
      assert.equal(latest.route.model, target === "claude" ? "sonnet" : `gpt-6-sol${target === "cursor" ? "-high" : ""}`);
      const pinArgs = { request: { ...args.request, metadata: { routing: { modelVersion: "pin" } } } };
      const pin = await call("handoff_routing_preview", pinArgs);
      assert.deepEqual(await pi.call("handoff_routing_preview", pinArgs), pin);
      assert.equal(pin.route.model, models[target].split("/").at(-1));
      assert.equal(pin.decision.modelFreshness.status, "pinned");
    }
    const unsupported = { request: { target: "cursor", task: "Check unsupported effort", route: { model: "synthetic-cursor", thinking: "high" } } };
    assert.equal((await client.callTool({ name: "handoff_routing_preview", arguments: unsupported })).isError, true);
    await assert.rejects(pi.call("handoff_routing_preview", unsupported), /thinking/i);
    assert.deepEqual(await new JobStore(join(directory, "jobs")).listAllReceipts(), []);
  });
}
