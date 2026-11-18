import assert from "node:assert/strict";
import { spawn as nodeSpawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

import CursorSessionAdapterDefault, {
  CursorSessionAdapter,
  SESSION_CAPABILITIES,
  desiredModeId,
  negotiateCapabilities,
  permissionDecision,
  resolveCursorAcpBaseModelId,
  resolveConfigOptionValue,
  toolRequiresWrite,
} from "../src/adapters/cursor-session.mjs";
import { normalizeRequest } from "../src/protocol.mjs";
import { sessionProgressTrace } from "../scripts/fixtures/session-progress-trace.mjs";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "fixtures", "cursor-session-fake-agent.mjs");

// In-memory ACP protocol double. Tests inject it with `createTransport` so no
// model, network or real cursor-agent process is ever involved.
class FakeTransport {
  constructor() {
    this.started = false;
    this.closed = false;
    this.closeCalls = 0;
    this.requests = [];
    this.notifications = [];
    this.responses = [];
    this.stderrText = "";
    this.behaviors = new Map();
    this.onNotification = null;
    this.onRequest = null;
    this.pending = new Set();
  }

  setHandlers({ onNotification, onRequest }) {
    this.onNotification = onNotification ?? null;
    this.onRequest = onRequest ?? null;
  }

  start() {
    this.started = true;
  }

  request(method, params, options = {}) {
    this.requests.push({ method, params, options });
    const behavior = this.behaviors.get(method);
    if (!behavior) {
      const error = new Error(`no fake behavior for ${method}`);
      error.code = -32601;
      return Promise.reject(error);
    }
    let rejectPending;
    const tracked = new Promise((resolve, reject) => {
      rejectPending = reject;
      Promise.resolve()
        .then(() => behavior(params, { ...options, transport: this, method }))
        .then(resolve, reject);
    });
    const record = { reject: (error) => rejectPending(error) };
    this.pending.add(record);
    tracked.then(() => this.pending.delete(record), () => this.pending.delete(record));
    return tracked;
  }

  notify(method, params) {
    if (this.closed) throw new Error("transport closed");
    this.notifications.push({ method, params });
  }

  respond(id, result) {
    this.responses.push({ id, result });
  }

  respondError(id, code, message, data) {
    this.responses.push({ id, code, message, data });
  }

  emitNotification(method, params) {
    return this.onNotification?.(params, { method });
  }

  emitRequest(method, params) {
    return this.onRequest?.(params, { method });
  }

  close() {
    this.closeCalls += 1;
    this.closed = true;
    for (const record of this.pending) record.reject(new Error("fake transport closed"));
    this.pending.clear();
    return Promise.resolve();
  }

  methods() {
    return this.requests.map((entry) => entry.method);
  }

  find(method) {
    return this.requests.filter((entry) => entry.method === method);
  }
}

function fakeAdapter(options = {}) {
  const transports = [];
  const factory = options.createTransport ?? (() => {
    const transport = new FakeTransport();
    transports.push(transport);
    return transport;
  });
  const adapter = new CursorSessionAdapter({
    command: "fake-cursor",
    requestTimeoutMs: 5_000,
    idleTimeoutMs: 0,
    ...options,
    createTransport: factory,
  });
  return { adapter, transports, last: () => transports.at(-1) };
}

function baseRequest(overrides = {}) {
  return normalizeRequest({
    target: "cursor",
    requestId: "req-cursor-session-001",
    task: "Return the handoff result.",
    cwd: process.cwd(),
    context: { source: "deterministic-test" },
    policy: { write: false, tools: [], maxCostUsd: null },
    ...overrides,
  });
}

const MODEL_OPTION = {
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue: "composer-2.5",
  options: [
    { value: "composer-2.5", name: "Composer 2.5" },
    { value: "gpt-5.4", name: "GPT-5.4" },
  ],
};

const MODE_OPTION = {
  id: "mode",
  name: "Mode",
  category: "mode",
  type: "select",
  currentValue: "agent",
  options: [
    { value: "ask", name: "Ask" },
    { value: "agent", name: "Agent" },
  ],
};

function sessionResult(sessionId = "sess-fake-1", { currentModeId = "agent" } = {}) {
  const configOptions = JSON.parse(JSON.stringify([MODEL_OPTION, MODE_OPTION]));
  for (const option of configOptions) if (option.id === "mode") option.currentValue = currentModeId;
  return {
    sessionId,
    configOptions,
    modes: { availableModes: [{ id: "ask", name: "Ask" }, { id: "agent", name: "Agent" }], currentModeId },
  };
}

function initializeResult(overrides = {}) {
  return {
    protocolVersion: 1,
    agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, close: {} } },
    agentInfo: { name: "fake-cursor", version: "0.0.0" },
    authMethods: [{ id: "cursor_login", name: "Cursor Login", type: "agent" }],
    ...overrides,
  };
}

