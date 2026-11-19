import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import test from "node:test";
import ClaudeSessionAdapter, {
  ClaudeSessionAdapter as NamedClaudeSessionAdapter,
  SESSION_CAPABILITIES,
} from "../src/adapters/claude-session.mjs";
import { normalizeRequest } from "../src/protocol.mjs";
import { sessionProgressTrace } from "../scripts/fixtures/session-progress-trace.mjs";

const fixture = JSON.parse(readFileSync(new URL("../scripts/fixtures/claude-session-stream.json", import.meta.url), "utf8"));

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clone(value) {
  return structuredClone(value);
}

/**
 * Fake of the SDK `query()` streaming surface. It consumes the adapter's
 * AsyncIterable prompt exactly as Query.streamInput does (writing each
 * SDKUserMessage to the child) and lets tests script the outbound messages.
 */
class FakeQuery {
  constructor({ prompt, options, consume = true, interruptReceipt } = {}) {
    this.prompt = prompt;
    this.options = options;
    this.messages = [];
    this.received = [];
    this.waiters = [];
    this.receivedWaiters = [];
    this.done = false;
    this.closed = false;
    this.interrupts = 0;
    this.interruptReceipt = interruptReceipt ?? { still_queued: [] };
    this.models = [];
    this.permissionModes = [];
    if (consume) this.inputLoop = this.#consumeInput();
  }

