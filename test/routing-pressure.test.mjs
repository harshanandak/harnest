// Subscription pressure: headroom-scaled efficiency + set-pressure script.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { normalizeRequest } from "../src/protocol.mjs";
import { resolvePolicyRoute } from "../src/routing-policy.mjs";

const execFileAsync = promisify(execFile);

function request(overrides = {}) {
  return normalizeRequest({
    requestId: "pressure-test",
    target: "pi",
    task: "do the thing",
    cwd: process.cwd(),
    ...overrides,
  });
}

function twinLanes() {
  return [
    { id: "aa", target: "pi", route: {}, scores: { quality: 5, speed: 5, efficiency: 8, reliability: 5 }, capabilities: { readOnly: true, write: true }, tags: [] },
    { id: "bb", target: "cursor", route: {}, scores: { quality: 5, speed: 5, efficiency: 8, reliability: 5 }, capabilities: { readOnly: true, write: true }, tags: [] },
  ];
}

test("pressure 0 halves efficiency, 1 keeps it whole, absent skips", () => {
  const req = request({ metadata: { routing: { mode: "auto" } } });
  const scopes = (lanes) => [{ name: "global", policy: { candidates: lanes } }, { name: "request", policy: req.metadata.routing }];
  const plain = resolvePolicyRoute(req, scopes(twinLanes()), { now: () => 0 });
  const plainEff = plain.explanation.scoreBreakdown.efficiency;
  assert.equal(plainEff, 8 * 3);
  const hot = resolvePolicyRoute(req, scopes(twinLanes().map((c) => c.id === "aa" ? { ...c, health: { status: "healthy", headroom: 0 } } : c)), { now: () => 0 });
  assert.equal(hot.explanation.scoreBreakdown.efficiency, plainEff);
  // aa is pressured: find its lane score via rankedRoutes
  const aaScore = hot.explanation.rankedRoutes.find((r) => r.id === "aa").score;
  const bbScore = hot.explanation.rankedRoutes.find((r) => r.id === "bb").score;
  assert.ok(aaScore < bbScore, "pressured lane must score below its twin");
  assert.equal(hot.explanation.selected, "bb");
});

test("fresh headroom leaves efficiency untouched", () => {
  const req = request({ metadata: { routing: { mode: "auto" } } });
  const lanes = twinLanes().map((c) => ({ ...c, health: { status: "healthy", headroom: 1 } }));
  const decided = resolvePolicyRoute(req, [{ name: "global", policy: { candidates: lanes } }, { name: "request", policy: req.metadata.routing }], { now: () => 0 });
  assert.equal(decided.explanation.scoreBreakdown.efficiency, 8 * 3);
});

test("health provenance (auto/manual) validates; anything else rejects", () => {
  const req = request({ metadata: { routing: { mode: "auto" } } });
  const scopes = (health) => [
    { name: "global", policy: { candidates: [{ ...twinLanes()[0], health }] } },
    { name: "request", policy: req.metadata.routing },
  ];
  for (const source of ["auto", "manual"]) {
    const decided = resolvePolicyRoute(req, scopes({ status: "healthy", headroom: 0.5, source }), { now: () => 0 });
    assert.equal(decided.explanation.selected, "aa");
  }
  assert.throws(
    () => resolvePolicyRoute(req, scopes({ status: "healthy", headroom: 0.5, source: "oracle" }), { now: () => 0 }),
    /health\.source must be auto or manual/,
  );
});

