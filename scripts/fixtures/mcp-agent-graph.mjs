import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
const { createServer } = await import("../../src/mcp-server.mjs");

const root = process.argv[2];
if (!root) throw new Error("isolated fixture root required");
await mkdir(root, { recursive: true });
await serveStdio(() => createServer({
  stateDir: join(root, "jobs"),
  graphDir: join(root, "graphs"),
  boardDir: join(root, "boards"),
  routeResolver: async (request) => request,
  adapterFactory: (target) => ({
    async run(request, { signal, onProgress }) {
      const nodeId = request.context.graph.nodeId;
      const upstream = Object.keys(request.context.graph.upstream || {}).sort();
      await appendFile(join(root, "launches.jsonl"), JSON.stringify({ nodeId, target, upstream, requestId: request.requestId }) + "\n");
      await onProgress({ type: "text", text: `${nodeId} started`, sessionId: `fixture-${nodeId}` });
      if (nodeId === "claude-review") {
        const first = await writeFile(join(root, "failed-once"), "1", { flag: "wx" }).then(() => true, (error) => { if (error.code === "EEXIST") return false; throw error; });
        if (first) throw new Error("synthetic first-attempt failure");
      }
      if (request.task === "hold") {
        await new Promise((_resolve, reject) => {
          const stop = () => reject(Object.assign(new Error("fixture stopped"), { details: { aborted: true } }));
          if (signal.aborted) stop(); else signal.addEventListener("abort", stop, { once: true });
        });
      }
      return { sessionId: `fixture-${nodeId}`, route: request.route, result: { finalText: `${nodeId} DONE; upstream=${upstream.join(",")}` }, usage: { input: 10, output: 5 } };
    },
  }),
}), { legacy: "serve" });
