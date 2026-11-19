import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import CodexSessionAdapter, {
  CODEX_SESSION_SUPPORTED_POLICY_HELP,
  SESSION_CAPABILITIES,
} from "../src/adapters/codex-session.mjs";
import { normalizeRequest } from "../src/protocol.mjs";
import { SessionAdapterPool } from "../src/session-pool.mjs";
import { sessionProgressTrace } from "../scripts/fixtures/session-progress-trace.mjs";

const FIXTURE_PEER = fileURLToPath(new URL("../scripts/fixtures/codex-session-peer.mjs", import.meta.url));
const THREAD_ID = "thread-1";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(condition, { timeout = 2000, label = "condition" } = {}) {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${label}`);
    await sleep(5);
  }
}

class FakePeer {
  constructor(child, { threadId = THREAD_ID, model = "gpt-6.1-sol", auto = true } = {}) {
    this.child = child;
    this.threadId = threadId;
    this.model = model;
    this.auto = auto;
    this.requests = [];
    this.notifications = [];
    this.responses = [];
    this.interrupts = [];
    this.turnCount = 0;
    this.activeTurnId = null;
    this.seen = new Set();
    this.waiters = new Map();
    this.handlers = new Map();
  }

  onRequest(method, handler) {
    this.handlers.set(method, handler);
  }

  #markSeen(kind, method) {
    const key = `${kind}:${method}`;
    this.seen.add(key);
    const waiters = this.waiters.get(key);
    if (waiters) {
      this.waiters.delete(key);
      for (const resolve of waiters) resolve();
    }
  }

  waitFor(kind, method, timeout = 2000) {
    const key = `${kind}:${method}`;
    if (this.seen.has(key)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const list = this.waiters.get(key) || [];
      list.push(resolve);
      this.waiters.set(key, list);
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${key}`)), timeout);
      timer.unref?.();
    });
  }

  handleLine(line) {
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      return;
    }
    if (frame.method && frame.id !== undefined && frame.id !== null) {
      this.requests.push(frame);
      this.#markSeen("request", frame.method);
      const handler = this.handlers.get(frame.method);
      if (handler) handler(frame, this);
      else if (this.auto) this.#defaultHandle(frame);
      return;
    }
    if (frame.method) {
      this.notifications.push(frame);
      this.#markSeen("notification", frame.method);
      return;
    }
    if (frame.id !== undefined) {
      this.responses.push(frame);
      this.#markSeen("response", "any");
    }
  }

  #defaultHandle(frame) {
    switch (frame.method) {
      case "initialize":
        this.respond(frame.id, { capabilities: {} });
        return;
      case "thread/start":
      case "thread/resume":
        this.respond(frame.id, this.threadPayload(frame.params));
        return;
      case "turn/start": {
        this.turnCount += 1;
        this.activeTurnId = `turn-${this.turnCount}`;
        this.respond(frame.id, { turn: { id: this.activeTurnId, status: "inProgress", items: [] } });
        return;
      }
      case "turn/steer":
        this.respond(frame.id, { turnId: this.activeTurnId });
        return;
      case "turn/interrupt":
        this.interrupts.push(frame.params);
        this.respond(frame.id, {});
        return;
      default:
        this.respondError(frame.id, { code: -32601, message: `unknown method ${frame.method}` });
    }
  }

  threadPayload(params = {}) {
    return {
      thread: { id: this.threadId, sessionId: `${this.threadId}-native` },
      model: this.model,
      modelProvider: "openai",
      cwd: params.cwd,
      sandbox: params.sandbox ?? { type: "readOnly" },
      approvalPolicy: params.approvalPolicy ?? "never",
    };
  }

  serverRequest(id, method, params) {
    queueMicrotask(() => this.child.emitLine(JSON.stringify({ id, method, params })));
  }

  respond(id, result) {
    queueMicrotask(() => this.child.emitLine(JSON.stringify({ id, result })));
  }

  respondError(id, error) {
    queueMicrotask(() => this.child.emitLine(JSON.stringify({ id, error })));
  }

  notify(method, params) {
    queueMicrotask(() => this.child.emitLine(JSON.stringify({ method, params })));
  }

  startTurn() {
    this.turnCount += 1;
    this.activeTurnId = `turn-${this.turnCount}`;
    return this.activeTurnId;
  }

  delta(text, turnId = this.activeTurnId, threadId = this.threadId) {
    this.notify("item/agentMessage/delta", { threadId, turnId, itemId: "item-1", delta: text });
  }

  message(text, turnId = this.activeTurnId, threadId = this.threadId, itemId = "item-1") {
    this.lastMessage = { id: itemId, type: "agentMessage", text };
    this.notify("item/completed", {
      threadId, turnId, completedAtMs: Date.now(), item: this.lastMessage,
    });
  }

  usage(breakdown, turnId = this.activeTurnId, threadId = this.threadId) {
    this.notify("thread/tokenUsage/updated", {
      threadId, turnId, tokenUsage: { last: breakdown, total: breakdown, modelContextWindow: 1_000_000 },
    });
  }

  complete(turnId = this.activeTurnId, items = null, threadId = this.threadId) {
    const finalItems = items ?? (this.lastMessage ? [this.lastMessage] : []);
    this.notify("turn/completed", { threadId, turn: { id: turnId, status: "completed", items: finalItems } });
  }

  failTurn(turnId = this.activeTurnId, error = { message: "boom" }, threadId = this.threadId) {
    this.notify("turn/completed", { threadId, turn: { id: turnId, status: "failed", items: [], error } });
  }

  errorNotification(error, { turnId = this.activeTurnId, willRetry = false, threadId = this.threadId } = {}) {
    this.notify("error", { threadId, turnId, willRetry, error });
  }
}

class FakeChild extends EventEmitter {
  constructor(peerOptions = {}) {
    super();
    this.killed = false;
    this.paused = false;
    this.input = "";
    this.stdout = new EventEmitter();
    this.stdout.pause = () => { this.paused = true; };
    this.stdout.resume = () => { this.paused = false; };
    this.stderr = new EventEmitter();
    this.peer = new FakePeer(this, peerOptions);
    this.stdin = {
      destroyed: false,
      write: (value) => {
        this.input += value;
        for (const line of String(value).split("\n")) {
          if (line.trim()) this.peer.handleLine(line);
        }
        return true;
      },
      end: () => { this.stdinEnded = true; },
    };
  }

