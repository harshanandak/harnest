import { createInterface } from "node:readline";
import { createDaemonClient, ensureDaemon } from "./daemon-client.mjs";

try {
  await ensureDaemon();
} catch {
  process.stderr.write("Harnest bridge could not connect to the local daemon.\n");
  process.exit(1);
}
const client = createDaemonClient();
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let protocolVersion;
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
async function forward(message, version) {
  try {
    return await client.rpc(message, version);
  } catch (error) {
    await ensureDaemon();
    // Only connection refusal proves the daemon could not have accepted a tool call.
    if (error.code === "ECONNREFUSED" || ["initialize", "tools/list", "ping"].includes(message.method)) {
      return await client.rpc(message, version);
    }
    throw error;
  }
}
lines.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } });
    return;
  }
  if (message?.jsonrpc !== "2.0" || typeof message.method !== "string") return;
  forward(message, protocolVersion).then((response) => {
    if (!response) return;
    if (message.method === "initialize") protocolVersion = response.result?.protocolVersion;
    send(response);
  }).catch(() => {
    if (message.id !== undefined) send({
      jsonrpc: "2.0", id: message.id,
      error: { code: -32603, message: "Harnest daemon exchange failed" },
    });
  });
});
