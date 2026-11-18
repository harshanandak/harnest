import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { JobStore } from "../src/job-store.mjs";

const root = await mkdtemp(join(tmpdir(), "harnest-store-benchmark-"));
const store = new JobStore(root);
async function measure(name, operation) {
  const samples = [];
  for (let i = 0; i < 20; i += 1) {
    const start = performance.now();
    await operation();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return { name, p50Ms: samples[9], p95Ms: samples[18], maxMs: samples[19] };
}
try {
  for (const eventCount of [300, 30_000]) {
    const jobId = `fixture-${eventCount}`;
    const job = { request: { requestId: jobId }, receipt: { jobId, state: "running" }, lease: { ownerId: "fixture" } };
    await store.put(job);
    for (let offset = 0; offset < eventCount; offset += 300) {
      await store.commitBatch(job, Array.from({ length: 300 }, (_, index) => ({
        at: new Date().toISOString(), event: { type: "delta", text: `${offset + index}: ${"x".repeat(200)}` },
      })), { expectedLeaseOwner: "fixture" });
    }
    const measurements = [];
    measurements.push(await measure("snapshot", () => store.get(jobId)));
    measurements.push(await measure("trace-tail", () => store.readTrace(jobId, { limit: 50 })));
    measurements.push(await measure("trace-caught-up", () => store.readTrace(jobId, { afterSequence: eventCount, limit: 50 })));
    measurements.push(await measure("trace-summary", () => store.traceSummary(jobId)));
    measurements.push(await measure("fenced-flush", () => store.commitBatch(job, [{
      at: new Date().toISOString(), event: { type: "delta", text: "flush" },
    }], { expectedLeaseOwner: "fixture" })));
    console.log(JSON.stringify({ eventCount, traceBytes: (await stat(store.tracePath(jobId))).size, measurements }));
  }
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