  emitLine(line) {
    this.stdout.emit("data", Buffer.from(`${line}\n`));
  }

  emitStderr(text) {
    this.stderr.emit("data", Buffer.from(text));
  }

  exit(code = 0) {
    this.emit("close", code, null);
  }

  kill() {
    if (this.killed) return false;
    this.killed = true;
    queueMicrotask(() => this.emit("close", null, "SIGTERM"));
    return true;
  }
}

function spawnFor(children, peerOptions = {}) {
  return (command, args, options) => {
    const child = new FakeChild(peerOptions);
    children.push({ command, args, options, child });
    return child;
  };
}

function request(overrides = {}) {
  return normalizeRequest({
    target: "codex",
    requestId: "req-codex-session-001",
    task: "Return the handoff result.",
    cwd: process.cwd(),
    context: { source: "deterministic-test" },
    policy: { write: false, tools: [], maxCostUsd: null },
    ...overrides,
  });
}

function requestsOf(peer, method) {
  return peer.requests.filter((frame) => frame.method === method);
}

test("SESSION_CAPABILITIES stays truthful and the default export is the class", () => {
  assert.equal(typeof CodexSessionAdapter, "function");
  assert.equal(SESSION_CAPABILITIES.harness, "codex");
  assert.equal(SESSION_CAPABILITIES.transport, "session");
  assert.equal(SESSION_CAPABILITIES.resume, true);
  assert.equal(SESSION_CAPABILITIES.steer, true);
  assert.equal(SESSION_CAPABILITIES.followUp, "local-bounded");
  assert.equal(SESSION_CAPABILITIES.nativeFollowUp, false);
  assert.equal(SESSION_CAPABILITIES.oneShotFallback, false);
  assert.deepEqual([...SESSION_CAPABILITIES.sandboxPolicies], ["read-only", "workspace-write"]);
  assert.ok(CODEX_SESSION_SUPPORTED_POLICY_HELP.includes("dangerFullAccess"));
});

test("handshake sends initialize then initialized, thread/start, and an exact read-only turn/start", async () => {
  const children = [];
  const adapter = new CodexSessionAdapter({ command: "fake-codex", spawnFn: spawnFor(children) });
  const runPromise = adapter.run(request());
  await flush();
  const peer = children[0].child.peer;
  await peer.waitFor("request", "turn/start");
  peer.delta("final ");
  peer.message("final answer");
  peer.usage({ inputTokens: 12, cachedInputTokens: 8, outputTokens: 4, reasoningOutputTokens: 1, totalTokens: 17 });
  peer.complete();
  const output = await runPromise;

  assert.equal(children.length, 1);
  assert.equal(children[0].command, "fake-codex");
  assert.deepEqual(children[0].args, ["app-server"]);

  const initialize = requestsOf(peer, "initialize")[0];
  assert.equal(initialize.params.clientInfo.name, "harnest");
  assert.equal(initialize.params.capabilities.experimentalApi, false);
  assert.ok(peer.notifications.some((frame) => frame.method === "initialized"));

  const start = requestsOf(peer, "thread/start")[0];
  assert.equal(start.params.cwd, process.cwd());
  assert.equal(start.params.sandbox, "read-only");
  assert.equal(start.params.approvalPolicy, "never");

  const turn = requestsOf(peer, "turn/start")[0];
  assert.equal(turn.params.threadId, THREAD_ID);
  assert.equal(turn.params.approvalPolicy, "never");
  assert.deepEqual(turn.params.sandboxPolicy, { type: "readOnly" });
  assert.equal(turn.params.cwd, process.cwd());
  assert.equal(turn.params.input.length, 1);
  assert.equal(turn.params.input[0].type, "text");
  assert.match(turn.params.input[0].text, /Return the handoff result/);

  assert.equal(output.sessionId, THREAD_ID);
  assert.equal(output.workflowRunId, "codex:req-codex-session-001");
  assert.equal(output.route.harness, "codex");
  assert.equal(output.route.transport, "session");
  assert.equal(output.route.model, "gpt-6.1-sol");
  assert.equal(output.result.finalText, "final answer");
  assert.deepEqual(output.usage, {
    input_tokens: 12,
    cached_input_tokens: 8,
    output_tokens: 4,
    reasoning_output_tokens: 1,
    total_tokens: 17,
  });
  assert.deepEqual(output.usageSummary, {
    inputTokens: 12,
    uncachedInputTokens: 4,
    inputSemantics: "inclusive",
    outputTokens: 4,
    cacheReadTokens: 8,
    cacheWriteTokens: null,
    costUsd: null,
  });
  assert.ok(output.result.eventSummary.count >= 3);
  assert.ok(output.result.eventSummary.types.length <= 20);
  await adapter.close();
});

test("the prompt envelope keeps stable context before task, requestId and route", async () => {
  const children = [];
  const adapter = new CodexSessionAdapter({ command: "fake-codex", spawnFn: spawnFor(children) });
  const runPromise = adapter.run(request());
  await flush();
  const peer = children[0].child.peer;
  await peer.waitFor("request", "turn/start");
  const text = requestsOf(peer, "turn/start")[0].params.input[0].text;
  const contextIndex = text.indexOf('"context"');
  const taskIndex = text.indexOf('"task"');
  const requestIdIndex = text.indexOf('"requestId"');
  const routeIndex = text.indexOf('"route"');
  assert.ok(contextIndex >= 0 && contextIndex < taskIndex);
  assert.ok(taskIndex < requestIdIndex);
  assert.ok(requestIdIndex < routeIndex);
  peer.message("ok");
  peer.complete();
  await runPromise;
  await adapter.close();
});

