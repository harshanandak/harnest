import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ClaudeAdapter } from "../src/adapters/claude.mjs";
import { CursorAdapter } from "../src/adapters/cursor.mjs";
import { CodexAdapter } from "../src/adapters/codex.mjs";
import { Companion } from "../src/companion.mjs";
import { JobStore } from "../src/job-store.mjs";
import { normalizeRequest } from "../src/protocol.mjs";

const adapters = { claude: ClaudeAdapter, cursor: CursorAdapter, codex: CodexAdapter };

class StreamingChild extends EventEmitter {
  constructor({ lines = [], code = 0, beforeClose, hang = false, transportError = false, stderr = "" } = {}) {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdin = { write() { return true; }, end() {} };
    queueMicrotask(() => {
      for (const line of lines) this.stdout.emit("data", Buffer.from(`${typeof line === "string" ? line : JSON.stringify(line)}\n`));
      if (stderr) this.stderr.emit("data", Buffer.from(stderr));
      beforeClose?.();
      if (transportError) this.emit("error", Object.assign(new Error("fixture transport failure"), { code: "EIO" }));
      if (!hang) this.emit("close", code, null);
    });
  }
  kill() {
    this.killed = true;
    queueMicrotask(() => this.emit("close", null, "SIGTERM"));
    return true;
  }
}

function request(target, overrides = {}) {
  return normalizeRequest({
    requestId: `one-shot-${target}`,
    target,
    task: "Return a final answer.",
    cwd: process.cwd(),
    context: { requiredResultFields: ["finalText"] },
    ...overrides,
  });
}

function adapter(target, options = {}) {
  return new adapters[target]({
    command: `fake-${target}`,
    ...(target === "codex" ? {
      gitCheckFn: async () => true,
      quotaProbeFn: async () => ({ status: "unknown", source: "test", observedAt: 0, reason: "fixture" }),
    } : {}),
    spawnFn(_command, args) {
      if (target === "codex" && options.finalText !== undefined) writeFileSync(args[args.indexOf("-o") + 1], options.finalText);
      return new StreamingChild(options);
    },
  });
}

for (const code of [0, 1]) {
  for (const [subtype, result, kind] of [
    ["error_max_budget_usd", "Authentication required.", "budget"],
    ["error_during_execution", "Authentication required.", "provider-auth"],
    ["error_max_turns", "Turn limit reached.", "downstream"],
  ]) {
    test(`Claude retains ${subtype} metadata on exit ${code}`, async () => {
      const terminal = { type: "result", is_error: true, subtype, result,
        stop_reason: "limit", permission_denials: [{ tool_name: "Bash" }], errors: [result] };
      await assert.rejects(adapter("claude", { lines: [terminal], code }).run(request("claude")), (error) => {
        assert.equal(error.details.kind, kind);
        assert.equal(error.details.subtype, subtype);
        assert.equal(error.details.stopReason, "limit");
        assert.deepEqual(error.details.permissionDenials, [{ tool_name: "Bash" }]);
        assert.deepEqual(error.details.errors, [result]);
        return true;
      });
    });
  }

  test(`Claude retains stream authentication errors on exit ${code}`, async () => {
    await assert.rejects(adapter("claude", { code, lines: [
      { type: "error", error: { type: "authentication_error", message: "Authentication required.", status: 401 } },
    ] }).run(request("claude")), (error) => error.details.kind === "provider-auth" && error.details.status === 401);
  });
}

const incompleteCursor = [
  { name: "error result", lines: [{ type: "result", is_error: true, subtype: "error_during_execution", result: "Execution failed unexpectedly." }] },
  { name: "non-success result", lines: [{ type: "result", subtype: "cancelled", result: "Stopped early." }] },
  { name: "init only", lines: [{ type: "system", subtype: "init", session_id: "cursor-early" }] },
  { name: "delta only", lines: [{ type: "assistant", delta: "Still working." }] },
  { name: "empty result", lines: [{ type: "result", subtype: "success", result: "" }] },
  { name: "untyped error result", lines: [{ is_error: true, result: "Execution failed unexpectedly." }] },
];

for (const fixture of incompleteCursor) {
  test(`Cursor rejects ${fixture.name} through Companion completion`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "one-shot-completion-"));
    t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
    const companion = new Companion({ store: new JobStore(root), routeResolver: async (value) => value,
      adapterFactory: () => adapter("cursor", fixture) });
    const receipt = await companion.start(request("cursor"));
    assert.equal(receipt.state, "failed");
    assert.equal(receipt.error.details.kind, "downstream");
    assert.equal(receipt.result, null);
    if (fixture.name === "init only") assert.equal(receipt.sessionId, "cursor-early");
  });
}

