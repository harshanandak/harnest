import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Companion } from "../../src/companion.mjs";
import { JobStore } from "../../src/job-store.mjs";
import { GraphRunner } from "../../src/graph.mjs";
import { graphIdFor } from "../../src/graph-protocol.mjs";

if (process.argv[2]) {
  const root = process.argv[2], action = process.argv[3];
  const graph = JSON.parse(await readFile(join(root, "input.json"), "utf8"));
  const companion = new Companion({ store: new JobStore(join(root, "jobs")), heartbeatIntervalMs: 20, cancelAckTimeoutMs: 100,
    routeResolver: async (r) => r, adapterFactory: () => ({ async run(request, { signal }) {
      await appendFile(join(root, "launches.txt"), `${request.requestId}\n`);
      if (graph.context?.failOnce && request.requestId.endsWith(":1")) throw new Error("first attempt fails");
      if (graph.context?.hold) {
        // Causal gate for cross-process tests: block until the test releases
        // the run, abort-aware. A 60s safety cap keeps a broken cancel from
        // hanging the fixture past the test's own timeout.
        const release = join(root, String(graph.context.hold));
        const deadline = Date.now() + 60_000;
        while (!signal.aborted && Date.now() < deadline) {
          const present = await readFile(release, "utf8").then(() => true).catch(() => false);
          if (present) break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      } else {
        await new Promise((resolve) => { const timer = setTimeout(resolve, graph.context?.failOnce ? 150 : 5000); signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true }); });
      }
      if (signal.aborted) throw Object.assign(new Error("stopped"), { details: { aborted: true } });
      return { result: { finalText: "fixture complete" } };
    } }),
  });
  const runner = new GraphRunner({ companion, pollIntervalMs: 20, heartbeatIntervalMs: 40 });
  const result = action === "cancel" ? await runner.cancel(graphIdFor(graph.requestId))
    : action === "resume" ? await runner.resume({ graphId: graphIdFor(graph.requestId), commandId: "retry", background: false }) : await runner.start(graph);
  console.log(JSON.stringify(result));
}