  async #consumeInput() {
    try {
      for await (const message of this.prompt) {
        this.received.push(message);
        for (const waiter of this.receivedWaiters.splice(0)) waiter();
      }
    } catch {
      // The adapter ends the prompt iterator during shutdown.
    }
  }

  waitForInput(count = 1, timeoutMs = 2_000) {
    if (this.received.length >= count) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`fake SDK never received ${count} input message(s)`)), timeoutMs);
      timer.unref?.();
      const waiter = () => {
        if (this.received.length < count) {
          this.receivedWaiters.push(waiter);
          return;
        }
        clearTimeout(timer);
        resolve();
      };
      this.receivedWaiters.push(waiter);
    });
  }

  emit(message) {
    if (this.done || this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: message, done: false });
    else this.messages.push(message);
  }

  [Symbol.asyncIterator]() {
    return this;
  }

  next() {
    if (this.messages.length) return Promise.resolve({ value: this.messages.shift(), done: false });
    if (this.done || this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  return() {
    this.close();
    return Promise.resolve({ value: undefined, done: true });
  }

  /** Ends the outbound stream without marking the query closed, like an early process exit. */
  end() {
    this.done = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  async interrupt() {
    this.interrupts += 1;
    return this.interruptReceipt;
  }

  async setModel(model) {
    this.models.push(model);
  }

  async setPermissionMode(mode) {
    this.permissionModes.push(mode);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.done = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }
}

function makeAdapter({ consume = true, interruptReceipt, ...options } = {}) {
  const queries = [];
  const sdk = {
    query(params) {
      const query = new FakeQuery({ prompt: params.prompt, options: params.options, consume, interruptReceipt });
      queries.push(query);
      return query;
    },
  };
  const adapter = new ClaudeSessionAdapter({ command: "fake-claude", query: sdk.query, ...options });
  return { adapter, queries };
}

async function waitForQuery(queries, count = 1) {
  const deadline = Date.now() + 2_000;
  while (queries.length < count) {
    if (Date.now() > deadline) throw new Error("fake SDK query was not created");
    await delay(5);
  }
  return queries[count - 1];
}

function request(overrides = {}) {
  return normalizeRequest({
    target: "claude",
    requestId: "req-claude-session-001",
    task: "Return the handoff result.",
    cwd: process.cwd(),
    context: { source: "deterministic-test" },
    policy: { write: false, tools: [], maxCostUsd: null },
    ...overrides,
  });
}

function resultEvent(overrides = {}) {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: fixture.sessionId,
    result: "done",
    stop_reason: "end_turn",
    num_turns: 1,
    total_cost_usd: 0.01,
    usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: {},
    permission_denials: [],
    ...overrides,
  };
}

function trackSettlement(promise) {
  const state = { settled: false };
  promise.then(() => { state.settled = true; }, () => { state.settled = true; });
  return state;
}

test("Claude session adapter exposes an honest capability matrix and both exports", () => {
  assert.equal(NamedClaudeSessionAdapter, ClaudeSessionAdapter);
  assert.equal(ClaudeSessionAdapter.SESSION_CAPABILITIES, SESSION_CAPABILITIES);
  assert.equal(SESSION_CAPABILITIES.transport, "session");
  for (const capability of ["steer", "followUp", "reroute", "resume", "interrupt", "permissionMode", "partialMessages", "usage"]) {
    assert.equal(SESSION_CAPABILITIES[capability], true, `${capability} is advertised`);
  }
  assert.equal(SESSION_CAPABILITIES.acknowledgement.message, "sdk-user-message-uuid-consumed");
  assert.equal(SESSION_CAPABILITIES.acknowledgement.reroute, "cli-control-response");
  assert.equal(SESSION_CAPABILITIES.followUpScheduling, "local-deferred-next-turn");
});

test("Claude session run uses streaming input with native plan-mode policy", async () => {
  const { adapter, queries } = makeAdapter();
  const progress = [];
  const runPromise = adapter.run(request(), { onProgress: (event) => { progress.push(event); } });
  const query = await waitForQuery(queries);
  await query.waitForInput(1);

  const options = query.options;
  assert.equal(typeof query.prompt[Symbol.asyncIterator], "function", "the SDK receives an async iterable prompt");
  assert.equal(options.permissionMode, "plan");
  assert.equal(options.permissionPrompts, "none");
  assert.equal(options.includePartialMessages, true);
  assert.equal(options.pathToClaudeCodeExecutable, "fake-claude");
  assert.equal(options.cwd, process.cwd());
  assert.equal(options.allowDangerouslySkipPermissions, undefined, "bypass flags are never set");
  assert.equal(options.canUseTool, undefined, "permissionPrompts none keeps the native permission surface");
  assert.equal(options.maxBudgetUsd, undefined);
  const envKeys = new Map(Object.keys(options.env || {}).map((key) => [key.toLowerCase(), key]));
  assert.ok(envKeys.has("path"), "the parent environment reaches the harness");

  const message = query.received[0];
  assert.equal(message.type, "user");
  assert.equal(message.parent_tool_use_id, null);
  assert.match(message.uuid, /^[0-9a-f-]{36}$/);
  const content = message.message.content;
  assert.match(content, /req-claude-session-001/);
  assert.match(content, /Return the handoff result/);
  assert.ok(content.indexOf('"context"') < content.indexOf('"requestId"'), "stable context precedes request identifiers");
  assert.ok(content.indexOf('"requestId"') < content.indexOf("\nTASK\n"), "the task follows the identifier tail");

  for (const event of clone(fixture.turns[0].events)) query.emit(event);
  const output = await runPromise;
  assert.equal(output.sessionId, fixture.sessionId);
  assert.equal(output.workflowRunId, "claude:req-claude-session-001");
  assert.equal(output.route.harness, "claude");
  assert.equal(output.route.provider, "anthropic");
  assert.equal(output.result.finalText, "first turn complete");
  assert.equal(output.usage.inputTokens, 100);
  assert.equal(output.usage.outputTokens, 20);
  assert.equal(output.usage.totalCostUsd, 0.01);
  assert.deepEqual(output.usageSummary, {
    inputTokens: 115,
    uncachedInputTokens: 100,
    inputSemantics: "exclusive",
    outputTokens: 20,
    cacheReadTokens: 10,
    cacheWriteTokens: 5,
    costUsd: 0.01,
  });
  assert.ok(output.result.eventSummary.count >= 5);
  assert.ok(output.result.eventSummary.types.includes("result"));
  await adapter.close();
});

test("Claude session reuses one live SDK query for an explicit matching session across two turns", async () => {
  const { adapter, queries } = makeAdapter();
  const first = adapter.run(request());
  const query = await waitForQuery(queries);
  await query.waitForInput(1);
  for (const event of clone(fixture.turns[0].events)) query.emit(event);
  const out1 = await first;

  const second = adapter.run(request({ requestId: "req-claude-session-002", execution: { sessionId: out1.sessionId } }));
  await query.waitForInput(2);
  assert.notEqual(query.received[1].uuid, query.received[0].uuid, "each turn has its own native turn id");
  assert.match(query.received[1].message.content, /req-claude-session-002/);
  for (const event of clone(fixture.turns[1].events)) query.emit(event);
  const out2 = await second;

  assert.equal(queries.length, 1, "the live session is reused, not restarted");
  assert.equal(query.closed, false);
  assert.equal(out2.result.finalText, "second turn complete");
  assert.equal(out2.usage.totalCostUsd, 0.01, "per-turn cost is the cumulative delta");
  assert.equal(out2.usage.sessionTotalCostUsd, 0.02, "the cumulative session total stays reported");
  await adapter.close();
});

test("Claude session steer acknowledges only after the SDK echoes the message uuid", async () => {
  const { adapter, queries } = makeAdapter();
  const runPromise = adapter.run(request());
  const query = await waitForQuery(queries);
  await query.waitForInput(1);

  const steer = adapter.control({ commandId: "cmd-steer-1", kind: "message", delivery: "steer", message: "prefer the smaller fix" });
  const settlement = trackSettlement(steer);
  await query.waitForInput(2);
  await delay(20);
  assert.equal(settlement.settled, false, "SDK input delivery alone is not an acknowledgement");

  const steerUuid = query.received[1].uuid;
  query.emit(resultEvent({ result: "first", user_message_uuids: [query.received[0].uuid] }));
  await delay(20);
  assert.equal(settlement.settled, false, "a result that does not echo the steer keeps the run open");

  query.emit(resultEvent({ result: "second", user_message_uuids: [steerUuid] }));
  const ack = await steer;
  assert.equal(ack.state, "consumed");
  assert.equal(ack.acknowledged, true);
  assert.equal(ack.consumed, true);
  assert.equal(ack.evidence, "sdk-user-message-uuid");
  assert.equal(ack.messageUuid, steerUuid);

  const output = await runPromise;
  assert.equal(output.result.finalText, "first", "the run returns its own turn result");
  assert.equal(output.usage.inputTokens, 20, "usage from both turns is aggregated");

  const duplicate = await adapter.control({ commandId: "cmd-steer-1", kind: "message", delivery: "steer", message: "prefer the smaller fix" });
  assert.strictEqual(duplicate, ack, "a repeated identical command returns the same receipt");
  await assert.rejects(
    adapter.control({ commandId: "cmd-steer-1", kind: "message", delivery: "steer", message: "different guidance" }),
    (error) => error.details?.kind === "invalid-control",
  );
  assert.equal(query.received.length, 2, "duplicate controls never re-send the message");
  await adapter.close();
});

test("Claude session follow_up is deferred to the next turn instead of sharing the current SDK queue", async () => {
  const { adapter, queries } = makeAdapter();
  const runPromise = adapter.run(request());
  const query = await waitForQuery(queries);
  await query.waitForInput(1);

  const follow = adapter.control({ commandId: "cmd-follow-1", kind: "message", delivery: "follow_up", message: "then summarize" });
  await delay(20);
  assert.equal(query.received.length, 1, "follow_up is held locally until the current turn settles");

  query.emit(resultEvent({ result: "first", user_message_uuids: [query.received[0].uuid] }));
  await query.waitForInput(2);
  assert.equal(query.received[1].message.content, "then summarize", "follow_up is delivered as its own next turn");

  const followUuid = query.received[1].uuid;
  query.emit(resultEvent({ result: "second", user_message_uuids: [followUuid] }));
  const ack = await follow;
  assert.equal(ack.consumed, true);
  const output = await runPromise;
  assert.equal(output.result.finalText, "first");
  await adapter.close();
});

test("Claude session accepts stream_event and assistant uuid echoes as consumption evidence", async () => {
  const { adapter, queries } = makeAdapter();
  const runPromise = adapter.run(request());
  const query = await waitForQuery(queries);
  await query.waitForInput(1);

  const steer = adapter.control({ commandId: "cmd-echo-1", kind: "message", delivery: "steer", message: "also check tests" });
  await query.waitForInput(2);
  const steerUuid = query.received[1].uuid;
  query.emit({
    type: "stream_event",
    session_id: fixture.sessionId,
    user_message_uuid: steerUuid,
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "ok" } },
  });
  const ack = await steer;
  assert.equal(ack.consumed, true);
  assert.equal(ack.evidence, "sdk-user-message-uuid");

  query.emit(resultEvent({ result: "done", user_message_uuids: [query.received[0].uuid] }));
  await runPromise;
  await adapter.close();
});

