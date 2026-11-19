import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertDynamicLeaf, childRequestIdFor, controlIdentity, dynamicError, invocationFingerprint,
  normalizeAgentOptions, normalizeDynamicSpec, normalizePolicy, normalizeRoute, normalizeSchema,
  normalizeExecution, projectHistoryRun, projectStatus, runIdFor, specIdentity,
} from "../src/dynamic-protocol.mjs";

async function tmp(t) {
  const root = await mkdtemp(join(tmpdir(), "harnest-dyn-prop-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return root;
}

const source = JSON.stringify({ name: "fixture", plan: [{ type: "agent", prompt: "a" }] });

test("spec normalization applies defaults, realpaths cwd and rejects unknown keys", async (t) => {
  const root = await tmp(t);
  const spec = await normalizeDynamicSpec({ requestId: "r1", source, cwd: root });
  assert.equal(spec.name, null);
  assert.equal(spec.target, null);
  assert.equal(spec.execution.background, true);
  assert.equal(spec.execution.maxConcurrency, 4);
  assert.equal(spec.execution.maxAgents, 1000);
  assert.equal(spec.execution.prefixStaggerMs, 5000);
  assert.equal(spec.args, null);
  assert.equal(spec.scriptDigest.length, 64);
  assert.equal(spec.argsDigest.length, 64);
  await assert.rejects(() => normalizeDynamicSpec({ requestId: "r1", source, cwd: root, rogue: 1 }), /rogue is unsupported/);
  await assert.rejects(() => normalizeDynamicSpec({ requestId: "r1", source, cwd: join(root, "missing") }), /existing absolute directory/);
});

test("execution caps match the contract ceilings", async () => {
  assert.throws(() => normalizeExecution({ maxConcurrency: 7 }), /between 1 and 6/);
  assert.throws(() => normalizeExecution({ maxAgents: 1001 }), /between 1 and 1000/);
  assert.throws(() => normalizeExecution({ prefixStaggerMs: 5001 }), /between 0 and 5000/);
  assert.equal(normalizeExecution({ background: false, maxConcurrency: 6, maxAgents: 2, prefixStaggerMs: 0 }).maxConcurrency, 6);
});

test("identifiers are stable and attempt-scoped", () => {
  const runId = runIdFor("stable-request");
  assert.equal(runId, runIdFor("stable-request"));
  assert.match(runId, /^dyn-[a-f0-9]{64}$/);
  assert.notEqual(runIdFor("other"), runId);
  assert.equal(childRequestIdFor(runId, 3, 1), `${runId}:3:1`);
  assert.notEqual(childRequestIdFor(runId, 3, 1), childRequestIdFor(runId, 3, 2));
});

test("spec identity ignores background but changes with source", async (t) => {
  const root = await tmp(t);
  const base = { requestId: "r1", source, cwd: root };
  const a = await normalizeDynamicSpec({ ...base, execution: { background: true } });
  const b = await normalizeDynamicSpec({ ...base, execution: { background: false } });
  assert.equal(specIdentity(a), specIdentity(b));
  const c = await normalizeDynamicSpec({ ...base, source: JSON.stringify({ name: "fixture", plan: [] }) });
  assert.notEqual(specIdentity(a), specIdentity(c));
  // Leading/trailing whitespace is normalized away, so it is not a new revision.
  const padded = await normalizeDynamicSpec({ ...base, source: `  ${source}  ` });
  assert.equal(specIdentity(a), specIdentity(padded));
});

test("policy narrowing never widens write, tools or cost", () => {
  const root = normalizePolicy({ write: true, tools: ["read", "edit"], maxCostUsd: 5 });
  assert.deepEqual(root, { write: true, tools: ["read", "edit"], maxCostUsd: 5 });
  assert.throws(() => normalizePolicy({ write: true }, { write: false }), /escalate write policy/);
  assert.throws(() => normalizePolicy({ tools: ["read", "rm"] }, root), /widen allowed tools/);
  assert.throws(() => normalizePolicy({ maxCostUsd: 6 }, root), /increase cost ceiling/);
  assert.deepEqual(normalizePolicy({}, root), root);
  assert.throws(() => normalizePolicy({ write: "true" }), /policy\.write must be boolean/);
});

test("inherited explicit deny lists, plan mode and sandbox survive child overrides", () => {
  const parent = normalizePolicy({ tools: { allow: ["Read", "Glob"], deny: ["Bash"] }, mode: "plan", sandbox: true });
  assert.deepEqual(normalizePolicy({ tools: { allow: ["Read"], deny: ["Glob"] } }, parent), {
    write: false, maxCostUsd: null, tools: { allow: ["Read"], deny: ["Bash", "Glob"] }, mode: "plan", sandbox: true,
  });
  assert.deepEqual(normalizePolicy({ tools: { deny: [] } }, parent), parent);
  assert.throws(() => normalizePolicy({ tools: { allow: ["Edit"] } }, parent), /cannot widen allowed tools/);
  assert.throws(() => normalizePolicy({ tools: [] }, parent), /cannot change inherited tool policy format/);
  assert.throws(() => normalizePolicy({ sandbox: false }, parent), /cannot disable inherited sandbox/);
});

test("agent options default the label, merge context and reject widening", async (t) => {
  const root = await tmp(t);
  const spec = await normalizeDynamicSpec({
    requestId: "r1", source, cwd: root,
    policy: { write: false, tools: ["read"] },
    context: { shared: true },
    route: { model: "fixture/model" },
    execution: { timeoutMs: 60_000 },
  });
  const merged = await normalizeAgentOptions("do it", { label: "first", target: "pi" }, { ordinal: 0, root: spec });
  assert.equal(merged.label, "first");
  assert.equal(merged.target, "pi");
  assert.equal(merged.route.model, "fixture/model");
  assert.deepEqual(merged.context, { shared: true });
  assert.equal(merged.execution.timeoutMs, 60_000);
  const defaulted = await normalizeAgentOptions("do it", undefined, { ordinal: 4, root: spec });
  assert.equal(defaulted.label, "call 4");
  assert.equal(defaulted.target, null);
  await assert.rejects(() => normalizeAgentOptions("x", { policy: { write: true } }, { ordinal: 0, root: spec }), /escalate/);
  await assert.rejects(() => normalizeAgentOptions("x", { execution: { timeoutMs: 120_000 } }, { ordinal: 0, root: spec }), /cannot exceed the root deadline/);
  await assert.rejects(() => normalizeAgentOptions("x", { rogue: true }, { ordinal: 0, root: spec }), /rogue is unsupported/);
});

test("route and schema validation", async () => {
  assert.deepEqual(normalizeRoute({ model: "a/b", thinking: true }), { model: "a/b", thinking: true });
  assert.throws(() => normalizeRoute({ prompt: "no" }), /prompt is unsupported/);
  assert.throws(() => normalizeRoute({ thinking: 1 }), /thinking/);
  assert.equal(normalizeSchema({ type: "object", properties: { a: {} }, required: ["a"] }).type, "object");
  assert.throws(() => normalizeSchema({ type: "object", additionalProperties: false, properties: {}, required: ["a"] }), /matching patternProperties/);
});

test("invocation fingerprint covers prompt, context, route, schema and policy", async (t) => {
  const root = await tmp(t);
  const spec = await normalizeDynamicSpec({ requestId: "r1", source, cwd: root });
  const base = await normalizeAgentOptions("p", undefined, { ordinal: 0, root: spec });
  const resolved = { ...base, target: "pi", route: { model: "m" } };
  const fingerprint = invocationFingerprint(resolved);
  assert.notEqual(fingerprint, invocationFingerprint({ ...resolved, prompt: "q" }));
  assert.notEqual(fingerprint, invocationFingerprint({ ...resolved, context: { x: 1 } }));
  assert.notEqual(fingerprint, invocationFingerprint({ ...resolved, route: { model: "n" } }));
  assert.notEqual(fingerprint, invocationFingerprint({ ...resolved, schema: { type: "object" } }));
  assert.notEqual(fingerprint, invocationFingerprint({ ...resolved, policy: { write: true, tools: [], maxCostUsd: null } }));
});

test("status projection exposes the exact contract shape and hides prompts/results", async (t) => {
  const root = await tmp(t);
  const source = JSON.stringify({ plan: [] });
  const record = {
    runId: runIdFor("r1"), requestId: "r1", name: "demo", state: "running", revision: 7,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:01.000Z", startedAt: null, completedAt: null,
    attempt: 2, scriptDigest: "a".repeat(64), argsDigest: "b".repeat(64),
    phases: [{ title: "plan", ordinal: 0, firstAt: "2026-01-01T00:00:00.100Z" }],
    calls: [{
      id: "inv-0", ordinal: 0, label: "first", phase: "plan", state: "completed", target: "pi", route: { model: "m" },
      jobId: "job-1", sessionId: "s-1", attempts: [{ attempt: 1 }], usageSummary: { costUsd: 1 }, progress: null, error: null,
      value: { finalText: "secret child result" }, fingerprint: "f", deliverySeq: 1,
    }],
    usageTotals: { costUsd: 1 }, progress: { phase: "plan" }, error: null,
    controls: [{ commandId: "c1", action: "pause", state: "applied", requestedAt: "x", updatedAt: "y" }],
    output: "secret output", resumeOf: "dyn-parent", recoveryRequired: true,
  };
  const status = projectStatus(record);
  assert.deepEqual(Object.keys(status).sort(), ["argsDigest", "attempt", "completedAt", "controls", "createdAt", "error", "invocations", "invocationsTotal", "name", "phases", "phasesOmitted", "phasesTotal", "progress", "recoveryRequired", "requestId", "resumeOf", "revision", "runId", "scriptDigest", "startedAt", "state", "updatedAt", "usageTotals"].sort());
  assert.equal(JSON.stringify(status).includes("secret"), false);
  assert.equal(status.invocations[0].attempts, 1);
  assert.deepEqual(Object.keys(status.invocations[0]).sort(), ["attempts", "completedAt", "error", "id", "jobId", "label", "ordinal", "phase", "progress", "route", "sessionId", "startedAt", "state", "target", "usageSummary"].sort());
  const result = projectStatus(record, { includeOutput: true });
  assert.equal(result.output, "secret output");
  const history = projectHistoryRun(record);
  assert.equal(JSON.stringify(history).includes("secret"), false);
  assert.equal(history.counts.completed, 1);
  assert.equal(history.scriptDigest, "a".repeat(64));
});

test("phase timing keeps an uncertain historical attempt in its original phase", () => {
  const timing = { startedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:00:01.000Z" };
  const record = {
    state: "completed",
    phases: ["Draft", { title: "Review", ordinal: 1 }],
    calls: [{
      phase: "Review", state: "completed", uncertain: false,
      attempts: [
        { phase: "Draft", state: "partial", uncertain: true, ...timing },
        { phase: "Review", state: "completed", ...timing },
      ],
    }],
  };
  const [draft, review] = projectStatus(record).phases;
  assert.deepEqual(draft.elapsed, { state: "unknown", ms: null });
  assert.deepEqual(review.elapsed, { state: "settled", ms: 1000 });
  assert.deepEqual(projectStatus(record, { phaseCursor: 0 }).phases, [review]);

  record.calls[0].uncertain = true;
  assert.deepEqual(projectStatus(record, { phaseCursor: 0 }).phases[0].elapsed, { state: "unknown", ms: null });
});

test("assertDynamicLeaf rejects workflow smuggling", () => {
  const request = { target: "pi", route: {}, policy: { write: false, tools: [], maxCostUsd: null }, workflow: "evil" };
  assert.throws(() => assertDynamicLeaf(request), /cannot set a workflow/);
  assert.doesNotThrow(() => assertDynamicLeaf({ ...request, workflow: null }));
});

test("agent execution accepts session transport and rejects unknown modes", async (t) => {
  const root = await tmp(t);
  const spec = await normalizeDynamicSpec({ requestId: "r1", source, cwd: root });
  const session = await normalizeAgentOptions("p", { execution: { transport: "session" } }, { ordinal: 0, root: spec });
  assert.equal(session.execution.transport, "session");
  const oneShot = await normalizeAgentOptions("p", { execution: { transport: "oneshot" } }, { ordinal: 0, root: spec });
  assert.equal(oneShot.execution.transport, "oneshot");
  assert.equal((await normalizeAgentOptions("p", undefined, { ordinal: 0, root: spec })).execution.transport, null);
  await assert.rejects(() => normalizeAgentOptions("p", { execution: { transport: "one-shot" } }, { ordinal: 0, root: spec }), /session or oneshot/);
  await assert.rejects(() => normalizeAgentOptions("p", { execution: { transport: "stream" } }, { ordinal: 0, root: spec }), /session or oneshot/);
});

test("schema contradictions consult patternProperties and reject unsatisfiable bounds", async () => {
  assert.deepEqual(
    normalizeSchema({ type: "object", additionalProperties: false, properties: {}, patternProperties: { "^a$": { type: "number" } }, required: ["a"] }),
    { type: "object", additionalProperties: false, properties: {}, patternProperties: { "^a$": { type: "number" } }, required: ["a"] },
  );
  assert.throws(() => normalizeSchema({ type: "object", additionalProperties: false, properties: {}, required: ["a"] }), /matching patternProperties/);
  assert.throws(() => normalizeSchema({ minimum: 5, maximum: 1 }), /minimum \(5\) exceeds schema\.maximum \(1\)/);
  assert.throws(() => normalizeSchema({ minLength: 4, maxLength: 1 }), /minLength/);
  assert.throws(() => normalizeSchema({ minItems: 3, maxItems: 2 }), /minItems/);
  assert.throws(() => normalizeSchema({ exclusiveMinimum: 2, exclusiveMaximum: 2 }), /exclusiveMinimum/);
  assert.throws(() => normalizeSchema(false), /false schema/);
  assert.throws(() => normalizeSchema({ enum: [] }), /enum is empty/);
  assert.throws(() => normalizeSchema({ not: {} }), /can never be satisfied/);
  assert.equal(normalizeSchema(true), true);
});

test("control identity is stable and content-sensitive", () => {
  const a = controlIdentity({ action: "steer", invocationId: "inv-0", message: "go" });
  assert.equal(a, controlIdentity({ action: "steer", invocationId: "inv-0", message: "go" }));
  assert.notEqual(a, controlIdentity({ action: "steer", invocationId: "inv-0", message: "stop" }));
});

test("dynamicError carries a kind and extra details", () => {
  const error = dynamicError("policy", "nope", { hint: "x" });
  assert.equal(error.details.kind, "policy");
  assert.equal(error.details.hint, "x");
});