function wireHandshake(transport, { init = initializeResult(), session = sessionResult() } = {}) {
  let sessionId = session.sessionId;
  let configOptions = JSON.parse(JSON.stringify(session.configOptions ?? [MODEL_OPTION, MODE_OPTION]));
  transport.behaviors.set("initialize", () => init);
  transport.behaviors.set("session/new", () => ({ ...session, configOptions: JSON.parse(JSON.stringify(configOptions)) }));
  transport.behaviors.set("session/resume", (params) => ({ ...sessionResult(params.sessionId), configOptions: JSON.parse(JSON.stringify(configOptions)) }));
  transport.behaviors.set("session/load", (params) => ({ ...sessionResult(params.sessionId), configOptions: JSON.parse(JSON.stringify(configOptions)) }));
  transport.behaviors.set("authenticate", () => ({}));
  transport.behaviors.set("session/set_config_option", (params) => {
    configOptions = configOptions.map((option) =>
      option.id === params.configId ? { ...option, currentValue: params.value } : option);
    return { configOptions: JSON.parse(JSON.stringify(configOptions)) };
  });
  transport.behaviors.set("session/set_mode", () => ({}));
  transport.behaviors.set("session/prompt", async (params, { transport: fake }) => {
    const target = typeof params?.sessionId === "string" && params.sessionId ? params.sessionId : sessionId;
    await fake.emitNotification("session/update", {
      sessionId: target,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello " } },
    });
    await fake.emitNotification("session/update", {
      sessionId: target,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "world" } },
    });
    await fake.emitNotification("session/update", {
      sessionId: target,
      update: { sessionUpdate: "usage_update", used: 100, size: 200_000, cost: { amount: 0.05, currency: "USD" } },
    });
    return { stopReason: "end_turn" };
  });
  return transport;
}

test("exports a named class, a default class and truthful client capabilities", () => {
  assert.equal(typeof CursorSessionAdapter, "function");
  assert.equal(CursorSessionAdapterDefault, CursorSessionAdapter);
  assert.equal(SESSION_CAPABILITIES.fsReadTextFile, false);
  assert.equal(SESSION_CAPABILITIES.fsWriteTextFile, false);
  assert.equal(SESSION_CAPABILITIES.terminal, false);
  assert.equal(SESSION_CAPABILITIES.steer, false);
  assert.equal(SESSION_CAPABILITIES.followUp, false);
  assert.equal(SESSION_CAPABILITIES.resume, "negotiated");
});

test("helper functions strip parameterized model ids and classify tool kinds", () => {
  assert.equal(resolveCursorAcpBaseModelId("gpt-5.4[high]"), "gpt-5.4");
  assert.equal(resolveCursorAcpBaseModelId("  "), "default");
  assert.equal(toolRequiresWrite("edit"), true);
  assert.equal(toolRequiresWrite("execute"), true);
  assert.equal(toolRequiresWrite("read"), false);
  assert.equal(toolRequiresWrite(undefined), true);
  assert.deepEqual(
    permissionDecision({ policyWrite: false, toolKind: "read", options: [{ optionId: "a", kind: "allow_once" }, { optionId: "r", kind: "reject_once" }] }),
    { outcome: { outcome: "selected", optionId: "a" }, decision: "allowed", enforced: true },
  );
  assert.deepEqual(
    permissionDecision({ policyWrite: false, toolKind: "execute", options: [{ optionId: "a", kind: "allow_once" }, { optionId: "r", kind: "reject_once" }] }),
    { outcome: { outcome: "selected", optionId: "r" }, decision: "rejected", enforced: true },
  );
  const loose = permissionDecision({ policyWrite: false, toolKind: "edit", options: [{ optionId: "a", kind: "allow_once" }] });
  assert.equal(loose.decision, "cancelled");
  assert.equal(loose.enforced, false);
  assert.deepEqual(resolveCursorAcpBaseModelId("gpt-5.4[high]"), "gpt-5.4");
  assert.deepEqual(resolveConfigOptionValue(MODEL_OPTION, "gpt-5.4[high]"), { value: "gpt-5.4", matched: true });
  assert.equal(resolveConfigOptionValue(MODEL_OPTION, "nope").matched, false);
  assert.deepEqual(
    resolveConfigOptionValue({ id: "model", type: "select", currentValue: "x", options: [] }, "anything"),
    { value: "anything", matched: true },
  );
  // Read-only mode selection is exact-id only. Descriptions and names never
  // grant a permission boundary.
  assert.equal(desiredModeId(false, [{ id: "agent", description: "Ask anything" }]), null);
  assert.equal(desiredModeId(false, [{ id: "agent", name: "Ask anything", description: "read-only Q&A" }]), null);
  assert.equal(desiredModeId(false, [{ id: "ask" }]), "ask");
  assert.equal(desiredModeId(false, [{ id: "plan", name: "Plan" }]), "plan");
  assert.equal(desiredModeId(false, [{ id: "ask", name: "Ask" }, { id: "agent" }]), "ask");
  assert.equal(desiredModeId(true, [{ id: "ask" }, { id: "agent" }]), "agent");
  assert.equal(desiredModeId(true, [{ value: "code" }]), "code");
});

test("negotiates resume/load capability from the initialize response", () => {
  const withResume = negotiateCapabilities(initializeResult());
  assert.equal(withResume.resume, true);
  assert.equal(withResume.loadSession, true);
  assert.equal(withResume.protocolVersion, 1);
  const loadOnly = negotiateCapabilities({ protocolVersion: 1, agentCapabilities: { loadSession: true } });
  assert.equal(loadOnly.resume, false);
  assert.equal(loadOnly.loadSession, true);
  const none = negotiateCapabilities({ protocolVersion: 1, agentCapabilities: {} });
  assert.equal(none.resume, false);
  assert.equal(none.loadSession, false);
});