test("Claude session reroute applies setModel and rejects non-anthropic providers", async () => {
  const { adapter, queries } = makeAdapter();
  const runPromise = adapter.run(request());
  const query = await waitForQuery(queries);
  await query.waitForInput(1);

  const ack = await adapter.control({ commandId: "cmd-reroute-1", kind: "reroute", route: { provider: "anthropic", model: "opus" } });
  assert.equal(ack.command, "set_model");
  assert.equal(ack.model, "opus");
  assert.equal(ack.applied, true);
  assert.equal(ack.effect, "next_model_request");
  assert.equal(ack.acknowledgement, "cli-control-response");
  assert.deepEqual(query.models, ["opus"]);

  await assert.rejects(
    adapter.control({ commandId: "cmd-reroute-2", kind: "reroute", route: { provider: "openai", model: "gpt-5" } }),
    (error) => error.details?.kind === "invalid-control",
  );
  assert.deepEqual(query.models, ["opus"], "a rejected reroute never reaches setModel");

  query.emit(resultEvent({ result: "rerouted", user_message_uuids: [query.received[0].uuid] }));
  await runPromise;
  const follow = adapter.run(request({ requestId: "req-reroute-follow", route: { provider: "anthropic", model: "opus" }, execution: { sessionId: fixture.sessionId } }));
  await query.waitForInput(2);
  query.emit(resultEvent({ result: "follow", user_message_uuids: [query.received[1].uuid] }));
  const output = await follow;
  assert.equal(queries.length, 1, "the rerouted session stays reusable for the matching model");
  assert.equal(output.result.finalText, "follow");
  await adapter.close();
});

test("Claude session rejects unmappable policy and workflow graphs before launch", async () => {
  const { adapter, queries } = makeAdapter();
  await assert.rejects(
    adapter.run(request({ policy: { write: false, tools: ["Read"] } })),
    (error) => error.details?.kind === "policy" && /tools/.test(error.message),
  );
  await assert.rejects(
    adapter.run(request({ policy: { write: false, tools: { deny: ["Read"] } } })),
    (error) => error.details?.kind === "policy" && /tools/.test(error.message),
  );
  await assert.rejects(
    adapter.run(request({ workflow: { spec: { name: "flow" } } })),
    (error) => error.details?.kind === "policy",
  );
  await assert.rejects(
    adapter.run(request({ policy: { write: false, maxCostUsd: 0 } })),
    (error) => error.details?.kind === "policy",
  );
  assert.equal(queries.length, 0, "rejected requests never spawn the SDK");
  assert.equal(adapter.session, null);
});

test("Claude session maps write policy to acceptEdits without bypass flags", async () => {
  const { adapter, queries } = makeAdapter();
  const runPromise = adapter.run(request({ policy: { write: true, maxCostUsd: 2.5 } }));
  const query = await waitForQuery(queries);
  await query.waitForInput(1);
  assert.equal(query.options.permissionMode, "acceptEdits");
  assert.equal(query.options.maxBudgetUsd, 2.5);
  assert.equal(query.options.allowDangerouslySkipPermissions, undefined);
  query.emit(resultEvent());
  await runPromise;
  await adapter.close();
});

test("Claude session resume failure fails closed instead of starting a new conversation", async () => {
  const { adapter, queries } = makeAdapter();
  const runPromise = adapter.run(request({ execution: { sessionId: "missing-session-9" } }));
  const query = await waitForQuery(queries);
  assert.equal(query.options.resume, "missing-session-9");
  await query.waitForInput(1);
  query.emit(resultEvent({
    subtype: "error_during_execution",
    is_error: true,
    session_id: "missing-session-9",
    result: "",
    errors: ["No conversation found with session ID: missing-session-9"],
    num_turns: 0,
    total_cost_usd: 0,
  }));
  await assert.rejects(runPromise, (error) => error.details?.resumeFailed === true && /resume failed/.test(error.message));
  assert.equal(queries.length, 1, "no second query is created on resume failure");
  assert.equal(adapter.session.closed, true, "the unusable resume query is torn down");
});

