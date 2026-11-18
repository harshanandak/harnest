import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createAdapter } from "../src/adapters/index.mjs";
import { normalizeRequest } from "../src/protocol.mjs";

test("importing Companion and selecting an adapter do not load the Taskflow runtime", () => {
  const child = spawnSync(process.execPath, [
    "--experimental-loader", new URL("./fixtures/reject-taskflow-loader.mjs", import.meta.url).href,
    "--input-type=module", "-e", `
      await import(${JSON.stringify(new URL("../src/companion.mjs", import.meta.url).href)});
      const { createAdapter } = await import(${JSON.stringify(new URL("../src/adapters/index.mjs", import.meta.url).href)});
      for (const target of ["opencode", "pi", "cursor", "claude", "codex", "gemini", "amp"]) {
        const adapter = createAdapter(target, { [target]: { command: "synthetic" } });
        if (typeof adapter.run !== "function" || typeof adapter.control !== "function") throw new Error(target);
        if (adapter instanceof Promise) throw new Error("createAdapter must remain synchronous");
      }
    `,
  ], { encoding: "utf8", timeout: 15_000, windowsHide: true });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
});

test("plain Pi and OpenCode runs execute natively while Taskflow imports are blocked", () => {
  const child = spawnSync(process.execPath, [
    "--experimental-loader", new URL("./fixtures/reject-taskflow-loader.mjs", import.meta.url).href,
    fileURLToPath(new URL("../scripts/fixtures/direct-run.mjs", import.meta.url)),
  ], { encoding: "utf8", timeout: 30_000, windowsHide: true });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /DIRECT_RUN_OK/);
});

test("a Taskflow module evaluation error is not masked as a missing optional dependency", () => {
  const child = spawnSync(process.execPath, [
    "--experimental-loader", new URL("./fixtures/reject-taskflow-loader.mjs", import.meta.url).href,
    fileURLToPath(new URL("../scripts/fixtures/direct-run.mjs", import.meta.url)),
  ], { encoding: "utf8", timeout: 30_000, windowsHide: true, env: { ...process.env, REJECT_TASKFLOW_MODE: "eval" } });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /DIRECT_RUN_OK/);
});

test("lazy OpenCode forwards progress, live controls and abort to the same adapter", async () => {
  let child;
  let started;
  const launched = new Promise((resolve) => { started = resolve; });
  const progress = [];
  const adapter = createAdapter("opencode", { opencode: {
    command: "synthetic",
    spawnFn() {
      child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {
        child.killed = true;
        queueMicrotask(() => child.emit("close", null, "SIGTERM"));
      };
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "text", sessionID: "lazy-session", part: { text: "lazy progress" } })}\n`));
        started();
      });
      return child;
    },
  } });
  const controller = new AbortController();
  const running = adapter.run(normalizeRequest({
    requestId: "lazy-opencode", target: "opencode", task: "fixture", cwd: process.cwd(),
    route: { model: "fixture/model" }, execution: { timeoutMs: 10_000 },
  }), { signal: controller.signal, onProgress: (event) => progress.push(event) });
  const aborted = assert.rejects(running, (error) => error.details?.kind === "abort");
  await launched;
  await assert.rejects(adapter.control({ kind: "message", message: "fixture" }), (error) =>
    error.details?.kind === "unsupported-control" && /V1/.test(error.message));
  controller.abort();
  await aborted;
  assert.equal(child.killed, true);
  assert.ok(progress.some((event) => event.sessionId === "lazy-session"));
});