test("handshake creates a session, applies mode, prompts and folds streamed output", async () => {
  const { adapter, last } = fakeAdapter();
  const transport = wireHandshake(new FakeTransport());
  adapter.createTransport = () => transport;
  const progress = [];
  const output = await adapter.run(baseRequest(), { onProgress: (event) => { progress.push(event); } });

  assert.deepEqual(transport.methods().slice(0, 2), ["initialize", "session/new"]);
  const initialize = transport.find("initialize")[0].params;
  assert.equal(initialize.protocolVersion, 1);
  assert.deepEqual(initialize.clientCapabilities, {});
  assert.equal(initialize.clientInfo.name, "harnest");
  const newSession = transport.find("session/new")[0].params;
  assert.equal(newSession.cwd, process.cwd());
  assert.deepEqual(newSession.mcpServers, []);

  const modeRequest = transport.find("session/set_config_option").find((entry) => entry.params.configId === "mode");
  assert.ok(modeRequest, "read-only sets the ask mode when it is advertised");
  assert.equal(modeRequest.params.value, "ask");

  assert.equal(output.sessionId, "sess-fake-1");
  assert.equal(output.workflowRunId, "cursor:req-cursor-session-001");
  assert.equal(output.route.harness, "cursor");
  assert.equal(output.route.transport, "acp");
  assert.equal(output.route.model, "composer-2.5");
  assert.equal(output.result.finalText, "hello world");
  assert.equal(output.usage.totalCostUsd, 0.05);
  assert.equal(output.usage.contextWindowUsed, 100);
  assert.equal(output.usage.contextWindowSize, 200_000);
  assert.equal(output.usageSummary.inputTokens, null);
  assert.equal(output.usageSummary.outputTokens, null);
  assert.equal(output.usageSummary.costUsd, 0.05);
  assert.equal(output.capabilities.resume, true);
  assert.ok(progress.some((event) => event.type === "cursor_delta"));
  assert.ok(progress.some((event) => event.type === "cursor_usage"));
  assert.deepEqual(output.result.eventSummary.types.includes("agent_message_chunk"), true);
  await adapter.close();
  assert.ok(transport.closeCalls >= 1);
});

test("passes an explicit model through the negotiated config option verbatim", async () => {
  const { adapter } = fakeAdapter();
  const transport = wireHandshake(new FakeTransport());
  adapter.createTransport = () => transport;
  const output = await adapter.run(baseRequest({ route: { provider: "cursor", model: "gpt-5.4" } }));
  const modelRequest = transport.find("session/set_config_option").find((entry) => entry.params.configId === "model");
  assert.ok(modelRequest);
  assert.equal(modelRequest.params.value, "gpt-5.4");
  assert.equal(output.route.model, "gpt-5.4");
  await adapter.close();
});

test("rejects an unadvertised model before any prompt instead of silently running another", async () => {
  const { adapter } = fakeAdapter();
  const transport = wireHandshake(new FakeTransport());
  adapter.createTransport = () => transport;
  await assert.rejects(
    adapter.run(baseRequest({ route: { model: "not-a-real-model" } })),
    (error) => error.details?.kind === "unavailable" && /did not advertise/.test(error.message),
  );
  assert.equal(transport.find("session/prompt").length, 0);
  await adapter.close();
});

test("write policy selects the implement mode instead of ask", async () => {
  const { adapter } = fakeAdapter();
  const transport = wireHandshake(new FakeTransport(), { session: sessionResult("sess-fake-1", { currentModeId: "ask" }) });
  adapter.createTransport = () => transport;
  await adapter.run(baseRequest({ policy: { write: true } }));
  const modeRequest = transport.find("session/set_config_option").find((entry) => entry.params.configId === "mode");
  assert.ok(modeRequest);
  assert.equal(modeRequest.params.value, "agent");
  await adapter.close();
});

test("resumes a native session and reuses it only for the same explicit session identity", async () => {
  const { adapter } = fakeAdapter();
  const transport = wireHandshake(new FakeTransport());
  adapter.createTransport = () => transport;
  const first = await adapter.run(baseRequest({ execution: { sessionId: "prior-1" } }));
  assert.equal(first.sessionId, "prior-1");
  assert.deepEqual(transport.methods().slice(0, 2), ["initialize", "session/resume"]);
  assert.equal(transport.find("session/resume")[0].params.sessionId, "prior-1");

  const second = await adapter.run(baseRequest({ execution: { sessionId: "prior-1" }, task: "Follow up." }));
  assert.equal(second.sessionId, "prior-1");
  assert.equal(transport.find("initialize").length, 1, "a matching explicit session is reused, not re-initialized");
  assert.equal(transport.find("session/resume").length, 1);
  assert.equal(transport.find("session/prompt").length, 2);

  const third = await adapter.run(baseRequest({ execution: { sessionId: "other-2" } }));
  assert.equal(third.sessionId, "other-2");
  assert.equal(transport.find("initialize").length, 2, "a different session id starts a fresh connection");
  await adapter.close();
});

test("resume without advertised capability fails instead of silently starting a new session", async () => {
  const { adapter } = fakeAdapter();
  const transport = wireHandshake(new FakeTransport(), {
    init: initializeResult({ agentCapabilities: {} }),
  });
  adapter.createTransport = () => transport;
  await assert.rejects(
    adapter.run(baseRequest({ execution: { sessionId: "prior-1" } })),
    (error) => error.details?.kind === "resume-unsupported" && /refusing to silently start/.test(error.message),
  );
  assert.equal(transport.find("session/new").length, 0);
  assert.equal(transport.find("session/prompt").length, 0);
  assert.equal(transport.closed, true, "the failed transport is closed");
  await adapter.close();
});