test("Claude session cancellation hard-closes its own query and close() is idempotent", async () => {
  const { adapter, queries } = makeAdapter();
  const controller = new AbortController();
  const runPromise = adapter.run(request(), { signal: controller.signal });
  const query = await waitForQuery(queries);
  await query.waitForInput(1);
  controller.abort();
  await assert.rejects(runPromise, (error) => error.details?.kind === "abort" && error.details?.aborted === true);
  assert.equal(query.closed, true, "the adapter's SDK query is force-closed on cancellation");
  await adapter.close();
  await adapter.close();
  assert.equal(adapter.session, null);
});

test("Claude session reports partial usage for a cancelled turn that never reached a result", async () => {
  const { adapter, queries } = makeAdapter();
  const controller = new AbortController();
  const runPromise = adapter.run(request(), { signal: controller.signal });
  const query = await waitForQuery(queries);
  await query.waitForInput(1);
  query.emit({
    type: "assistant",
    session_id: fixture.sessionId,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "working" }],
      usage: { input_tokens: 40, output_tokens: 12, cache_read_input_tokens: 3, cache_creation_input_tokens: 1 },
    },
  });
  await delay(10);
  controller.abort();
  await assert.rejects(runPromise, (error) => {
    assert.equal(error.details?.kind, "abort");
    assert.equal(error.details?.usagePartial, true, "the accumulated usage is marked as a lower bound");
    assert.equal(error.details?.usage?.inputTokens, 40);
    assert.equal(error.details?.usage?.outputTokens, 12);
    assert.equal(error.details?.usageSummary?.cacheReadTokens, 3);
    return true;
  });
});

test("Claude session idle eviction closes the query it owns", async () => {
  const { adapter, queries } = makeAdapter({ idleTimeoutMs: 25 });
  const runPromise = adapter.run(request());
  const query = await waitForQuery(queries);
  await query.waitForInput(1);
  query.emit(resultEvent());
  await runPromise;
  assert.equal(query.closed, false);
  await delay(80);
  assert.equal(query.closed, true);
  assert.equal(adapter.session, null);
  await adapter.close();
});

test("Claude session awaits slow onProgress before continuing and before settling", async () => {
  const { adapter, queries } = makeAdapter();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const seen = [];
  const runPromise = adapter.run(request(), {
    onProgress: (event) => {
      seen.push(event.type);
      if (event.type === "claude_delta") return gate;
    },
  });
  const query = await waitForQuery(queries);
  await query.waitForInput(1);
  query.emit({ type: "stream_event", session_id: fixture.sessionId, event: { type: "message_start" } });
  query.emit({ type: "stream_event", session_id: fixture.sessionId, event: { type: "content_block_delta", delta: { type: "text_delta", text: "slow" } } });
  query.emit({ type: "stream_event", session_id: fixture.sessionId, event: { type: "message_stop" } });
  query.emit(resultEvent());
  await delay(20);
  assert.deepEqual(seen, ["claude_delta"], "the consumer parks on the progress promise");

  const settlement = trackSettlement(runPromise);
  await delay(20);
  assert.equal(settlement.settled, false, "the run does not settle while progress is unapplied");

  release();
  const output = await runPromise;
  assert.equal(output.result.finalText, "done");
  await adapter.close();
});

test("Claude session surfaces a progress callback failure as a transport failure", async () => {
  const { adapter, queries } = makeAdapter();
  const runPromise = adapter.run(request(), { onProgress: () => { throw new Error("ledger write failed"); } });
  const query = await waitForQuery(queries);
  await query.waitForInput(1);
  query.emit(resultEvent());
  await assert.rejects(runPromise, (error) => error.details?.kind === "transport" && /progress callback failed/.test(error.message));
  assert.equal(query.closed, true, "a failed progress consumer does not leave an orphaned query");
});

test("#27 Claude session caps UTF-8 result text before emitting progress", async (t) => {
  const { adapter, queries } = makeAdapter();
  t.after(() => adapter.close());
  const progress = [];
  const run = adapter.run(request(), { onProgress: (event) => progress.push(event) });
  const query = await waitForQuery(queries);
  await query.waitForInput(1);
  const rejected = assert.rejects(run, (error) =>
    error.details?.kind === "output-limit" && error.details.maxBytes === 1024 * 1024);
  query.emit(resultEvent({ result: "€".repeat(400_000) }));
  await rejected;
  assert.equal(progress.some((event) => event.type === "claude_result"), false);
});

test("#27 Claude session caps a split wire frame before the SDK JSON parser sees it", async (t) => {
  let parsed = 0;
  const adapter = new ClaudeSessionAdapter({
    command: "fake-claude",
    query({ prompt, options }) {
      let child;
      return {
        close() { child?.kill(); },
        async *[Symbol.asyncIterator]() {
          await prompt[Symbol.asyncIterator]().next();
          const args = ["-e", `const frame = ${JSON.stringify(resultEvent({ result: "" }))};
            frame.result = 'x'.repeat(2 * 1024 * 1024);
            const line = JSON.stringify(frame);
            for (let offset = 0; offset < line.length; offset += 65536) {
              process.stdout.write(line.slice(offset, offset + 65536));
            }
            process.stdout.write('\\n');`];
          const launch = options.spawnClaudeCodeProcess
            ?? (({ command, args }) => spawn(command, args, { windowsHide: true }));
          child = launch({ command: process.execPath, args, cwd: options.cwd, env: {}, signal: new AbortController().signal });
          const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
          for await (const line of lines) {
            parsed += 1;
            yield JSON.parse(line);
          }
        },
      };
    },
  });
  t.after(() => adapter.close());
  await assert.rejects(adapter.run(request()), (error) =>
    error.details?.kind === "output-limit" && error.details.maxBytes === 2 * 1024 * 1024);
  assert.equal(parsed, 0);
});