test("subsidy pulls costEff toward free; default is API reality", () => {
  const lanes = () => [
    { id: "pricey", target: "pi", route: {}, scores: { quality: 5, speed: 5, efficiency: 5, reliability: 5 }, model: { intelligence: 5, costEff: 2, decisiveness: 5 }, capabilities: { readOnly: true, write: true } },
    { id: "lean", target: "cursor", route: {}, scores: { quality: 5, speed: 5, efficiency: 5, reliability: 5 }, model: { intelligence: 5, costEff: 9, decisiveness: 5 }, capabilities: { readOnly: true, write: true } },
  ];
  const weights = { quality: 0, speed: 0, efficiency: 10, reliability: 0 };
  const req = request({ metadata: { routing: { mode: "auto" } } });
  const scopes = (list) => [{ name: "global", policy: { candidates: list, weights } }, { name: "request", policy: req.metadata.routing }];
  // API reality (no subsidy): lean wins on sticker.
  assert.equal(resolvePolicyRoute(req, scopes(lanes()), { now: () => 0 }).explanation.selected, "lean");
  // Covered sub: pricey behaves as costEff 10 and wins on reliability-weighted tiebreak of quality/speed.
  const covered = lanes().map((c) => c.id === "pricey" ? { ...c, subsidy: 1 } : c);
  const decided = resolvePolicyRoute(req, scopes(covered), { now: () => 0 });
  assert.equal(decided.explanation.selected, "pricey");
  // Efficiency math (no harness block on these lanes): 0.6*10 + 0.4*5 = 8, x10 weight = 80.
  assert.equal(decided.explanation.scoreBreakdown.efficiency, 80);
});

test("subsidy validates 0..1 and explicit candidate values win over the map", async () => {
  const { expandUserPolicy } = await import("../src/routing-presets.mjs");
  assert.throws(() => expandUserPolicy({ subscriptions: { pi: { subsidy: 2 } } }), /subsidy must be between 0 and 1/);
  assert.throws(() => expandUserPolicy({ subscriptions: { pi: "yes" } }), /must be an object/);
  const expanded = expandUserPolicy({
    models: { cursor: "composer-2.5" },
    subscriptions: { cursor: { plan: "pro", subsidy: 1 }, pi: { subsidy: 0.5 } },
    candidates: [{ id: "auto-cursor", subsidy: 0.25 }],
  });
  assert.ok(!("subscriptions" in expanded) && !("models" in expanded));
  const cursorLanes = expanded.candidates.filter((c) => c.id === "auto-cursor");
  assert.equal(cursorLanes[0].subsidy, 1);
  assert.equal(cursorLanes[1].subsidy, 0.25);
  const pi = expanded.candidates.find((c) => c.id === "auto-pi");
  assert.equal(pi.subsidy, 0.5);
});

test("set-pressure writes overlays, refuses model-less lanes, rejects garbage", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "harnest-pressure-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const out = join(dir, "routing.json");
  await execFileAsync(process.execPath, [
    "scripts/set-pressure.mjs", "--pressure", "cursor=0.3,claude=0.8", "--out", out, "--yes",
  ], { cwd: join(import.meta.dirname, "..") }).then(
    () => { throw new Error("should have refused cursor without models.cursor"); },
    (error) => assert.match(String(error.stderr || error.message), /no generated lane/),
  );
  const { stdout } = await execFileAsync(process.execPath, [
    "scripts/set-pressure.mjs", "--pressure", "pi=0.25", "--out", out, "--yes",
  ], { cwd: join(import.meta.dirname, "..") });
  assert.match(stdout, /pi=0.25/);
  const written = JSON.parse(await readFile(out, "utf8"));
  assert.deepEqual(written.candidates, [{ id: "auto-pi", target: "pi", health: { status: "healthy", headroom: 0.25, source: "manual" } }]);
  written.candidates.push({ id: "auto-amp", target: "amp", route: { variant: "medium" }, capabilities: { readOnly: false, write: true } });
  await writeFile(out, JSON.stringify(written));
  await execFileAsync(process.execPath, [
    "scripts/set-pressure.mjs", "--pressure", "amp=0.4", "--out", out, "--yes",
  ], { cwd: join(import.meta.dirname, "..") });
  const withAmp = JSON.parse(await readFile(out, "utf8"));
  assert.deepEqual(withAmp.candidates.find((candidate) => candidate.id === "auto-amp"), {
    id: "auto-amp", target: "amp", route: { variant: "medium" }, capabilities: { readOnly: false, write: true },
    health: { status: "healthy", headroom: 0.4, source: "manual" },
  });
  await assert.rejects(execFileAsync(process.execPath, [
    "scripts/set-pressure.mjs", "--pressure", "pi=high", "--out", out, "--yes",
  ], { cwd: join(import.meta.dirname, "..") }));
});
