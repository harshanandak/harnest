import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The demo runs the real engine, Companion and detached DynamicWorkflowRunner
// with fake adapters only; this test drives it as a subprocess so a hung demo
// cannot hang the suite, then re-asserts every artifact it produced.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEMO = join(REPO_ROOT, "scripts", "demo-dynamic-workflow.mjs");
const RUNNER_ROOT = process.env.HARNEST_DEMO_ROOT
  ? resolve(process.env.HARNEST_DEMO_ROOT)
  : REPO_ROOT;
const REQUIRED_INTEGRATION = [
  "src/companion.mjs",
  "src/dynamic-runner.mjs",
  "src/dynamic-tools.mjs",
  "src/workflow-registry.mjs",
  "src/dynamic-view.mjs",
  "src/dynamic-engine.mjs",
  "scripts/dynamic-view.mjs",
];
const INTEGRATED = REQUIRED_INTEGRATION.every((relative) => existsSync(join(RUNNER_ROOT, relative)));

const LABELS = ["plan", "work-pi", "work-opencode", "work-claude", "work-codex", "work-cursor", "work-amp", "checkpoint", "after-pause"];
const EXPECTED_ATTEMPTS = {
  plan: 1,
  "work-pi": 1,
  "work-opencode": 1,
  "work-claude": 1,
  "work-codex": 1,
  "work-cursor": 2,
  "work-amp": 2,
  checkpoint: 2,
  "after-pause": 2,
};
const EXPECTED_LAUNCHES = {
  plan: 2,
  "work-pi": 2,
  "work-opencode": 2,
  "work-claude": 2,
  "work-codex": 2,
  "work-cursor": 3,
  "work-amp": 3,
  checkpoint: 3,
  "after-pause": 2,
};

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

