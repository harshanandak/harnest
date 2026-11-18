import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { smokeHarnesses, smokePiCore, smokePiTaskflow, versionOf } from "../scripts/smoke-harnesses.mjs";

test("version probe preserves the real missing executable code and reason", () => {
  assert.throws(() => versionOf("opencode", {
    resolveLaunch: () => ({ command: join(tmpdir(), "missing-harnest-readiness-executable"), args: [] }),
  }), (error) => error.code === "ENOENT" && /ENOENT/.test(error.message) && /spawnSync/.test(error.message));
});

test("readiness reports all current targets after failures, with legacy and Taskflow explicitly optional", async () => {
  const lines = [];
  const called = [];
  const result = await smokeHarnesses({
    versionProbe(target) {
      called.push(target);
      if (["opencode2", "opencode", "claude"].includes(target)) throw Object.assign(new Error("fixture missing"), { code: "ENOENT" });
      return "fixture-version";
    },
    piProbe: async () => { throw new Error("fixture pi core failure"); },
    piTaskflowProbe: async () => {},
    report: (line) => lines.push(line),
  });
  assert.equal(result.ok, false);
  assert.deepEqual(called, ["opencode2", "pi", "cursor", "claude", "codex", "gemini", "amp", "opencode"]);
  assert.deepEqual(result.results.filter((entry) => entry.required).map((entry) => entry.name), ["opencode", "pi", "cursor", "claude", "codex"]);
  assert.ok(lines.some((line) => /target=opencode required=true status=failed.*ENOENT/.test(line)));
  assert.ok(lines.some((line) => /target=opencode-legacy required=false status=optional-unavailable/.test(line)));
  assert.ok(lines.some((line) => /target=pi .*fixture pi core failure/.test(line)));
  assert.ok(lines.some((line) => /target=codex required=true status=ready/.test(line)));
  assert.ok(lines.some((line) => /target=gemini required=false status=ready/.test(line)));
  assert.ok(lines.some((line) => /target=amp required=false status=ready/.test(line)));
  assert.equal(lines.at(-1), "HARNESS_SMOKE_FAILED");
});

test("a missing optional Pi Taskflow capability does not fail ordinary readiness", async () => {
  const lines = [];
  const result = await smokeHarnesses({
    versionProbe: () => "fixture-version",
    piProbe: async () => {},
    piTaskflowProbe: async () => { throw new Error("pi-taskflow is not installed"); },
    report: (line) => lines.push(line),
  });
  assert.equal(result.ok, true);
  assert.equal(result.results.find((entry) => entry.name === "pi").taskflow, "optional-unavailable");
  assert.ok(lines.some((line) => /target=pi-taskflow required=false status=optional-unavailable.*pi-taskflow is not installed/.test(line)));
  assert.ok(lines.some((line) => /target=pi required=true status=ready .*piCore=ready piTaskflow=optional-unavailable/.test(line)));
  assert.equal(lines.at(-1), "HARNESS_SMOKE_OK");
});

test("Pi core readiness does not require the /tf command", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "harnest-readiness-core-"));
  t.after(() => rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  let child;
  let closed = false;
  t.after(() => { if (child && !closed) child.kill("SIGKILL"); });
  await smokePiCore({
    cwd,
    timeoutMs: 3_000,
    cleanupTimeoutMs: 3_000,
    resolveLaunch: () => ({ command: process.execPath, args: [fileURLToPath(new URL("./fixtures/pi-readiness.mjs", import.meta.url)), "missing"] }),
    spawnFn(...args) { child = spawn(...args); child.on("close", () => { closed = true; }); return child; },
  });
  assert.equal(closed, true);
});

test("missing optional legacy OpenCode does not fail healthy current harnesses", async () => {
  let piCalls = 0;
  let taskflowCalls = 0;
  const result = await smokeHarnesses({
    versionProbe(target) {
      if (target === "opencode") throw Object.assign(new Error("missing legacy"), { code: "ENOENT" });
      return "fixture-version";
    },
    piProbe: async () => { piCalls += 1; },
    piTaskflowProbe: async () => { taskflowCalls += 1; },
    report() {},
  });
  assert.equal(result.ok, true);
  assert.equal(piCalls, 1);
  assert.equal(taskflowCalls, 1);
  assert.equal(result.results.filter((entry) => entry.ok && entry.required).length, 5);
});

for (const mode of ["ready", "missing", "hang", "exit"]) {
  test(`Pi readiness waits for process cleanup (${mode})`, { timeout: 10_000 }, async (t) => {
    const cwd = await mkdtemp(join(tmpdir(), "harnest-readiness-"));
    t.after(() => rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
    let child;
    let closed = false;
    const probe = smokePiTaskflow({
      cwd,
      timeoutMs: mode === "hang" ? 300 : 3_000,
      cleanupTimeoutMs: 3_000,
      resolveLaunch: () => ({ command: process.execPath, args: [fileURLToPath(new URL("./fixtures/pi-readiness.mjs", import.meta.url)), mode] }),
      spawnFn(...args) {
        child = spawn(...args);
        child.on("close", () => { closed = true; });
        return child;
      },
    });
    t.after(() => { if (!closed) child.kill("SIGKILL"); });
    if (mode === "ready") await probe;
    else await assert.rejects(probe, mode === "missing" ? /without the \/tf command/ : mode === "hang" ? /smoke timed out/ : /exited 3|EPIPE/);
    assert.equal(closed, true, "probe must not settle with the RPC process still alive");
    assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
  });
}

test("Pi readiness rejects launch failures without leaving a cleanup timer", async () => {
  await assert.rejects(smokePiTaskflow({
    resolveLaunch: () => ({ command: join(tmpdir(), "missing-harnest-pi-readiness") }),
    timeoutMs: 1_000,
  }), { code: "ENOENT" });
});

test("non-object Pi startup JSON cannot interrupt all-target checks or child cleanup", { timeout: 10_000 }, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "harnest-readiness-noise-"));
  t.after(() => rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const targets = [];
  let child;
  let closed = false;
  t.after(() => { if (child && !closed) child.kill("SIGKILL"); });
  const result = await smokeHarnesses({
    versionProbe(target) { targets.push(target); return "fixture"; },
    piProbe: () => smokePiTaskflow({ cwd, timeoutMs: 3_000, cleanupTimeoutMs: 3_000,
      resolveLaunch: () => ({ command: process.execPath, args: [fileURLToPath(new URL("./fixtures/pi-readiness.mjs", import.meta.url)), "noise"] }),
      spawnFn(...args) { child = spawn(...args); child.on("close", () => { closed = true; }); return child; },
    }),
    piTaskflowProbe: async () => {},
    report() {},
  });
  assert.equal(result.ok, true);
  assert.deepEqual(targets, ["opencode2", "pi", "cursor", "claude", "codex", "gemini", "amp", "opencode"]);
  assert.equal(closed, true);
  assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
});
