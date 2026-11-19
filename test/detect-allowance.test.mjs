// Allowance auto-detection: parse rules, headroom math, provenance, apply.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const {
  applyAutoHeadroom,
  detectAllowance,
  piHeadroom,
  subsidySuggestions,
} = await import("../scripts/detect-allowance.mjs");

function mockRun(outputs) {
  return async (command, args) => {
    const key = `${command} ${args.join(" ")}`;
    if (!(key in outputs)) return { ok: false, stdout: "", error: "spawn ENOENT" };
    const value = outputs[key];
    if (typeof value === "string") return { ok: true, stdout: value };
    return value;
  };
}

const PI_READY = {
  "pi auth check --provider anthropic --json --no-refresh": JSON.stringify({ status: "ready", provider: "anthropic", authType: "oauth" }),
  "pi auth check --provider openrouter --json --no-refresh": JSON.stringify({ status: "ready", provider: "openrouter", authType: "api_key" }),
  "pi auth check --provider openai-codex --json --no-refresh": JSON.stringify({ status: "ready", provider: "openai-codex", authType: "oauth" }),
  "pi auth check --provider deepseek --json --no-refresh": JSON.stringify({ status: "not_ready", provider: "deepseek", reason: "credentials_not_configured" }),
  "pi auth check --provider openai --json --no-refresh": JSON.stringify({ status: "not_ready", provider: "openai", reason: "credentials_not_configured" }),
};

const UNKNOWN_CODEX_QUOTA = async () => ({
  status: "unknown",
  source: "codex app-server account/rateLimits/read",
  observedAt: 1,
  reason: "fixture",
});

test("parses subscription logins and pi provider readiness", async () => {
  const detection = await detectAllowance(mockRun({
    "codex login status": "Logged in using ChatGPT\n",
    "cursor status": "✓ Logged in as someone@example.com\n",
    ...PI_READY,
  }), { codexQuotaProbe: async () => ({
    status: "available",
    source: "codex app-server account/rateLimits/read",
    observedAt: 1,
    ordinaryUsageAllowed: true,
    limitId: "codex",
    headroom: 0.76,
    usedPercent: 24,
    windowDurationMins: 10080,
    resetsAt: 1_791_454_018,
    windows: [],
  }) });
  assert.equal(detection.codex.auth, "chatgpt");
  assert.equal(detection.cursor.auth, "subscription");
  assert.equal(detection.pi.providers.anthropic.ready, true);
  assert.equal(detection.pi.providers.anthropic.authType, "oauth");
  assert.equal(detection.pi.providers.deepseek.ready, false);
  assert.equal(detection.codex.quota.headroom, 0.76);
  assert.equal(detection.claude.signal, "none");
  assert.equal(detection.opencode.signal, "none");
  assert.equal(detection.amp.signal, "none");
  assert.match(detection.amp.note, /unknown/);
});

test("absent CLIs degrade to unknown, never to ready", async () => {
  const detection = await detectAllowance(mockRun({}), { codexQuotaProbe: UNKNOWN_CODEX_QUOTA });
  assert.equal(detection.codex.auth, "unknown");
  assert.equal(detection.cursor.auth, "unknown");
  assert.equal(detection.codex.quota.status, "unknown");
  assert.deepEqual(
    Object.values(detection.pi.providers).map((p) => p.ready),
    [false, false, false, false, false],
  );
  // Failed probes count as down (silence reads as zero, never neutral).
  assert.deepEqual(
    Object.values(detection.pi.providers).map((p) => p.reason),
    ["probe-failed", "probe-failed", "probe-failed", "probe-failed", "probe-failed"],
  );
});

test("auth readiness never becomes quota headroom, even for known providers", () => {
  const detection = {
    pi: { providers: {
      openrouter: { ready: true, authType: "api_key" },
      deepseek: { ready: false },
      anthropic: { ready: false, reason: "unparseable" },
    } },
  };
  const policy = { candidates: [{ id: "auto-pi", target: "pi", route: { provider: "openrouter", model: "m" } }] };
  assert.equal(piHeadroom(detection, policy), null);
  const mixed = { candidates: [
    { id: "auto-pi", target: "pi", route: { provider: "openrouter", model: "m" } },
    { id: "x", target: "pi", route: { provider: "deepseek", model: "m" } },
  ] };
  assert.equal(piHeadroom(detection, mixed), null);
  // Unparseable-only references: no signal, skip rather than zero.
  const unknownOnly = { candidates: [{ id: "auto-pi", target: "pi", route: { provider: "anthropic", model: "m" } }] };
  assert.equal(piHeadroom(detection, unknownOnly), null);
  // No pi lanes at all: nothing to apply.
  assert.equal(piHeadroom(detection, { candidates: [] }), null);
});

test("subsidy suggestions fire only for unrecorded subscription logins", () => {
  const detection = { codex: { auth: "chatgpt" }, cursor: { auth: "subscription" } };
  const fresh = subsidySuggestions(detection, { subscriptions: {} });
  assert.equal(fresh.length, 2);
  assert.ok(fresh[0].includes("subscriptions.codex"));
  const recorded = subsidySuggestions(detection, {
    subscriptions: { codex: { plan: "chatgpt", subsidy: 1 }, cursor: { plan: "sub", subsidy: 1 } },
  });
  assert.deepEqual(recorded, []);
  const api = subsidySuggestions({ codex: { auth: "none" }, cursor: { auth: "unknown" } }, {});
  assert.deepEqual(api, []);
});

test("apply refuses invented headroom and preserves policy byte-for-byte", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harnest-allowance-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "routing.json");
  await writeFile(path, JSON.stringify({ candidates: [{ id: "auto-pi", target: "pi" }] }));
  const first = await applyAutoHeadroom({ policyPath: path, detection: {}, headroom: 0.5 });
  assert.equal(first.applied, false);
  const written = JSON.parse(await readFile(path, "utf8"));
  assert.equal(written.candidates[0].health, undefined);
  // Manual entry is sacred.
  written.candidates[0].health = { status: "healthy", headroom: 0.2, source: "manual" };
  await writeFile(path, JSON.stringify(written));
  const second = await applyAutoHeadroom({ policyPath: path, detection: {}, headroom: 1 });
  assert.equal(second.applied, false);
  assert.match(second.reason, /manual/);
  assert.equal(JSON.parse(await readFile(path, "utf8")).candidates[0].health.headroom, 0.2);
});

test("failed auth cannot invent exhausted quota either", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harnest-allowance-zero-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "routing.json");
  await writeFile(path, JSON.stringify({ candidates: [{ id: "auto-pi", target: "pi" }] }));
  const result = await applyAutoHeadroom({ policyPath: path, detection: {}, headroom: 0 });
  assert.equal(result.applied, false);
  const written = JSON.parse(await readFile(path, "utf8"));
  assert.equal(written.candidates[0].health, undefined);
});
