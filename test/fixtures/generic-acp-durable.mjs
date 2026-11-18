import { createInterface } from "node:readline";

let sessionId = "durable-acp-session";
const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
const update = (value) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: value } })}\n`);
// Node's test discovery also loads fixtures; only an explicit child launch reads stdin.
const input = process.argv.includes("--acp-fixture") ? createInterface({ input: process.stdin }) : [];
for await (const line of input) {
  const message = JSON.parse(line);
  switch (message.method) {
    case "initialize":
      reply(message.id, { protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: "durable-fixture", version: "1" }, authMethods: [] });
      break;
    case "session/new":
      reply(message.id, { sessionId });
      break;
    case "session/load":
      sessionId = message.params.sessionId;
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OLD_REPLAY_ONLY" } });
      reply(message.id, {});
      break;
    case "session/prompt":
      {
        const prompt = JSON.stringify(message.params.prompt);
        let text = "ACP_DURABLE_CANARY\nVerified disposable ACP handoff.";
        if (prompt.includes("graph-root-task")) text = "ROOT_NODE_OUTPUT";
        if (prompt.includes("consume-upstream-task")) text = prompt.includes("ROOT_NODE_OUTPUT") ? "JOIN_USED_UPSTREAM" : "MISSING_UPSTREAM";
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
      }
      reply(message.id, { stopReason: "end_turn" });
      break;
    case "session/cancel":
      break;
    default:
      if (message.id !== undefined) reply(message.id, {});
  }
}
