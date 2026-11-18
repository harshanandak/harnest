import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { listConfiguredAcpAgents, resolveAcpAgent } from "../src/acp-registry.mjs";
import { JobStore } from "../src/job-store.mjs";
import { createReceipt, normalizeRequest, TARGETS } from "../src/protocol.mjs";
import { adapterPolicyRejectionReasons, adapterRouteRejectionReasons } from "../src/model-policy.mjs";
import { buildDefaultCandidates } from "../src/routing-presets.mjs";
import { resolvePolicyRoute } from "../src/routing-policy.mjs";
import { summarizeUsage } from "../src/usage.mjs";

const registration = {
  command: "C:\\tools\\fixture-acp.exe",
  args: ["serve", "--stdio"],
  trusted: true,
  registryId: "fixture-agent",
  version: "1.2.3",
};

function request(overrides = {}) {
  return {
    requestId: "acp-shared-contract",
    target: "acp",
    task: "Implement the approved change.",
    cwd: process.cwd(),
    route: { agent: "fixture" },
    policy: { write: true },
    metadata: { harnest: { writeApproved: true } },
    ...overrides,
  };
}

test("trusted ACP registrations resolve to the exact launch contract", async () => {
  assert.deepEqual(await resolveAcpAgent("fixture", { registrations: { fixture: registration } }), {
    id: "fixture",
    ...registration,
  });
  assert.deepEqual(listConfiguredAcpAgents({ registrations: { fixture: registration } }), [{
    id: "fixture",
    trusted: true,
    registryId: "fixture-agent",
    version: "1.2.3",
  }]);
});

test("ACP registration resolution fails closed on missing, untrusted, and injectable entries", async () => {
  await assert.rejects(resolveAcpAgent("missing", { registrations: {} }), /not registered/i);
  await assert.rejects(resolveAcpAgent("fixture", {
    registrations: { fixture: { ...registration, trusted: false } },
  }), /not trusted/i);
  for (const injected of [
    { env: { TOKEN: "secret" } },
    { module: "./agent.mjs" },
    { shell: true },
  ]) {
    await assert.rejects(resolveAcpAgent("fixture", {
      registrations: { fixture: { ...registration, ...injected } },
    }), /unsupported/i);
  }
  await assert.rejects(resolveAcpAgent("fixture", {
    registrations: { fixture: { ...registration, protocolVersion: 3 } },
  }), /protocolVersion must be 1 or 2/i);
  assert.equal((await resolveAcpAgent("fixture", {
    registrations: { fixture: { ...registration, protocolVersion: 1 } },
  })).protocolVersion, 1);
});

test("ACP is opt-in, write-only, agent-selected, and rejects unimplemented route controls", () => {
  assert.equal(TARGETS.has("acp"), true);
  const normalized = normalizeRequest(request());
  assert.equal(normalized.target, "acp");
  assert.equal(normalized.route.agent, "fixture");
  assert.equal(normalized.policy.write, true);

  for (const bad of [
    request({ route: {} }),
    request({ policy: { write: false } }),
    request({ route: { agent: "fixture", model: "invented" } }),
    request({ workflow: { spec: {} } }),
  ]) assert.throws(() => normalizeRequest(bad), /ACP|acp/i);

  assert.deepEqual(adapterRouteRejectionReasons("acp", { agent: "fixture" }), []);
  assert.ok(adapterRouteRejectionReasons("acp", { agent: "fixture", provider: "remote" }).length > 0);
  assert.deepEqual(adapterPolicyRejectionReasons("acp", { write: true }), []);
  assert.ok(adapterPolicyRejectionReasons("acp", { write: false }).includes("read-only"));
});

test("ACP usage remains unknown without verified native metric semantics", () => {
  assert.deepEqual(summarizeUsage("acp", {
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 2,
    cost: 7,
    currency: "EUR",
  }), {
    inputTokens: null,
    uncachedInputTokens: null,
    inputSemantics: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    costUsd: null,
  });
});

test("ACP usage and metadata-only updates do not reset meaningful progress", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "acp-progress-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new JobStore(directory);
  const storedRequest = normalizeRequest({ requestId: "acp-progress-request", target: "pi", task: "fixture", cwd: process.cwd() });
  await store.put({ request: storedRequest, receipt: createReceipt(storedRequest, { jobId: "acp-progress" }), events: [] });
  const meaningfulAt = new Date(Date.now() - 600_000).toISOString();
  await store.appendEvent("acp-progress", { at: meaningfulAt, event: { type: "progress", data: {
    type: "acp_update", sessionUpdate: "agent_message_chunk", text: "working",
  } } });
  for (const sessionUpdate of ["usage_update", "available_commands_update"]) {
    await store.appendEvent("acp-progress", { at: new Date().toISOString(), event: { type: "progress", data: {
      type: "acp_update", sessionUpdate, usage: sessionUpdate === "usage_update" ? { inputTokens: 1 } : null,
    } } });
  }
  const summary = await store.traceSummary("acp-progress");
  assert.equal(summary.progress.current, "working");
  assert.equal(summary.progress.lastMeaningfulAt, meaningfulAt);
  const trace = await store.readTrace("acp-progress", { limit: 10 });
  assert.equal(trace.events.find((entry) => entry.event?.data?.sessionUpdate === "usage_update")?.event?.data?.usage?.inputTokens, 1);
});

test("routing keeps ACP out of bare auto and preserves route.agent as the registration selector", () => {
  assert.equal(buildDefaultCandidates({}).some((candidate) => candidate.target === "acp"), false);
  const normalized = normalizeRequest(request());
  const decision = resolvePolicyRoute(normalized, [{ name: "global", policy: {
    candidates: [{
      id: "trusted-acp",
      target: "acp",
      route: { agent: "fixture" },
      scores: { quality: 5, speed: 5, efficiency: 5, reliability: 5 },
      capabilities: { readOnly: false, write: true, taskflow: false, liveControl: false },
    }],
  } }], { now: () => 0 });
  assert.equal(decision.target, "acp");
  assert.deepEqual(decision.route, { agent: "fixture" });
  assert.equal(decision.explanation.selected, "explicit-route");
});

test("static request and receipt schemas register ACP while comparison remains read-only", async () => {
  const load = async (name) => JSON.parse(await readFile(new URL(`../schemas/${name}`, import.meta.url), "utf8"));
  const requestSchema = await load("handoff-request.schema.json");
  const receiptSchema = await load("handoff-receipt.schema.json");
  const comparisonSchema = await load("handoff-comparison.schema.json");
  assert.ok(requestSchema.properties.target.enum.includes("acp"));
  assert.ok(requestSchema.properties.metadata.properties.routing.properties.target.enum.includes("acp"));
  assert.ok(receiptSchema.properties.target.enum.includes("acp"));
  assert.ok(receiptSchema.properties.usageAttempts.items.properties.target.enum.includes("acp"));
  assert.equal(comparisonSchema.properties.candidates.items.properties.target.enum.includes("acp"), false);
});
