// Model catalog discovery: strict parsers, env/config launch, bounded
// timeouts, generic reasons, fake-spawned processes (incl. real app-server
// framing), cache/backoff scoping. No real harness is ever spawned.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  CLAUDE_MANAGED_ALIASES,
  KNOWN_THINKING_LEVELS,
  createModelCatalog,
  parseCodexModelList,
  parseCursorListModels,
  parseOpencodeApiModels,
  parseOpencodeModels,
  parsePiListModels,
  runCodexMetadata,
} from "../src/model-catalog.mjs";

const PI_TABLE = `provider      model              context  max-out  thinking  images
openai-codex  gpt-5.6-sol        272K     128K     yes       yes
opencode-go   deepseek-v4-flash  1M       384K     no        no`;

const PI_BANNER = `Fetching models...
Sign in with \`pi auth login\` first.
provider      model              context  max-out  thinking  images
openai-codex  gpt-5.6-sol        272K     128K     yes       yes`;

const CURSOR_LINES = `Available models
auto - Auto (default)
gpt-5.6-sol-high - GPT-5.6 Sol 1M High
composer-2.5-fast - Composer 2.5 Fast
Run with --verbose for details (not a model)`;

const OC_CLI = `openai/gpt-5.6-sol
Signing in, please wait...
opencode/muse-spark-1.3-contributor-free
Available models
bare-without-provider
/trailing
`;

const OPENCODE_API = {
  data: [
    { id: "gpt-5.6-sol", modelID: "gpt-5.6-sol", providerID: "openai", variants: [{ id: "none" }, { id: "low" }, { id: "high" }], cost: [{ input: 5, output: 30, cache: { read: 1, write: 1 } }], status: "active", enabled: true },
    { id: "gpt-5.6-sol-fast", modelID: "gpt-5.6-sol", providerID: "openai", variants: [{ id: "low" }, { id: "turbo" }], cost: [], status: "active", enabled: true },
    { id: "muse-spark-1.3-contributor-free", modelID: "muse-spark-1.3-contributor-free", providerID: "opencode", variants: [{ id: "minimal" }, { id: "xhigh" }], cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }], status: "active", enabled: true },
    { id: "tiered-only", modelID: "tiered-only", providerID: "openai", variants: [], cost: [{ tier: { type: "context", size: 1 }, input: 2, output: 3, cache: { read: 0, write: 0 } }], status: "active", enabled: true },
    { id: "old-model", modelID: "old-model", providerID: "openai", variants: [], cost: [], status: "deprecated", enabled: true },
    { id: "off-model", modelID: "off-model", providerID: "openai", variants: [], cost: [], status: "active", enabled: false },
    { id: "openai/embedded-prefix", modelID: "embedded-prefix", providerID: "openai", variants: [], cost: [], status: "active", enabled: true },
    { id: "has spaces", modelID: "x", providerID: "openai", variants: [], cost: [], status: "active", enabled: true },
  ],
};

function fakeProbe(handlers) {
  const calls = [];
  const probe = async (spec) => {
    calls.push(spec);
    if (spec.target === "opencode" && spec.args.at(-1) === "--version") return { status: 0, stdout: "opencode v2.2.1" };
    const handler = handlers[spec.target];
    if (!handler) throw new Error(`no fake for ${spec.target}`);
    return typeof handler === "function" ? handler(spec, calls.length) : handler;
  };
  probe.calls = calls;
  return probe;
}

// --- strict parsers ----------------------------------------------------------

test("opencode api: bare ids, provider separate, alias + variant thinking kept", () => {
  const models = parseOpencodeApiModels(OPENCODE_API);
  assert.deepEqual(models[0], { id: "gpt-5.6-sol", provider: "openai", available: true, cost: { input: 5, output: 30 }, thinking: ["low", "high"] });
  // Selectable catalog alias preserved against modelID; unknown variant dropped.
  assert.deepEqual(models[1], { id: "gpt-5.6-sol-fast", provider: "openai", available: true, alias: "gpt-5.6-sol", thinking: ["low"] });
  assert.deepEqual(models[2].thinking, ["minimal", "xhigh"]);
  assert.deepEqual(models[2].cost, { input: 0, output: 0 });
  assert.ok(!("cost" in models[3]));
  assert.equal(models[4].available, false);
  assert.equal(models[5].available, false);
  // Only an exact provider prefix is stripped.
  assert.deepEqual(models[6], { id: "embedded-prefix", provider: "openai", available: true });
  // Unsafe ids never become rows.
  assert.equal(models.length, 7);
});

