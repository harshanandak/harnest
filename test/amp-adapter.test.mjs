import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { AmpAdapter } from "../src/adapters/amp.mjs";
import { normalizeRequest } from "../src/protocol.mjs";

class FakeStdin extends EventEmitter {
  constructor() {
    super();
    this.chunks = [];
    this.destroyed = false;
  }
  write(value) { this.chunks.push(String(value)); return true; }
  end() { this.emit("close"); }
  destroy() { this.destroyed = true; }
}

class FakeChild extends EventEmitter {
  constructor({ stdout = "", stderr = "", code = 0, hang = false } = {}) {
    super();
    this.killed = false;
    this.stdout = new EventEmitter();
    this.stdout.pause = () => {};
    this.stdout.resume = () => {};
    this.stderr = new EventEmitter();
    this.stdin = new FakeStdin();
    queueMicrotask(() => {
      if (stdout) this.stdout.emit("data", Buffer.from(stdout));
      if (stderr) this.stderr.emit("data", Buffer.from(stderr));
      if (!hang) {
        this.emit("exit", code, null);
        this.emit("close", code, null);
      }
    });
  }
  kill(signal = "SIGTERM") {
    if (this.killed) return false;
    this.killed = true;
    queueMicrotask(() => {
      this.emit("exit", null, signal);
      this.emit("close", null, signal);
    });
    return true;
  }
}

function stream(result = "Amp completed the task.", overrides = {}) {
  const sessionId = overrides.sessionId || "T-amp-session-1";
  const terminal = {
    type: "result",
    subtype: "success",
    session_id: sessionId,
    is_error: false,
    result,
    duration_ms: 125,
    num_turns: 2,
    usage: {
      input_tokens: 20,
      cache_creation_input_tokens: 3,
      cache_read_input_tokens: 7,
      output_tokens: 5,
      service_tier: "standard",
    },
    ...overrides.terminal,
  };
  return [
    JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, cwd: "/workspace", tools: ["Bash"] }),
    JSON.stringify({
      type: "assistant",
      session_id: sessionId,
      message: {
        id: "msg-1",
        type: "message",
        role: "assistant",
        model: "amp-native-model",
        content: [{ type: "text", text: "working" }],
        usage: terminal.usage,
      },
      parent_tool_use_id: null,
    }),
    JSON.stringify(terminal),
    "",
  ].join("\n");
}

function request(overrides = {}) {
  return normalizeRequest({
    target: "amp",
    requestId: "req-amp-001",
    task: "Return the Amp handoff result safely.",
    cwd: process.cwd(),
    context: { source: "amp-contract-test" },
    policy: { write: true, tools: [], maxCostUsd: null },
    ...overrides,
  });
}

function prepared(overrides = {}) {
  let cleaned = 0;
  return {
    value: {
      args: ["--settings-file", "/tmp/harnest-amp/settings.json"],
      env: { AMP_SKIP_UPDATE_CHECK: "1", AMP_REMOTE_CONTROL_TERMINAL: "0" },
      diagnostics: {
        effectivePolicy: { write: true, isolation: "best-effort-native-settings" },
        launchFlags: ["--settings-file"],
        limitations: ["read-only unsupported", "plugins are not a containment boundary"],
      },
      cleanup: async () => { cleaned += 1; },
      ...overrides,
    },
    cleaned: () => cleaned,
  };
}

test("Amp rejects native Windows before policy preparation or spawn", async () => {
  let preparedCount = 0;
  let spawned = 0;
  const adapter = new AmpAdapter({
    platform: "win32",
    command: "fake-amp",
    policyPreparer: async () => { preparedCount += 1; },
    spawnFn() { spawned += 1; return new FakeChild({ stdout: stream() }); },
  });
  await assert.rejects(adapter.run(request()), (error) => {
    assert.equal(error.details?.kind, "unavailable");
    assert.match(error.message, /whole Harnest MCP server inside Linux or WSL/i);
    return true;
  });
  assert.equal(preparedCount, 0);
  assert.equal(spawned, 0);
});

