import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Companion } from "../src/companion.mjs";
import { JobStore } from "../src/job-store.mjs";

const [target, provider, model, mode] = process.argv.slice(2);
if (!target || !provider || !model) {
  throw new Error("usage: node scripts/live-control-smoke.mjs <opencode|pi> <provider> <model> [no-control]");
}

const root = await mkdtemp(join(tmpdir(), "harnest-live-control-"));
const companion = new Companion({ store: new JobStore(root) });
const requestId = `live-control-${randomUUID()}`;

try {
  const started = await companion.start({
    requestId,
    target,
    task: "First run a shell command that waits for 15 seconds without changing files. Then reply exactly ORIGINAL_RESULT.",
    cwd: process.cwd(),
    context: { expectedControlMarker: "STEER_APPLIED" },
    route: { provider, model },
    execution: { background: true, timeoutMs: 180_000 },
    policy: { write: false },
  });
  const acknowledgement = mode === "no-control" ? null : await companion.message(started.jobId, {
      commandId: `message-${randomUUID()}`,
      message: "Change the final response: reply exactly STEER_APPLIED.",
      delivery: "steer",
    });
  const deadline = Date.now() + 180_000;
  let receipt = await companion.status(started.jobId);
  while (["queued", "running"].includes(receipt.state) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    receipt = await companion.status(started.jobId);
  }
  const finalText = receipt.result?.finalText || "";
  const expected = mode === "no-control" ? "ORIGINAL_RESULT" : "STEER_APPLIED";
  if ((acknowledgement && acknowledgement.state !== "applied") || receipt.state !== "completed" || !finalText.includes(expected)) {
    throw new Error(JSON.stringify({ acknowledgement, receipt }, null, 2));
  }
  console.log(`${mode === "no-control" ? "LIVE_HANDOFF_OK" : "LIVE_CONTROL_OK"} target=${target} state=${receipt.state}`);
} finally {
  await rm(root, { recursive: true, force: true });
}