test("dynamic workflow demo exercises branch, fan-out, failure, pause, resume, drill-in and rerun", { timeout: 240_000 }, (t) => {
  if (!INTEGRATED) {
    t.skip(`dynamic workflow integration is not present in ${RUNNER_ROOT}`);
    return;
  }
  const fixture = mkdtempSync(join(tmpdir(), "harnest-demo-test-"));
  const result = spawnSync(process.execPath, [
    DEMO,
    "--root", RUNNER_ROOT,
    "--fixture", fixture,
    "--timeout-ms", "120000",
  ], { encoding: "utf8", timeout: 210_000, windowsHide: true, env: process.env });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  let manifest = null;
  try {
    manifest = readJson(join(fixture, "demo.json"));
  } catch {
    manifest = null;
  }
  const keep = process.env.HARNEST_DEMO_KEEP === "1" || result.status !== 0;
  t.after(() => {
    if (keep) process.stderr.write(`dynamic demo fixture kept for review: ${fixture}\n`);
    else rmSync(fixture, { recursive: true, force: true });
  });

  assert.ok(manifest, `demo did not write demo.json (exit ${result.status})\nstdout: ${stdout}\nstderr: ${stderr}`);
  assert.equal(result.status, 0, `demo exited ${result.status}: ${manifest.error?.message ?? (stderr || stdout)}`);
  assert.equal(manifest.error, null, JSON.stringify(manifest.error));
  assert.equal(manifest.assertions.every((entry) => entry.ok), true, JSON.stringify(manifest.assertions.filter((entry) => !entry.ok)));
  assert.match(stdout, /DEMO_OK/);

  // --- named objects: runs, controls, statuses, final output --------------
  const { runIds } = manifest;
  assert.match(runIds.initial, /^dyn-[a-f0-9]{64}$/);
  assert.match(runIds.savedRerun, /^dyn-[a-f0-9]{64}$/);
  assert.notEqual(runIds.initial, runIds.savedRerun);
  assert.ok(["queued", "running"].includes(manifest.status.started.state), manifest.status.started.state);
  assert.equal(manifest.status.paused.state, "paused");
  assert.notEqual(manifest.status.stopped.state, "completed");
  assert.equal(manifest.status.final.state, "completed");

  assert.equal(manifest.controls.stopped.length, 2, JSON.stringify(manifest.controls.stopped));
  const pause = manifest.controls.stopped.find((control) => control.commandId === "demo-pause-1");
  const stop = manifest.controls.stopped.find((control) => control.commandId === "demo-stop-1");
  assert.equal(pause?.state, "applied");
  assert.equal(pause?.effect, "dispatch-gate-closed");
  assert.equal(stop?.state, "applied");
  assert.equal(stop?.effect, "cancellation-requested");

  const output = manifest.results.final.output;
  assert.equal(output.branch, "proceed");
  assert.equal(output.itemCount, 5);
  assert.equal(output.total, 30);
  assert.deepEqual(output.failedLabels, []);
  assert.equal(output.completedCount, 6);
  assert.equal(output.lanes.length, 6);
  assert.equal(output.checkpoint, "checkpoint");
  assert.equal(output.afterPause, "after-pause");

  // --- every invocation, not just the first three --------------------------
  const invocations = manifest.status.final.invocations;
  assert.deepEqual(invocations.map((call) => call.label), LABELS);
  assert.deepEqual(invocations.map((call) => call.ordinal), LABELS.map((_, index) => index));
  for (const call of invocations) {
    assert.equal(call.state, "completed", call.label);
    assert.ok(call.jobId, `${call.label} jobId`);
    assert.ok(call.sessionId, `${call.label} sessionId`);
  }
  assert.deepEqual(Object.fromEntries(invocations.map((call) => [call.label, call.attempts])), EXPECTED_ATTEMPTS);

  for (const call of invocations) {
    const inspect = manifest.inspects[call.id];
    assert.ok(inspect, `missing inspect for ${call.id}`);
    assert.equal(inspect.label, call.label);
    assert.equal(inspect.totalAttempts, call.attempts);
    assert.equal(inspect.attempts.length, call.attempts);
  }
  const cursorInspect = manifest.inspects[invocations.find((call) => call.label === "work-cursor").id];
  assert.equal(cursorInspect.attempts[0].state, "failed");
  const prefixInspect = manifest.inspects[invocations.find((call) => call.label === "work-pi").id];
  assert.equal(prefixInspect.reused, true);

  // --- history and pagination ----------------------------------------------
  assert.ok(manifest.history.runs.some((run) => run.runId === runIds.initial));
  assert.ok(manifest.history.runs.some((run) => run.runId === runIds.savedRerun));
  assert.ok(manifest.historyPages.page2, "expected a second history page");
  assert.notEqual(manifest.historyPages.page1.runs[0].runId, manifest.historyPages.page2.runs[0].runId);

  // --- launch evidence: pause gating and prefix replay ---------------------
  assert.equal(manifest.launchesAfterStop["after-pause"] ?? 0, 0);
  assert.deepEqual(manifest.launchesAfterResume, {
    plan: 1,
    "work-pi": 1,
    "work-opencode": 1,
    "work-claude": 1,
    "work-codex": 1,
    "work-cursor": 2,
    "work-amp": 2,
    checkpoint: 2,
    "after-pause": 1,
  });
  assert.deepEqual(manifest.launches.counts, EXPECTED_LAUNCHES);
  assert.ok(manifest.launches.pids.length >= 2, manifest.launches.pids);
  assert.ok(manifest.launches.records.every((entry) => entry.target && entry.label && entry.requestId));

  // --- parameterized saved workflow rerun ----------------------------------
  assert.equal(manifest.savedWorkflow.name, "dynamic-demo");
  assert.match(manifest.savedWorkflow.revision, /^[a-f0-9]{64}$/);
  assert.equal(manifest.savedRerun.status.state, "completed");
  assert.equal(manifest.savedRerun.result.output.itemCount, 3);
  assert.equal(manifest.savedRerun.result.output.total, 18);
  assert.deepEqual(manifest.savedRerun.result.output.failedLabels, []);

  // --- canonical CLI frames ------------------------------------------------
  assert.ok(manifest.frames.stopped.length > 0);
  for (const label of LABELS) assert.ok(manifest.frames.final.includes(label), `final frame missing ${label}`);
  assert.ok(manifest.frames.final.includes("completed"));
  assert.ok(manifest.frames.savedRerun.includes("dynamic-demo"));

  // --- fresh-process controller evidence -----------------------------------
  assert.notEqual(manifest.controllerResume.pid, manifest.pid);
  assert.equal(manifest.controllerResume.runId, runIds.initial);
  assert.equal(manifest.controllerResume.attempt, 2);
  assert.equal(manifest.controllerResume.state, "completed");
  assert.equal(manifest.controllerResume.invocationIds.length, LABELS.length);
});
