// Minimal `codex app-server` JSON-RPC peer for adapter framing tests.
// Newline-delimited JSON on stdio only; it never calls a model.
const THREAD_ID = process.env.CODEX_SESSION_FIXTURE_THREAD || "fixture-thread";
const TURN_ID = "fixture-turn-1";

function send(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function threadPayload(params = {}) {
  return {
    thread: { id: THREAD_ID, sessionId: `${THREAD_ID}-native` },
    model: typeof params.model === "string" && params.model ? params.model : "fixture-model",
    modelProvider: "openai",
    cwd: typeof params.cwd === "string" ? params.cwd : process.cwd(),
    sandbox: params.sandbox ?? { type: "readOnly" },
    approvalPolicy: params.approvalPolicy ?? "never",
  };
}

function handle(frame) {
  if (frame && typeof frame.method === "string" && frame.id !== undefined && frame.id !== null) {
    switch (frame.method) {
      case "initialize":
        return send({ id: frame.id, result: { capabilities: {} } });
      case "thread/start":
      case "thread/resume":
        return send({ id: frame.id, result: threadPayload(frame.params) });
      case "turn/start":
        send({ id: frame.id, result: { turn: { id: TURN_ID, status: "inProgress", items: [] } } });
        send({ method: "turn/started", params: { threadId: THREAD_ID, turn: { id: TURN_ID, status: "inProgress", items: [] } } });
        send({ method: "item/agentMessage/delta", params: { threadId: THREAD_ID, turnId: TURN_ID, itemId: "fixture-item", delta: "fixture " } });
        send({ method: "item/agentMessage/delta", params: { threadId: THREAD_ID, turnId: TURN_ID, itemId: "fixture-item", delta: "final answer" } });
        send({
          method: "item/completed",
          params: {
            threadId: THREAD_ID,
            turnId: TURN_ID,
            completedAtMs: Date.now(),
            item: { id: "fixture-item", type: "agentMessage", text: "fixture final answer" },
          },
        });
        send({
          method: "thread/tokenUsage/updated",
          params: {
            threadId: THREAD_ID,
            turnId: TURN_ID,
            tokenUsage: {
              last: { inputTokens: 10, cachedInputTokens: 4, outputTokens: 3, reasoningOutputTokens: 1, totalTokens: 14 },
              total: { inputTokens: 10, cachedInputTokens: 4, outputTokens: 3, reasoningOutputTokens: 1, totalTokens: 14 },
              modelContextWindow: 100000,
            },
          },
        });
        return send({
          method: "turn/completed",
          params: { threadId: THREAD_ID, turn: { id: TURN_ID, status: "completed", items: [{ id: "fixture-item", type: "agentMessage", text: "fixture final answer" }] } },
        });
      case "turn/steer":
        return send({ id: frame.id, result: { turnId: TURN_ID } });
      case "turn/interrupt":
        return send({ id: frame.id, result: {} });
      default:
        return send({ id: frame.id, error: { code: -32601, message: `unknown ${frame.method}` } });
    }
  }
  return undefined;
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch {
      // Malformed fixture input is ignored; the fixture is a transport stub.
    }
  }
});
process.stdin.on("end", () => {});
