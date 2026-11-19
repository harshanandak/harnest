import assert from "node:assert/strict";
import test from "node:test";
import { createReceipt, digestContext, normalizeRequest, terminalReceipt } from "../src/protocol.mjs";

test("context digest is stable across object key order", () => {
  assert.equal(digestContext({ b: 2, a: 1 }), digestContext({ a: 1, b: 2 }));
});

test("normalization rejects a mismatched supplied digest", () => {
  assert.throws(
    () =>
      normalizeRequest({
        requestId: "digest-mismatch-request",
        target: "pi",
        task: "return a canary",
        cwd: process.cwd(),
        context: { canary: "right" },
        contextDigest: "0".repeat(64),
      }),
    /does not match/,
  );
});

test("completed receipt must carry a result", () => {
  const request = normalizeRequest({ requestId: "completed-receipt-request", target: "opencode", task: "test", cwd: process.cwd() });
  const receipt = createReceipt(request);
  assert.throws(() => terminalReceipt(receipt, "completed"), /requires result/);
});

test("normalization requires a caller-owned recovery ID", () => {
  assert.throws(
    () => normalizeRequest({ target: "pi", task: "missing id", cwd: process.cwd() }),
    /requestId is required/,
  );
});

test("policy aliases readOnly/allowWrites are accepted when unambiguous and rejected when contradictory", () => {
  const base = { requestId: "policy-alias-request", target: "pi", task: "test", cwd: process.cwd() };
  // alias-only: readOnly:false => write:true
  assert.equal(normalizeRequest({ ...base, policy: { readOnly: false } }).policy.write, true);
  // alias-only: readOnly:true => write:false
  assert.equal(normalizeRequest({ ...base, policy: { readOnly: true } }).policy.write, false);
  // alias-only: allowWrites:true => write:true
  assert.equal(normalizeRequest({ ...base, policy: { allowWrites: true } }).policy.write, true);
  // alias-only: allowWrites:false => write:false
  assert.equal(normalizeRequest({ ...base, policy: { allowWrites: false } }).policy.write, false);
  // both aliases agreeing => accepted
  assert.equal(normalizeRequest({ ...base, policy: { readOnly: true, allowWrites: false } }).policy.write, false);
  assert.equal(normalizeRequest({ ...base, policy: { readOnly: false, allowWrites: true } }).policy.write, true);
  // alias contradicting explicit write => reject
  assert.throws(() => normalizeRequest({ ...base, policy: { write: true, readOnly: true } }), /contradict/);
  assert.throws(() => normalizeRequest({ ...base, policy: { write: false, allowWrites: true } }), /contradict/);
  assert.throws(() => normalizeRequest({ ...base, policy: { write: true, allowWrites: false } }), /contradict/);
  // contradictory aliases => reject
  assert.throws(() => normalizeRequest({ ...base, policy: { readOnly: true, allowWrites: true } }), /contradict/);
  assert.throws(() => normalizeRequest({ ...base, policy: { readOnly: false, allowWrites: false } }), /contradict/);
});

test("legacy aliases are not silently ignored to read-only", () => {
  const base = { requestId: "policy-alias-not-ignored", target: "opencode", task: "test", cwd: process.cwd(), route: { model: "openai/gpt-test" } };
  const withAlias = normalizeRequest({ ...base, policy: { allowWrites: true, tools: ["write"] } });
  assert.equal(withAlias.policy.write, true, "allowWrites:true must not normalize to read-only");
});

test("explicit tool lists retain their meaning through request normalization", () => {
  const base = { requestId: "policy-tools", target: "claude", task: "test", cwd: process.cwd() };
  const tools = { allow: ["Read", "Glob"], deny: ["Glob", "mcp__server__Tool"] };
  assert.deepEqual(normalizeRequest({ ...base, policy: { tools } }).policy, { write: false, tools, maxCostUsd: null });
  assert.deepEqual(normalizeRequest({ ...base, policy: { tools: { allow: [] } } }).policy.tools, { allow: [] });
  for (const invalidTools of [{}, { allowed: ["Read"] }, { deny: null }, { allow: "Read" }, { deny: ["Bash(*)"] }, { deny: ["Read,Write"] }, { allow: ["--force"] }]) {
    assert.throws(() => normalizeRequest({ ...base, policy: { tools: invalidTools } }), /policy\.tools/);
  }
});

test("Cursor policy controls have strict shapes and reject other targets or session transport", () => {
  const base = { requestId: "cursor-controls", target: "cursor", task: "test", cwd: process.cwd() };
  assert.deepEqual(normalizeRequest({ ...base, policy: { readOnly: true, mode: "plan", sandbox: true } }).policy, {
    write: false, tools: [], mode: "plan", sandbox: true, maxCostUsd: null,
  });
  assert.throws(() => normalizeRequest({ ...base, policy: { mode: "agent" } }), /policy\.mode must be plan/);
  assert.throws(() => normalizeRequest({ ...base, policy: { sandbox: "enabled" } }), /policy\.sandbox must be a boolean/);
  for (const policy of [{ mode: "plan" }, { sandbox: true }]) {
    for (const target of ["claude", "codex", "pi", "opencode", "gemini", "amp", "acp"]) {
      assert.throws(() => normalizeRequest({ ...base, target, policy }), /only by Cursor print mode/);
    }
    assert.throws(() => normalizeRequest({ ...base, execution: { transport: "session" }, policy }), /only by Cursor print mode/);
  }
});

