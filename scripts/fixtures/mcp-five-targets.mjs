import { join } from "node:path";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
const { createServer } = await import("../../src/mcp-server.mjs");

const root = process.argv[2];
if (!root) throw new Error("isolated fixture root required");
await serveStdio(() => createServer({
  stateDir: join(root, "jobs"),
  boardDir: join(root, "boards"),
  routing: { config: {}, env: {}, userPolicy: {
    harnessOrder: ["pi", "claude", "codex", "opencode", "cursor"],
    tier: "balanced", allowTrainingEndpoints: false,
    models: { codex: "synthetic-codex" }, subscriptions: { codex: { subsidy: 1 } },
  } },
  adapterFactory: (target) => ({
    async run(request, { onProgress }) {
      await onProgress({ type: "text", text: `${target} fixture progress` });
      return { sessionId: `fixture-${target}`, route: request.route, result: { finalText: `${target} fixture result\nDONE` } };
    },
  }),
}), { legacy: "serve" });