for (const text of [
  "The billing screen is implemented and its tests passed.",
  "Authentication required is the label shown by the login form.",
  "The API key configuration and region selector are documented.",
  "The unknown model and model not found messages have been explained.",
]) {
  test(`Cursor accepts healthy plain text: ${text}`, async () => {
    const output = await adapter("cursor", { lines: [text] }).run(request("cursor"));
    assert.equal(output.result.finalText, text);
  });
}

test("Cursor preserves single JSON success, including formatted JSON", async () => {
  for (const space of [undefined, 2]) {
    const output = await adapter("cursor", { lines: [JSON.stringify({ result: "DONE", session_id: "single-json" }, null, space)] }).run(request("cursor"));
    assert.equal(output.result.finalText, "DONE");
    assert.equal(output.sessionId, "single-json");
  }
});

test("Cursor still classifies an explicit stdout authentication failure", async () => {
  await assert.rejects(adapter("cursor", { lines: ["Error: Authentication required."] }).run(request("cursor")),
    (error) => error.details.kind === "provider-auth");
});

function* largeStream(target, failed) {
  yield target === "codex" ? { type: "thread.started", thread_id: "early-session" }
    : { type: "system", subtype: "init", session_id: "early-session" };
  if (target === "codex") {
    yield { type: "turn.completed", usage: { input_tokens: 12, output_tokens: 4 } };
    if (failed) yield { type: "turn.failed", error: { message: "Authentication required." } };
  } else {
    yield { type: "result", subtype: failed ? "error_during_execution" : "success", is_error: failed,
      result: failed ? "Authentication required." : "DONE", session_id: "early-session",
      usage: target === "claude" ? { input_tokens: 12, output_tokens: 4 } : { inputTokens: 12, outputTokens: 4 } };
  }
  // More than the process helper's 1 MiB stdout tail, without one oversized line.
  for (let i = 0; i < 1500; i += 1) yield { type: "diagnostic", text: "x".repeat(1024) };
}

for (const target of Object.keys(adapters)) {
  for (const code of [0, 1]) {
    test(`${target} retains early identity, usage and errors across >1 MiB on exit ${code}`, async () => {
      let identity;
      let usage;
      let seenBeforeClose = false;
      const run = adapter(target, {
        lines: largeStream(target, code !== 0), code, finalText: "DONE",
        beforeClose() { seenBeforeClose = identity === "early-session" && (usage?.inputTokens ?? usage?.input_tokens) === 12; },
      }).run(request(target), { onProgress(event) { identity = event.sessionId || identity; usage = event.usage || usage; } });
      if (code) await assert.rejects(run, (error) => error.details.kind === "provider-auth");
      else {
        const output = await run;
        assert.equal(output.result.finalText, "DONE");
        assert.equal(output.sessionId, "early-session");
        assert.ok(JSON.stringify(output.result.eventSummary).length < 1000);
      }
      assert.equal(seenBeforeClose, true, "failure recovery must not depend on final stdout retention");
    });
  }
}

for (const target of Object.keys(adapters)) {
  test(`${target} preserves session and usage in a failed Companion receipt`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "one-shot-failed-"));
    t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
    const stream = largeStream(target, true);
    const lines = Array.from({ length: target === "codex" ? 3 : 2 }, () => stream.next().value);
    const companion = new Companion({ store: new JobStore(root), routeResolver: async (value) => value,
      adapterFactory: () => adapter(target, { lines, code: 1 }) });
    const receipt = await companion.start(request(target));
    assert.equal(receipt.state, "failed");
    assert.equal(receipt.error.details.kind, "provider-auth", JSON.stringify(receipt.error));
    assert.equal(receipt.sessionId, "early-session");
    assert.equal(receipt.usage.inputTokens ?? receipt.usage.input_tokens, 12);
    assert.equal(receipt.result, null);
  });
}

for (const target of Object.keys(adapters)) {
  test(`${target} preserves output-limit after prior provider error evidence`, async () => {
    await assert.rejects(adapter(target, {
      lines: [{ type: "error", message: "Authentication required." }, "x".repeat(2 * 1024 * 1024 + 1)],
      finalText: "DONE",
    }).run(request(target)), (error) => error.details.kind === "output-limit" && error.details.stdoutTruncated === true);
  });
}

test("Cursor refuses truncated plain text instead of returning its diagnostic tail as success", async () => {
  function* lines() {
    for (let i = 0; i < 1100; i += 1) yield "x".repeat(1024);
  }
  await assert.rejects(adapter("cursor", { lines: lines() }).run(request("cursor")),
    (error) => error.details.kind === "output-limit" && error.details.stdoutTruncated === true);
});