test("Claude session bounds queues, event-type summaries, progress text, and stderr tails", async () => {
  const { adapter, queries } = makeAdapter({ maxQueueBytes: 4096 });
  const progress = [];
  const runPromise = adapter.run(request(), { onProgress: (event) => { progress.push(event); } });
  const query = await waitForQuery(queries);
  await query.waitForInput(1);

  await assert.rejects(
    adapter.control({ commandId: "cmd-huge-1", kind: "message", delivery: "steer", message: "y".repeat(8192) }),
    (error) => error.details?.kind === "queue-limit",
  );
  await assert.rejects(
    adapter.control({ commandId: "cmd-huge-2", kind: "message", delivery: "follow_up", message: "y".repeat(8192) }),
    (error) => error.details?.kind === "queue-limit",
    "the deferred follow_up queue is byte-bounded too",
  );

  query.emit({ type: "assistant", session_id: fixture.sessionId, message: { role: "assistant", content: [{ type: "text", text: "z".repeat(9_000) }] } });
  await delay(10);
  const delta = progress.find((event) => event.type === "claude_delta");
  assert.ok(delta && delta.text.length <= 2_001, "progress text is bounded");

  for (let index = 0; index < 300; index += 1) query.emit({ type: `custom_type_${index}` });
  query.options.stderr("s".repeat(100 * 1024));
  query.emit(resultEvent({ result: "bounded", user_message_uuids: [query.received[0].uuid] }));
  const output = await runPromise;
  assert.equal(output.result.finalText, "bounded");
  assert.equal(output.result.eventSummary.types.length, 20, "the event summary keeps the last 20 types");
  assert.equal(output.result.eventSummary.typesTruncated, true, "the 256-type cap is reported honestly");
  assert.ok(!JSON.stringify(progress).includes("s".repeat(1024)), "stderr is never forwarded through progress");
  await adapter.close();
});

test("Claude session fails closed when guidance is never delivered or acknowledged", async () => {
  const { adapter, queries } = makeAdapter({ consume: false, controlTimeoutMs: 30 });
  const runPromise = adapter.run(request());
  runPromise.catch(() => {});
  await waitForQuery(queries);
  await assert.rejects(
    adapter.control({ commandId: "cmd-stuck-1", kind: "message", delivery: "steer", message: "never delivered" }),
    (error) => error.details?.kind === "control"
      && error.details?.uncertain === false
      && error.details?.delivered === false
      && error.details?.failClosed === true,
  );
  await adapter.close();
  await assert.rejects(runPromise, () => true);
});

test("Claude session fails closed as soon as uuid consumption evidence is proven unavailable", async () => {
  const { adapter, queries } = makeAdapter({ controlTimeoutMs: 5_000 });
  const runPromise = adapter.run(request());
  runPromise.catch(() => {});
  const query = await waitForQuery(queries);
  await query.waitForInput(1);

  const steer = adapter.control({ commandId: "cmd-nouuid-1", kind: "message", delivery: "steer", message: "more" });
  await query.waitForInput(2);
  // An older producer's result carries no uuid fields: consumption is unprovable.
  const started = Date.now();
  query.emit(resultEvent({ result: "first" }));
  await assert.rejects(steer, (error) => {
    assert.equal(error.details?.kind, "control");
    assert.equal(error.details?.uncertain, true);
    assert.equal(error.details?.failClosed, true);
    assert.equal(error.details?.reason, "missing-uuid-evidence");
    return true;
  });
  assert.ok(Date.now() - started < 1_000, "the missing-evidence case fails without waiting for the control deadline");
  assert.equal(query.closed, true, "the owned query is torn down so no unacknowledged run is orphaned");
  await assert.rejects(runPromise, () => true);
});

test("Claude session rejects a second concurrent run on one live session", async () => {
  const { adapter, queries } = makeAdapter();
  const first = adapter.run(request());
  const query = await waitForQuery(queries);
  await query.waitForInput(1);
  await assert.rejects(
    adapter.run(request({ requestId: "req-concurrent" })),
    (error) => error.details?.kind === "session-busy",
  );
  query.emit(resultEvent());
  await first;
  await adapter.close();
});

test("Claude session refuses to attach a different or absent explicit session to a live conversation", async () => {
  const { adapter, queries } = makeAdapter();
  const first = adapter.run(request());
  const query = await waitForQuery(queries);
  await query.waitForInput(1);
  query.emit(resultEvent());
  await first;

  const second = adapter.run(request({ requestId: "req-no-session" }));
  const query2 = await waitForQuery(queries, 2);
  assert.equal(queries.length, 2, "an absent explicit session never reuses the live conversation");
  assert.equal(query.closed, true);
  assert.equal(query2.options.resume, undefined);
  await query2.waitForInput(1);
  query2.emit(resultEvent({ result: "fresh" }));
  const out2 = await second;
  assert.equal(out2.result.finalText, "fresh");

  const third = adapter.run(request({ requestId: "req-other-session", execution: { sessionId: "other-session" } }));
  const query3 = await waitForQuery(queries, 3);
  assert.equal(query3.options.resume, "other-session", "a different explicit session resumes its own conversation");
  await query3.waitForInput(1);
  query3.emit(resultEvent({ session_id: "other-session", result: "other" }));
  const out3 = await third;
  assert.equal(out3.sessionId, "other-session");
  await adapter.close();
});

