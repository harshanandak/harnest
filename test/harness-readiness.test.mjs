import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { smokeHarnesses, smokePiCore, versionOf } from "../scripts/smoke-harnesses.mjs";

test("version probe preserves the real missing executable code and reason", () => {
  assert.throws(() => versionOf("opencode", {
    resolveLaunch: () => ({ command: join(tmpdir(), "missing-harnest-readiness-executable"), args: [] }),
  }), (error) => error.code === "ENOENT" && /ENOENT/.test(error.message) && /spawnSync/.test(error.message));
});

test("readiness reports all current targets after failures", async () => {
  const lines = [];
  const called = [];
  const result = await smokeHarnesses({
    versionProbe(target) {
      called.push(target);
      if (["opencode", "claude"].includes(target)) throw Object.assign(new Error("fixture missing"), { code: "ENOENT" });
      return "fixture-version";
    },
    piProbe: async () => { throw new Error("fixture pi core failure"); },
    report: (line) => lines.push(line),
  });
  assert.equal(result.ok, false);
  assert.deepEqual(called, ["opencode", "pi", "cursor", "claude", "codex", "amp"]);
  assert.deepEqual(result.results.filter((entry) => entry.required).map((entry) => entry.name), ["opencode", "pi", "cursor", "claude", "codex"]);
  assert.ok(lines.some((line) => /target=opencode required=true status=failed.*ENOENT/.test(line)));
  assert.ok(lines.some((line) => /target=pi .*fixture pi core failure/.test(line)));
  assert.ok(lines.some((line) => /target=codex required=true status=ready/.test(line)));
  assert.ok(lines.some((line) => /target=amp required=false status=ready/.test(line)));
  assert.equal(lines.at(-1), "HARNESS_SMOKE_FAILED");
});

test("Pi readiness accepts a successful RPC response with no commands", async (t) => {
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

test("OpenCode readiness rejects a V1 executable", () => {
  assert.throws(() => versionOf("opencode", {
    resolveLaunch: () => ({ command: "opencode", args: [] }),
    spawnSyncFn: () => ({ status: 0, stdout: "1.18.18" }),
  }), /OpenCode V2 is required/);
});

for (const mode of ["ready", "rejected", "hang", "exit"]) {
  test(`Pi readiness waits for process cleanup (${mode})`, { timeout: 10_000 }, async (t) => {
    const cwd = await mkdtemp(join(tmpdir(), "harnest-readiness-"));
    t.after(() => rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
    let child;
    let closed = false;
    const probe = smokePiCore({
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
    else await assert.rejects(probe, mode === "rejected" ? /did not acknowledge get_commands/ : mode === "hang" ? /smoke timed out/ : /exited 3|EPIPE/);
    assert.equal(closed, true, "probe must not settle with the RPC process still alive");
    assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
  });
}

test("Pi readiness rejects launch failures without leaving a cleanup timer", async () => {
  await assert.rejects(smokePiCore({
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
    piProbe: () => smokePiCore({ cwd, timeoutMs: 3_000, cleanupTimeoutMs: 3_000,
      resolveLaunch: () => ({ command: process.execPath, args: [fileURLToPath(new URL("./fixtures/pi-readiness.mjs", import.meta.url)), "noise"] }),
      spawnFn(...args) { child = spawn(...args); child.on("close", () => { closed = true; }); return child; },
    }),
    report() {},
  });
  assert.equal(result.ok, true);
  assert.deepEqual(targets, ["opencode", "pi", "cursor", "claude", "codex", "amp"]);
  assert.equal(closed, true);
  assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
});