for (const target of Object.keys(adapters)) {
  for (const kind of ["timeout", "abort", "transport"]) {
    test(`${target} keeps ${kind} ahead of an observed provider failure`, async () => {
      const controller = new AbortController();
      const keepAlive = setTimeout(() => {}, 2000);
      try {
        await assert.rejects(adapter(target, {
          lines: target === "claude" ? [{ type: "result", is_error: true, subtype: "error_max_budget_usd", result: "Authentication required." }]
            : [{ type: "error", message: "Authentication required." }],
          hang: kind !== "transport",
          transportError: kind === "transport",
          beforeClose() { if (kind === "abort") controller.abort(); },
        }).run(request(target, { execution: { timeoutMs: 50 } }), { signal: controller.signal }),
        (error) => error.details.kind === kind);
      } finally {
        clearTimeout(keepAlive);
      }
    });
  }
}

test("Claude budget envelope wins over stream and stderr authentication errors", async () => {
  for (const code of [0, 1]) {
    await assert.rejects(adapter("claude", { code, stderr: "Authentication required.", lines: [
      { type: "error", message: "Authentication required." },
      { type: "result", is_error: true, subtype: "error_max_budget_usd", result: "", errors: ["budget exhausted"] },
    ] }).run(request("claude")), (error) => error.details.kind === "budget" && error.details.errors[0] === "budget exhausted");
  }
});

test("Provider evidence on existing fallback error channels remains classified", async () => {
  const fixtures = [
    ["claude", { lines: [{ type: "result", subtype: "success", result: "", errors: ["Authentication required."] }] }],
    ["cursor", { lines: ["Login failed."], stderr: "Error: Authentication required." }],
    ["codex", { lines: [{ type: "error", message: "request failed" }], stderr: "Error: Authentication required.", code: 1 }],
  ];
  for (const [target, options] of fixtures) {
    await assert.rejects(adapter(target, options).run(request(target)), (error) => error.details.kind === "provider-auth");
  }
});

test("Claude and Codex keep authoritative success after recoverable diagnostics", async () => {
  for (const target of ["claude", "codex"]) {
    const lines = [{ type: "error", message: "connection interrupted, retrying" }];
    if (target === "claude") lines.push({ type: "result", subtype: "success", result: "DONE" });
    const output = await adapter(target, { lines, finalText: "DONE", stderr: "billing settings loaded" }).run(request(target));
    assert.equal(output.result.finalText, "DONE");
  }
});

for (const target of ["cursor", "codex"]) {
  test(`${target} counts deltas without retaining a transcript or requiring a progress consumer`, async () => {
    function* lines() {
      for (let i = 0; i < 2000; i += 1) yield { type: "assistant", text: "x".repeat(1024) };
      if (target === "cursor") yield { type: "result", subtype: "success", result: "DONE" };
    }
    const output = await adapter(target, { lines: lines(), finalText: "DONE" }).run(request(target));
    assert.deepEqual(output.result.eventSummary, { count: 2001, types: [`${target}_stdout`, `${target}_delta`] });
    assert.equal(Object.hasOwn(output.result, "events"), false);
    assert.equal(Object.hasOwn(output.result, "deltas"), false);
  });
}

for (const target of Object.keys(adapters)) {
  for (const code of [0, 1]) {
    test(`${target} parses a backpressured real child beyond the diagnostic tail on exit ${code}`, { timeout: 10000 }, async () => {
      const script = `
        const { writeFileSync } = require('node:fs');
        const { once } = require('node:events');
        const target = ${JSON.stringify(target)};
        const code = ${code};
        process.stdin.resume();
        async function emit(event) {
          if (!process.stdout.write(JSON.stringify(event) + '\\n')) await once(process.stdout, 'drain');
        }
        (async () => {
          if (target === 'codex') {
            writeFileSync(process.argv[process.argv.indexOf('-o') + 1], 'DONE');
            await emit({type:'thread.started', thread_id:'real-child'});
            await emit({type:'turn.completed', usage:{input_tokens:12,output_tokens:4}});
            if (code) await emit({type:'turn.failed', error:{message:'Authentication required.'}});
          } else {
            await emit({type:'result',subtype:code ? 'error_during_execution' : 'success',is_error:Boolean(code),
              result:code ? 'Authentication required.' : 'DONE',session_id:'real-child',usage:{input_tokens:12,output_tokens:4}});
          }
          for (let i=0;i<1600;i++) await emit({type:'diagnostic',text:'x'.repeat(1024)});
          process.exitCode = code;
        })().catch(() => {process.exitCode = 3;});
      `;
      let sessionId;
      const runner = new adapters[target]({
        launch: { command: process.execPath, args: ["-e", script, "--"] },
        ...(target === "codex" ? {
          quotaProbeFn: async () => ({ status: "unknown", source: "test", observedAt: 0, reason: "fixture" }),
        } : {}),
      });
      const run = runner.run(request(target, { execution: { timeoutMs: 5000 } }), {
        onProgress(event) { sessionId = event.sessionId || sessionId; },
      });
      if (code) await assert.rejects(run, (error) => error.details.kind === "provider-auth");
      else assert.equal((await run).result.finalText, "DONE");
      assert.equal(sessionId, "real-child");
    });
  }
}