test("Claude session interrupt returns the CLI receipt and dedupes commandIds", async () => {
  const { adapter, queries } = makeAdapter({ interruptReceipt: { still_queued: ["u-1"], cancelled: [] } });
  const runPromise = adapter.run(request());
  const query = await waitForQuery(queries);
  await query.waitForInput(1);

  const ack = await adapter.control({ commandId: "cmd-int-1", kind: "interrupt" });
  assert.equal(ack.command, "interrupt");
  assert.equal(ack.applied, true);
  assert.deepEqual(ack.receipt, { still_queued: ["u-1"], cancelled: [] });
  assert.equal(query.interrupts, 1);

  const again = await adapter.control({ commandId: "cmd-int-1", kind: "interrupt" });
  assert.strictEqual(again, ack);
  assert.equal(query.interrupts, 1, "duplicate interrupts are not re-sent");

  query.emit(resultEvent());
  await runPromise;
  await adapter.close();
});

test("Claude session never evicts a pending control receipt to satisfy the cache cap", async () => {
  const { adapter, queries } = makeAdapter({ maxCachedControls: 1, controlTimeoutMs: 5_000 });
  const runPromise = adapter.run(request());
  const query = await waitForQuery(queries);
  await query.waitForInput(1);

  const pending = adapter.control({ commandId: "cmd-pending-1", kind: "message", delivery: "steer", message: "first" });
  await query.waitForInput(2);
  await adapter.control({ commandId: "cmd-settled-1", kind: "interrupt" });

  const again = adapter.control({ commandId: "cmd-pending-1", kind: "message", delivery: "steer", message: "first" });
  assert.equal(query.received.length, 2, "the duplicate never re-sends, so the pending receipt was not evicted");

  query.emit(resultEvent({ result: "first", user_message_uuids: [query.received[0].uuid, query.received[1].uuid] }));
  const [ack, ackAgain] = await Promise.all([pending, again]);
  assert.strictEqual(ackAgain, ack, "the duplicate joins the same pending receipt");
  assert.equal(ack.consumed, true);
  await runPromise;
  await adapter.close();
});

test("Claude session aggregates per-turn usage and counts cumulative cost once across guidance turns", async () => {
  const { adapter, queries } = makeAdapter();
  const runPromise = adapter.run(request());
  const query = await waitForQuery(queries);
  await query.waitForInput(1);

  const steer = adapter.control({ commandId: "cmd-count-1", kind: "message", delivery: "steer", message: "more" });
  await query.waitForInput(2);
  query.emit(resultEvent({
    result: "first",
    user_message_uuids: [query.received[0].uuid],
    usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    total_cost_usd: 0.01,
    num_turns: 1,
  }));
  query.emit(resultEvent({
    result: "second",
    user_message_uuids: [query.received[1].uuid],
    usage: { input_tokens: 40, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 },
    total_cost_usd: 0.03,
    num_turns: 1,
  }));
  await steer;
  const output = await runPromise;
  assert.equal(output.usage.inputTokens, 140, "per-turn token usage is summed across the run's turns");
  assert.equal(output.usage.outputTokens, 15);
  assert.equal(output.usage.cacheReadTokens, 2);
  assert.equal(output.usage.totalCostUsd, 0.03, "the cumulative delta is counted once, not per result");
  assert.equal(output.usage.sessionTotalCostUsd, 0.03);
  assert.equal(output.result.finalText, "first");
  await adapter.close();
});

test("Claude session abort between the run result and its guidance acknowledgement cleans up", async () => {
  const { adapter, queries } = makeAdapter();
  const controller = new AbortController();
  const runPromise = adapter.run(request(), { signal: controller.signal });
  const query = await waitForQuery(queries);
  await query.waitForInput(1);

  const steer = adapter.control({ commandId: "cmd-abort-1", kind: "message", delivery: "steer", message: "more" });
  steer.catch(() => {});
  await query.waitForInput(2);
  query.emit(resultEvent({ result: "first", user_message_uuids: [query.received[0].uuid] }));
  await delay(20);
  controller.abort();

  await assert.rejects(runPromise, (error) => {
    assert.equal(error.details?.kind, "abort");
    assert.equal(error.details?.usage?.inputTokens, 10, "usage observed before the abort stays reported");
    return true;
  });
  assert.equal(query.closed, true, "the owned query is closed between turns");
  await assert.rejects(steer, (error) => error.details?.cancelled === true);
  await adapter.close();
});

test("Claude session rejects promptly when the SDK stream ends before a result", async () => {
  const { adapter, queries } = makeAdapter();
  const runPromise = adapter.run(request({ execution: { timeoutMs: 60_000 } }));
  const query = await waitForQuery(queries);
  await query.waitForInput(1);
  const started = Date.now();
  query.end();
  await assert.rejects(runPromise, (error) => error.details?.kind === "transport" && error.details?.streamEnded === true);
  assert.ok(Date.now() - started < 2_000, "the run rejects on EOF instead of waiting for the timeout");
  assert.equal(query.closed, true, "the stream-ended query is torn down");
});

test("Claude session does not leak usage from a previous session into a resumed run", async () => {
  const { adapter, queries } = makeAdapter();
  const first = adapter.run(request());
  const query = await waitForQuery(queries);
  await query.waitForInput(1);
  query.emit(resultEvent({
    result: "first",
    user_message_uuids: [query.received[0].uuid],
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    total_cost_usd: 0.01,
  }));
  const out1 = await first;
  assert.equal(out1.usage.inputTokens, 100);

  const second = adapter.run(request({ requestId: "req-stale", execution: { sessionId: "resumed-session" } }));
  const query2 = await waitForQuery(queries, 2);
  await query2.waitForInput(1);
  query2.emit(resultEvent({ session_id: "resumed-session", result: "second", user_message_uuids: [query2.received[0].uuid], usage: {} }));
  const out2 = await second;
  assert.equal(out2.usage.inputTokens, null, "no stale token counts from the previous session");
  assert.equal(out2.usage.outputTokens, null);
  assert.equal(out2.usage.totalCostUsd, null, "a resumed session's cost baseline is unknown");
  await adapter.close();
});

