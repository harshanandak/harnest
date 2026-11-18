import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixture = await mkdtemp(join(tmpdir(), "harnest-dynamic-mcp-"));
const modern = process.argv.includes("--modern");
const client = new Client({ name: "dynamic-acceptance", version: "1" }, modern ? { versionNegotiation: { mode: "auto" } } : {});
const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, "src/mcp-server.mjs")], cwd: root, env: { ...process.env, HARNEST_STATE_DIR: join(fixture, "state") } });
const call = async (name, input) => {
  const result = await client.callTool({ name: `handoff_dynamic_${name}`, arguments: input });
  assert.equal(Boolean(result.isError), false, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
};
let started;
try {
  await client.connect(transport);
  const source = 'export const meta = { name: "parameterized", description: "Disposable smoke fixture" }; await phase("Calculate"); return {answer: args.value * 2};';
  const saved = await call("save", { name: "parameterized", cwd: fixture, source });
  const edited = await call("save", { name: "parameterized", cwd: fixture, expectedRevision: saved.revision, source: source.replace("* 2", "* 3") });
  const versions = await call("revisions", { name: "parameterized", cwd: fixture });
  assert.deepEqual(versions.revisions.map((item) => item.revision).sort(), [saved.revision, edited.revision].sort());
  const pinned = await call("get", { name: "parameterized", cwd: fixture, revision: saved.revision });
  assert.equal(pinned.source, source);
  started = await call("invoke", { requestId: "pinned-smoke", name: "parameterized", cwd: fixture, revision: saved.revision, args: { value: 21 }, execution: { timeoutMs: 15000 } });
  let status = started;
  const expiry = Date.now() + 20000;
  while (!["completed", "failed", "partial", "cancelled"].includes(status.state) && Date.now() < expiry) {
    const update = await call("status", { runId: started.runId, afterRevision: status.revision, waitMs: 1000 });
    if (!update.unchanged) status = update;
  }
  assert.equal(status.state, "completed", JSON.stringify(status));
  const result = await call("result", { runId: started.runId });
  assert.deepEqual(result.output, { answer: 42 });
  assert.equal(result.invocations.length, 0, "no native agent may launch in this smoke");
  const history = await call("history", { limit: 5 });
  assert.equal(history.runs[0].runId, started.runId);
  await call("delete", { name: "parameterized", cwd: fixture, expectedRevision: edited.revision });
  assert.equal((await call("list", { cwd: fixture })).workflows.length, 0);
  assert.equal((await call("revisions", { name: "parameterized", cwd: fixture })).revisions.length, 2);
  assert.equal((await call("get", { name: "parameterized", cwd: fixture, revision: saved.revision })).source, source);
  console.log(`DYNAMIC_MCP_OK era=${client.getProtocolEra()} revisions=2 agents=0 answer=42`);
} finally {
  if (started) await client.callTool({ name: "handoff_dynamic_control", arguments: { runId: started.runId, commandId: "smoke-cleanup", action: "stop" } }).catch(() => {});
  await client.close();
  await rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
