import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createAdapter } from "../src/adapters/index.mjs";
import { normalizeRequest } from "../src/protocol.mjs";

test("Companion loads and adapter selection stays synchronous", () => {
  const child = spawnSync(process.execPath, [
    "--input-type=module", "-e", `
      await import(${JSON.stringify(new URL("../src/companion.mjs", import.meta.url).href)});
      const { createAdapter } = await import(${JSON.stringify(new URL("../src/adapters/index.mjs", import.meta.url).href)});
      for (const target of ["opencode", "pi", "cursor", "claude", "codex", "amp"]) {
        const adapter = createAdapter(target, { [target]: { command: "synthetic" } });
        if (typeof adapter.run !== "function" || typeof adapter.control !== "function") throw new Error(target);
        if (adapter instanceof Promise) throw new Error("createAdapter must remain synchronous");
      }
    `,
  ], { encoding: "utf8", timeout: 15_000, windowsHide: true });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
});

test("lazy OpenCode forwards progress, live controls and abort to the same adapter", async () => {
  let child;
  let started;
  const launched = new Promise((resolve) => { started = resolve; });
  const progress = [];
  const prompts = [];
  const adapter = createAdapter("opencode", { opencode: {
    command: "synthetic",
    serverUrl: "http://127.0.0.1:43991",
    async fetchFn(url) {
      assert.equal(new URL(url).pathname, "/global/health");
      return { ok: true, status: 200 };
    },
    clientFactory: () => ({ session: { async prompt(input) { prompts.push(input); } } }),
    spawnFn(_command, args) {
      assert.equal(args[0], "run");
      assert.ok(args.includes("--server"));
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
  const request = normalizeRequest({
    requestId: "lazy-opencode", target: "opencode", task: "fixture", cwd: process.cwd(),
    route: { model: "fixture/model" }, policy: { write: true }, execution: { timeoutMs: 10_000 },
  });
  const running = adapter.run(request, { signal: controller.signal, onProgress: (event) => progress.push(event) });
  try {
    await Promise.race([launched, running]);
    await assert.rejects(adapter.run({ ...request, requestId: "another-request" }), (error) => error.details?.kind === "busy");
    const acknowledgement = await adapter.control({ commandId: "lazy-message", kind: "message", message: "fixture", delivery: "follow_up" });
    assert.equal(acknowledgement.harnessVersion, "v2");
    assert.equal(acknowledgement.sessionId, "lazy-session");
    assert.equal(acknowledgement.persisted, true);
    assert.deepEqual(prompts.map(({ sessionID, delivery, text }) => ({ sessionID, delivery, text })), [
      { sessionID: "lazy-session", delivery: "queue", text: "fixture" },
    ]);
  } finally {
    controller.abort();
    await assert.rejects(running, (error) => error.details?.kind === "abort");
  }
  assert.equal(child.killed, true);
  assert.ok(progress.some((event) => event.sessionId === "lazy-session"));
});
