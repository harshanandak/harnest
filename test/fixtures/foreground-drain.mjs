// Fixture: proves a foreground handoff settles in a bare process whose event
// loop has NO live handles except the handoff itself. Run as a child process;
// exits 0 printing SETTLED <state> on success. (Regression test for the
// terminal-event flush depending solely on the unref'd 25ms batch timer,
// which let bare scripts drain out before the terminal receipt persisted.)
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Companion } from "../../src/companion.mjs";
import { JobStore } from "../../src/job-store.mjs";

const root = await mkdtemp(join(tmpdir(), "harnest-drain-"));
const companion = new Companion({
  store: new JobStore(root),
  adapterFactory: () => ({
    async run(request, { onProgress } = {}) {
      // Awaited late progress: the completion resolves only via the batch
      // flush, so this proves a bare process cannot drain out from under a
      // pending durable write (the loop must be held until it commits).
      await onProgress?.({ type: "progress", text: "late delta" });
      return { result: { finalText: "done" }, route: request.route };
    },
  }),
  routeResolver: async (request) => request,
});
const receipt = await companion.start(
  {
    requestId: "drain-test",
    target: "pi",
    task: "simple task",
    cwd: process.cwd(),
    context: {},
    policy: { write: false },
    execution: { background: false },
  },
  { routeResolved: true },
);
console.log(`SETTLED ${receipt.state}`);
await rm(root, { recursive: true, force: true });
process.exit(receipt.state === "completed" ? 0 : 1);
