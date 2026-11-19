import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createReceipt, digestContext, normalizeRequest, terminalReceipt } from "../src/protocol.mjs";
import { MAX_ATTACHMENT_BYTES } from "../src/execution-controls.mjs";

test("execution controls validate paths, limits, targets, transport, and write scope", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harnest-controls-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "work");
  const extra = join(root, "extra");
  await Promise.all([mkdir(cwd), mkdir(extra)]);
  const alias = join(cwd, "linked-extra");
  await symlink(extra, alias, process.platform === "win32" ? "junction" : "dir");
  const file = join(root, "input.png");
  const oversized = join(root, "large.png");
  await Promise.all([writeFile(file, "image"), writeFile(oversized, Buffer.alloc(MAX_ATTACHMENT_BYTES + 1))]);
  const base = { requestId: "execution-controls", target: "claude", task: "test", cwd };
  const check = (execution, overrides = {}) => normalizeRequest({ ...base, ...overrides, execution });
  const approved = { policy: { write: true }, metadata: { harnest: { writeApproved: true } } };

  assert.deepEqual(check({ addDirs: [alias], maxTurns: 3, instructions: "guide" }).execution.addDirs, [await realpath(extra)]);
  assert.deepEqual(check({ addDirs: [alias] }, approved).execution.addDirs, [await realpath(extra)]);
  assert.throws(() => check({ addDirs: [alias] }, { policy: { write: true } }), /external write roots require/);
  assert.throws(() => check({ addDirs: [extra] }, { target: "codex" }), /requires policy\.write=true/);
  assert.throws(() => check({ addDirs: [extra] }, { target: "pi" }), /execution\.addDirs is unsupported/);
  assert.throws(() => check({ addDirs: Array(9).fill(extra) }), /at most 8/);
  assert.throws(() => check({ addDirs: ["relative"] }), /absolute paths/);
  assert.throws(() => check({ addDirs: [file] }), /existing directory/);
  assert.throws(() => check({ addDirs: [join(root, "missing")] }), /existing directory/);

  const image = (path) => ({ type: "image", path });
  const attach = (path) => ({ attachments: [image(path)] });
  const codex = { target: "codex" };
  assert.deepEqual(check(attach(file), codex).execution.attachments, [image(await realpath(file))]);
  assert.throws(() => check(attach(file)), /execution\.attachments is unsupported/);
  assert.throws(() => check(attach("relative.png"), codex), /absolute paths/);
  assert.throws(() => check(attach(extra), codex), /regular file/);
  assert.throws(() => check(attach(join(root, "missing.png")), codex), /existing file/);
  assert.throws(() => check(attach(oversized), codex), /at most 262144 bytes/);
  assert.throws(() => check({ attachments: Array(5).fill(image(file)) }, codex), /at most 4/);
  assert.throws(() => check({ attachments: [{ type: "file", path: file }] }, codex), /only image/);
  assert.throws(() => check({ attachments: [{ type: "file", path: file }] }, { target: "pi" }), /only image/);

  assert.throws(() => check({ instructions: "é".repeat(4001) }), /8000 UTF-8 bytes/);
  assert.throws(() => check({ instructions: "guide" }, codex), /execution\.instructions is unsupported/);
  assert.throws(() => check({ sessionAction: "fork" }), /requires an explicit sessionId/);
  assert.throws(() => check({ sessionAction: "fork", sessionId: "old" }, { target: "cursor" }), /execution\.sessionAction is unsupported/);
  assert.equal(check({ sessionAction: "resume", sessionId: "old" }, { target: "cursor" }).execution.sessionAction, "resume");
  assert.throws(() => check({ sessionAction: "fork", sessionId: "old", transport: "session" }), /unsupported.*session transport/);
  assert.throws(() => check({ maxTurns: 1.5 }), /positive safe integer/);
  assert.throws(() => check({ maxTurns: 1 }, { target: "pi" }), /execution\.maxTurns is unsupported/);
});

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

test("normalization rejects unsupported route and policy keys with the accepted contract", () => {
  const base = { requestId: "strict-request-fields", target: "pi", task: "test", cwd: process.cwd() };
  assert.throws(
    () => normalizeRequest({ ...base, route: { reasoningEffort: "xhigh" } }),
    /route\.reasoningEffort is unsupported; expected one of provider, model, agent, variant, thinking, harnessVersion, serverUrl/,
  );
  assert.throws(
    () => normalizeRequest({ ...base, policy: { permissions: "write" } }),
    /policy\.permissions is unsupported; expected one of write, readOnly, allowWrites, tools, maxCostUsd/,
  );
});

test("native route fields reject unsupported targets, transports and values", () => {
  const base = { requestId: "native-route-controls", task: "test", cwd: process.cwd() };
  for (const [target, route, execution, expected] of [
    ["pi", { serviceTier: "fast" }, {}, /route\.serviceTier requires/],
    ["claude", { serviceTier: "flex" }, {}, /route\.serviceTier for claude must be fast/],
    ["codex", { serviceTier: "unknown" }, {}, /route\.serviceTier for codex/],
    ["codex", { profile: "../review" }, {}, /route\.profile must be a Codex config profile name/],
    ["codex", { profile: "review" }, { transport: "session" }, /route\.profile requires Codex one-shot/],
    ["codex", { serviceTier: "fast" }, { transport: "session" }, /route\.serviceTier requires/],
    ["claude", { agent: "reviewer" }, { transport: "session" }, /route\.agent requires Claude one-shot/],
    ["claude", { agent: "reviewer" }, { transport: "session", sessionAction: "fork", sessionId: "prior" }, /route\.agent requires Claude one-shot/],
    ["claude", { profile: "review" }, {}, /route\.profile requires Codex one-shot/],
    ["opencode", { options: {} }, {}, /route\.options requires a registered ACP agent/],
  ]) {
    assert.throws(() => normalizeRequest({ ...base, target, route, execution }), expected);
  }
});

test("ACP route options validate their shape, keys, and size", () => {
  const base = { requestId: "acp-options-bounds", target: "acp", task: "test", cwd: process.cwd(), policy: { write: true } };
  const normalize = (options) => normalizeRequest({ ...base, route: { agent: "fixture", options } }).route.options;
  assert.deepEqual(normalize({ speed: "slow", review: false }), { speed: "slow", review: false });
  for (const options of [
    null, [], { flag: 1 }, { flag: "x".repeat(257) }, { " ": true },
    { ["x".repeat(129)]: true }, JSON.parse('{"__proto__":true}'),
    Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`option-${index}`, true])),
  ]) {
    assert.throws(() => normalize(options), /route\.options/);
  }
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
