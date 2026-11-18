// Deterministic fake `cursor-agent acp` for tests. It speaks newline-delimited
// JSON-RPC 2.0 over stdio and never contacts a model or the network. Behavior
// is selected with FAKE_ACP_MODE; unknown modes fall back to `happy`.
//
// Modes:
//   happy            initialize/session/new/prompt with streamed text + usage
//   resume           same, but the test passes a sessionId and expects session/resume
//   load             advertises only loadSession (no sessionCapabilities.resume)
//   no-capabilities  advertises neither resume nor loadSession
//   auth-required    first session/new returns -32000 until authenticate succeeds
//   denied           asks the client for fs/write_text_file, then permission for an edit
//   permission-only-allow  permission request with only an allow option (read-only must cancel)
//   cancel-slow      holds the prompt until session/cancel arrives (delay configurable)
//   cancel-never     holds the prompt forever unless killed
//   oversized        writes a single stdout line larger than 2 MiB
//   nonjson          writes a non-JSON stdout line
//   late             answers the prompt, then emits one late agent_message_chunk
//   noisy            streams multi-chunk messages to exercise progress backpressure

import process from "node:process";

const MODE = process.env.FAKE_ACP_MODE || "happy";
const envNumber = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

let nextId = 1000;
let buffer = "";
let promptRequestId = null;
const pendingClientRequests = new Map();

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result: result ?? {} });
}

function respondError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function notify(method, params) {
  send({ jsonrpc: "2.0", method, params: params ?? {} });
}

function requestClient(method, params) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pendingClientRequests.set(id, { resolve, reject, method });
    send({ jsonrpc: "2.0", id, method, params: params ?? {} });
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

const BASE_CONFIG = [MODEL_OPTION, MODE_OPTION];

function initializeResult() {
  const capabilities = { loadSession: true, sessionCapabilities: { resume: {}, close: {} } };
  if (MODE === "no-capabilities") return { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "fake-cursor", version: "0.0.0" }, authMethods: [] };
  if (MODE === "load") return { protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: "fake-cursor", version: "0.0.0" }, authMethods: [] };
  return { protocolVersion: 1, agentCapabilities: capabilities, agentInfo: { name: "fake-cursor", version: "0.0.0" }, authMethods: [{ id: "cursor_login", name: "Cursor Login", type: "agent" }] };
}

function sessionResult(sessionId) {
  return {
    sessionId,
    configOptions: BASE_CONFIG.map((option) => ({ ...option, options: [...option.options] })),
    modes: { availableModes: [{ id: "ask", name: "Ask" }, { id: "agent", name: "Agent" }], currentModeId: "agent" },
  };
}