test("falls back to session/load only when the agent advertises it", async () => {
  const { adapter } = fakeAdapter();
  const transport = wireHandshake(new FakeTransport(), {
    init: initializeResult({ agentCapabilities: { loadSession: true } }),
  });
  adapter.createTransport = () => transport;
  const output = await adapter.run(baseRequest({ execution: { sessionId: "prior-load" } }));
  assert.equal(output.sessionId, "prior-load");
  assert.deepEqual(transport.methods().slice(0, 2), ["initialize", "session/load"]);
  await adapter.close();
});

test("authenticates natively after auth_required and then retries session setup", async () => {
  const { adapter } = fakeAdapter();
  const transport = new FakeTransport();
  let authed = false;
  transport.behaviors.set("initialize", () => initializeResult());
  transport.behaviors.set("session/new", () => {
    if (!authed) {
      const error = new Error("Authentication required");
      error.code = -32000;
      throw error;
    }
    return sessionResult();
  });
  transport.behaviors.set("authenticate", () => { authed = true; return {}; });
  transport.behaviors.set("session/set_config_option", (params) => ({
    configOptions: [MODEL_OPTION, MODE_OPTION].map((option) =>
      option.id === params.configId ? { ...option, currentValue: params.value } : option),
  }));
  transport.behaviors.set("session/prompt", () => ({ stopReason: "end_turn" }));
  adapter.createTransport = () => transport;
  await assert.rejects(adapter.run(baseRequest()), (error) => error.details?.kind === "downstream");
  assert.equal(transport.find("authenticate").length, 1);
  assert.equal(transport.find("session/new").length, 2);
  await adapter.close();
});