test("Amp launches the documented native macOS CLI through the attached contract", async () => {
  let preparedCount = 0;
  let spawned = 0;
  const policy = prepared();
  const adapter = new AmpAdapter({
    platform: "darwin",
    command: "fake-amp",
    policyPreparer: async () => { preparedCount += 1; return policy.value; },
    spawnFn(_command, args) {
      spawned += 1;
      assert.ok(args.includes("--executor"));
      assert.ok(args.includes("local"));
      assert.ok(args.includes("--stream-json"));
      return new FakeChild({ stdout: stream("macOS Amp completed.") });
    },
  });
  const output = await adapter.run(request());
  assert.equal(output.result.finalText, "macOS Amp completed.");
  assert.equal(output.sessionId, "T-amp-session-1");
  assert.equal(preparedCount, 1);
  assert.equal(spawned, 1);
  assert.equal(policy.cleaned(), 1);
});

test("Amp rejects unknown platforms before policy preparation or spawn", async () => {
  let preparedCount = 0;
  let spawned = 0;
  const adapter = new AmpAdapter({
    platform: "freebsd",
    command: "fake-amp",
    policyPreparer: async () => { preparedCount += 1; },
    spawnFn() { spawned += 1; return new FakeChild({ stdout: stream() }); },
  });
  await assert.rejects(adapter.run(request()), (error) => {
    assert.equal(error.details?.kind, "unavailable");
    assert.equal(error.details?.platform, "freebsd");
    assert.match(error.message, /macOS and Linux/);
    return true;
  });
  assert.equal(preparedCount, 0);
  assert.equal(spawned, 0);
});

test("Amp rejects read-only because native settings and plugins cannot enforce it", async () => {
  let spawned = 0;
  const adapter = new AmpAdapter({ platform: "linux", command: "fake-amp", spawnFn() { spawned += 1; return new FakeChild(); } });
  await assert.rejects(adapter.run(request({ policy: { write: false, tools: [], maxCostUsd: null } })), (error) => {
    assert.equal(error.details?.kind, "policy");
    assert.equal(error.details?.reason, "read-only-unenforceable");
    assert.match(error.message, /workspace settings|plugins/i);
    return true;
  });
  assert.equal(spawned, 0);
});

test("Amp rejects unsupported tools, budget, route controls, and session transport before spawn", async () => {
  let spawned = 0;
  const adapter = new AmpAdapter({ platform: "linux", command: "fake-amp", spawnFn() { spawned += 1; return new FakeChild(); } });
  const unsupportedTransport = request();
  unsupportedTransport.execution = { transport: "session" };
  const cases = [
    request({ policy: { write: true, tools: ["read"], maxCostUsd: null } }),
    request({ policy: { write: true, tools: { deny: ["read"] }, maxCostUsd: null } }),
    request({ policy: { write: true, tools: [], maxCostUsd: 1 } }),
    request({ route: { model: "some-model" } }),
    request({ route: { provider: "amp" } }),
    request({ route: { thinking: "high" } }),
    request({ route: { variant: "fast" } }),
    unsupportedTransport,
  ];
  for (const input of cases) {
    await assert.rejects(adapter.run(input), (error) => error.details?.kind === "policy");
  }
  assert.equal(spawned, 0);
});

