import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  CODEX_QUOTA_SOURCE,
  normalizeCodexQuotaResponse,
  probeCodexQuota,
} from "../src/codex-quota.mjs";

class FakeAppServer extends EventEmitter {
  constructor(onFrame = () => {}) {
    super();
    this.frames = [];
    this.killed = false;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdin = new EventEmitter();
    this.stdin.write = (value) => {
      const frame = JSON.parse(String(value).trim());
      this.frames.push(frame);
      onFrame(frame, this);
      return true;
    };
    this.stdin.end = () => { this.stdinEnded = true; };
  }

  send(frame) {
    queueMicrotask(() => this.stdout.emit("data", Buffer.from(`${JSON.stringify(frame)}\n`)));
  }

  sendRaw(value) {
    queueMicrotask(() => this.stdout.emit("data", Buffer.from(value)));
  }

  kill() {
    if (this.killed) return false;
    this.killed = true;
    queueMicrotask(() => this.emit("close", null, "SIGTERM"));
    return true;
  }
}

function protocolSpawn(result, calls = []) {
  return (command, args, options) => {
    const child = new FakeAppServer((frame, server) => {
      if (frame.method === "initialize") server.send({ id: frame.id, result: { userAgent: "fake" } });
      if (frame.method === "account/rateLimits/read") server.send({ id: frame.id, result });
    });
    calls.push({ command, args, options, child });
    return child;
  };
}

test("normalizes the selected Codex bucket and its constraining window", () => {
  const quota = normalizeCodexQuotaResponse({
    ordinaryUsageAllowed: true,
    rateLimits: {
      limitId: "codex",
      primary: { usedPercent: 24, windowDurationMins: 10080, resetsAt: 1_791_454_018 },
      secondary: { usedPercent: 60, windowDurationMins: 300, resetsAt: 1_791_000_000 },
    },
    rateLimitsByLimitId: {
      unrelated: { limitId: "unrelated", primary: { usedPercent: 100, windowDurationMins: 1, resetsAt: 1 } },
    },
    credits: { balance: 999 },
    accountId: "must-not-escape",
  }, { observedAt: 7 });

  assert.equal(quota.status, "available");
  assert.equal(quota.source, CODEX_QUOTA_SOURCE);
  assert.equal(quota.headroom, 0.4);
  assert.equal(quota.usedPercent, 60);
  assert.equal(quota.resetsAt, 1_791_000_000);
  assert.equal(quota.windows.length, 2);
  const serialized = JSON.stringify(quota);
  assert.ok(!serialized.includes("unrelated"));
  assert.ok(!serialized.includes("must-not-escape"));
  assert.ok(!serialized.includes("balance"));
});

test("uses only the exact Codex multi-bucket fallback", () => {
  const quota = normalizeCodexQuotaResponse({
    ordinaryUsageAllowed: null,
    rateLimitsByLimitId: {
      codex: { limitId: "codex", primary: { usedPercent: 75, windowDurationMins: 300, resetsAt: 50 } },
      "codex-other": { limitId: "codex-other", primary: { usedPercent: 99, windowDurationMins: 60, resetsAt: 40 } },
    },
  }, { observedAt: 8 });
  assert.equal(quota.limitId, "codex");
  assert.equal(quota.usedPercent, 75);
  assert.equal(quota.headroom, 0.25);
  assert.equal(quota.ordinaryUsageAllowed, null);
});

test("ordinary permission remains distinct from percentage headroom", () => {
  const denied = normalizeCodexQuotaResponse({ ordinaryUsageAllowed: false }, { observedAt: 1 });
  assert.equal(denied.status, "available");
  assert.equal(denied.ordinaryUsageAllowed, false);
  assert.equal(denied.headroom, null);

  const percentageOnly = normalizeCodexQuotaResponse({
    ordinaryUsageAllowed: null,
    rateLimits: { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 20 } },
  }, { observedAt: 2 });
  assert.equal(percentageOnly.ordinaryUsageAllowed, null);
  assert.equal(percentageOnly.headroom, 0);
});

test("malformed and empty quota payloads remain unknown", () => {
  for (const payload of [
    null,
    {},
    { rateLimits: {} },
    { rateLimits: { primary: { usedPercent: "95" } } },
    { rateLimits: { primary: { usedPercent: null } } },
    { rateLimits: { primary: { usedPercent: 95, windowDurationMins: 1.5 } } },
    { rateLimits: { primary: { usedPercent: 95, resetsAt: "100" } } },
  ]) {
    const quota = normalizeCodexQuotaResponse(payload, { observedAt: 3 });
    assert.equal(quota.status, "unknown");
    assert.equal(quota.source, CODEX_QUOTA_SOURCE);
  }
});

test("native probe performs only initialize and rateLimits/read", async () => {
  const calls = [];
  const quota = await probeCodexQuota({
    launch: { command: "fake-codex", args: ["--profile", "safe"] },
    spawnFn: protocolSpawn({
      ordinaryUsageAllowed: true,
      rateLimits: { limitId: "codex", primary: { usedPercent: 24, windowDurationMins: 10080, resetsAt: 1_791_454_018 } },
    }, calls),
    timeoutMs: 1000,
    now: () => 9,
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ["--profile", "safe", "app-server"]);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.windowsHide, true);
  assert.deepEqual(calls[0].child.frames.map((frame) => frame.method), [
    "initialize",
    "initialized",
    "account/rateLimits/read",
  ]);
  assert.ok(!calls[0].child.frames.some((frame) => /thread|turn/i.test(frame.method || "")));
  assert.equal(quota.headroom, 0.76);
  assert.equal(quota.observedAt, 9);
});