test("write policy maps to workspaceWrite over the canonical cwd and never dangerFullAccess", async () => {
  const children = [];
  const adapter = new CodexSessionAdapter({ command: "fake-codex", spawnFn: spawnFor(children) });
  const runPromise = adapter.run(request({ policy: { write: true }, cwd: join(process.cwd(), "sub", "..") }));
  await flush();
  const peer = children[0].child.peer;
  await peer.waitFor("request", "turn/start");
  const start = requestsOf(peer, "thread/start")[0];
  assert.equal(start.params.sandbox, "workspace-write");
  assert.equal(start.params.cwd, process.cwd());
  const turn = requestsOf(peer, "turn/start")[0];
  assert.deepEqual(turn.params.sandboxPolicy, { type: "workspaceWrite", writableRoots: [process.cwd()] });
  assert.ok(!JSON.stringify([...peer.requests]).includes("dangerFullAccess"));
  assert.ok(!JSON.stringify([...peer.requests]).includes("danger-full-access"));
  peer.message("edited");
  peer.complete();
  const output = await runPromise;
  assert.equal(output.result.finalText, "edited");
  await adapter.close();
});

test("execution.sessionId resumes the native thread and never starts a fresh one", async () => {
  const children = [];
  const adapter = new CodexSessionAdapter({ command: "fake-codex", spawnFn: spawnFor(children, { threadId: "prior-thread" }) });
  const runPromise = adapter.run(request({ execution: { sessionId: "prior-thread" } }));
  await flush();
  const peer = children[0].child.peer;
  await peer.waitFor("request", "turn/start");
  assert.equal(requestsOf(peer, "thread/resume").length, 1);
  assert.equal(requestsOf(peer, "thread/resume")[0].params.threadId, "prior-thread");
  assert.equal(requestsOf(peer, "thread/start").length, 0);
  peer.message("resumed");
  peer.complete();
  const output = await runPromise;
  assert.equal(output.sessionId, "prior-thread");
  await adapter.close();
});

test("a failed resume throws and never silently starts a fresh conversation", async () => {
  const children = [];
  const adapter = new CodexSessionAdapter({
    command: "fake-codex",
    spawnFn(command, args, options) {
      const fake = spawnFor(children, { threadId: "prior-thread" })(command, args, options);
      fake.peer.onRequest("thread/resume", (frame, peer) => {
        peer.respondError(frame.id, { code: -32000, message: "no rollout found for thread prior-thread" });
      });
      return fake;
    },
  });
  await assert.rejects(
    adapter.run(request({ execution: { sessionId: "prior-thread" } })),
    (error) => {
      assert.ok(["transport", "downstream"].includes(error.details?.kind), `unexpected kind ${error.details?.kind}`);
      assert.match(error.message, /no rollout found/);
      return true;
    },
  );
  assert.equal(children.length, 1);
  assert.equal(requestsOf(children[0].child.peer, "thread/start").length, 0, "resume failure never becomes a fresh start");
  assert.equal(children[0].child.killed, true, "the failed process is cleaned up");
  await adapter.close();
});

test("an explicit matching sessionId reuses one process; unrelated requests do not share context", async () => {
  const children = [];
  const adapter = new CodexSessionAdapter({ command: "fake-codex", spawnFn: spawnFor(children) });
  const first = adapter.run(request({ requestId: "req-one" }));
  await flush();
  children[0].child.peer.message("first");
  children[0].child.peer.complete();
  const firstOutput = await first;
  assert.equal(firstOutput.sessionId, THREAD_ID);

  const second = adapter.run(request({ requestId: "req-two", execution: { sessionId: firstOutput.sessionId } }));
  await flush();
  const peer = children[0].child.peer;
  await peer.waitFor("request", "turn/start");
  peer.delta("second");
  peer.message("second");
  peer.complete("turn-2");
  const secondOutput = await second;
  assert.equal(secondOutput.sessionId, THREAD_ID);
  assert.equal(children.length, 1, "matching explicit sessionId reuses the process");
  assert.equal(requestsOf(peer, "thread/start").length, 1);
  assert.equal(requestsOf(peer, "thread/resume").length, 0);
  assert.equal(requestsOf(peer, "turn/start").length, 2);

  // A request without execution.sessionId must not inherit the live conversation.
  const third = adapter.run(request({ requestId: "req-three" }));
  await flush();
  await waitFor(() => children.length === 2, { label: "second process" });
  children[1].child.peer.message("third");
  children[1].child.peer.complete();
  const thirdOutput = await third;
  assert.equal(thirdOutput.sessionId, THREAD_ID);
  assert.equal(children.length, 2);
  assert.equal(children[0].child.killed, true, "the unrelated prior session is closed, not shared");
  await adapter.close();
});

test("steer acknowledges the native turn/steer RPC with the active turn id", async () => {
  const children = [];
  const adapter = new CodexSessionAdapter({ command: "fake-codex", spawnFn: spawnFor(children, { auto: true }) });
  const runPromise = adapter.run(request());
  await flush();
  const peer = children[0].child.peer;
  await peer.waitFor("request", "turn/start");
  const turnId = peer.activeTurnId;

  const ack = await adapter.control({
    commandId: "cmd-steer-1", kind: "message", delivery: "steer", message: "narrow the scope",
  });
  assert.equal(ack.applied, true);
  assert.equal(ack.queued, false);
  assert.equal(ack.command, "turn/steer");
  assert.equal(ack.turnId, turnId);
  const steer = requestsOf(peer, "turn/steer")[0];
  assert.equal(steer.params.expectedTurnId, turnId);
  assert.equal(steer.params.input[0].text, "narrow the scope");

  peer.message("steered answer");
  peer.complete();
  const output = await runPromise;
  assert.equal(output.result.finalText, "steered answer");
  await adapter.close();
});