test("Amp launches attached local execute mode with prompt over stdin and parses the terminal receipt", async () => {
  const calls = [];
  const policy = prepared();
  const adapter = new AmpAdapter({
    platform: "linux",
    command: "fake-amp",
    policyPreparer: async () => policy.value,
    spawnFn(command, args, options) {
      const child = new FakeChild({ stdout: stream() });
      calls.push({ command, args, options, child });
      return child;
    },
  });
  const output = await adapter.run(request({ route: { variant: "high" } }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "fake-amp");
  assert.deepEqual(calls[0].args, [
    "--settings-file", "/tmp/harnest-amp/settings.json",
    "--visibility", "private", "--no-notifications", "--no-ide",
    "--executor", "local", "-m", "high", "-x", "--stream-json", "--no-archive-after-execute",
  ]);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.cwd, process.cwd());
  const stdin = calls[0].child.stdin.chunks.join("");
  assert.match(stdin, /req-amp-001/);
  assert.match(stdin, /Return the Amp handoff result safely/);
  assert.ok(stdin.indexOf('"context"') < stdin.indexOf("TASK"), "stable context precedes the task");
  assert.equal(output.sessionId, "T-amp-session-1");
  assert.equal(output.workflowRunId, "amp:req-amp-001");
  assert.equal(output.route.harness, "amp");
  assert.equal(output.route.variant, "high");
  assert.equal(output.route.model, "amp-native-model");
  assert.equal(output.result.finalText, "Amp completed the task.");
  assert.deepEqual(output.usage, {
    inputTokens: 20,
    outputTokens: 5,
    cacheReadTokens: 7,
    cacheWriteTokens: 3,
    serviceTier: "standard",
    durationMs: 125,
    numTurns: 2,
  });
  assert.equal(output.execution.effectivePolicy.write, true);
  assert.match(JSON.stringify(output.execution.limitations), /read-only unsupported/);
  assert.equal(policy.cleaned(), 1);
});

test("Amp continuation uses the documented threads continue command and preserves session identity", async () => {
  const calls = [];
  const policy = prepared();
  const adapter = new AmpAdapter({
    platform: "linux",
    command: "fake-amp",
    policyPreparer: async () => policy.value,
    spawnFn(command, args) { calls.push(args); return new FakeChild({ stdout: stream("continued", { sessionId: "T-existing" }) }); },
  });
  const output = await adapter.run(request({ execution: { sessionId: "T-existing" } }));
  assert.deepEqual(calls[0], [
    "--settings-file", "/tmp/harnest-amp/settings.json",
    "--visibility", "private", "--no-notifications", "--no-ide", "--executor", "local",
    "threads", "continue", "T-existing", "-x", "--stream-json", "--no-archive-after-execute",
  ]);
  assert.equal(output.sessionId, "T-existing");
  assert.equal(output.result.finalText, "continued");
  assert.equal(output.route.variant, null);
  assert.equal(policy.cleaned(), 1);
});

test("Amp rejects an explicit mode for native continuation before preparation or spawn", async () => {
  let preparedCount = 0;
  let spawned = 0;
  const adapter = new AmpAdapter({
    platform: "linux",
    command: "fake-amp",
    policyPreparer: async () => { preparedCount += 1; return prepared().value; },
    spawnFn() { spawned += 1; return new FakeChild({ stdout: stream("continued", { sessionId: "T-existing" }) }); },
  });
  await assert.rejects(
    adapter.run(request({ route: { variant: "high" }, execution: { sessionId: "T-existing" } })),
    (error) => {
      assert.equal(error.details?.kind, "policy");
      assert.equal(error.details?.reason, "continuation-mode-owned-by-thread");
      assert.match(error.message, /existing thread retains its native mode/i);
      return true;
    },
  );
  assert.equal(preparedCount, 0);
  assert.equal(spawned, 0);
});

test("Amp awaits progress persistence before settling", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let progressCalls = 0;
  const policy = prepared();
  const adapter = new AmpAdapter({
    platform: "linux",
    command: "fake-amp",
    policyPreparer: async () => policy.value,
    spawnFn() { return new FakeChild({ stdout: stream() }); },
  });
  let settled = false;
  const running = adapter.run(request(), {
    onProgress(event) {
      progressCalls += 1;
      if (event.type === "amp_delta") return gate;
    },
  }).finally(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  release();
  await running;
  assert.ok(progressCalls >= 2);
});

