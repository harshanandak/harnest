// SessionStart hook tests: drive scripts/hook-session-start.mjs with a
// crafted HARNEST_STATE_DIR, following the script-driving pattern
// from write-guard.test.mjs.
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon } from "../src/daemon.mjs";

const root = join(import.meta.dirname, "..");
const script = "scripts/hook-session-start.mjs";

async function run(env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("hook script timed out after 10s"));
    }, 10_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end();
  });
}

async function withTempStateDir(setup, assertion) {
  const fixture = await mkdtemp(join(tmpdir(), "harnest-hook-test-"));
  const stateDir = join(fixture, "jobs");
  const daemon = await startDaemon({ port: 0, directory: join(fixture, "daemon") });
  try {
    await setup(stateDir);
    const result = await run({ HARNEST_STATE_DIR: stateDir, HARNEST_DAEMON_FIXTURE_PORT: String(daemon.port) });
    await assertion(result);
  } finally {
    await daemon.close();
    await rm(fixture, { recursive: true, force: true });
  }
}

test("reports a running workflow graph with node counts and points to /workflows", async () => {
  await withTempStateDir(
    async (stateDir) => {
      const graphsDir = join(stateDir, "graphs");
      await mkdir(graphsDir, { recursive: true });
      const graphId = `graph-${"a".repeat(64)}`;
      await writeFile(
        join(graphsDir, `${graphId}.json`),
        JSON.stringify({
          state: "running",
          nodes: [{ id: "n1", state: "completed" }, { id: "n2", state: "running" }],
        }),
      );
    },
    (result) => {
      assert.equal(result.code, 0);
      const output = JSON.parse(result.stdout.trim());
      assert.equal(output.hookSpecificOutput.hookEventName, "SessionStart");
      assert.match(output.hookSpecificOutput.additionalContext, /9 bridge workers available/);
      assert.match(output.hookSpecificOutput.additionalContext, /1 workflow graph\(s\) running/);
      assert.match(output.hookSpecificOutput.additionalContext, /1\/2/);
      assert.match(output.hookSpecificOutput.additionalContext, /\/workflows/);
    },
  );
});

test("counts every running graph even when only five names are listed", async () => {
  await withTempStateDir(
    async (stateDir) => {
      const graphsDir = join(stateDir, "graphs");
      await mkdir(graphsDir, { recursive: true });
      for (const prefix of ["11111111", "22222222", "33333333", "44444444", "55555555", "66666666"]) {
        const graphId = `graph-${prefix}${"a".repeat(56)}`;
        await writeFile(
          join(graphsDir, `${graphId}.json`),
          JSON.stringify({ state: "running", nodes: [{ id: "n1", state: "completed" }] }),
        );
      }
      for (let index = 0; index < 4; index += 1) {
        const graphId = `graph-${"b".repeat(62)}${index.toString(16)}${index.toString(16)}`;
        await writeFile(join(graphsDir, `${graphId}.json`), JSON.stringify({ state: "completed", nodes: [] }));
      }
    },
    (result) => {
      assert.equal(result.code, 0);
      const context = JSON.parse(result.stdout.trim()).hookSpecificOutput.additionalContext;
      assert.doesNotMatch(context, /\b5 workflow graph\(s\) running/, "six running graphs must not be reported as five");
      assert.match(context, /at least 6 workflow graph\(s\) running/);
      assert.equal((context.match(/\(1\/1\)/g) || []).length, 5, "only five graph names are listed");
    },
  );
});

test("scans the most recently updated graphs first when more than 100 files exist", async () => {
  // The running graph is the oldest entry (created first) but is still being
  // updated, so its mtime must pull it inside the 100-file read cap.
  const runningId = `graph-${"f".repeat(64)}`;
  await withTempStateDir(
    async (stateDir) => {
      const graphsDir = join(stateDir, "graphs");
      await mkdir(graphsDir, { recursive: true });
      const runningPath = join(graphsDir, `${runningId}.json`);
      await writeFile(
        runningPath,
        JSON.stringify({ state: "running", nodes: [{ id: "n1", state: "completed" }, { id: "n2", state: "running" }] }),
      );
      const old = new Date(Date.now() - 120_000);
      for (let index = 0; index < 100; index += 1) {
        const hex = index.toString(16).padStart(2, "0") + "0".repeat(62);
        const filePath = join(graphsDir, `graph-${hex}.json`);
        await writeFile(filePath, JSON.stringify({ state: "completed", nodes: [] }));
        await utimes(filePath, old, old);
      }
      await utimes(runningPath, new Date(), new Date());
    },
    (result) => {
      assert.equal(result.code, 0);
      const context = JSON.parse(result.stdout.trim()).hookSpecificOutput.additionalContext;
      assert.match(context, /1 workflow graph\(s\) running/);
      assert.match(context, new RegExp(runningId.slice(6, 14)));
    },
  );
});

test("stays silent about graphs when none are running", async () => {
  await withTempStateDir(
    async (stateDir) => {
      const graphsDir = join(stateDir, "graphs");
      await mkdir(graphsDir, { recursive: true });
      const graphId = `graph-${"b".repeat(64)}`;
      await writeFile(join(graphsDir, `${graphId}.json`), JSON.stringify({ state: "completed", nodes: [] }));
    },
    (result) => {
      assert.equal(result.code, 0);
      const output = JSON.parse(result.stdout.trim());
      assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /workflow graph/);
    },
  );
});

test("ignores an unreadable graph record instead of failing the hook", async () => {
  await withTempStateDir(
    async (stateDir) => {
      const graphsDir = join(stateDir, "graphs");
      await mkdir(graphsDir, { recursive: true });
      const graphId = `graph-${"c".repeat(64)}`;
      await writeFile(join(graphsDir, `${graphId}.json`), "not json{{{");
    },
    (result) => {
      assert.equal(result.code, 0);
      const output = JSON.parse(result.stdout.trim());
      assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /workflow graph/);
    },
  );
});

test("stays safe (exit 0, base line only) with no state dir at all", async () => {
  const missingStateDir = join(tmpdir(), `harnest-hook-test-missing-${Date.now()}`);
  const result = await run({ HARNEST_STATE_DIR: missingStateDir });
  assert.equal(result.code, 0);
  const output = JSON.parse(result.stdout.trim());
  assert.equal(output.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(output.hookSpecificOutput.additionalContext, /0 durable job file\(s\)/);
});