test("Claude session does not resurrect a settled turn from a late result", async () => {
  const { adapter, queries } = makeAdapter();
  const first = adapter.run(request());
  const query = await waitForQuery(queries);
  await query.waitForInput(1);
  query.emit(resultEvent());
  const out1 = await first;
  query.emit(resultEvent({ result: "stray" }));
  await delay(10);
  assert.equal(adapter.session.fatalError, null);

  const second = adapter.run(request({ requestId: "req-late", execution: { sessionId: out1.sessionId } }));
  await query.waitForInput(2);
  query.emit(resultEvent({ result: "second", user_message_uuids: [query.received[1].uuid] }));
  const out2 = await second;
  assert.equal(out2.result.finalText, "second");
  await adapter.close();
});

test("Claude session reports usage for failed turns and classifies budget exhaustion", async () => {
  const { adapter, queries } = makeAdapter();
  const progress = [];
  const runPromise = adapter.run(request(), { onProgress: (event) => { progress.push(event); } });
  const query = await waitForQuery(queries);
  await query.waitForInput(1);
  query.emit(resultEvent({
    subtype: "error_max_budget_usd",
    is_error: true,
    result: "budget exceeded",
    stop_reason: "max_budget",
    total_cost_usd: 0.5,
    usage: { input_tokens: 1_000, output_tokens: 500, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 },
    user_message_uuids: [query.received[0].uuid],
  }));
  await assert.rejects(runPromise, (error) => {
    assert.equal(error.details?.kind, "budget");
    assert.equal(error.details?.usage?.inputTokens, 1_000);
    assert.equal(error.details?.usage?.totalCostUsd, 0.5);
    assert.equal(error.details?.usageSummary?.costUsd, 0.5);
    assert.equal(error.details?.subtype, "error_max_budget_usd");
    return true;
  });
  const errorEvent = progress.find((event) => event.type === "claude_error");
  assert.ok(errorEvent, "a failed turn emits a terminal progress event carrying usage");
  assert.equal(errorEvent.usage.inputTokens, 1_000);
  await adapter.close();
});

test("Claude session classifies a structured usage limit as usage-limit with an ISO reset", async () => {
  const { adapter, queries } = makeAdapter();
  const progress = [];
  const runPromise = adapter.run(request(), { onProgress: (event) => { progress.push(event); } });
  const query = await waitForQuery(queries);
  await query.waitForInput(1);
  const resetsAt = 1790000000; // unix epoch seconds, per the CLI producer
  query.emit({
    type: "rate_limit_event",
    session_id: fixture.sessionId,
    rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt, utilization: 1.2 },
  });
  query.emit(resultEvent({
    subtype: "success",
    is_error: true,
    result: "You've hit your session limit · resets 5:10pm (Asia/Kolkata)",
    total_cost_usd: 0.02,
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    user_message_uuids: [query.received[0].uuid],
  }));
  await assert.rejects(runPromise, (error) => {
    assert.equal(error.details?.kind, "usage-limit");
    assert.equal(error.details?.category, "quota");
    assert.equal(error.details?.provider, "anthropic");
    assert.equal(error.details?.rateLimitEvidence, "structured");
    assert.equal(error.details?.resetAt, new Date(resetsAt * 1000).toISOString());
    assert.equal(new Date(error.details.resetAt).toISOString(), error.details.resetAt, "resetAt is an ISO timestamp");
    assert.equal(error.details?.rateLimit?.status, "rejected");
    assert.equal(error.details?.rateLimit?.resetsAt, resetsAt);
    assert.equal(error.details?.rateLimit?.rateLimitType, "five_hour");
    assert.equal(error.details?.usage?.inputTokens, 100, "observed usage is preserved on the limit error");
    assert.equal(error.details?.usageSummary?.costUsd, 0.02);
    return true;
  });
  const errorEvent = progress.find((event) => event.type === "claude_error");
  assert.ok(errorEvent, "the limit is reported as a failed turn, never a successful output");
  assert.match(errorEvent.text, /usage limit/i);
  await adapter.close();
});

test("Claude session keeps resetAt null when the structured limit reports no reset", async () => {
  const { adapter, queries } = makeAdapter();
  const runPromise = adapter.run(request());
  const query = await waitForQuery(queries);
  await query.waitForInput(1);
  query.emit({ type: "rate_limit_event", session_id: fixture.sessionId, rate_limit_info: { status: "rejected", rateLimitType: "seven_day" } });
  query.emit(resultEvent({ subtype: "success", is_error: true, result: "You've hit your session limit · resets 5:10pm (Asia/Kolkata)" }));
  await assert.rejects(runPromise, (error) => {
    assert.equal(error.details?.kind, "usage-limit");
    assert.equal(error.details?.rateLimitEvidence, "structured");
    assert.equal(error.details?.resetAt, null, "no structured reset means no reset claim");
    assert.equal(error.details?.rateLimit?.resetsAt, null);
    return true;
  });
  await adapter.close();
});

