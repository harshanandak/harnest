// MCP edge-case gate: every tool is CALLED (not just listed) against invalid,
// boundary, and unknown-reference inputs. Nothing here may spend a model
// call: all cases fail in validation/routing/lookup, or read local state.
// Usage: node scripts/edge-mcp.mjs [--modern]
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const modern = process.argv.includes("--modern");
const client = new Client(
  { name: "harnest-edge", version: "0.0.1" },
  modern ? { versionNegotiation: { mode: "auto" } } : {},
);
const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, "src", "mcp-server.mjs")], cwd: root });

const results = [];
async function call(tool, args) {
  const res = await client.callTool({ name: tool, arguments: args });
  const text = res.content?.[0]?.text || "";
  let structured = null;
  try { structured = JSON.parse(text); } catch { /* plain text error, also fine */ }
  return { isError: Boolean(res.isError), text, structured, raw: res };
}

function expectError(name, res, kindPattern) {
  assert.equal(res.isError, true, `${name}: expected isError`);
  const kind = res.structured?.error?.kind || res.text;
  assert.match(String(kind), kindPattern, `${name}: kind mismatch (${res.text.slice(0, 160)})`);
  results.push(`ok ${name} -> ${res.structured?.error?.kind || "text-error"}`);
}

await client.connect(transport);
try {
  // Healthy reads.
  {
    const res = await call("handoff_host_info", {});
    assert.equal(res.isError, false);
    assert.match(res.text, /leadHost|mcpServerName/);
    results.push("ok handoff_host_info returns launch info");
  }
  {
    const res = await call("handoff_sessions", { limit: 3 });
    assert.equal(res.isError, false);
    results.push("ok handoff_sessions lists");
  }
  // Unknown references fail typed, without model spend.
  await expectError("status unknown job", await call("handoff_status", { jobId: "nope-missing-job" }), /not-found|invalid job id|job not found/i);
  await expectError("result unknown job", await call("handoff_result", { requestId: "nope-missing-request" }), /not-found|request not found|invalid/i);
  await expectError("trace unknown job", await call("handoff_trace", { jobId: "nope-missing-job" }), /not-found|invalid|job not found/i);
  await expectError("cancel unknown job", await call("handoff_cancel", { jobId: "nope-missing-job" }), /not found|not-found|invalid/i);
  await expectError("message unknown job", await call("handoff_message", { jobId: "nope-missing-job", commandId: "c1", message: "hi" }), /^not-found$/);
  await expectError("resume unknown job", await call("handoff_resume", { jobId: "nope-missing-job" }), /not found|not-found|invalid|terminal/i);
  // Validation boundaries.
  await expectError("graph invalid empty nodes", await call("handoff_graph_start", { graph: { requestId: "invalid-graph", cwd: process.cwd(), nodes: [] } }), /validation/i);
  await expectError("graph cyclic dependencies", await call("handoff_graph_validate", { graph: { requestId: "cyclic-graph", cwd: process.cwd(), nodes: [
    { id: "a", target: "pi", task: "a", dependsOn: ["b"] }, { id: "b", target: "codex", task: "b", dependsOn: ["a"] },
  ] } }), /validation|cycle/i);
  for (const action of ["status", "result", "cancel"]) {
    await expectError(`graph ${action} unknown`, await call(`handoff_graph_${action}`, { graphId: `graph-${"0".repeat(64)}` }), /not-found|validation/i);
  }
  await expectError("graph resume unknown", await call("handoff_graph_resume", { graphId: `graph-${"0".repeat(64)}`, commandId: "no-retry" }), /not-found|validation/i);
  await expectError("workflow missing requestId", await call("handoff_workflow", { request: { target: "pi", task: "x", cwd: process.cwd() } }), /validation/i);
  await expectError("workflow bad target", await call("handoff_workflow", { request: { requestId: "e1", target: "watson", task: "x", cwd: process.cwd() } }), /validation/i);
  await expectError("workflow oversized task", await call("handoff_workflow", { request: { requestId: "e2", target: "pi", task: "x".repeat(200000), cwd: process.cwd() } }), /exceeds|too large|validation/i);
  await expectError("workflow whitespace requestId", await call("handoff_workflow", { request: { requestId: "   ", target: "pi", task: "x", cwd: process.cwd() } }), /validation/i);
  await expectError("compare single candidate", await call("handoff_compare", {
    request: { requestId: "e3", target: "pi", task: "x", cwd: process.cwd(), policy: { write: false } },
    candidates: [{ name: "only", route: { model: "m" } }],
  }), /validation/i);
  await expectError("compare write policy", await call("handoff_compare", {
    request: { requestId: "e4", target: "pi", task: "x", cwd: process.cwd(), policy: { write: true } },
    candidates: [{ name: "a", route: { model: "m1" } }, { name: "b", route: { model: "m2" } }],
  }), /policy/i);
  await expectError("compare duplicate routes", await call("handoff_compare", {
    request: { requestId: "e5", target: "pi", task: "x", cwd: process.cwd(), policy: { write: false } },
    candidates: [{ name: "a", route: { model: "m" } }, { name: "b", route: { model: "m" } }],
  }), /validation/i);
  await expectError("trace bad limit", await call("handoff_trace", { jobId: "x", limit: 201 }), /validation/i);
  await expectError("reroute missing provider", await call("handoff_reroute", { jobId: "x", commandId: "c1", route: { model: "m" } }), /validation/i);
  await expectError("review single reviewer", await call("handoff_review", {
    request: { requestId: "e6", target: "pi", task: "x", cwd: process.cwd(), policy: { write: false } },
    reviewers: [{ name: "only", route: { model: "m" } }],
  }), /validation/i);
  await expectError("review write policy", await call("handoff_review", {
    request: { requestId: "e7", target: "pi", task: "x", cwd: process.cwd(), policy: { write: true } },
    reviewers: [{ name: "a", route: { model: "m1" } }, { name: "b", route: { model: "m2" } }],
  }), /policy/i);
  await expectError("review empty rubric", await call("handoff_review", {
    request: { requestId: "e8", target: "pi", task: "x", cwd: process.cwd(), policy: { write: false } },
    reviewers: [{ name: "a", route: { model: "m1" } }, { name: "b", route: { model: "m2" } }],
    rubric: [],
  }), /rubric|non-empty/i);

  console.log(`EDGE_MCP_OK checks=${results.length} era=${client.getProtocolEra()}`);
  for (const line of results) console.log(`  ${line}`);
} finally {
  await client.close();
}