test("catalog ids preserve provider namespaces and price tiers cannot look free", () => {
  assert.deepEqual(parseOpencodeModels("openrouter/openai/gpt-6-sol:free\n"), [{ provider: "openrouter", id: "openai/gpt-6-sol:free", available: true }]);
  const models = parseOpencodeApiModels({ data: [{
    id: "gpt-6-sol", modelID: "gpt-6-sol", providerID: "openai", enabled: true,
    cost: [{ input: 0, output: 0 }, { tier: { type: "context", size: 100000 }, input: 1, output: 2 }],
  }] });
  assert.equal(models[0].cost, undefined, "zero base price is not proof that all context tiers are free");
});

test("opencode CLI: provider/model split; banners rejected", () => {
  const models = parseOpencodeModels(OC_CLI);
  assert.deepEqual(models, [
    { id: "gpt-5.6-sol", provider: "openai", available: true },
    { id: "muse-spark-1.3-contributor-free", provider: "opencode", available: true },
  ]);
});

test("pi table: header required; short and unsafe rows skipped", () => {
  assert.deepEqual(parsePiListModels("Sign in first\n"), []);
  assert.deepEqual(parsePiListModels(`${PI_TABLE.split("\n")[0]}\nshort row\nopenai-codex  gpt-5.6-sol  272K  128K  yes  yes`).map((entry) => entry.id), ["gpt-5.6-sol"]);
  const models = parsePiListModels(PI_TABLE);
  assert.deepEqual(models[0], { id: "gpt-5.6-sol", provider: "openai-codex", available: true, thinking: [...KNOWN_THINKING_LEVELS] });
  assert.ok(!("thinking" in models[1]));
  assert.deepEqual(parsePiListModels(PI_BANNER).map((entry) => entry.id), ["gpt-5.6-sol"]);
});

test("cursor parse: safe ids only, effort suffixes and auto preserved", () => {
  assert.deepEqual(
    parseCursorListModels(CURSOR_LINES).map((entry) => entry.id),
    ["auto", "gpt-5.6-sol-high", "composer-2.5-fast"],
  );
});

test("codex entries: hidden unavailable, efforts filtered, unsafe rejected", () => {
  const models = parseCodexModelList([
    { id: "gpt-5.6-sol", model: "gpt-5.6-sol", hidden: false, supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "none" }, { reasoningEffort: "turbo" }] },
    { id: "old-hidden", hidden: true, supportedReasoningEfforts: [] },
    { id: "has spaces", hidden: false },
  ]);
  assert.deepEqual(models[0], { id: "gpt-5.6-sol", available: true, thinking: ["low"] });
  assert.deepEqual(models[1], { id: "old-hidden", available: false });
  assert.equal(models.length, 2);
  assert.ok(!("provider" in models[0]));
});

test("OpenCode catalog uses the same V2 override for omitted and explicit versions", async () => {
  const probe = fakeProbe({
    opencode: { status: 0, stdout: JSON.stringify({ data: [] }), stderr: "" },
    pi: { status: 0, stdout: PI_TABLE, stderr: "" },
  });
  const fromEnv = createModelCatalog({ probe, env: { HARNEST_OPENCODE_V2: "oc2-fake" } });
  const automatic = await fromEnv({ target: "opencode" });
  const explicit = await fromEnv({ target: "opencode", route: { harnessVersion: "v2" } });
  assert.equal(explicit, automatic);
  assert.equal(automatic.source, "opencode api model.list");
  assert.deepEqual(probe.calls.map(({ command, args }) => [command, args]), [
    ["oc2-fake", ["--version"]], ["oc2-fake", ["api", "model.list"]],
  ]);

  const fromConfig = createModelCatalog({ probe, env: {}, config: { executables: { opencode2: "oc2-config", pi: "pi-fake" } } });
  await fromConfig({ target: "opencode" });
  assert.equal(probe.calls.at(-1).command, "oc2-config");
  await fromConfig({ target: "pi" });
  assert.equal(probe.calls.at(-1).command, "pi-fake");
});

test("catalog rejects a V1 route and never requests metadata from a V1 binary", async () => {
  const calls = [];
  const catalog = createModelCatalog({ probe: async ({ args }) => {
    calls.push(args);
    return { status: 0, stdout: "1.18.18" };
  } });
  assert.equal((await catalog({ target: "opencode", route: { harnessVersion: "v1" } })).reason, "opencode:v2-required");
  assert.deepEqual(calls, []);
  assert.equal((await catalog({ target: "opencode" })).reason, "opencode:v2-required");
  assert.deepEqual(calls.map((args) => args.at(-1)), ["--version"]);
  assert.equal((await catalog({ target: "dsh" })).reason, "catalog:unsupported-target");
});

