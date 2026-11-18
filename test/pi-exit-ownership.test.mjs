import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { PiAdapter } from "../src/adapters/pi.mjs";

for (const mode of ["reject", "timeout", "abort", "success"]) {
  test(`Pi never kills or writes to an exited child while progress settles (${mode})`, async () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let exited = false;
    let kills = 0;
    let writesAfterExit = 0;
    let release;
    let reject;
    let started;
    const ready = new Promise((resolve) => { started = resolve; });
    const gate = new Promise((resolve, fail) => { release = resolve; reject = fail; });
    const emit = (event) => child.stdout.emit("data", Buffer.from(`${JSON.stringify(event)}\n`));
    child.kill = () => { kills++; return true; };
    child.stdin = { write(line) {
      if (exited) writesAfterExit++;
      const command = JSON.parse(line);
      if (command.type === "prompt") emit({ type: "progress-gate" });
      else emit({ type: "response", id: command.id, command: command.type, success: true,
        data: command.type === "get_state" ? { model: { provider: "openai", id: "fixture" } }
          : command.type === "get_last_assistant_text" ? { text: "DONE" } : {} });
      return true;
    } };
    const controller = new AbortController();
    const adapter = new PiAdapter({ command: "fake-pi", spawnFn: () => child });
    const run = adapter.run({ target: "pi", requestId: `exit-${mode}`, task: "synthetic fixture", cwd: process.cwd(),
      policy: { write: false }, route: {}, execution: { timeoutMs: mode === "timeout" ? 60 : 1000 } }, {
      signal: controller.signal,
      onProgress(event) { if (event.type === "progress-gate") { started(); return gate; } },
    }).then((value) => ({ value }), (error) => ({ error }));
    await ready;
    if (mode === "success") {
      emit({ type: "message_end", message: { role: "assistant", content: "DONE" } });
      emit({ type: "agent_settled" });
    }
    exited = true;
    child.emit("exit", 0, null);
    if (mode === "reject") reject(new Error("progress failed after exit"));
    else if (mode === "abort") controller.abort();
    else if (mode === "success") { child.emit("close", 0, null); release(); }
    const result = await run;
    if (mode === "success") assert.equal(result.value?.result.finalText, "DONE");
    else assert.equal(result.error?.details.kind, mode === "reject" ? "transport" : mode === "abort" ? "aborted" : "timeout");
    assert.equal(kills, 0, "the native exit ends ownership of its PID");
    assert.equal(writesAfterExit, 0, "RPC commands cannot be sent after native exit");
  });
}
