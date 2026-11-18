import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startDaemon } from "../src/daemon.mjs";
import { createRuntimeServices } from "../src/runtime-services.mjs";

const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;

test("Pi executes the installed graph tools with real schemas, persistence and selective recovery", { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "harnest-pi-graph-"));
  const launches = [];
  const daemonDirectory = join(directory, "daemon");
  const daemon = await startDaemon({ port: 0, directory: daemonDirectory,
    buildServices: () => createRuntimeServices({
      stateDir: join(directory, "jobs"), routeResolver: async r => r,
      adapterFactory: target => ({ async run(r) {
        const nodeId = r.context.graph.nodeId;
        launches.push({ nodeId, target, upstream: Object.keys(r.context.graph.upstream) });
        if (nodeId === "retry" && launches.filter(n => n.nodeId === nodeId).length === 1) throw new Error("fixture failure");
        return { sessionId: "pi-fixture-" + nodeId, result: { finalText: nodeId + " DONE" } };
      } }),
    }),
  });
  const shim = moduleUrl(`
    import { createDaemonClient as create } from ${JSON.stringify(new URL("../src/daemon-client.mjs", import.meta.url).href)};
    export const createDaemonClient = () => create({ port: ${daemon.port}, directory: ${JSON.stringify(daemonDirectory)} });
    export const ensureDaemon = async () => ({ ready: true });
  `);
  let source = await readFile(new URL("../pi-extension/harnest.mjs", import.meta.url), "utf8");
  source = source.replace('"__HARNEST_DAEMON_CLIENT_URL__"', JSON.stringify(shim))
    .replace('"__HARNEST_DAEMON_SETTINGS_URL__"', JSON.stringify(new URL("../src/daemon-settings.mjs", import.meta.url).href))
    .replace('"__HARNEST_DYNAMIC_VIEW_URL__"', JSON.stringify(new URL("../src/dynamic-view.mjs", import.meta.url).href))
    .replace('"__HARNEST_LAUNCH_COMMAND_URL__"', JSON.stringify(new URL("../src/launch-command.mjs", import.meta.url).href))
    .replace('"@earendil-works/pi-ai"', JSON.stringify(import.meta.resolve("@earendil-works/pi-ai")))
    .replace('"typebox"', JSON.stringify(import.meta.resolve("typebox")));
  try {
    const tools = new Map(), entries = [];
    const { default: extension } = await import(moduleUrl(source));
    extension({ registerTool: tool => tools.set(tool.name, tool), registerCommand() {}, on() {}, appendEntry: (type, data) => entries.push({ type, data }) });
    const invoke = async (name, params) => {
      const result = await tools.get(name).execute("test-call", params, new AbortController().signal);
      assert.notEqual(result.isError, true);
      return JSON.parse(result.content[0].text);
    };
    const graph = {
      requestId: "pi-runtime", cwd: directory, execution: { background: false },
      nodes: [
        { id: "keep", target: "pi", task: "keep" },
        { id: "retry", target: "codex", task: "retry" },
        { id: "join", target: "cursor", task: "join", dependsOn: ["keep", "retry"] },
      ], outputs: ["join"],
    };
    assert.equal((await invoke("handoff_graph_validate", { graph })).valid, true);
    assert.equal(launches.length, 0);
    const first = await invoke("handoff_graph_start", { graph });
    assert.equal(first.state, "partial");
    assert.equal((await invoke("handoff_graph_resume", { graphId: first.graphId, commandId: "retry-once", nodeIds: ["retry"], background: false })).state, "completed");
    const status = await invoke("handoff_graph_status", { graphId: first.graphId });
    assert.equal(status.nodes.length, 3);
    assert.equal(status.outputs, undefined);
    const unchanged = await invoke("handoff_graph_status", { graphId: first.graphId, afterRevision: status.revision, waitMs: 1 });
    assert.equal(unchanged.unchanged, true);
    assert.ok(JSON.stringify(unchanged).length < 250);
    const result = await invoke("handoff_graph_result", { graphId: first.graphId });
    for (const node of result.nodes) assert.equal(node.state, "completed", node.id);
    assert.equal(result.outputs.join.finalText, "join DONE");
    assert.equal((await invoke("handoff_graph_cancel", { graphId: first.graphId })).state, "completed");
    assert.equal(launches.length, 4);
    assert.deepEqual(launches.find(n => n.nodeId === "join").upstream, ["keep", "retry"]);
    const info = await invoke("handoff_host_info", {});
    assert.equal(info.graphWorkflows.tools.length, 6);
    assert.ok(entries.some(entry => entry.type === "harnest-graph" && entry.data.graphId === first.graphId));
    assert.equal(tools.get("handoff_graph_start").parameters.properties.graph.properties.nodes.maxItems, 256);
    const graphSchema = tools.get("handoff_graph_start").parameters.properties.graph;
    const nodeSchema = graphSchema.properties.nodes.items;
    assert.equal(graphSchema.properties.execution.additionalProperties, false);
    assert.equal(nodeSchema.properties.execution.additionalProperties, false);
    assert.equal(nodeSchema.properties.dependsOn.maxItems, 256);
    const idPattern = "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$";
    assert.equal(nodeSchema.properties.dependsOn.items.pattern, idPattern);
    assert.equal(graphSchema.properties.outputs.items.pattern, idPattern);
    assert.equal(tools.get("handoff_graph_resume").parameters.properties.nodeIds.items.pattern, idPattern);
    await assert.rejects(invoke("handoff_graph_validate", { graph: { ...graph, nodes: [] } }), /nodes/);
  } finally {
    await daemon.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