// --- bounded total timeout, generic reasons -----------------------------------

test("an error shaped like a reason code cannot expose arbitrary subprocess text", async () => {
  const catalog = createModelCatalog({ probe: async () => { throw new Error("pi:private-diagnostic-text"); } });
  const result = await catalog({ target: "pi" });
  assert.equal(result.reason, "pi:probe-failed");
  assert.ok(!JSON.stringify(result).includes("private-diagnostic-text"));
});

test("version, API, and CLI share one total timeout budget", async () => {
  const seen = [];
  const probe = async (spec) => {
    seen.push({ args: spec.args, timeoutMs: spec.timeoutMs });
    if (spec.args.at(-1) === "--version") return { status: 0, stdout: "2.2.1" };
    if (spec.args.includes("api")) {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return { status: 1 };
    }
    return { status: 0, stdout: "openai/gpt-5.6-sol\n" };
  };
  const getCatalog = createModelCatalog({ probe, env: { HARNEST_OPENCODE_V2: "oc-fake" }, timeoutMs: 5000 });
  const result = await getCatalog({ target: "opencode" });
  assert.equal(result.source, "opencode models");
  assert.equal(seen[0].timeoutMs, 5000);
  assert.ok(seen[2].timeoutMs < seen[1].timeoutMs && seen[2].timeoutMs > 0);
});

test("failures are generic codes; stderr never leaks", async () => {
  const probe = fakeProbe({
    pi: { status: 1, stdout: "", stderr: "login failed for SECRET-abc-123" },
  });
  const getCatalog = createModelCatalog({ probe });
  const result = await getCatalog({ target: "pi" });
  assert.equal(result.status, "unavailable");
  assert.deepEqual(result.models, []);
  assert.equal(result.reason, "pi:exit-1");
});

test("first failure is unavailable, never a hollow stale shell", async () => {
  let count = 0;
  const probe = async () => {
    count++;
    throw new Error("raw process boom (must not surface)");
  };
  let timestamp = 2_000_000;
  const getCatalog = createModelCatalog({ probe, now: () => timestamp });
  const first = await getCatalog({ target: "cursor" });
  assert.equal(first.status, "unavailable");
  assert.deepEqual(first.models, []);
  assert.equal(first.reason, "cursor:probe-failed");
  // Backoff: no re-probe inside the retry window.
  const second = await getCatalog({ target: "cursor" });
  assert.equal(second.status, "unavailable");
  assert.equal(count, 1);
});

test("stale served only after success, then recovery", async () => {
  let mode = "ok";
  let count = 0;
  const probe = async () => {
    count++;
    if (mode === "ok") return { status: 0, stdout: PI_TABLE, stderr: "" };
    throw new Error("raw failure text");
  };
  let timestamp = 3_000_000;
  const getCatalog = createModelCatalog({ probe, now: () => timestamp, ttlMs: 1000, retryMs: 60_000 });
  const fresh = await getCatalog({ target: "pi" });
  assert.equal(fresh.status, "available");
  assert.equal(fresh.source, "pi --list-models");

  timestamp += 1001;
  mode = "bad";
  const stale = await getCatalog({ target: "pi" });
  assert.equal(stale.status, "stale");
  assert.equal(stale.models.length, 2);
  assert.equal(stale.source, "pi --list-models");
  assert.equal(stale.reason, "pi:probe-failed");

  timestamp += 60_001;
  mode = "ok";
  const recovered = await getCatalog({ target: "pi" });
  assert.equal(recovered.status, "available");
  assert.equal(count, 3);
});

test("codex custom provider is unsupported without probing", async () => {
  let probed = false;
  const getCatalog = createModelCatalog({ probe: async () => { probed = true; throw new Error("nope"); } });
  const result = await getCatalog({ target: "codex", route: { provider: "openrouter" } });
  assert.equal(probed, false);
  assert.equal(result.status, "unavailable");
  assert.equal(result.reason, "codex:unsupported-provider");
});