test("a queued follow-up keeps the run open, dispatches after the active turn, and aggregates usage", async () => {
  const children = [];
  const adapter = new CodexSessionAdapter({ command: "fake-codex", spawnFn: spawnFor(children) });
  const progress = [];
  const runPromise = adapter.run(request({ route: { model: "gpt-5.6-luna" } }), { onProgress: (event) => progress.push(event) });
  await flush();
  const peer = children[0].child.peer;
  await peer.waitFor("request", "turn/start");
  const primary = peer.activeTurnId;

  await assert.rejects(
    adapter.control({ commandId: "cmd-follow", kind: "message", delivery: "follow_up", message: "next step" }),
    (error) => {
      assert.equal(error.details?.kind, "control");
      assert.equal(error.details?.uncertain, true);
      assert.equal(error.details?.applied, false);
      assert.equal(error.details?.acknowledged, false);
      assert.equal(error.details?.queued, true);
      return true;
    },
  );
  await assert.rejects(
    adapter.control({
      commandId: "cmd-reroute", kind: "reroute", delivery: "follow_up",
      message: "use the other model", route: { provider: "openai", model: "gpt-5.7-sol" },
    }),
    (error) => error.details?.uncertain === true && error.details?.queued === true && error.details?.model === "gpt-5.7-sol",
  );
  // A model-only reroute has no protocol primitive on a live turn.
  await assert.rejects(
    adapter.control({ commandId: "cmd-bare", kind: "reroute", delivery: "steer", route: { provider: "openai", model: "gpt-5.7-sol" } }),
    (error) => error.details?.kind === "unsupported-control" && error.details?.applied === false,
  );
  assert.equal(requestsOf(peer, "turn/start").length, 1, "no native turn is dispatched while the primary is active");

  peer.usage({ inputTokens: 10, cachedInputTokens: 4, outputTokens: 2, reasoningOutputTokens: 1, totalTokens: 12 }, primary);
  peer.message("primary answer", primary);
  peer.complete(primary);

  await waitFor(() => requestsOf(peer, "turn/start").length === 2, { label: "first follow-up dispatch" });
  const followTurn = peer.activeTurnId;
  assert.notEqual(followTurn, primary);
  assert.equal(requestsOf(peer, "turn/start")[1].params.model, "gpt-5.6-luna");
  assert.equal(requestsOf(peer, "turn/start")[1].params.input[0].text, "next step");

  let settled = false;
  runPromise.then(() => { settled = true; }, () => { settled = true; });
  await sleep(25);
  assert.equal(settled, false, "the parent run stays open while a follow-up turn is active");

  const steerAck = await adapter.control({ commandId: "cmd-steer-follow", kind: "message", delivery: "steer", message: "tighten it" });
  assert.equal(steerAck.applied, true);
  assert.equal(steerAck.acknowledged, true);
  assert.equal(steerAck.turnId, followTurn);

  peer.usage({ inputTokens: 20, cachedInputTokens: 10, outputTokens: 5, reasoningOutputTokens: 2, totalTokens: 25 }, followTurn);
  peer.message("follow-up answer", followTurn);
  peer.complete(followTurn);

  await waitFor(() => requestsOf(peer, "turn/start").length === 3, { label: "reroute dispatch" });
  const rerouteTurn = peer.activeTurnId;
  assert.equal(requestsOf(peer, "turn/start")[2].params.model, "gpt-5.7-sol");
  assert.equal(requestsOf(peer, "turn/start")[2].params.input[0].text, "use the other model");
  peer.usage({ inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0, totalTokens: 2 }, rerouteTurn);
  peer.message("reroute answer", rerouteTurn);
  peer.complete(rerouteTurn);

  const output = await runPromise;
  assert.equal(output.result.finalText, "reroute answer");
  assert.deepEqual(output.usage, {
    input_tokens: 31, cached_input_tokens: 14, output_tokens: 8, reasoning_output_tokens: 3, total_tokens: 39,
  });
  assert.deepEqual(output.usageSummary, {
    inputTokens: 31,
    uncachedInputTokens: 17,
    inputSemantics: "inclusive",
    outputTokens: 8,
    cacheReadTokens: 14,
    cacheWriteTokens: null,
    costUsd: null,
  });
  assert.deepEqual(output.result.turns.map((turn) => turn.ordinal), [1, 2, 3]);
  assert.deepEqual(output.result.turns.map((turn) => turn.turnId), [primary, followTurn, rerouteTurn]);
  const finalTurnEvent = progress.filter((event) => event.type === "codex_turn" && event.state === "completed").at(-1);
  assert.deepEqual(finalTurnEvent.usageTotals, output.usage, "progress reports inclusive spending across all owned turns");
  await adapter.close();
});

test("a failing follow-up fails the run with summed usage and leaves no queued native turn", async () => {
  const children = [];
  const adapter = new CodexSessionAdapter({ command: "fake-codex", spawnFn: spawnFor(children) });
  const runPromise = adapter.run(request());
  await flush();
  const peer = children[0].child.peer;
  await peer.waitFor("request", "turn/start");
  await assert.rejects(
    adapter.control({ commandId: "q1", kind: "message", delivery: "follow_up", message: "first queued" }),
    (error) => error.details?.queued === true,
  );
  await assert.rejects(
    adapter.control({ commandId: "q2", kind: "message", delivery: "follow_up", message: "second queued" }),
    (error) => error.details?.queued === true,
  );

  peer.usage({ inputTokens: 5, cachedInputTokens: 1, outputTokens: 1, reasoningOutputTokens: 0, totalTokens: 6 });
  peer.message("primary ok");
  peer.complete(peer.activeTurnId);

  await waitFor(() => requestsOf(peer, "turn/start").length === 2, { label: "follow-up dispatch" });
  const followTurn = peer.activeTurnId;
  peer.usage({ inputTokens: 7, cachedInputTokens: 2, outputTokens: 3, reasoningOutputTokens: 1, totalTokens: 10 }, followTurn);
  peer.failTurn(followTurn, { message: "follow-up exploded" });

  await assert.rejects(runPromise, (error) => {
    assert.equal(error.details?.kind, "downstream");
    assert.equal(error.details?.queuedNotRun, 1);
    assert.equal(error.details?.completedTurns, 1);
    assert.deepEqual(error.details?.usage, {
      input_tokens: 12, cached_input_tokens: 3, output_tokens: 4, reasoning_output_tokens: 1, total_tokens: 16,
    });
    return true;
  });
  assert.equal(requestsOf(peer, "turn/start").length, 2, "nothing is dispatched after the run turns terminal");
  await adapter.close();
  assert.equal(children[0].child.killed, true, "close stops only the owned process; no orphan survives");
});