test("Amp redacts credentials from assistant progress", async () => {
  const progress = [];
  const policy = prepared();
  const sessionId = "T-redacted";
  const stdout = [
    JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, cwd: "/workspace", tools: [] }),
    JSON.stringify({ type: "assistant", session_id: sessionId, message: { model: "amp-native-model", content: [{ type: "text", text: "Authorization: Bearer top-secret-value" }] } }),
    JSON.stringify({ type: "result", subtype: "success", session_id: sessionId, is_error: false, result: "safe final", duration_ms: 1, num_turns: 1 }),
    "",
  ].join("\n");
  const adapter = new AmpAdapter({
    platform: "linux",
    command: "fake-amp",
    policyPreparer: async () => policy.value,
    spawnFn() { return new FakeChild({ stdout }); },
  });
  await adapter.run(request(), { onProgress(event) { progress.push(event); } });
  const delta = progress.find((event) => event.type === "amp_delta");
  assert.ok(delta);
  assert.doesNotMatch(delta.text, /top-secret-value/);
  assert.match(delta.text, /REDACTED/);
});

test("Amp redacts credentials from plain and structured completed results", async () => {
  const completions = [
    {
      value: "Completed with api_key=plain-secret-value and token: plain-token-value",
      assertResult(result) {
        assert.match(result.finalText, /\[REDACTED\]/);
        assert.match(result.summary, /\[REDACTED\]/);
      },
    },
    {
      value: JSON.stringify({
        finalText: "Done with password=json-password-value",
        summary: "Authorization: Bearer json-bearer-value",
        evidence: ["API_KEY=json-evidence-value"],
        tests: ["token=json-test-value"],
        risks: ["secret=json-risk-value"],
      }),
      assertResult(result) {
        assert.equal(result.evidence.length, 1);
        assert.equal(result.tests.length, 1);
        assert.equal(result.risks.length, 1);
      },
    },
  ];
  for (const completion of completions) {
    const policy = prepared();
    const adapter = new AmpAdapter({
      platform: "linux",
      command: "fake-amp",
      policyPreparer: async () => policy.value,
      spawnFn() { return new FakeChild({ stdout: stream(completion.value) }); },
    });
    const output = await adapter.run(request());
    completion.assertResult(output.result);
    const serialized = JSON.stringify(output.result);
    for (const credential of [
      "plain-secret-value",
      "plain-token-value",
      "json-password-value",
      "json-bearer-value",
      "json-evidence-value",
      "json-test-value",
      "json-risk-value",
    ]) {
      assert.ok(!serialized.includes(credential), `completed result leaked ${credential}`);
    }
    assert.match(serialized, /\[REDACTED\]/);
    assert.equal(policy.cleaned(), 1);
  }
});

test("Amp rejects missing, empty, and unsuccessful terminal results", async () => {
  const outputs = [
    `${JSON.stringify({ type: "system", subtype: "init", session_id: "T-missing" })}\n`,
    stream("   "),
    stream("ignored", { terminal: { subtype: "error_during_execution", is_error: true, result: undefined, error: "tool execution failed" } }),
  ];
  for (const stdout of outputs) {
    const policy = prepared();
    const adapter = new AmpAdapter({
      platform: "linux",
      command: "fake-amp",
      policyPreparer: async () => policy.value,
      spawnFn() { return new FakeChild({ stdout }); },
    });
    await assert.rejects(adapter.run(request()), (error) => error.details?.kind === "downstream");
    assert.equal(policy.cleaned(), 1);
  }
});

test("Amp requires a valid terminal session identity and rejects identity conflicts", async () => {
  const cases = [
    stream("missing terminal identity", { terminal: { session_id: undefined } }),
    stream("conflicting identity", { sessionId: "T-init", terminal: { session_id: "T-other" } }),
    stream("invalid identity", { terminal: { session_id: "not-a-thread" } }),
  ];
  for (const stdout of cases) {
    const policy = prepared();
    const adapter = new AmpAdapter({
      platform: "linux",
      command: "fake-amp",
      policyPreparer: async () => policy.value,
      spawnFn() { return new FakeChild({ stdout }); },
    });
    await assert.rejects(adapter.run(request()), (error) => {
      assert.equal(error.details?.kind, "downstream");
      assert.match(error.message, /session identity/i);
      return true;
    });
    assert.equal(policy.cleaned(), 1);
  }
});

