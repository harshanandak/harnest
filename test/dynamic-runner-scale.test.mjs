import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Drives scripts/dynamic-runner-scale.mjs as a subprocess: one real
// DynamicWorkflowRunner attempt, real Companion, fake adapter, exactly 1000
// agent calls at maxConcurrency 6, absolute 120s probe deadline. The probe's
// own exit code and report are the evidence; this test re-asserts all of it.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROBE = join(REPO_ROOT, "scripts", "dynamic-runner-scale.mjs");
const RUNNER_ROOT = process.env.HARNEST_SCALE_ROOT
  ? resolve(process.env.HARNEST_SCALE_ROOT)
  : REPO_ROOT;
const REQUIRED_INTEGRATION = [
  "src/companion.mjs",
  "src/dynamic-runner.mjs",
  "src/dynamic-engine.mjs",
  "src/dynamic-protocol.mjs",
];
const INTEGRATED = REQUIRED_INTEGRATION.every((relative) => existsSync(join(RUNNER_ROOT, relative)));

test("1000 dynamic agent calls stay bounded at concurrency 6 within the 120s probe deadline", { timeout: 200_000 }, (t) => {
  if (!INTEGRATED) {
    t.skip(`dynamic runner integration is not present in ${RUNNER_ROOT}`);
    return;
  }
  const fixture = mkdtempSync(join(tmpdir(), "harnest-scale-test-"));
  const result = spawnSync(process.execPath, [
    PROBE,
    "--root", RUNNER_ROOT,
    "--fixture", fixture,
    "--calls", "1000",
    "--concurrency", "6",
    "--deadline-ms", "120000",
    "--poll-ms", "250",
  ], { encoding: "utf8", timeout: 150_000, windowsHide: true, env: process.env });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  let report = null;
  try {
    report = JSON.parse(readFileSync(join(fixture, "scale-report.json"), "utf8"));
  } catch {
    report = null;
  }
  const keep = process.env.HARNEST_SCALE_KEEP === "1" || result.status !== 0;
  t.after(() => {
    if (keep) process.stderr.write(`scale fixture kept for review: ${fixture}\n`);
    else rmSync(fixture, { recursive: true, force: true });
  });

  assert.ok(report, `probe did not write scale-report.json (exit ${result.status})\nstdout: ${stdout}\nstderr: ${stderr}`);
  assert.equal(result.status, 0, `probe exited ${result.status}: ${report.failures.join("; ")}${report.statusError ? ` | ${report.statusError.message}` : ""}`);
  assert.deepEqual(report.failures, []);
  assert.equal(report.passed, true);

  // Semantic acceptance: exactly 1000 observed calls, bounded concurrency,
  // complete final output, and a terminal completed run.
  assert.equal(report.calls, 1000);
  assert.equal(report.concurrency, 6);
  assert.ok(report.elapsedMs <= 120_000, `elapsed ${report.elapsedMs}ms exceeded the probe deadline`);
  assert.equal(report.state, "completed");
  assert.equal(report.observed, 1000);
  assert.equal(report.distinctIndices, 1000);
  assert.ok(report.maxInflight >= 1 && report.maxInflight <= 6, `maxInflight ${report.maxInflight}`);
  assert.deepEqual(report.finalOutput, { calls: 1000, observed: 1000, completed: 1000, sum: 499500 });
  assert.equal(report.invocationsSeen, 1000);
  assert.equal(report.invocationsTotal, 1000);
  assert.ok(report.throughputPerSecond > 0, "throughput not recorded");
  assert.ok(report.runRecordBytes > 0, "run record bytes not recorded");
  assert.equal(report.deadlineExceeded, false);

  // Resource evidence is recorded, not promised as a native-agent bound.
  assert.ok(report.peakMemory.rssBytes > 0, "peak RSS not recorded");
  assert.ok(report.peakMemory.heapUsedBytes > 0, "peak heap not recorded");
  assert.ok(report.peakHandles.activeHandles >= 0, "handles not recorded");
  assert.equal(report.peakHandles.childProcesses, 0, "probe must not spawn native harness processes");

  // Default and paginated status bounds over all 1000 invocations.
  assert.ok(report.statusBytes.default > 0, "default status bytes not recorded");
  assert.ok(report.statusBytes.default < 5_000_000, `default status ${report.statusBytes.default} bytes`);
  assert.equal(report.statusBytes.pages, 5, `expected 5 pages of 200, saw ${report.statusBytes.pages}`);
  assert.deepEqual(report.statusBytes.pageCounts, [200, 200, 200, 200, 200]);
  assert.ok(report.statusBytes.pageMax > 0 && report.statusBytes.pageMax < 5_000_000, `pageMax ${report.statusBytes.pageMax}`);
  assert.equal(report.statusBytes.pageCounts.reduce((sum, count) => sum + count, 0), 1000);

  // Retained disk bytes are recorded for both stores.
  assert.ok(report.diskBytes.total.bytes > 0, "disk bytes not recorded");
  assert.ok(report.diskBytes.total.files > 0, "disk file count not recorded");
  assert.ok(report.diskBytes.companion.bytes > 0, "companion store bytes not recorded");
  assert.ok(report.diskBytes.dynamic.bytes > 0, "dynamic store bytes not recorded");
});