test("abort with a queued follow-up stops before any extra native turn", async () => {
  const children = [];
  const adapter = new CodexSessionAdapter({ command: "fake-codex", spawnFn: spawnFor(children) });
  const controller = new AbortController();
  const progress = [];
  const runPromise = adapter.run(request(), { signal: controller.signal, onProgress: (event) => progress.push(event) });
  await flush();
  const peer = children[0].child.peer;
  await peer.waitFor("request", "turn/start");
  const primary = peer.activeTurnId;
  await assert.rejects(
    adapter.control({ commandId: "abort-q", kind: "message", delivery: "follow_up", message: "queued then aborted" }),
    (error) => error.details?.queued === true,
  );
  peer.notify("turn/started", { threadId: THREAD_ID, turn: { id: primary, status: "inProgress", items: [] } });
  await waitFor(() => progress.some((event) => event.type === "codex_turn" && event.state === "started"), { label: "turn started" });
  peer.onRequest("turn/interrupt", (frame, self) => {
    self.respond(frame.id, {});
    queueMicrotask(() => self.notify("turn/completed", {
      threadId: self.threadId, turn: { id: primary, status: "interrupted", items: [] },
    }));
  });
  controller.abort();
  await assert.rejects(runPromise, (error) => {
    assert.equal(error.details?.kind, "abort");
    assert.equal(error.details?.queuedNotRun, 1);
    return true;
  });
  assert.equal(requestsOf(peer, "turn/start").length, 1, "the queued follow-up never became a native turn");
  await adapter.close();
});

test("follow-up queue caps reject rather than silently drop", async () => {
  const children = [];
  const adapter = new CodexSessionAdapter({ command: "fake-codex", spawnFn: spawnFor(children), maxFollowUps: 1, maxFollowUpBytes: 1024 });
  const runPromise = adapter.run(request());
  await flush();
  const peer = children[0].child.peer;
  await peer.waitFor("request", "turn/start");
  await assert.rejects(
    adapter.control({ commandId: "cap-1", kind: "message", delivery: "follow_up", message: "fits" }),
    (error) => error.details?.queued === true,
  );
  await assert.rejects(
    adapter.control({ commandId: "cap-2", kind: "message", delivery: "follow_up", message: "overflow" }),
    (error) => {
      assert.equal(error.details?.kind, "control");
      assert.equal(error.details?.queued, false);
      assert.equal(error.details?.rejected, true);
      assert.equal(error.details?.reason, "queue-count");
      return true;
    },
  );
  peer.message("primary done");
  peer.complete(peer.activeTurnId);
  await waitFor(() => requestsOf(peer, "turn/start").length === 2, { label: "queued fits dispatch" });
  peer.message("queued fits answered");
  peer.complete(peer.activeTurnId);
  const output = await runPromise;
  assert.equal(output.result.finalText, "queued fits answered");
  await adapter.close();

  const byteChildren = [];
  const byteAdapter = new CodexSessionAdapter({ command: "fake-codex", spawnFn: spawnFor(byteChildren), maxFollowUpBytes: 4 });
  const byteRun = byteAdapter.run(request({ requestId: "req-codex-session-bytes" }));
  await flush();
  const bytePeer = byteChildren[0].child.peer;
  await bytePeer.waitFor("request", "turn/start");
  await assert.rejects(
    byteAdapter.control({ commandId: "cap-bytes", kind: "message", delivery: "follow_up", message: "12345" }),
    (error) => error.details?.reason === "queue-bytes" && error.details?.queued === false && error.details?.rejected === true,
  );
  bytePeer.message("done");
  bytePeer.complete(bytePeer.activeTurnId);
  await byteRun;
  await byteAdapter.close();
});

test("per-turn usage replaces its previous breakdown without double counting", async () => {
  const children = [];
  const adapter = new CodexSessionAdapter({ command: "fake-codex", spawnFn: spawnFor(children) });
  const runPromise = adapter.run(request());
  await flush();
  const peer = children[0].child.peer;
  await peer.waitFor("request", "turn/start");
  const primary = peer.activeTurnId;
  peer.usage({ inputTokens: 100, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0, totalTokens: 101 }, primary);
  // The per-turn `last` breakdown resets; the latest event is authoritative.
  peer.usage({ inputTokens: 10, cachedInputTokens: 4, outputTokens: 2, reasoningOutputTokens: 1, totalTokens: 12 }, primary);
  peer.message("answer");
  peer.complete(primary);
  const output = await runPromise;
  assert.deepEqual(output.usage, {
    input_tokens: 10, cached_input_tokens: 4, output_tokens: 2, reasoning_output_tokens: 1, total_tokens: 12,
  });
  await adapter.close();
});

test("control fails closed without a live session or active turn", async () => {
  const adapter = new CodexSessionAdapter({ command: "fake-codex", spawnFn: spawnFor([]) });
  await assert.rejects(
    adapter.control({ commandId: "c1", kind: "message", delivery: "steer", message: "x" }),
    (error) => error.details?.kind === "control" && error.details?.applied === false,
  );
  await adapter.close();
});

