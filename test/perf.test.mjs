// Speed + smoothness gate: local-operation latency budgets that catch
// regressions (accidental sleeps, O(n^2) scans, lock contention), not
// hardware benchmarks. Budgets are deliberately generous for Windows CI;
// a failure means something got pathologically slower, not 10% slower.
// Zero model spend throughout: all adapters are in-process fakes.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { Companion } from "../src/companion.mjs";
import { JobStore } from "../src/job-store.mjs";

// Generous budgets (ms). Calibrated: local ops measure 1-30ms on dev
// hardware; CI spikes stay an order of magnitude under these.
const BUDGET = {
  statusP99: 500,
  tracePage: 750,
  flushP95: 1500,
  boardRoundTripP95: 750,
  pollBatchTotal: 15_000,
};

async function tempCompanion(t, adapterFactory) {
  const root = await mkdtemp(join(tmpdir(), "harnest-perf-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return new Companion({ store: new JobStore(root), adapterFactory, routeResolver: async (request) => request });
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function report(name, samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  console.log(`  perf ${name}: n=${sorted.length} p50=${percentile(sorted, 50).toFixed(1)}ms p95=${percentile(sorted, 95).toFixed(1)}ms p99=${percentile(sorted, 99).toFixed(1)}ms max=${sorted.at(-1).toFixed(1)}ms`);
}

test("status polls stay fast under a loaded session list", async (t) => {
  const companion = await tempCompanion(t, () => ({
    async run() {
      return { result: { finalText: "done" }, sessionId: "s", workflowRunId: null };
    },
  }));
  // Seed sessions so list/status paths touch real state volume.
  for (let i = 0; i < 10; i += 1) {
    await companion.start({
      requestId: `perf-seed-${i}`, target: "pi", task: "seed",
      cwd: process.cwd(), execution: { background: false, timeoutMs: 10_000 },
    });
  }
  const target = await companion.start({
    requestId: "perf-status", target: "pi", task: "poll me",
    cwd: process.cwd(), execution: { background: false, timeoutMs: 10_000 },
  });
  await companion.status(target.jobId); // warm-up (cold FS cache)
  const samples = [];
  for (let i = 0; i < 30; i += 1) {
    const start = performance.now();
    const status = await companion.status(target.jobId);
    samples.push(performance.now() - start);
    assert.equal(status.jobId, target.jobId);
  }
  report("handoff_status", samples);
  assert.ok(percentile([...samples].sort((a, b) => a - b), 99) < BUDGET.statusP99,
    `status p99 exceeded ${BUDGET.statusP99}ms`);
});

test("trace pages stay bounded and smooth over a deep event log", async (t) => {
  const EVENTS = 300;
  const companion = await tempCompanion(t, () => ({
    async run(_request, { onProgress } = {}) {
      // Fire-and-forget like the real adapters (codex/cursor/claude never
      // await onProgress); the terminal path flushes before completing.
      for (let i = 0; i < EVENTS; i += 1) {
        onProgress?.({ type: "codex_delta", text: `delta-${i}` });
      }
      await new Promise((r) => setTimeout(r, 300));
      return { result: { finalText: "done" }, sessionId: "s", workflowRunId: null };
    },
  }));
  const receipt = await companion.start({
    requestId: "perf-deep", target: "codex", task: "many deltas",
    cwd: process.cwd(), execution: { background: false, timeoutMs: 30_000 },
  });
  // Walk the full log the way a worker does: sequential afterSequence pages.
  const seen = [];
  const samples = [];
  let after = 0;
  let pages = 0;
  for (;;) {
    const start = performance.now();
    const page = await companion.traceReference({ jobId: receipt.jobId }, { afterSequence: after, limit: 50 });
    samples.push(performance.now() - start);
    pages += 1;
    for (const event of page.events) seen.push(event.sequence);
    if (!page.hasMore) {
      after = page.nextSequence;
      break;
    }
    after = page.nextSequence;
    assert.ok(pages < 50, "paging must terminate");
  }
  report("handoff_trace page (deep log)", samples);
  // Smoothness: strictly increasing, gap-free, duplicate-free.
  const sorted = [...seen].sort((a, b) => a - b);
  assert.deepEqual(seen, sorted, "pages must arrive in sequence order");
  assert.equal(new Set(seen).size, seen.length, "no duplicate events across pages");
  for (let i = 1; i < sorted.length; i += 1) {
    assert.equal(sorted[i], sorted[i - 1] + 1, `gap in trace sequence at ${sorted[i - 1]}`);
  }
  assert.ok(seen.length >= EVENTS, `expected at least ${EVENTS} events, saw ${seen.length}`);
  const p99 = percentile([...samples].sort((a, b) => a - b), 99);
  assert.ok(p99 < BUDGET.tracePage, `trace page p99 ${p99.toFixed(1)}ms exceeded ${BUDGET.tracePage}ms`);
  console.log(`  perf deep-log: ${seen.length} events in ${pages} pages, gap-free`);
});

test("downstream deltas flush to the trace promptly (smooth streaming)", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const companion = await tempCompanion(t, () => ({
    async run(_request, { onProgress } = {}) {
      // Emit on a steady cadence like a streaming harness, then hold.
      for (let i = 0; i < 5; i += 1) {
        await onProgress?.({ type: "codex_delta", text: `smooth-${i}` });
        await new Promise((r) => setTimeout(r, 20));
      }
      await gate;
      return { result: { finalText: "done" }, sessionId: "s", workflowRunId: null };
    },
  }));
  const queued = await companion.start({
    requestId: "perf-flush", target: "codex", task: "smooth",
    cwd: process.cwd(), execution: { background: true, timeoutMs: 10_000 },
  });
  // Per-delta arrival latency: time from poll loop start until each delta is
  // first observed. The flush timer is 25ms; budget allows 60x headroom.
  const firstSeen = new Map();
  const start = performance.now();
  let after = 0;
  while (firstSeen.size < 5 && performance.now() - start < BUDGET.flushP95) {
    const page = await companion.traceReference({ jobId: queued.jobId }, { afterSequence: after, limit: 50 });
    after = page.nextSequence;
    const serialized = JSON.stringify(page.events);
    for (let i = 0; i < 5; i += 1) {
      if (!firstSeen.has(i) && serialized.includes(`smooth-${i}`)) {
        firstSeen.set(i, performance.now() - start);
      }
    }
    if (firstSeen.size < 5) await new Promise((r) => setTimeout(r, 10));
  }
  release();
  const latencies = [...firstSeen.entries()].sort((a, b) => a[0] - b[0]).map(([, ms]) => ms);
  console.log(`  perf flush arrivals: ${latencies.map((ms) => `${ms.toFixed(0)}ms`).join(", ")}`);
  assert.equal(firstSeen.size, 5, "all 5 deltas must surface before the flush budget");
  // Smoothness: no single delta stalls far behind its emission slot
  // (emitted at ~0/20/40/60/80ms; each must arrive within budget).
  assert.ok(Math.max(...latencies) < BUDGET.flushP95, "max arrival latency exceeded budget");
  for (let i = 0; i < 50; i += 1) {
    if ((await companion.status(queued.jobId)).state === "completed") break;
    await new Promise((r) => setTimeout(r, 10));
  }
});

test("board post-to-read round trips stay fast", async (t) => {
  const companion = await tempCompanion(t, () => ({
    async run() {
      return { result: { finalText: "done" }, sessionId: "s", workflowRunId: null };
    },
  }));
  const samples = [];
  for (let i = 0; i < 20; i += 1) {
    const start = performance.now();
    await companion.postToBoard({ topic: "perf", from: "worker-a", message: `ping-${i}` });
    const page = await companion.readBoard({ topic: "perf", limit: 5 });
    samples.push(performance.now() - start);
    assert.ok(page.entries.some((e) => e.message === `ping-${i}`));
  }
  report("board post+read", samples);
  assert.ok(percentile([...samples].sort((a, b) => a - b), 95) < BUDGET.boardRoundTripP95,
    `board round-trip p95 exceeded ${BUDGET.boardRoundTripP95}ms`);
});

test("mixed poll batch (status + trace + sessions) completes in budget", async (t) => {
  const companion = await tempCompanion(t, () => ({
    async run() {
      return { result: { finalText: "done" }, sessionId: "s", workflowRunId: null };
    },
  }));
  const receipt = await companion.start({
    requestId: "perf-batch", target: "pi", task: "batch",
    cwd: process.cwd(), execution: { background: false, timeoutMs: 10_000 },
  });
  const start = performance.now();
  for (let i = 0; i < 20; i += 1) {
    await companion.status(receipt.jobId);
    await companion.traceReference({ jobId: receipt.jobId }, { limit: 10 });
    await companion.sessions({ limit: 10 });
  }
  const total = performance.now() - start;
  console.log(`  perf mixed batch: 60 ops in ${total.toFixed(0)}ms`);
  assert.ok(total < BUDGET.pollBatchTotal, `mixed batch ${total.toFixed(0)}ms exceeded ${BUDGET.pollBatchTotal}ms`);
});
