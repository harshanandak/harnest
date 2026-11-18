import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Companion } from "../src/companion.mjs";
import { JobStore } from "../src/job-store.mjs";
import { GraphRunner } from "../src/graph.mjs";

const registrations = {
  fixture: {
    command: process.execPath,
    args: [fileURLToPath(new URL("./fixtures/generic-acp-durable.mjs", import.meta.url)), "--acp-fixture"],
    trusted: true,
    protocolVersion: 1,
  },
};

test("generic ACP factory saves background results and resumes the native session without replay contamination", { timeout: 20_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "harnest-acp-durable-"));
  const store = new JobStore(join(directory, "state"));
  const companion = new Companion({ store, adapterOptions: { acp: { registrations } }, routeResolver: async (request) => request });
  t.after(async () => {
    await companion.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const queued = await companion.start({
    target: "acp", requestId: "generic-acp-durable", task: "Return the fixture canary.", cwd: directory,
    route: { agent: "fixture" }, policy: { write: true }, metadata: { harnest: { writeApproved: true } },
    context: { requiredText: ["ACP_DURABLE_CANARY"] }, execution: { background: true, timeoutMs: 5_000 },
  });
  assert.equal(queued.state, "queued");
  let receipt = queued;
  const deadline = Date.now() + 8_000;
  while (["queued", "running"].includes(receipt.state) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    receipt = await companion.status(queued.jobId);
  }
  assert.equal(receipt.state, "completed", JSON.stringify(receipt.error));
  assert.equal(receipt.sessionId, "durable-acp-session");
  assert.equal(receipt.route.agent, "fixture");
  assert.equal(receipt.requestId, queued.requestId);
  assert.equal(receipt.contextDigest, queued.contextDigest);
  assert.match(receipt.result.finalText, /^ACP_DURABLE_CANARY\n/);
  const fresh = new Companion({ store: new JobStore(store.root), routeResolver: async (request) => request });
  t.after(() => fresh.close());
  assert.deepEqual(await fresh.result(receipt.jobId), receipt);
  const resumed = await companion.resume(receipt.jobId, { task: "Return the canary for the next turn.", execution: { background: false } });
  assert.equal(resumed.state, "completed", JSON.stringify(resumed.error));
  assert.equal(resumed.sessionId, receipt.sessionId);
  assert.equal(resumed.resumeOf, receipt.jobId);
  assert.doesNotMatch(resumed.result.finalText, /OLD_REPLAY_ONLY/);
  assert.equal(resumed.contextDigest, receipt.contextDigest);
});

test("generic ACP graph nodes execute through the real adapter with direct dependency results", { timeout: 20_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "harnest-acp-graph-"));
  const companion = new Companion({ stateDir: join(directory, "state"), adapterOptions: { acp: { registrations } }, routeResolver: async (request) => request });
  const runner = new GraphRunner({ companion, pollIntervalMs: 20 });
  t.after(async () => {
    await Promise.all([...runner.running.values()]);
    await companion.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const result = await runner.start({
    requestId: "generic-acp-graph", cwd: directory,
    policy: { write: true }, metadata: { harnest: { writeApproved: true } },
    execution: { background: false, maxConcurrency: 1, timeoutMs: 10_000 },
    nodes: [
      { id: "root", target: "acp", task: "graph-root-task", route: { agent: "fixture" } },
      { id: "join", target: "acp", task: "consume-upstream-task", route: { agent: "fixture" }, dependsOn: ["root"] },
    ],
  });
  assert.equal(result.state, "completed", JSON.stringify(result.nodes));
  assert.equal(result.counts.completed, 2);
  assert.equal(result.outputs.join.finalText, "JOIN_USED_UPSTREAM");
  for (const node of result.nodes) {
    const receipt = await companion.result(node.jobId);
    assert.equal(receipt.target, "acp");
    assert.equal(receipt.route.agent, "fixture");
    assert.equal(receipt.state, "completed");
    assert.equal(receipt.sessionId, "durable-acp-session");
  }
});