test("Claude session classifies a limit result without structured state and never parses human reset text", async () => {
  const { adapter, queries } = makeAdapter();
  const runPromise = adapter.run(request());
  const query = await waitForQuery(queries);
  await query.waitForInput(1);
  query.emit(resultEvent({
    subtype: "success",
    is_error: true,
    result: "You've hit your session limit · resets 5:10pm (Asia/Kolkata)",
  }));
  await assert.rejects(runPromise, (error) => {
    assert.equal(error.details?.kind, "usage-limit");
    assert.equal(error.details?.rateLimitEvidence, "text");
    assert.equal(error.details?.resetAt, null, "the human reset text is not converted into a timestamp");
    return true;
  });
  await adapter.close();
});

test("Claude session classifies authentication failures without leaking credential-looking text", async () => {
  const { adapter, queries } = makeAdapter();
  const runPromise = adapter.run(request());
  const query = await waitForQuery(queries);
  await query.waitForInput(1);
  query.emit(resultEvent({
    subtype: "error_during_execution",
    is_error: true,
    result: "Invalid API key provided: sk-ant-abcdefghijklmnop. Please run /login",
  }));
  await assert.rejects(runPromise, (error) => {
    assert.equal(error.details?.kind, "provider-auth");
    assert.equal(error.details?.provider, "anthropic");
    assert.ok(!error.message.includes("sk-ant-abcdefghijklmnop"), "the credential-looking token is redacted");
    assert.ok(!JSON.stringify(error.details).includes("sk-ant-abcdefghijklmnop"), "details never carry the raw token");
    return true;
  });
  await adapter.close();
});

test("Claude session progress never forwards the coordinator prompt or context", async () => {
  const { adapter, queries } = makeAdapter();
  const progress = [];
  const runPromise = adapter.run(
    request({ task: "TOP_SECRET_TASK_MARKER", context: { secretish: "CONTEXT_MARKER" } }),
    { onProgress: (event) => { progress.push(event); } },
  );
  const query = await waitForQuery(queries);
  await query.waitForInput(1);
  for (const event of clone(fixture.turns[0].events)) query.emit(event);
  await runPromise;
  const text = JSON.stringify(progress);
  assert.ok(!text.includes("TOP_SECRET_TASK_MARKER"), "the task prompt never reaches progress");
  assert.ok(!text.includes("CONTEXT_MARKER"), "the context capsule never reaches progress");
  assert.ok(!text.includes("COORDINATOR DATA"), "the coordinator envelope never reaches progress");
  await adapter.close();
});

test("Claude redacts progress before truncation and fields before returning the result", async (t) => {
  const { adapter, queries } = makeAdapter();
  t.after(() => adapter.close());
  const progress = [];
  const run = adapter.run(request(), { onProgress: (event) => { progress.push(event); } });
  const query = await waitForQuery(queries);
  await query.waitForInput(1);
  const sentinel = `sk-${"synthetic".repeat(3)}`;
  const [init, delta] = clone(fixture.turns[0].events);
  delta.event.delta.text = `${"a".repeat(1994)} ${sentinel}`;
  query.emit(init);
  query.emit(delta);
  query.emit(resultEvent({ result: JSON.stringify({ finalText: "done", summary: sentinel }) }));
  const output = await run;
  assert.equal(output.result.finalText, "done");
  assert.equal(output.result.summary, "[REDACTED]");
  assert.match(progress.find(({ type }) => type === "claude_delta").text, / \[REDA…$/);
});

test("Claude keeps credentials split across message deltas out of progress and trace", async (t) => {
  const { adapter, queries } = makeAdapter();
  t.after(() => adapter.close());
  const trace = await sessionProgressTrace(t);
  const run = adapter.run(request(), { onProgress: trace.onProgress });
  const query = await waitForQuery(queries);
  await query.waitForInput(1);
  const value = "json-password-value";
  const [, first, second, assistant] = clone(fixture.turns[0].events);
  first.event.delta.text = "password=";
  second.event.delta.text = value;
  assistant.message.content[0].text = `password=${value}`;
  query.emit(first);
  query.emit(second);
  query.emit(assistant);
  query.emit(resultEvent());
  await run;
  await trace.assertRedacted("claude_delta", value);
});

test("Claude session controls fail closed before a session exists", async () => {
  const { adapter } = makeAdapter();
  await assert.rejects(
    adapter.control({ commandId: "c-none", kind: "message", delivery: "steer", message: "x" }),
    (error) => error.details?.kind === "not-ready",
  );
});

test("Claude session rejects unsupported control kinds", async () => {
  const { adapter, queries } = makeAdapter();
  const runPromise = adapter.run(request());
  const query = await waitForQuery(queries);
  await query.waitForInput(1);
  await assert.rejects(
    adapter.control({ commandId: "c-mystery", kind: "mystery" }),
    (error) => error.details?.kind === "unsupported-control",
  );
  query.emit(resultEvent());
  await runPromise;
  await adapter.close();
});

test("Claude session spawns the native executable with the parent environment under both policies", async () => {
  const sentinel = "HARNEST_TEST_CLAUDE_SESSION_ENV";
  const override = "HARNEST_TEST_CLAUDE_SESSION_OVERRIDE";
  process.env[sentinel] = "inherited";
  try {
    const { adapter, queries } = makeAdapter({ env: { [override]: "override" } });
    const runPromise = adapter.run(request({ policy: { write: true } }));
    const query = await waitForQuery(queries);
    await query.waitForInput(1);
    assert.equal(query.options.env[sentinel], "inherited");
    assert.equal(query.options.env[override], "override");
    assert.equal(query.options.env.HOME ?? query.options.env.USERPROFILE, process.env.HOME ?? process.env.USERPROFILE);
    query.emit(resultEvent());
    await runPromise;
    await adapter.close();
  } finally {
    delete process.env[sentinel];
  }
});