test("abort interrupts the active turn, then settles bounded without orphaning the process", async () => {
  const children = [];
  const adapter = new CodexSessionAdapter({ command: "fake-codex", spawnFn: spawnFor(children) });
  const controller = new AbortController();
  const progress = [];
  const runPromise = adapter.run(request(), { signal: controller.signal, onProgress: (event) => progress.push(event) });
  await flush();
  const peer = children[0].child.peer;
  await peer.waitFor("request", "turn/start");
  const turnId = peer.activeTurnId;
  peer.notify("turn/started", { threadId: THREAD_ID, turn: { id: turnId, status: "inProgress", items: [] } });
  await waitFor(() => progress.some((event) => event.type === "codex_turn" && event.state === "started"), { label: "turn started" });
  peer.onRequest("turn/interrupt", (frame, self) => {
    self.interrupts.push(frame.params);
    self.respond(frame.id, {});
    queueMicrotask(() => self.notify("turn/completed", {
      threadId: self.threadId, turn: { id: turnId, status: "interrupted", items: [] },
    }));
  });
  controller.abort();
  await assert.rejects(runPromise, (error) => {
    assert.equal(error.details?.kind, "abort");
    assert.equal(error.details?.aborted, true);
    return true;
  });
  assert.equal(peer.interrupts.length, 1);
  assert.deepEqual(peer.interrupts[0], { threadId: THREAD_ID, turnId });
  assert.equal(children[0].child.killed, false, "a settled interrupt needs no forced kill");
  await adapter.close();
  assert.equal(children[0].child.killed, true, "close stops exactly this owned process");
  await adapter.close();
  assert.equal(children[0].child.killed, true);
});

test("Codex clears the referenced interrupt grace timer when the turn settles", async (t) => {
  const children = [];
  const adapter = new CodexSessionAdapter({ command: "fake-codex", spawnFn: spawnFor(children), idleCloseMs: 0 });
  t.after(() => adapter.close());
  const controller = new AbortController();
  const run = adapter.run(request(), { signal: controller.signal });
  await flush();
  const peer = children[0].child.peer;
  await peer.waitFor("request", "turn/start");
  await flush();
  const timers = t.mock.method(globalThis, "setTimeout");
  const cleared = t.mock.method(globalThis, "clearTimeout");
  peer.onRequest("turn/interrupt", (frame, self) => {
    self.respond(frame.id, {});
    setImmediate(() => self.notify("turn/completed", {
      threadId: THREAD_ID, turn: { id: self.activeTurnId, status: "interrupted", items: [] },
    }));
  });
  controller.abort();
  await assert.rejects(run, (error) => error.details?.kind === "abort" && error.details.aborted === true);
  const grace = timers.mock.calls.find((entry) => entry.arguments[1] === 5_000)?.result;
  assert.ok(grace, "the native turn settled within the interrupt grace");
  assert.ok(cleared.mock.calls.some((entry) => entry.arguments[0] === grace), "the losing grace timer must be cleared");
});

test("Codex retains the native lease when close is never observed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harnest-codex-unconfirmed-exit-"));
  const first = new SessionAdapterPool({ lockDir: root });
  const second = new SessionAdapterPool({ lockDir: root });
  t.after(async () => { await first.close(); await second.close(); await rm(root, { recursive: true, force: true }); });
  const children = [];
  const adapter = new CodexSessionAdapter({ command: "fake-codex", spawnFn: spawnFor(children), idleCloseMs: 0 });
  const input = request({ execution: { sessionId: THREAD_ID } });
  const lease = await first.acquire(input, () => adapter);
  const run = adapter.run(input);
  await flush();
  const { child } = children[0];
  await child.peer.waitFor("request", "turn/start");
  await flush();
  child.peer.message("done");
  child.peer.complete();
  await run;
  child.kill = () => { child.killed = true; return true; };
  await assert.rejects(lease.release(), /exit (was )?not (observed|confirmed)/i);
  assert.equal(child.killed, true);
  await assert.rejects(second.acquire(input, () => { throw new Error("must not create a second owner"); }), /leased by another owner/);
  child.exit();
});

