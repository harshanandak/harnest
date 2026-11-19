// Write-guard hook script tests (B2): drive scripts/hook-guard-write.mjs with
// piped hook JSON, following the execFile script-driving pattern.
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const script = "scripts/hook-guard-write.mjs";

const WORKFLOW_TOOL = "mcp__plugin_harnest_harnest__handoff_workflow";

function hookPayload(toolInput, toolName = WORKFLOW_TOOL) {
  return JSON.stringify({ session_id: "s1", tool_name: toolName, tool_input: toolInput });
}

function writeRequest(overrides = {}) {
  return {
    requestId: "req-1",
    target: "pi",
    task: "do the thing",
    cwd: "/work/proj",
    policy: { write: true },
    metadata: {},
    ...overrides,
  };
}

async function run(stdin) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`hook script timed out after 10s for stdin ${JSON.stringify(stdin)}`));
    }, 10_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

test("write without approval is blocked with exit 2 and names the approval marker", async () => {
  const result = await run(hookPayload({ request: writeRequest() }));
  assert.equal(result.code, 2);
  assert.match(String(result.stderr), /metadata\.harnest\.writeApproved/);
});

test("write with approval is allowed", async () => {
  const result = await run(
    hookPayload({ request: writeRequest({ metadata: { harnest: { writeApproved: true } } }) }),
  );
  assert.equal(result.code, 0);
});

test("tool denies and Cursor plan or sandbox leave the write approval gate intact", async () => {
  for (const [target, controls] of [
    ["pi", { tools: { deny: ["write"] } }],
    ["cursor", { mode: "plan", sandbox: true }],
  ]) {
    const request = writeRequest({ target, policy: { write: true, ...controls } });
    assert.equal((await run(hookPayload({ request }))).code, 2);
    assert.equal((await run(hookPayload({ request: { ...request, metadata: { harnest: { writeApproved: true } } } }))).code, 0);
    assert.equal((await run(hookPayload({ request: { ...request, policy: { write: false, ...controls } } }))).code, 0);
  }
});

test("Amp write handoffs use the same explicit approval marker", async () => {
  for (const target of ["amp"]) {
    const blocked = await run(hookPayload({ request: writeRequest({ target }) }));
    assert.equal(blocked.code, 2, target);
    assert.match(String(blocked.stderr), /metadata\.harnest\.writeApproved/);
    const allowed = await run(hookPayload({ request: writeRequest({ target, metadata: { harnest: { writeApproved: true } } }) }));
    assert.equal(allowed.code, 0, target);
  }
});

test("read-only handoff_workflow is allowed", async () => {
  const readOnly = writeRequest({ policy: { write: false } });
  const result = await run(hookPayload({ request: readOnly }));
  assert.equal(result.code, 0);
});

test("graph launch uses the same explicit write approval as an individual handoff", async () => {
  const tool = "mcp__plugin_harnest_harnest__handoff_graph_start";
  assert.equal((await run(hookPayload({ graph: writeRequest() }, tool))).code, 2);
  assert.equal((await run(hookPayload({ graph: writeRequest({ metadata: { harnest: { writeApproved: true } } }) }, tool))).code, 0);
  assert.equal((await run(hookPayload({ graph: writeRequest({ policy: { write: false } }) }, tool))).code, 0);
});

test("missing policy counts as read-only and is allowed", async () => {
  const { policy, ...rest } = writeRequest();
  const result = await run(hookPayload({ request: rest }));
  assert.equal(result.code, 0);
});

test("non-workflow handoff tools are never blocked", async () => {
  const result = await run(
    hookPayload(
      { request: writeRequest() },
      "mcp__plugin_harnest_harnest__handoff_status",
    ),
  );
  assert.equal(result.code, 0);
});

test("garbage stdin fails open with exit 0", async () => {
  for (const stdin of ["not json{{{", "", "{}", "[]", "null"]) {
    const result = await run(stdin);
    assert.equal(result.code, 0, `must fail open for ${JSON.stringify(stdin)}`);
  }
});