test("read-only rejects write/execute permission and never proxies host IO", async () => {
  const { adapter } = fakeAdapter();
  const transport = new FakeTransport();
  wireHandshake(transport);
  transport.behaviors.set("session/prompt", async (params, { transport: fake }) => {
    // The agent must not be able to ask this client to write files.
    let fsOutcome;
    try {
      await fake.emitRequest("fs/write_text_file", { sessionId: "sess-fake-1", path: "C:/tmp/x.txt", content: "no" });
      fsOutcome = "allowed";
    } catch (error) {
      fsOutcome = `denied:${error.details?.rpcCode}`;
    }
    const outcome = await fake.emitRequest("session/request_permission", {
      sessionId: "sess-fake-1",
      toolCall: { toolCallId: "call-1", title: "Edit file", kind: "edit" },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
    });
    await fake.emitNotification("session/update", {
      sessionId: "sess-fake-1",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${fsOutcome};${outcome.outcome.optionId}` } },
    });
    return { stopReason: "end_turn" };
  });
  adapter.createTransport = () => transport;
  const progress = [];
  const output = await adapter.run(baseRequest(), { onProgress: (event) => progress.push(event) });
  assert.equal(output.result.finalText, "denied:-32601;reject-once");
  assert.equal(adapter.session.policyUnenforced, false);
  const permissionEvent = progress.find((event) => event.type === "cursor_permission");
  assert.equal(permissionEvent.decision, "rejected");
  assert.equal(permissionEvent.enforced, true);
  await adapter.close();
});

test("read-only cancels a mutating turn when the agent offers no reject option", async () => {
  const { adapter } = fakeAdapter();
  const transport = new FakeTransport();
  wireHandshake(transport);
  transport.behaviors.set("session/prompt", async (params, { transport: fake }) => {
    const outcome = await fake.emitRequest("session/request_permission", {
      sessionId: "sess-fake-1",
      toolCall: { toolCallId: "call-2", title: "Edit file", kind: "edit" },
      options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
    });
    return { stopReason: outcome.outcome.outcome === "cancelled" ? "cancelled" : "end_turn" };
  });
  adapter.createTransport = () => transport;
  await assert.rejects(
    adapter.run(baseRequest()),
    (error) => error.details?.kind === "policy" && /could not prove read-only/.test(error.message),
  );
  const cancels = transport.notifications.filter((entry) => entry.method === "session/cancel");
  assert.equal(cancels.length, 1, "the turn is cancelled instead of granting write access");
  assert.equal(transport.closed, true);
  await adapter.close();
});

function readOnlySession({ configOptions, modes }) {
  return { sessionId: "sess-fake-1", ...(configOptions ? { configOptions } : {}), ...(modes ? { modes } : {}) };
}

async function assertReadOnlyRefused(session, pattern) {
  const { adapter } = fakeAdapter();
  const transport = new FakeTransport();
  wireHandshake(transport, { session });
  adapter.createTransport = () => transport;
  await assert.rejects(
    adapter.run(baseRequest()),
    (error) => error.details?.kind === "policy" && pattern.test(error.message),
  );
  assert.equal(transport.find("session/prompt").length, 0, "a refused read-only run must never dispatch a prompt");
  assert.equal(transport.closed, true, "the refused session is retired");
  await adapter.close();
}

test("read-only refuses an agent that only advertises a permissive mode", async () => {
  await assertReadOnlyRefused(readOnlySession({
    configOptions: [MODEL_OPTION, { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "agent", options: [{ value: "agent", name: "Agent" }] }],
    modes: { availableModes: [{ id: "agent", name: "Agent" }], currentModeId: "agent" },
  }), /no exact read-only mode/);
});

test("read-only ignores a permissive mode with a misleading read-only name or description", async () => {
  await assertReadOnlyRefused(readOnlySession({
    configOptions: [MODEL_OPTION, {
      id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "agent",
      options: [{ value: "agent", name: "Ask anything", description: "read-only Q&A" }],
    }],
    modes: { availableModes: [{ id: "agent", name: "Ask anything", description: "Ask anything, read only" }], currentModeId: "agent" },
  }), /no exact read-only mode/);
});

test("read-only refuses modes without a verifiable mode config option", async () => {
  await assertReadOnlyRefused(readOnlySession({
    configOptions: [MODEL_OPTION],
    modes: { availableModes: [{ id: "ask", name: "Ask" }, { id: "agent", name: "Agent" }], currentModeId: "ask" },
  }), /verifiable mode config option/);
});

test("read-only refuses a mode change the agent does not acknowledge", async () => {
  const { adapter } = fakeAdapter();
  const transport = new FakeTransport();
  wireHandshake(transport);
  // The agent answers but keeps reporting the permissive mode.
  transport.behaviors.set("session/set_config_option", () => ({
    configOptions: [MODEL_OPTION, { ...MODE_OPTION, currentValue: "agent" }],
  }));
  adapter.createTransport = () => transport;
  await assert.rejects(
    adapter.run(baseRequest()),
    (error) => error.details?.kind === "policy" && /did not acknowledge the requested read-only mode/.test(error.message),
  );
  assert.equal(transport.find("session/prompt").length, 0);
  assert.equal(transport.closed, true);
  await adapter.close();
});

test("read-only accepts the documented plan mode when ask is not advertised", async () => {
  const { adapter } = fakeAdapter();
  const transport = new FakeTransport();
  wireHandshake(transport, {
    session: readOnlySession({
      configOptions: [MODEL_OPTION, {
        id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "agent",
        options: [{ value: "agent", name: "Agent" }, { value: "plan", name: "Plan" }],
      }],
      modes: { availableModes: [{ id: "agent", name: "Agent" }, { id: "plan", name: "Plan" }], currentModeId: "agent" },
    }),
  });
  adapter.createTransport = () => transport;
  const modeSets = [];
  const base = transport.behaviors.get("session/set_config_option");
  transport.behaviors.set("session/set_config_option", (params, ctx) => {
    if (params.configId === "mode") modeSets.push(params.value);
    return base(params, ctx);
  });
  const output = await adapter.run(baseRequest());
  assert.deepEqual(modeSets, ["plan"]);
  assert.equal(transport.find("session/prompt").length, 1);
  assert.equal(output.result.finalText, "hello world");
  await adapter.close();
});

test("write policy uses session/set_mode when only mode state is advertised", async () => {
  const { adapter } = fakeAdapter();
  const transport = new FakeTransport();
  wireHandshake(transport, {
    session: readOnlySession({
      configOptions: [MODEL_OPTION],
      modes: { availableModes: [{ id: "ask", name: "Ask" }, { id: "agent", name: "Agent" }], currentModeId: "ask" },
    }),
  });
  adapter.createTransport = () => transport;
  const output = await adapter.run(baseRequest({ policy: { write: true } }));
  const modeSet = transport.find("session/set_mode")[0];
  assert.ok(modeSet, "write policy switches to the full-access mode");
  assert.equal(modeSet.params.modeId, "agent");
  assert.equal(transport.find("session/set_config_option").filter((entry) => entry.params.configId === "mode").length, 0);
  assert.equal(transport.find("session/prompt").length, 1);
  assert.equal(output.result.finalText, "hello world");
  await adapter.close();
});

test("write policy refuses a mode change the agent does not acknowledge", async () => {
  const { adapter } = fakeAdapter();
  const transport = new FakeTransport();
  wireHandshake(transport, { session: sessionResult("sess-fake-1", { currentModeId: "ask" }) });
  transport.behaviors.set("session/set_config_option", () => ({
    configOptions: [MODEL_OPTION, { ...MODE_OPTION, currentValue: "ask" }],
  }));
  adapter.createTransport = () => transport;
  await assert.rejects(
    adapter.run(baseRequest({ policy: { write: true } })),
    (error) => error.details?.kind === "policy" && /did not acknowledge the requested mode/.test(error.message),
  );
  assert.equal(transport.find("session/prompt").length, 0);
  await adapter.close();
});

test("write policy approves permission requests it can grant", async () => {
  const { adapter } = fakeAdapter();
  const transport = new FakeTransport();
  wireHandshake(transport);
  transport.behaviors.set("session/prompt", async (params, { transport: fake }) => {
    const outcome = await fake.emitRequest("session/request_permission", {
      sessionId: "sess-fake-1",
      toolCall: { toolCallId: "call-3", title: "Edit file", kind: "edit" },
      options: [
        { optionId: "allow-always", name: "Always", kind: "allow_always" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
    });
    await fake.emitNotification("session/update", {
      sessionId: "sess-fake-1",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: outcome.outcome.optionId } },
    });
    return { stopReason: "end_turn" };
  });
  adapter.createTransport = () => transport;
  const output = await adapter.run(baseRequest({ policy: { write: true } }));
  assert.equal(output.result.finalText, "allow-always");
  await adapter.close();
});

test("native cancel waits for the prompt to settle and reports the stop reason", async () => {
  const { adapter } = fakeAdapter({ cancelTimeoutMs: 1_000 });
  const transport = new FakeTransport();
  wireHandshake(transport);
  let settle;
  transport.behaviors.set("session/prompt", () => new Promise((resolve) => { settle = resolve; }));
  transport.notify = function notify(method, params) {
    this.notifications.push({ method, params });
    if (method === "session/cancel" && settle) {
      const resolve = settle;
      settle = null;
      resolve({ stopReason: "cancelled" });
    }
  };
  adapter.createTransport = () => transport;
  const runPromise = adapter.run(baseRequest()).catch((error) => error);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const acknowledgement = await adapter.control({ commandId: "c1", kind: "cancel" });
  assert.equal(acknowledgement.settled, true);
  assert.equal(acknowledgement.stopReason, "cancelled");
  assert.equal(acknowledgement.delivery, "native");
  const error = await runPromise;
  assert.equal(error.details?.kind, "abort");
  await adapter.close();
});

test("cancel acknowledgement timeout fails uncertain instead of claiming the turn stopped", async () => {
  const { adapter } = fakeAdapter({ cancelTimeoutMs: 30 });
  const transport = new FakeTransport();
  wireHandshake(transport);
  transport.behaviors.set("session/prompt", () => new Promise(() => {}));
  adapter.createTransport = () => transport;
  const runPromise = adapter.run(baseRequest()).catch((error) => error);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await assert.rejects(
    adapter.control({ commandId: "c2", kind: "cancel" }),
    (error) => error.details?.kind === "cancel-unacknowledged" && error.details?.uncertain === true,
  );
  assert.equal(transport.closed, true, "an unacknowledged cancel retires the connection");
  await runPromise;
  await adapter.close();
});

test("steering and follow-up fail closed because ACP has no documented queued control", async () => {
  const { adapter } = fakeAdapter();
  const transport = new FakeTransport();
  wireHandshake(transport);
  let settle;
  transport.behaviors.set("session/prompt", () => new Promise((resolve) => { settle = resolve; }));
  adapter.createTransport = () => transport;
  const runPromise = adapter.run(baseRequest()).catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 10));
  for (const delivery of ["steer", "follow_up"]) {
    await assert.rejects(
      adapter.control({ commandId: `m-${delivery}`, kind: "message", delivery, message: "hurry" }),
      (error) => error.details?.kind === "unsupported-control",
    );
  }
  settle({ stopReason: "end_turn" });
  await runPromise;
  await adapter.close();
});

test("reroute applies a negotiated model config option and rejects an unadvertised model", async () => {
  const { adapter } = fakeAdapter();
  const transport = new FakeTransport();
  wireHandshake(transport);
  let settle;
  transport.behaviors.set("session/prompt", () => new Promise((resolve) => { settle = resolve; }));
  adapter.createTransport = () => transport;
  const runPromise = adapter.run(baseRequest()).catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 10));

  const applied = await adapter.control({ commandId: "r1", kind: "reroute", route: { provider: "cursor", model: "gpt-5.4" } });
  assert.equal(applied.command, "set_config_option");
  assert.equal(applied.model, "gpt-5.4");
  assert.equal(applied.effect, "next_model_request");

  await assert.rejects(
    adapter.control({ commandId: "r2", kind: "reroute", route: { provider: "cursor", model: "nope" } }),
    (error) => error.details?.kind === "control" && /did not advertise/.test(error.message),
  );
  settle({ stopReason: "end_turn" });
  await runPromise;
  await adapter.close();
});

test("policy rejections happen before any transport is started", async () => {
  const { adapter } = fakeAdapter();
  let created = 0;
  adapter.createTransport = () => { created += 1; return wireHandshake(new FakeTransport()); };
  await assert.rejects(adapter.run(baseRequest({ policy: { tools: ["read"] } })), (error) => error.details?.kind === "policy");
  await assert.rejects(adapter.run(baseRequest({ policy: { write: true, maxCostUsd: 5 } })), (error) => error.details?.kind === "policy");
  await assert.rejects(adapter.run(baseRequest({ route: { model: "gpt-5.4", thinking: "high" } })), (error) => error.details?.kind === "policy");
  assert.equal(created, 0);
});

test("graph workflows are rejected before spawn", async () => {
  const { adapter } = fakeAdapter();
  let created = 0;
  adapter.createTransport = () => { created += 1; return wireHandshake(new FakeTransport()); };
  await assert.rejects(
    adapter.run(baseRequest({ workflow: { spec: { name: "flow" } } })),
    (error) => error.details?.kind === "policy",
  );
  assert.equal(created, 0);
});

test("an already-aborted signal never starts a transport", async () => {
  const { adapter } = fakeAdapter();
  let created = 0;
  adapter.createTransport = () => { created += 1; return wireHandshake(new FakeTransport()); };
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(adapter.run(baseRequest(), { signal: controller.signal }), (error) => error.details?.kind === "abort");
  assert.equal(created, 0);
});

test("file reads and terminal requests are denied without host IO", async () => {
  const { adapter } = fakeAdapter();
  const transport = wireHandshake(new FakeTransport());
  adapter.createTransport = () => transport;
  transport.behaviors.set("session/prompt", async (params, { transport: fake }) => {
    const results = [];
    for (const [method, requestParams] of [
      ["fs/read_text_file", { sessionId: "sess-fake-1", path: "C:/tmp/x.txt" }],
      ["terminal/create", { sessionId: "sess-fake-1", command: "node" }],
    ]) {
      try {
        await fake.emitRequest(method, requestParams);
        results.push(`${method}:allowed`);
      } catch (error) {
        results.push(`${method}:${error.details?.rpcCode}:${error.details?.denied === true}`);
      }
    }
    await fake.emitNotification("session/update", {
      sessionId: "sess-fake-1",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: results.join("|") } },
    });
    return { stopReason: "end_turn" };
  });
  const output = await adapter.run(baseRequest());
  assert.equal(output.result.finalText, "fs/read_text_file:-32601:false|terminal/create:-32601:true");
  await adapter.close();
});

test("progress backpressure is awaited in order and never overlaps", async () => {
  const { adapter } = fakeAdapter();
  const transport = wireHandshake(new FakeTransport());
  adapter.createTransport = () => transport;
  let inFlight = 0;
  let maxInFlight = 0;
  const seen = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  setTimeout(() => release(), 20);
  let gateUsed = false;
  const output = await adapter.run(baseRequest({ task: "Backpressure run." }), {
    onProgress: async (event) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (!gateUsed) {
        gateUsed = true;
        await gate;
      }
      seen.push(event.type);
      inFlight -= 1;
    },
  });
  assert.equal(maxInFlight, 1, "progress callbacks never run concurrently");
  assert.deepEqual(seen, ["cursor_usage", "cursor_delta"]);
  assert.equal(output.result.finalText, "hello world");
  await adapter.close();
});

test("Cursor redacts progress before truncation and fields before returning the result", async (t) => {
  const transport = wireHandshake(new FakeTransport());
  const { adapter } = fakeAdapter({ createTransport: () => transport });
  t.after(() => adapter.close());
  const sentinel = `sk-${"synthetic".repeat(3)}`;
  transport.behaviors.set("session/prompt", async ({ sessionId }) => {
    const text = JSON.stringify({ finalText: "done", summary: `${"a".repeat(1963)} ${sentinel}` });
    await transport.emitNotification("session/update", {
      sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    });
    return { stopReason: "end_turn" };
  });
  const progress = [];
  const output = await adapter.run(baseRequest(), { onProgress: (event) => { progress.push(event); } });
  assert.equal(output.result.finalText, "done");
  assert.ok(output.result.summary.endsWith(" [REDACTED]"));
  const delta = progress.find(({ type }) => type === "cursor_delta").text;
  assert.equal(delta.length, 2_000);
  assert.match(delta, / \[REDA$/);
});

for (const [block, eventType] of [["message", "cursor_delta"], ["thought", "cursor_thought"]]) {
  test(`Cursor keeps credentials split across ${block} chunks out of progress and trace`, async (t) => {
    const transport = wireHandshake(new FakeTransport());
    const { adapter } = fakeAdapter({ createTransport: () => transport });
    t.after(() => adapter.close());
    const trace = await sessionProgressTrace(t);
    const value = "json-password-value";
    transport.behaviors.set("session/prompt", async ({ sessionId }) => {
      const emit = (kind, text) => transport.emitNotification("session/update", {
        sessionId, update: { sessionUpdate: `agent_${kind}_chunk`, content: { type: "text", text } },
      });
      await emit(block, "password=");
      await emit(block, value);
      if (block === "thought") await emit("message", "done");
      return { stopReason: "end_turn" };
    });
    await adapter.run(baseRequest(), { onProgress: trace.onProgress });
    await trace.assertRedacted(eventType, value);
  });
}

test("a failed progress callback fails the run through the transport path", async () => {
  const { adapter } = fakeAdapter();
  const transport = wireHandshake(new FakeTransport());
  adapter.createTransport = () => transport;
  await assert.rejects(
    adapter.run(baseRequest(), { onProgress: () => { throw new Error("disk full"); } }),
    (error) => error.details?.kind === "transport" && /progress callback failed/.test(error.message),
  );
  await adapter.close();
});

test("late events after settle are ignored and do not corrupt the returned turn", async () => {
  const { adapter } = fakeAdapter();
  const transport = wireHandshake(new FakeTransport());
  adapter.createTransport = () => transport;
  const output = await adapter.run(baseRequest());
  assert.equal(output.result.finalText, "hello world");
  await transport.emitNotification("session/update", {
    sessionId: "sess-fake-1",
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " LATE" } },
  });
  assert.equal(adapter.session.finalText, "hello world");
  await transport.emitNotification("session/update", {
    sessionId: "sess-other",
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "WRONG SESSION" } },
  });
  assert.equal(adapter.session.finalText, "hello world");
  await adapter.close();
});

test("events from a different session id are ignored while a prompt is active", async () => {
  const { adapter } = fakeAdapter();
  const transport = wireHandshake(new FakeTransport());
  transport.behaviors.set("session/prompt", async (params, { transport: fake }) => {
    await fake.emitNotification("session/update", {
      sessionId: "sess-other",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "leak" } },
    });
    await fake.emitNotification("session/update", {
      sessionId: "sess-fake-1",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "clean" } },
    });
    return { stopReason: "end_turn" };
  });
  adapter.createTransport = () => transport;
  const output = await adapter.run(baseRequest());
  assert.equal(output.result.finalText, "clean");
  await adapter.close();
});

function fixtureAdapter(env = {}, options = {}) {
  const children = [];
  const adapter = new CursorSessionAdapter({
    launch: { command: process.execPath, args: [FIXTURE] },
    spawnFn: (command, args, spawnOptions) => {
      const child = nodeSpawn(command, args, spawnOptions);
      children.push(child);
      return child;
    },
    env: { ...process.env, ...env },
    idleTimeoutMs: 0,
    cancelTimeoutMs: options.cancelTimeoutMs ?? 500,
    ...options,
  });
  return { adapter, children };
}

function waitForExit(child, timeoutMs = 5_000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once("close", () => { clearTimeout(timer); resolve(); });
  });
}

async function waitForSession(adapter, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (adapter.session && !adapter.session.closed) return adapter.session;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("fixture session did not become active");
}

test("real stdio: handshake, prompt, usage and idempotent cleanup against a child process", async (t) => {
  const { adapter, children } = fixtureAdapter({ FAKE_ACP_MODE: "happy" });
  t.after(() => adapter.close());
  const output = await adapter.run(baseRequest());
  assert.equal(output.sessionId, "sess-fake-1");
  assert.equal(output.result.finalText, "hello happy answer");
  assert.equal(output.usage.totalCostUsd, 0.05);
  assert.equal(output.usageSummary.inputTokens, null);
  assert.equal(output.usageSummary.costUsd, 0.05);
  assert.equal(children.length, 1);
  await adapter.close();
  await adapter.close();
  await waitForExit(children[0]);
  assert.ok(children[0].exitCode !== null || children[0].signalCode !== null, "the owned child is stopped");
});

test("real stdio: an oversized frame fails with output-limit and cleans up", async (t) => {
  const { adapter, children } = fixtureAdapter({ FAKE_ACP_MODE: "oversized" });
  t.after(() => adapter.close());
  await assert.rejects(adapter.run(baseRequest()), (error) => {
    assert.equal(error.details?.kind, "output-limit");
    assert.match(error.message, /maxLineBytes/);
    return true;
  });
  await adapter.close();
  await waitForExit(children[0]);
  assert.ok(children[0].exitCode !== null || children[0].signalCode !== null);
});

test("real stdio: non-JSON stdout is a protocol failure, not a final answer", async (t) => {
  const { adapter, children } = fixtureAdapter({ FAKE_ACP_MODE: "nonjson" });
  t.after(() => adapter.close());
  await assert.rejects(adapter.run(baseRequest()), (error) => {
    assert.equal(error.details?.kind, "transport");
    assert.match(error.message, /non-JSON/);
    return true;
  });
  await adapter.close();
  await waitForExit(children[0]);
});

test("real stdio: native cancel settles through session/cancel", async (t) => {
  const { adapter, children } = fixtureAdapter({ FAKE_ACP_MODE: "cancel-slow", FAKE_ACP_CANCEL_DELAY_MS: "30" });
  t.after(() => adapter.close());
  const runPromise = adapter.run(baseRequest()).catch((error) => error);
  await waitForSession(adapter);
  const acknowledgement = await adapter.control({ commandId: "real-cancel", kind: "cancel" });
  assert.equal(acknowledgement.settled, true);
  assert.equal(acknowledgement.stopReason, "cancelled");
  const error = await runPromise;
  assert.equal(error.details?.kind, "abort");
  await adapter.close();
  await waitForExit(children[0]);
});

test("real stdio: an ignored cancel times out uncertain and retires the child", async (t) => {
  const { adapter, children } = fixtureAdapter({ FAKE_ACP_MODE: "cancel-ignored" }, { cancelTimeoutMs: 80 });
  t.after(() => adapter.close());
  const runPromise = adapter.run(baseRequest()).catch((error) => error);
  await waitForSession(adapter);
  await assert.rejects(
    adapter.control({ commandId: "real-cancel-ignored", kind: "cancel" }),
    (error) => error.details?.kind === "cancel-unacknowledged" && error.details?.uncertain === true,
  );
  await runPromise;
  await waitForExit(children[0]);
  assert.ok(children[0].exitCode !== null || children[0].signalCode !== null);
});

test("real stdio: late events after settle do not corrupt a subsequent reused turn", async (t) => {
  const { adapter, children } = fixtureAdapter({ FAKE_ACP_MODE: "late" });
  t.after(() => adapter.close());
  const first = await adapter.run(baseRequest());
  assert.equal(first.result.finalText, "final");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(adapter.session.finalText, "final");
  const second = await adapter.run(baseRequest({ execution: { sessionId: "sess-fake-1" }, task: "Follow up." }));
  assert.equal(second.result.finalText, "final");
  await adapter.close();
  await waitForExit(children[0]);
});

test("real stdio: progress stays serialized under a slow consumer", async (t) => {
  const { adapter, children } = fixtureAdapter({ FAKE_ACP_MODE: "noisy", FAKE_ACP_CHUNKS: "120" });
  t.after(() => adapter.close());
  let inFlight = 0;
  let maxInFlight = 0;
  const messages = [];
  const output = await adapter.run(baseRequest(), {
    onProgress: async (event) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (event.type === "cursor_delta") messages.push(event.text);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
    },
  });
  assert.equal(maxInFlight, 1);
  assert.equal(messages.length, 12);
  assert.equal(messages.join(""), output.result.finalText);
  assert.ok(output.result.finalText.startsWith("chunk-0;"));
  assert.ok(output.result.finalText.includes("chunk-119;"));
  await adapter.close();
  await waitForExit(children[0]);
});