test("Codex redacts progress before truncation and fields before returning the result", async (t) => {
  const children = [];
  const adapter = new CodexSessionAdapter({ command: "fake-codex", spawnFn: spawnFor(children), idleCloseMs: 0 });
  t.after(() => adapter.close());
  const progress = [];
  const run = adapter.run(request(), { onProgress: (event) => { progress.push(event); } });
  await flush();
  const peer = children[0].child.peer;
  await peer.waitFor("request", "turn/start");
  await flush();
  const sentinel = `sk-${"synthetic".repeat(3)}`;
  const padding = "a".repeat(1994 - '{"padding":"'.length);
  const text = JSON.stringify({ padding: `${padding} ${sentinel}`, finalText: "done", summary: sentinel });
  peer.delta(text);
  peer.message(text);
  peer.complete();
  const output = await run;
  assert.equal(output.result.finalText, "done");
  assert.equal(output.result.summary, "[REDACTED]");
  assert.match(progress.find(({ type }) => type === "codex_message").text, / \[REDA$/);
});

test("Codex keeps credentials split across message deltas out of progress and trace", async (t) => {
  const children = [];
  const adapter = new CodexSessionAdapter({ command: "fake-codex", spawnFn: spawnFor(children), idleCloseMs: 0 });
  t.after(() => adapter.close());
  const trace = await sessionProgressTrace(t);
  const run = adapter.run(request(), { onProgress: trace.onProgress });
  await flush();
  const peer = children[0].child.peer;
  await peer.waitFor("request", "turn/start");
  await flush();
  const value = "json-password-value";
  peer.delta("password=");
  peer.delta(value);
  peer.message(`password=${value}`);
  peer.complete();
  await run;
  await trace.assertRedacted("codex_message", value);
});

test("a child exit mid-turn maps to a downstream failure and close stays idempotent", async () => {
  const children = [];
  const adapter = new CodexSessionAdapter({ command: "fake-codex", spawnFn: spawnFor(children) });
  const runPromise = adapter.run(request());
  await flush();
  await children[0].child.peer.waitFor("request", "turn/start");
  children[0].child.emitStderr("fatal: workspace vanished\n");
  children[0].child.exit(1);
  await assert.rejects(runPromise, (error) => {
    assert.equal(error.details?.kind, "downstream");
    assert.match(error.message, /exited before the turn completed/);
    return true;
  });
  await adapter.close();
  await adapter.close();
});

test("policy rejections happen before any process is spawned", async () => {
  let spawned = 0;
  const adapter = new CodexSessionAdapter({
    command: "fake-codex",
    spawnFn() {
      spawned += 1;
      throw new Error("must not spawn");
    },
  });
  await assert.rejects(
    adapter.run(request({ policy: { write: false, tools: ["read"], maxCostUsd: null } })),
    (error) => error.details?.kind === "policy" && /tools/.test(error.message),
  );
  await assert.rejects(
    adapter.run(request({ policy: { write: false, tools: { deny: ["read"] } } })),
    (error) => error.details?.kind === "policy" && /tools/.test(error.message),
  );
  await assert.rejects(
    adapter.run(request({ policy: { write: true, maxCostUsd: 5 } })),
    (error) => error.details?.kind === "policy" && /maxCostUsd/.test(error.message),
  );
  await assert.rejects(
    adapter.run(request({ workflow: { spec: { nodes: [] } } })),
    (error) => error.details?.kind === "policy",
  );
  await assert.rejects(
    adapter.run(request({ route: { model: "claude-sonnet-5" } })),
    (error) => error.details?.kind === "policy",
  );
  await assert.rejects(
    adapter.run(request({ route: { model: "bad model!" } })),
    (error) => error.details?.kind === "policy",
  );
  assert.equal(spawned, 0);
  await adapter.close();
});

test("an oversized stdout frame fails with output-limit before unbounded buffering", async () => {
  const children = [];
  const adapter = new CodexSessionAdapter({
    command: "fake-codex",
    spawnFn: spawnFor(children),
    maxLineBytes: 4096,
  });
  const runPromise = adapter.run(request());
  await flush();
  const peer = children[0].child.peer;
  await peer.waitFor("request", "turn/start");
  peer.notify("item/agentMessage/delta", {
    threadId: THREAD_ID, turnId: peer.activeTurnId, itemId: "item-1", delta: "x".repeat(10_000),
  });
  await assert.rejects(runPromise, (error) => {
    assert.equal(error.details?.kind, "output-limit");
    assert.equal(error.details?.maxLineBytes, 4096);
    return true;
  });
  assert.equal(children[0].child.killed, true);
  await adapter.close();
});

test("progress callbacks apply backpressure: stdout pauses until the persistence promise resolves", async () => {
  const children = [];
  const adapter = new CodexSessionAdapter({ command: "fake-codex", spawnFn: spawnFor(children) });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let releaseCompletion;
  const completionGate = new Promise((resolve) => { releaseCompletion = resolve; });
  const progress = [];
  let finished = false;
  const runPromise = adapter.run(request(), {
    onProgress: async (event) => {
      progress.push(event);
      if (event.type === "codex_message") await gate;
      if (event.type === "codex_turn" && event.state === "completed") await completionGate;
    },
  }).finally(() => { finished = true; });
  await flush();
  const peer = children[0].child.peer;
  await peer.waitFor("request", "turn/start");
  const turnId = peer.activeTurnId;
  peer.delta("on", turnId);
  peer.delta("e", turnId);
  peer.message("one", turnId);
  const messages = () => progress.filter((event) => event.type === "codex_message");
  await waitFor(() => messages().length === 1, { label: "first completed message" });
  assert.equal(children[0].child.paused, true, "stdout is paused while a progress promise is pending");

  peer.message("two", turnId, THREAD_ID, "item-2");
  peer.message("three", turnId, THREAD_ID, "item-3");
  await sleep(20);
  assert.equal(messages().length, 1, "later frames wait behind the pending callback");
  release();
  await waitFor(() => messages().length === 3, { label: "all three completed messages" });
  assert.deepEqual(messages().map(({ text }) => text), ["one", "two", "three"]);
  await waitFor(() => children[0].child.paused === false, { label: "stdout resumed" });
  peer.message("one two three", turnId, THREAD_ID, "item-4");
  peer.complete(turnId);
  try {
    await waitFor(() => progress.some((event) => event.type === "codex_turn" && event.state === "completed"), { label: "completion progress" });
    await flush();
    assert.equal(finished, false, "the run waits for completion progress to persist");
  } finally {
    releaseCompletion();
  }
  const output = await runPromise;
  assert.equal(output.result.finalText, "one two three");
  await adapter.close();
});

test("a native unauthorized error becomes provider-auth and preserves cancelled-turn usage", async () => {
  const children = [];
  const adapter = new CodexSessionAdapter({ command: "fake-codex", spawnFn: spawnFor(children) });
  const runPromise = adapter.run(request());
  await flush();
  const peer = children[0].child.peer;
  await peer.waitFor("request", "turn/start");
  const turnId = peer.activeTurnId;
  peer.usage({ inputTokens: 7, cachedInputTokens: 2, outputTokens: 1, reasoningOutputTokens: 0, totalTokens: 8 }, turnId);
  peer.errorNotification({ message: "Not logged in. Run 'codex login' to continue.", codexErrorInfo: "unauthorized" }, { turnId });
  peer.notify("turn/completed", {
    threadId: THREAD_ID,
    turn: { id: turnId, status: "failed", items: [], error: { message: "Not logged in. Run 'codex login' to continue.", codexErrorInfo: "unauthorized" } },
  });
  await assert.rejects(runPromise, (error) => {
    assert.equal(error.details?.kind, "provider-auth");
    assert.equal(error.details?.category, "auth");
    assert.equal(error.details?.provider, "openai/codex");
    assert.deepEqual(error.details?.usage, {
      input_tokens: 7, cached_input_tokens: 2, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: 8,
    });
    assert.match(error.message, /Codex provider authorization failure for openai\/codex/);
    return true;
  });
  await adapter.close();
});

test("a usage-limit codexErrorInfo is classified as a provider limit, not a model failure", async () => {
  const children = [];
  const adapter = new CodexSessionAdapter({ command: "fake-codex", spawnFn: spawnFor(children) });
  const runPromise = adapter.run(request());
  await flush();
  const peer = children[0].child.peer;
  await peer.waitFor("request", "turn/start");
  peer.failTurn(peer.activeTurnId, { message: "You have hit your usage limit; try again later.", codexErrorInfo: "usageLimitExceeded" });
  await assert.rejects(runPromise, (error) => {
    assert.equal(error.details?.kind, "provider-auth");
    assert.equal(error.details?.category, "billing");
    return true;
  });
  await adapter.close();
});

test("a model-not-found turn/start rejection classifies as unavailable", async () => {
  const children = [];
  const adapter = new CodexSessionAdapter({
    command: "fake-codex",
    spawnFn(command, args, options) {
      const fake = spawnFor(children)(command, args, options);
      fake.peer.onRequest("turn/start", (frame, self) => {
        self.respondError(frame.id, { code: -32000, message: "model 'gpt-9.9-void' not found in this account" });
      });
      return fake;
    },
  });
  const runPromise = adapter.run(request({ route: { model: "gpt-9.9-void" } }));
  await assert.rejects(runPromise, (error) => {
    assert.equal(error.details?.kind, "unavailable");
    assert.equal(error.details?.provider, "openai/codex");
    return true;
  });
  await adapter.close();
});

test("late events after turn completion never corrupt the settled result", async () => {
  const children = [];
  const adapter = new CodexSessionAdapter({ command: "fake-codex", spawnFn: spawnFor(children) });
  const progress = [];
  const runPromise = adapter.run(request(), { onProgress: (event) => progress.push(event) });
  await flush();
  const peer = children[0].child.peer;
  await peer.waitFor("request", "turn/start");
  const turnId = peer.activeTurnId;
  peer.message("authoritative", turnId);
  peer.complete(turnId);
  const output = await runPromise;
  assert.equal(output.result.finalText, "authoritative");
  const progressCount = progress.length;
  peer.delta("late delta", turnId);
  peer.message("late junk", turnId);
  peer.usage({ inputTokens: 999, cachedInputTokens: 999, outputTokens: 999, reasoningOutputTokens: 999, totalTokens: 999 }, turnId);
  peer.complete(turnId, [{ id: "late", type: "agentMessage", text: "late junk" }]);
  await flush();
  assert.equal(output.result.finalText, "authoritative");
  assert.equal(output.usage, null);
  assert.equal(progress.length, progressCount, "late events after the turn settles are dropped, not replayed");
  await adapter.close();
});

test("an unexpected server request is answered with a protocol error, never an approval", async () => {
  const children = [];
  const adapter = new CodexSessionAdapter({ command: "fake-codex", spawnFn: spawnFor(children) });
  const runPromise = adapter.run(request());
  await flush();
  const peer = children[0].child.peer;
  await peer.waitFor("request", "turn/start");
  peer.serverRequest(999, "item/commandExecution/requestApproval", {
    threadId: THREAD_ID, turnId: peer.activeTurnId, itemId: "item-1", command: "rm -rf /",
  });
  await peer.waitFor("response", "any");
  assert.equal(peer.responses.length, 1);
  assert.equal(peer.responses[0].error.code, -32601);
  assert.ok(!("result" in peer.responses[0]), "no approval decision is invented");
  peer.message("done");
  peer.complete();
  await runPromise;
  await adapter.close();
});

test("idle close stops an unused live session on the unref'd budget", async () => {
  const children = [];
  const adapter = new CodexSessionAdapter({ command: "fake-codex", spawnFn: spawnFor(children), idleCloseMs: 25 });
  const runPromise = adapter.run(request());
  await flush();
  const peer = children[0].child.peer;
  peer.message("idle me");
  peer.complete();
  await runPromise;
  assert.equal(children[0].child.killed, false);
  await waitFor(() => children[0].child.killed === true, { label: "idle close", timeout: 3000 });
  await adapter.close();
});

test("read-only and write policies spawn with identical inherited authorization environments", async () => {
  const children = [];
  const sentinel = "HARNEST_TEST_CODEX_SESSION_ENV";
  const override = "HARNEST_TEST_CODEX_SESSION_OVERRIDE";
  const saved = process.env[sentinel];
  process.env[sentinel] = "inherited";
  try {
    const adapter = new CodexSessionAdapter({
      command: "fake-codex",
      env: { [override]: "override" },
      spawnFn: spawnFor(children, { auto: true }),
    });
    const first = adapter.run(request({ requestId: "req-env-read" }));
    await flush();
    children[0].child.peer.message("read");
    children[0].child.peer.complete();
    await first;
    const second = adapter.run(request({ requestId: "req-env-write", policy: { write: true } }));
    await flush();
    await waitFor(() => children.length === 2, { label: "write process" });
    children[1].child.peer.message("write");
    children[1].child.peer.complete();
    await second;
    await adapter.close();

    assert.equal(children.length, 2, "a policy change gets its own process rather than sharing context");
    const [readEnv, writeEnv] = children.map((entry) => entry.options.env);
    assert.equal(readEnv[sentinel], "inherited");
    assert.equal(writeEnv[sentinel], "inherited");
    assert.equal(readEnv[override], "override");
    assert.deepEqual(readEnv, writeEnv, "read-only and write spawn with identical authorization environments");
    for (const env of [readEnv, writeEnv]) {
      const envKeys = new Map(Object.keys(env).map((key) => [key.toLowerCase(), key]));
      for (const key of ["HOME", "USERPROFILE", "APPDATA", "PATH", "OPENAI_API_KEY"]) {
        if (process.env[key] === undefined) continue;
        const actualKey = envKeys.get(key.toLowerCase());
        assert.ok(actualKey, `spawned env inherits ${key}`);
        assert.equal(env[actualKey], process.env[key]);
      }
    }
  } finally {
    if (saved === undefined) delete process.env[sentinel];
    else process.env[sentinel] = saved;
  }
});

test("a real child process fixture round-trips the app-server protocol", { timeout: 20000 }, async () => {
  const adapter = new CodexSessionAdapter({
    launch: { command: process.execPath, args: [FIXTURE_PEER] },
    idleCloseMs: 0,
  });
  const output = await adapter.run(request({ requestId: "req-codex-session-fixture" }));
  assert.equal(output.sessionId, "fixture-thread");
  assert.equal(output.result.finalText, "fixture final answer");
  assert.deepEqual(output.usage, {
    input_tokens: 10,
    cached_input_tokens: 4,
    output_tokens: 3,
    reasoning_output_tokens: 1,
    total_tokens: 14,
  });
  assert.equal(output.result.eventSummary.count >= 4, true);
  await adapter.close();
});