test("Amp keeps an unreported resolved model null instead of inventing one", async () => {
  const policy = prepared();
  const sessionId = "T-no-model";
  const stdout = [
    JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, cwd: "/workspace", tools: [] }),
    JSON.stringify({ type: "result", subtype: "success", session_id: sessionId, is_error: false, result: "complete", duration_ms: 1, num_turns: 1 }),
    "",
  ].join("\n");
  const adapter = new AmpAdapter({
    platform: "linux",
    command: "fake-amp",
    policyPreparer: async () => policy.value,
    spawnFn() { return new FakeChild({ stdout }); },
  });
  const output = await adapter.run(request());
  assert.equal(output.route.model, null);
});

test("Amp does not coerce null, boolean, or numeric-string usage counters", async () => {
  const policy = prepared();
  const stdout = stream("strict usage", {
    terminal: {
      usage: {
        input_tokens: null,
        output_tokens: true,
        cache_read_input_tokens: "7",
        cache_creation_input_tokens: 3,
      },
    },
  });
  const adapter = new AmpAdapter({
    platform: "linux",
    command: "fake-amp",
    policyPreparer: async () => policy.value,
    spawnFn() { return new FakeChild({ stdout }); },
  });
  const output = await adapter.run(request());
  assert.equal(output.usage.inputTokens, null);
  assert.equal(output.usage.outputTokens, null);
  assert.equal(output.usage.cacheReadTokens, null);
  assert.equal(output.usage.cacheWriteTokens, 3);
});

test("Amp classifies native authentication and model failures without exposing credentials", async () => {
  const cases = [
    { stderr: "Error: Invalid or missing API key. Run 'amp login' to authenticate.", kind: "provider-auth" },
    { stderr: "Error: requested model is not available", kind: "unavailable" },
  ];
  for (const item of cases) {
    const policy = prepared();
    const adapter = new AmpAdapter({
      platform: "linux",
      command: "fake-amp",
      policyPreparer: async () => policy.value,
      spawnFn() { return new FakeChild({ stderr: item.stderr, code: 1 }); },
    });
    await assert.rejects(adapter.run(request()), (error) => error.details?.kind === item.kind && !JSON.stringify(error).includes("sgamp_"));
    assert.equal(policy.cleaned(), 1);
  }
});

test("Amp distinguishes abort and timeout and always cleans prepared settings", async () => {
  const abortPolicy = prepared();
  const abortAdapter = new AmpAdapter({
    platform: "linux",
    command: "fake-amp",
    policyPreparer: async () => abortPolicy.value,
    spawnFn() { return new FakeChild({ hang: true }); },
  });
  const controller = new AbortController();
  const aborted = abortAdapter.run(request(), { signal: controller.signal });
  controller.abort();
  await assert.rejects(aborted, (error) => error.details?.kind === "abort");
  assert.equal(abortPolicy.cleaned(), 1);

  const timeoutPolicy = prepared();
  const timeoutAdapter = new AmpAdapter({
    platform: "linux",
    command: "fake-amp",
    policyPreparer: async () => timeoutPolicy.value,
    spawnFn() { return new FakeChild({ hang: true }); },
  });
  await assert.rejects(timeoutAdapter.run(request({ execution: { timeoutMs: 10 } })), (error) => error.details?.kind === "timeout");
  assert.equal(timeoutPolicy.cleaned(), 1);
});

