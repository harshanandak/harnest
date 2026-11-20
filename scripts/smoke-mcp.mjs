import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { assertMcpCatalog } from "./harnest-mcp-catalog.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const modern = process.argv.includes("--modern");
const bridge = process.argv.includes("--bridge");
const client = new Client(
  { name: "harnest-smoke", version: "0.1.1" },
  modern ? { versionNegotiation: { mode: "auto" } } : {},
);
let fixture, daemon;
try {
  let env;
  if (bridge) {
    fixture = await mkdtemp(join(tmpdir(), "harnest-smoke-bridge-"));
    const stateDir = join(fixture, "jobs");
    const { startDaemon } = await import("../src/daemon.mjs");
    const { createRuntimeServices } = await import("../src/runtime-services.mjs");
    daemon = await startDaemon({ port: 0, directory: join(fixture, "daemon"), buildServices: () => createRuntimeServices({
      stateDir, boardDir: join(fixture, "boards"), graphDir: join(fixture, "graphs"), workflowDir: join(fixture, "workflows"),
      routing: { config: {}, env: {}, policyFile: join(fixture, "routing.json") },
    }) });
    env = { HARNEST_STATE_DIR: stateDir, HARNEST_DAEMON_FIXTURE_PORT: String(daemon.port) };
  }
  const script = bridge ? "mcp-bridge.mjs" : "mcp-server.mjs";
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, "src", script)], cwd: root, env });
  await client.connect(transport);
  const listed = await client.listTools();
  const names = assertMcpCatalog(listed);
  const info = await client.callTool({ name: "handoff_host_info", arguments: {} });
  assert.equal(Boolean(info.isError), false);
  const host = JSON.parse(info.content[0].text);
  assert.equal(host.runtime.sourceStatus, "current");
  assert.deepEqual(host.runtime.targets, ["opencode", "pi", "cursor", "claude", "codex", "amp", "acp"]);
  assert.equal(host.runtime.routingPolicyVersion, 2);
  const dynamicValidation = await client.callTool({ name: "handoff_dynamic_validate", arguments: { workflow: {
    requestId: "smoke-dynamic-validation", cwd: root, source: "return args.value + 1;", args: { value: 41 }, policy: { write: false },
  } } });
  assert.equal(Boolean(dynamicValidation.isError), false, dynamicValidation.content?.[0]?.text);
  const importRejected = await client.callTool({ name: "handoff_dynamic_validate", arguments: { workflow: {
    requestId: "smoke-dynamic-import", cwd: root, source: "return await import('node:fs');", policy: { write: false },
  } } });
  assert.equal(importRejected.isError, true, "guest imports must fail before execution");
  assert.equal(host.writeApproval.marker, "metadata.harnest.writeApproved=true");
  assert.match(host.nestedHandoffs, /cannot widen/);
  process.stdout.write(`MCP_SMOKE_OK tools=${names.length} era=${client.getProtocolEra()}\n`);
} finally {
  await client.close();
  await daemon?.close();
  if (fixture) await rm(fixture, { recursive: true, force: true, maxRetries: 5 });
}