async function streamPrompt(id) {
  if (MODE === "oversized") {
    const chunk = `{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"sessionId\":\"sess-fake-1\",\"update\":{\"sessionUpdate\":\"agent_message_chunk\",\"content\":{\"type\":\"text\",\"text\":\"${"x".repeat(2 * 1024 * 1024 + 1024)}\"}}}}`;
    process.stdout.write(`${chunk}\n`);
    return;
  }
  if (MODE === "nonjson") {
    process.stdout.write("this is not JSON\n");
    return;
  }
  if (MODE === "denied") {
    try {
      await requestClient("fs/write_text_file", { sessionId: "sess-fake-1", path: "C:/tmp/should-not-write.txt", content: "denied" });
      notify("session/update", { sessionId: "sess-fake-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "FS-ALLOWED " } } });
    } catch {
      notify("session/update", { sessionId: "sess-fake-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "FS-DENIED " } } });
    }
    const outcome = await requestClient("session/request_permission", {
      sessionId: "sess-fake-1",
      toolCall: { toolCallId: "call-1", title: "Edit file", kind: "edit" },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
    });
    notify("session/update", { sessionId: "sess-fake-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `PERMISSION:${outcome?.outcome?.optionId ?? outcome?.outcome?.outcome ?? "none"}` } } });
    respond(id, { stopReason: "end_turn" });
    return;
  }
  if (MODE === "permission-only-allow") {
    const outcome = await requestClient("session/request_permission", {
      sessionId: "sess-fake-1",
      toolCall: { toolCallId: "call-2", title: "Edit file", kind: "edit" },
      options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
    });
    const label = outcome?.outcome?.outcome === "cancelled" ? "CANCELLED" : outcome?.outcome?.optionId ?? "none";
    notify("session/update", { sessionId: "sess-fake-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `PERMISSION:${label}` } } });
    respond(id, { stopReason: "end_turn" });
    return;
  }
  if (MODE === "cancel-slow" || MODE === "cancel-ignored") {
    promptRequestId = id;
    if (MODE === "cancel-slow") {
      const delay = envNumber("FAKE_ACP_CANCEL_DELAY_MS", 10);
      setTimeout(() => {
        if (promptRequestId !== id) return;
        promptRequestId = null;
        notify("session/update", { sessionId: "sess-fake-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "cancelled after delay" } } });
        respond(id, { stopReason: "cancelled" });
      }, delay);
    }
    return;
  }
  if (MODE === "noisy") {
    const count = envNumber("FAKE_ACP_CHUNKS", 200);
    for (let index = 0; index < count; index += 1) {
      notify("session/update", { sessionId: "sess-fake-1", update: {
        sessionUpdate: "agent_message_chunk", messageId: `message-${Math.floor(index / 10)}`,
        content: { type: "text", text: `chunk-${index};` },
      } });
    }
    notify("session/update", { sessionId: "sess-fake-1", update: { sessionUpdate: "usage_update", used: 42, size: 200000, cost: { amount: 0.01, currency: "USD" } } });
    respond(id, { stopReason: "end_turn" });
    return;
  }
  if (MODE === "late") {
    notify("session/update", { sessionId: "sess-fake-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "final" } } });
    respond(id, { stopReason: "end_turn" });
    setTimeout(() => {
      notify("session/update", { sessionId: "sess-fake-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " LATE-EVENT" } } });
    }, 20);
    return;
  }
  // happy / resume / load / auth-required
  notify("session/update", { sessionId: "sess-fake-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello " } } });
  notify("session/update", { sessionId: "sess-fake-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${MODE} answer` } } });
  notify("session/update", { sessionId: "sess-fake-1", update: { sessionUpdate: "usage_update", used: 100, size: 200000, cost: { amount: 0.05, currency: "USD" } } });
  respond(id, { stopReason: "end_turn" });
}

async function handle(message) {
  if (!message || typeof message !== "object") return;
  const { id, method, params, result, error } = message;
  if (typeof method !== "string") {
    // Response to a client request we sent.
    const pending = pendingClientRequests.get(id);
    if (!pending) return;
    pendingClientRequests.delete(id);
    if (error) pending.reject(new Error(error.message || "client error"));
    else pending.resolve(result ?? {});
    return;
  }
  if (method === "initialize") {
    respond(id, initializeResult());
    return;
  }
  if (method === "authenticate") {
    globalThis.__fakeAuthed = true;
    respond(id, {});
    return;
  }
  if (method === "session/new") {
    if (MODE === "auth-required" && !globalThis.__fakeAuthed) {
      respondError(id, -32000, "Authentication required");
      return;
    }
    respond(id, sessionResult("sess-fake-1"));
    return;
  }
  if (method === "session/resume" || method === "session/load") {
    respond(id, sessionResult(params?.sessionId || "sess-resumed-1"));
    return;
  }
  if (method === "session/set_config_option") {
    const configId = params?.configId;
    const value = params?.value;
    const configOptions = BASE_CONFIG.map((option) => ({
      ...option,
      options: [...option.options],
      ...(option.id === configId ? { currentValue: value } : {}),
    }));
    respond(id, { configOptions });
    return;
  }
  if (method === "session/set_mode") {
    respond(id, {});
    return;
  }
  if (method === "session/prompt") {
    void streamPrompt(id);
    return;
  }
  if (method === "session/cancel") {
    if (promptRequestId !== null && MODE !== "cancel-ignored") {
      const idToRespond = promptRequestId;
      promptRequestId = null;
      notify("session/update", { sessionId: "sess-fake-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "cancelled" } } });
      respond(idToRespond, { stopReason: "cancelled" });
    }
    return;
  }
  if (typeof id === "number") respondError(id, -32601, `method not found: ${method}`);
}

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    void handle(message);
  }
});
process.stdin.on("end", () => {
  // stdin closed: agent exits so a killed/closed transport cannot linger.
  process.exit(0);
});
process.on("SIGTERM", () => process.exit(0));