test("normalization rejects unsupported route and policy keys with the accepted contract", () => {
  const base = { requestId: "strict-request-fields", target: "pi", task: "test", cwd: process.cwd() };
  assert.throws(
    () => normalizeRequest({ ...base, route: { reasoningEffort: "xhigh" } }),
    /route\.reasoningEffort is unsupported; expected one of provider, model, agent, variant, thinking, harnessVersion, serverUrl/,
  );
  assert.throws(
    () => normalizeRequest({ ...base, policy: { permissions: "write" } }),
    /policy\.permissions is unsupported; expected one of write, readOnly, allowWrites, tools, maxCostUsd, mode, sandbox/,
  );
});

test("normalization rejects malformed known route and policy values before dispatch", () => {
  const base = { requestId: "strict-request-values", target: "pi", task: "test", cwd: process.cwd() };
  assert.throws(() => normalizeRequest({ ...base, route: { model: 123 } }), /route\.model must be a non-empty string/);
  assert.throws(() => normalizeRequest({ ...base, route: { provider: false } }), /route\.provider must be a non-empty string/);
  assert.throws(() => normalizeRequest({ ...base, route: { thinking: {} } }), /route\.thinking must be a non-empty string or boolean/);
  assert.throws(() => normalizeRequest({ ...base, route: { model: "   " } }), /route\.model must be a non-empty string/);
  assert.throws(() => normalizeRequest({ ...base, route: { provider: "\t" } }), /route\.provider must be a non-empty string/);
  assert.throws(() => normalizeRequest({ ...base, route: { thinking: "  " } }), /route\.thinking must be a non-empty string or boolean/);
  assert.throws(() => normalizeRequest({ ...base, policy: { tools: "shell" } }), /policy\.tools must be an array of non-empty strings/);
  assert.throws(() => normalizeRequest({ ...base, policy: { tools: ["  "] } }), /policy\.tools must be an array of non-empty strings/);
  for (const maxCostUsd of ["free", Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    assert.throws(() => normalizeRequest({ ...base, policy: { maxCostUsd } }), /policy\.maxCostUsd must be a non-negative number/);
  }
  assert.equal(Object.is(normalizeRequest({ ...base, policy: { maxCostUsd: -0 } }).policy.maxCostUsd, -0), true);
});

test("normalization preserves supported server and boolean thinking route fields", () => {
  const request = normalizeRequest({
    requestId: "supported-route-fields",
    target: "opencode",
    task: "test",
    cwd: process.cwd(),
    route: { serverUrl: "http://127.0.0.1:4096", thinking: true },
  });
  assert.deepEqual(request.route, { serverUrl: "http://127.0.0.1:4096", thinking: true });
});

test("normalization accepts only OpenCode harness versions v1 and v2", () => {
  const base = { requestId: "harness-version-contract", target: "opencode", task: "test", cwd: process.cwd() };
  assert.equal(normalizeRequest({ ...base }).route.harnessVersion, undefined);
  assert.equal(normalizeRequest({ ...base, route: { harnessVersion: "v1" } }).route.harnessVersion, "v1");
  assert.equal(normalizeRequest({ ...base, route: { harnessVersion: "v2" } }).route.harnessVersion, "v2");
  for (const harnessVersion of ["v3", "V2", "session", ""]) {
    assert.throws(
      () => normalizeRequest({ ...base, route: { harnessVersion } }),
      /route\.harnessVersion must be v1 or v2/,
    );
  }
});

test("normalization accepts codex target and preserves requestId", () => {
  const req = normalizeRequest({ requestId: "codex-target-request", target: "codex", task: "test codex", cwd: process.cwd(), policy: { write: false } });
  assert.equal(req.target, "codex");
  assert.equal(req.requestId, "codex-target-request");
  const receipt = createReceipt(req);
  assert.equal(receipt.target, "codex");
});

test("normalization rejects dsh with a redirect to pi/opencode", () => {
  assert.throws(() => normalizeRequest({ requestId: "dsh-target-request", target: "dsh", task: "test dsh", cwd: process.cwd(), policy: { write: true } }), /run DeepSeek models via pi or opencode/);
});

test("normalization rejects unknown target", () => {
  assert.throws(() => normalizeRequest({ requestId: "bad-target", target: "unknown", task: "x", cwd: process.cwd() }), /target must be/);
});

test("receipt exposes the bounded routing decision selected before launch", () => {
  const decision = { version: 2, selected: "strong", matchedRules: ["request:quality"] };
  const req = normalizeRequest({
    requestId: "routing-decision-receipt",
    target: "pi",
    task: "test",
    cwd: process.cwd(),
    metadata: { harnest: { routingDecision: decision } },
  });
  assert.deepEqual(createReceipt(req).routingDecision, decision);
});