test("Amp owns cancellation and timeout during async policy preparation", async () => {
  for (const mode of ["abort", "timeout"]) {
    let resolvePreparation;
    let cleaned = 0;
    let seenSignal = null;
    const candidate = prepared({ cleanup: async () => { cleaned += 1; } }).value;
    const adapter = new AmpAdapter({
      platform: "linux",
      command: "fake-amp",
      policyPreparer: ({ signal }) => {
        seenSignal = signal;
        return new Promise((resolve) => { resolvePreparation = () => resolve(candidate); });
      },
      spawnFn() { throw new Error("must not spawn"); },
    });
    const controller = new AbortController();
    const running = adapter.run(request({ execution: mode === "timeout" ? { timeoutMs: 10 } : undefined }), { signal: controller.signal });
    if (mode === "abort") controller.abort();
    await assert.rejects(running, (error) => error.details?.kind === mode);
    assert.ok(seenSignal instanceof AbortSignal);
    assert.equal(seenSignal.aborted, true);
    resolvePreparation();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cleaned, 1, "late preparation is cleaned after cancellation");
  }
});

test("Amp cleans a preparer candidate whose contract normalization fails", async () => {
  let cleaned = 0;
  const adapter = new AmpAdapter({
    platform: "linux",
    command: "fake-amp",
    policyPreparer: async () => ({
      args: [42],
      diagnostics: { effectivePolicy: { write: true } },
      cleanup: async () => { cleaned += 1; },
    }),
    spawnFn() { throw new Error("must not spawn"); },
  });
  await assert.rejects(adapter.run(request()), (error) => error.details?.kind === "policy");
  assert.equal(cleaned, 1);
});

test("Amp rejects oversized stream lines through the bounded process runner", async () => {
  const policy = prepared();
  const adapter = new AmpAdapter({
    platform: "linux",
    command: "fake-amp",
    policyPreparer: async () => policy.value,
    spawnFn() { return new FakeChild({ stdout: `${"x".repeat(2 * 1024 * 1024 + 1)}\n` }); },
  });
  await assert.rejects(adapter.run(request()), (error) => error.details?.kind === "output-limit");
  assert.equal(policy.cleaned(), 1);
});

test("Amp rejects a terminal result that exceeds the parent receipt bound", async () => {
  const policy = prepared();
  const adapter = new AmpAdapter({
    platform: "linux",
    command: "fake-amp",
    policyPreparer: async () => policy.value,
    spawnFn() { return new FakeChild({ stdout: stream("x".repeat(64_001)) }); },
  });
  await assert.rejects(adapter.run(request()), (error) => {
    assert.equal(error.details?.kind, "output-limit");
    assert.equal(error.details?.maxFinalChars, 64_000);
    return true;
  });
  assert.equal(policy.cleaned(), 1);
});

test("Amp inherits native authentication environment without reading or returning it", async () => {
  const calls = [];
  const policy = prepared();
  const key = "HARNEST_TEST_AMP_ENV";
  const saved = process.env[key];
  process.env[key] = "inherited";
  try {
    const adapter = new AmpAdapter({
      platform: "linux",
      command: "fake-amp",
      env: { AMP_SKIP_UPDATE_CHECK: "1" },
      policyPreparer: async () => policy.value,
      spawnFn(command, args, options) { calls.push(options.env); return new FakeChild({ stdout: stream() }); },
    });
    const output = await adapter.run(request());
    assert.equal(calls[0][key], "inherited");
    assert.equal(calls[0].AMP_SKIP_UPDATE_CHECK, "1");
    assert.doesNotMatch(JSON.stringify(output), /AMP_API_KEY|sgamp_/);
  } finally {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
});

test("Amp control fails closed; follow-up requires native continuation", async () => {
  const adapter = new AmpAdapter({ platform: "linux", command: "fake-amp" });
  await assert.rejects(adapter.control({ commandId: "amp-control", kind: "message", message: "continue" }), (error) => {
    assert.equal(error.details?.kind, "unsupported-control");
    assert.match(error.message, /execution\.sessionId/);
    return true;
  });
});
