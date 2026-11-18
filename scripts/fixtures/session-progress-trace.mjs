import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobStore } from "../../src/job-store.mjs";

export async function sessionProgressTrace(t) {
  const root = await mkdtemp(join(tmpdir(), "harnest-session-progress-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new JobStore(root);
  const jobId = "session-progress";
  const emitted = [];
  return {
    onProgress(data) {
      emitted.push(data);
      return store.appendEvent(jobId, { event: { type: "progress", data } });
    },
    async assertRedacted(type, value) {
      const persisted = await readFile(store.tracePath(jobId), "utf8");
      assert.deepEqual(
        { emitted: JSON.stringify(emitted).includes(value), persisted: persisted.includes(value) },
        { emitted: false, persisted: false },
        "the split credential value stays out of emitted progress and the trace",
      );
      assert.deepEqual(emitted.filter((event) => event.type === type).map((event) => event.text), ["password=[REDACTED]"]);
    },
  };
}