test("Codex metadata probe clears the cleanup timer when the child closes", async (t) => {
  const timers = t.mock.method(globalThis, "setTimeout");
  const cleared = t.mock.method(globalThis, "clearTimeout");
  const quota = await probeCodexQuota({
    launch: { command: "fake-codex", args: [] },
    spawnFn: protocolSpawn({
      ordinaryUsageAllowed: true,
      rateLimits: { limitId: "codex", primary: { usedPercent: 24, windowDurationMins: 10080, resetsAt: 1_791_454_018 } },
    }),
    timeoutMs: 1_000,
  });
  assert.equal(quota.status, "available");
  assert.equal(timers.mock.calls.length, 2, "the RPC deadline and child cleanup timers were scheduled");
  assert.ok(timers.mock.calls.every(({ result }) => cleared.mock.calls.some((entry) => entry.arguments[0] === result)),
    "both timers must be cleared when cleanup completes");
});

test("native probe rejects success when synchronous spawn exhausts the deadline", async () => {
  let child;
  const quota = await probeCodexQuota({
    launch: { command: "fake-codex", args: [] },
    spawnFn() {
      const spawnDeadline = performance.now() + 35;
      while (performance.now() < spawnDeadline) { /* simulate synchronous spawn delay */ }
      child = new FakeAppServer((frame, server) => {
        if (frame.method === "initialize") server.send({ id: frame.id, result: {} });
        if (frame.method === "account/rateLimits/read") {
          server.send({ id: frame.id, result: {
            ordinaryUsageAllowed: true,
            rateLimits: { limitId: "codex", primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 100 } },
          } });
        }
      });
      return child;
    },
    timeoutMs: 10,
    now: () => 9,
  });
  assert.deepEqual(quota, { status: "unknown", source: CODEX_QUOTA_SOURCE, observedAt: 9, reason: "timeout" });
  assert.deepEqual(child.frames, []);
  assert.equal(child.killed, true);
});

test("native probe rejects a final response that arrives after the deadline", async () => {
  const child = new FakeAppServer((frame, server) => {
    if (frame.method === "initialize") server.send({ id: frame.id, result: {} });
    if (frame.method === "account/rateLimits/read") {
      const responseDeadline = performance.now() + 35;
      while (performance.now() < responseDeadline) { /* delay the final response past the deadline */ }
      server.send({ id: frame.id, result: {
        ordinaryUsageAllowed: true,
        rateLimits: { limitId: "codex", primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 100 } },
      } });
    }
  });
  const quota = await probeCodexQuota({
    launch: { command: "fake-codex", args: [] },
    spawnFn: () => child,
    timeoutMs: 10,
    now: () => 10,
  });
  assert.deepEqual(quota, { status: "unknown", source: CODEX_QUOTA_SOURCE, observedAt: 10, reason: "timeout" });
  assert.equal(child.frames.filter((frame) => frame.method === "account/rateLimits/read").length, 1);
  assert.equal(child.killed, true);
});

test("already-aborted probes return unknown before spawning", async () => {
  const controller = new AbortController();
  controller.abort();
  let spawned = false;
  const quota = await probeCodexQuota({
    launch: { command: "fake-codex", args: [] },
    spawnFn() { spawned = true; throw new Error("must not spawn"); },
    signal: controller.signal,
    now: () => 9,
  });
  assert.equal(spawned, false);
  assert.deepEqual(quota, { status: "unknown", source: CODEX_QUOTA_SOURCE, observedAt: 9, reason: "aborted" });
});

test("RPC auth errors, malformed output, spawn failure, and deadline are safe unknowns", async () => {
  const cases = [
    () => new FakeAppServer((frame, server) => {
      if (frame.method === "initialize") server.send({ id: frame.id, result: {} });
      if (frame.method === "account/rateLimits/read") server.send({ id: frame.id, error: { message: "Bearer secret-value" } });
    }),
    () => new FakeAppServer((frame, server) => {
      if (frame.method === "initialize") server.sendRaw("not-json\n");
    }),
  ];
  for (const childFactory of cases) {
    const quota = await probeCodexQuota({
      launch: { command: "fake-codex", args: [] },
      spawnFn: childFactory,
      timeoutMs: 1000,
      now: () => 10,
    });
    assert.equal(quota.status, "unknown");
    assert.ok(!JSON.stringify(quota).includes("secret-value"));
  }

  const unavailable = await probeCodexQuota({
    launch: { command: "fake-codex", args: [] },
    spawnFn() { throw new Error("spawn failed with secret-value"); },
    now: () => 11,
  });
  assert.deepEqual(unavailable, { status: "unknown", source: CODEX_QUOTA_SOURCE, observedAt: 11, reason: "unavailable" });

  let hanging;
  const timedOut = await probeCodexQuota({
    launch: { command: "fake-codex", args: [] },
    spawnFn() { hanging = new FakeAppServer(); return hanging; },
    timeoutMs: 20,
    now: () => 12,
  });
  assert.equal(timedOut.status, "unknown");
  assert.equal(timedOut.reason, "timeout");
  assert.equal(hanging.killed, true);
});