test("row cap bounds untrusted catalog data", async () => {
  const big = Array.from({ length: 5000 }, (_, index) => `openai/model-${index}`).join("\n");
  const capped = createModelCatalog({
    probe: async ({ args }) => ({ status: 0, stdout: args.at(-1) === "--version" ? "2.2.1" : big, stderr: "" }),
    env: { HARNEST_OPENCODE_V2: "oc-fake" },
    maxRows: 10,
  });
  const rows = await capped({ target: "opencode", cwd: "rows" });
  assert.equal(rows.models.length, 10);
});

// --- fake spawned processes: real framing, no harness -------------------------

function fakeChild(script) {
  const child = new EventEmitter();
  const writes = [];
  child.stdin = {
    write: (chunk) => {
      writes.push(String(chunk));
      script.onWrite?.(String(chunk));
      return true;
    },
    end: () => {},
    on: () => {},
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {
    if (child.killed) return;
    child.killed = true;
    // Real children emit close after kill; the fake does too so tests never
    // wait out the graceful-close grace period.
    queueMicrotask(() => child.emit("close", 0));
  };
  child.writes = writes;
  child.serverSend = (text) => child.stdout.emit("data", Buffer.from(text));
  child.serverClose = (code = 0) => child.emit("close", code);
  child.methods = () => writes.map((text) => {
    try { return JSON.parse(text).method ?? null; } catch { return null; }
  });
  queueMicrotask(() => script.onSpawn?.(child));
  return child;
}

function codexSpawnFn(pages, hooks = {}) {
  // Returns { spawnFn, children } where the fake server answers initialize and
  // serves model/list pages, recording every client method.
  const children = [];
  let malformedSent = false;
  const spawnFn = (command, args, opts) => {
    const child = fakeChild({});
    children.push(child);
    if (hooks.onSpawn) hooks.onSpawn(child);
    const originalWrite = child.stdin.write;
    child.stdin.write = (chunk) => {
      const text = String(chunk);
      child.writes.push(text);
      let frame;
      try { frame = JSON.parse(text); } catch { return true; }
      queueMicrotask(() => {
        if (hooks.onFrame) hooks.onFrame(frame, child);
        if (frame.method === "initialize") {
          child.serverSend(`${JSON.stringify({ id: frame.id, result: {} })}\n`);
        } else if (frame.method === "model/list") {
          if (hooks.modelList) {
            hooks.modelList(frame, child);
            return;
          }
          if (malformedFirst(hooks) && !malformedSent) {
            malformedSent = true;
            child.serverSend("not json at all\n");
          }
          const page = frame.params?.cursor ? pages[1] : pages[0];
          child.serverSend(`${JSON.stringify({ id: frame.id, result: page })}\n`);
        }
      });
      return true;
    };
    return child;
  };
  const malformedFirst = (options) => options.malformedFirst === true;
  return { spawnFn, children };
}

const PAGE_1 = { data: [{ id: "gpt-5.6-sol", model: "gpt-5.6-sol", hidden: false, supportedReasoningEfforts: [{ reasoningEffort: "low" }] }], nextCursor: "c1" };
const PAGE_2 = { data: [{ id: "old-hidden", model: "old-hidden", hidden: true, supportedReasoningEfforts: [] }], nextCursor: null };

test("codex rpc paginates a fake process with no threads", async () => {
  const { spawnFn, children } = codexSpawnFn([PAGE_1, PAGE_2]);
  const getCatalog = createModelCatalog({ spawnFn, env: {} });
  const result = await getCatalog({ target: "codex" });
  assert.equal(result.source, "codex app-server model/list");
  assert.equal(result.status, "available");
  assert.deepEqual(result.models.map((entry) => entry.id), ["gpt-5.6-sol", "old-hidden"]);
  const child = children[0];
  assert.ok(!child.methods().includes("thread/start"));
  assert.ok(child.methods().includes("initialize"));
  assert.equal(child.methods().filter((method) => method === "model/list").length, 2);
  assert.equal(child.killed, true);
});

test("codex rpc skips malformed lines", async () => {
  const { spawnFn } = codexSpawnFn([PAGE_1, PAGE_2], { malformedFirst: true });
  const getCatalog = createModelCatalog({ spawnFn, env: {} });
  const result = await getCatalog({ target: "codex" });
  assert.equal(result.status, "available");
  assert.equal(result.models.length, 2);
});

test("codex rpc error response is a generic code", async () => {
  const { spawnFn } = codexSpawnFn([PAGE_1, PAGE_2], {
    modelList: (frame, child) => {
      child.serverSend(`${JSON.stringify({ id: frame.id, error: { code: -32000, message: "SECRET boom" } })}\n`);
    },
  });
  const getCatalog = createModelCatalog({ spawnFn, env: {} });
  const result = await getCatalog({ target: "codex" });
  assert.equal(result.status, "unavailable");
  assert.equal(result.reason, "codex:rpc-error");
});

test("codex rpc output overflow kills fast with a generic code", async () => {
  const { spawnFn, children } = codexSpawnFn([PAGE_1, PAGE_2], {
    onFrame: (frame, child) => {
      if (frame.method === "initialize") child.serverSend(`{"id":${frame.id},"result":${JSON.stringify({ padding: "x".repeat(500) })}}\n`);
    },
  });
  const getCatalog = createModelCatalog({ spawnFn, env: {}, maxOutputBytes: 64 });
  const result = await getCatalog({ target: "codex" });
  assert.equal(result.status, "unavailable");
  assert.equal(result.reason, "codex:output-limit");
  assert.equal(children[0].killed, true);
});

test("codex rpc silence hits the deadline", async () => {
  const spawnFn = () => fakeChild({});
  const getCatalog = createModelCatalog({ spawnFn, env: {}, timeoutMs: 50 });
  const result = await getCatalog({ target: "codex" });
  assert.equal(result.status, "unavailable");
  assert.equal(result.reason, "codex:timeout");
});

test("codex rpc rejects success when synchronous spawn exhausts the deadline", async () => {
  let child;
  const spawnFn = () => {
    const spawnDeadline = performance.now() + 35;
    while (performance.now() < spawnDeadline) { /* simulate synchronous spawn delay */ }
    child = fakeChild({
      onWrite(text) {
        const frame = JSON.parse(text);
        if (frame.method === "initialize") child.serverSend(`${JSON.stringify({ id: frame.id, result: {} })}\n`);
        if (frame.method === "account/rateLimits/read") child.serverSend(`${JSON.stringify({ id: frame.id, result: { rateLimits: {} } })}\n`);
      },
    });
    return child;
  };
  const result = await runCodexMetadata({
    command: "fake-codex",
    args: ["app-server"],
    env: {},
    cwd: process.cwd(),
    timeoutMs: 10,
    maxOutputBytes: 1024,
    maxRows: 10,
    method: "account/rateLimits/read",
    spawnFn,
  });
  assert.deepEqual(result, { status: null, code: "timeout" });
  assert.deepEqual(child.methods(), []);
  assert.equal(child.killed, true);
});

test("codex rpc rejects a final response that arrives after the deadline", async () => {
  let child;
  child = fakeChild({
    onWrite(text) {
      const frame = JSON.parse(text);
      if (frame.method === "initialize") child.serverSend(`${JSON.stringify({ id: frame.id, result: {} })}\n`);
      if (frame.method === "account/rateLimits/read") {
        const responseDeadline = performance.now() + 35;
        while (performance.now() < responseDeadline) { /* delay the final response past the deadline */ }
        child.serverSend(`${JSON.stringify({ id: frame.id, result: { rateLimits: {} } })}\n`);
      }
    },
  });
  const result = await runCodexMetadata({
    command: "fake-codex",
    args: ["app-server"],
    env: {},
    cwd: process.cwd(),
    timeoutMs: 10,
    maxOutputBytes: 1024,
    maxRows: 10,
    method: "account/rateLimits/read",
    spawnFn: () => child,
  });
  assert.deepEqual(result, { status: null, code: "timeout" });
  assert.equal(child.methods().filter((method) => method === "account/rateLimits/read").length, 1);
  assert.equal(child.killed, true);
});

test("codex rpc cleanup stays inside the original deadline", async () => {
  const child = fakeChild({});
  child.kill = () => true;
  const started = performance.now();
  const result = await runCodexMetadata({
    command: "fake-codex",
    args: ["app-server"],
    env: {},
    cwd: process.cwd(),
    timeoutMs: 30,
    maxOutputBytes: 1024,
    maxRows: 10,
    spawnFn: () => child,
  });
  const elapsedMs = performance.now() - started;
  assert.deepEqual(result, { status: null, code: "timeout" });
  assert.ok(elapsedMs < 250, `RPC deadline cleanup took ${Math.round(elapsedMs)}ms`);
});

test("codex rpc successful cleanup also stays inside the original deadline", async () => {
  const child = fakeChild({
    onWrite(text) {
      const frame = JSON.parse(text);
      if (frame.method === "initialize") child.serverSend(`${JSON.stringify({ id: frame.id, result: {} })}\n`);
      if (frame.method === "account/rateLimits/read") child.serverSend(`${JSON.stringify({ id: frame.id, result: { rateLimits: {} } })}\n`);
    },
  });
  child.kill = () => true;
  const started = performance.now();
  const result = await runCodexMetadata({
    command: "fake-codex",
    args: ["app-server"],
    env: {},
    cwd: process.cwd(),
    timeoutMs: 50,
    maxOutputBytes: 1024,
    maxRows: 10,
    method: "account/rateLimits/read",
    spawnFn: () => child,
  });
  const elapsedMs = performance.now() - started;
  assert.equal(result.status, 0);
  assert.ok(elapsedMs < 250, `successful RPC cleanup took ${Math.round(elapsedMs)}ms`);
});

test("codex rpc early exit fails closed", async () => {
  const spawnFn = () => {
    const child = fakeChild({});
    queueMicrotask(() => child.serverClose(1));
    return child;
  };
  const getCatalog = createModelCatalog({ spawnFn, env: {} });
  const result = await getCatalog({ target: "codex" });
  assert.equal(result.status, "unavailable");
  assert.equal(result.reason, "codex:closed-early");
});

test("codex spawn and stdin failures fail closed", async () => {
  const throwing = createModelCatalog({ spawnFn: () => { throw new Error("ENOENT SECRET"); }, env: {} });
  const spawnFailed = await throwing({ target: "codex" });
  assert.equal(spawnFailed.reason, "codex:spawn-failed");

  const badStdin = () => {
    const child = fakeChild({});
    child.stdin.write = () => { throw new Error("EPIPE SECRET"); };
    return child;
  };
  const stdinFailed = createModelCatalog({ spawnFn: badStdin, env: {} });
  const result = await stdinFailed({ target: "codex" });
  assert.equal(result.reason, "codex:stdin-error");
});

test("exec child error and secret stderr stay generic", async () => {
  const failing = () => {
    const child = fakeChild({});
    queueMicrotask(() => {
      child.stderr.emit("data", Buffer.from("login failed for SECRET-abc"));
      child.serverClose(1);
    });
    return child;
  };
  const getCatalog = createModelCatalog({ spawnFn: failing, env: {} });
  const result = await getCatalog({ target: "pi" });
  assert.equal(result.status, "unavailable");
  assert.equal(result.reason, "pi:exit-1");

  const erroring = () => {
    const child = fakeChild({});
    queueMicrotask(() => child.emit("error", new Error("spawn ENOENT SECRET")));
    return child;
  };
  const crashed = createModelCatalog({ spawnFn: erroring, env: {} });
  const second = await crashed({ target: "pi" });
  assert.equal(second.reason, "pi:spawn-failed");
});

test("claude returns managed aliases with no probe", async () => {
  let probed = false;
  const getCatalog = createModelCatalog({ probe: async () => { probed = true; throw new Error("must not probe"); } });
  const result = await getCatalog({ target: "claude" });
  assert.equal(probed, false);
  assert.deepEqual(result.models, []);
  assert.deepEqual(result.managed, [...CLAUDE_MANAGED_ALIASES]);
  assert.equal(result.source, "claude:aliases");
  assert.equal(result.status, "available");
});

test("concurrent callers coalesce; TTL expiry refetches", async () => {
  let count = 0;
  const probe = async () => {
    count++;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { status: 0, stdout: JSON.stringify({ data: [] }), stderr: "" };
  };
  let timestamp = 1_000_000;
  const getCatalog = createModelCatalog({ probe, now: () => timestamp, env: { HARNEST_OPENCODE_V2: "oc-fake" } });
  const [first, second] = await Promise.all([getCatalog({ target: "opencode" }), getCatalog({ target: "opencode" })]);
  assert.equal(count, 1);
  assert.equal(second, first);
  timestamp += 3_600_001;
  await getCatalog({ target: "opencode" });
  assert.equal(count, 2);
});

test("Gemini and Amp catalogs are explicitly unavailable without probing or inventing aliases", async () => {
  let probes = 0;
  const getCatalog = createModelCatalog({ probe: async () => { probes += 1; throw new Error("must not probe"); } });
  for (const target of ["gemini", "amp"]) {
    const result = await getCatalog({ target });
    assert.equal(result.status, "unavailable");
    assert.deepEqual(result.models, []);
    assert.equal(result.reason, `${target}:native-catalog-unavailable`);
  }
  assert.equal(probes, 0);
});
