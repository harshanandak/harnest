// Brutal tests: concurrency, storms, boundaries, and cross-cutting
// independence that unit tests don't cover. Zero model spend throughout.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Companion } from "../src/companion.mjs";
import { JobStore } from "../src/job-store.mjs";
import { BoardStore } from "../src/board.mjs";

async function tempCompanion(t, adapterFactory) {
  const root = await mkdtemp(join(tmpdir(), "harnest-brutal-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return new Companion({ store: new JobStore(root), adapterFactory, routeResolver: async (request) => request });
}

function gateAdapter() {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  return {
    release: () => release(),
    factory: () => ({
      async run() {
        await gate;
        return { result: { finalText: "done" }, sessionId: "s", workflowRunId: null };
      },
      async control(command) {
        return { harness: "fake", command: command.kind, delivery: command.delivery };
      },
    }),
  };
}

async function runningJob(companion, requestId) {
  const queued = await companion.start({
    requestId, target: "pi", task: "hold", cwd: process.cwd(),
    execution: { background: true, timeoutMs: 10_000 },
  });
  for (let i = 0; i < 100; i += 1) {
    if ((await companion.status(queued.jobId)).state === "running") return queued;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("job never reached running");
}

test("mid-job trace shows downstream deltas before terminal state", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const companion = await tempCompanion(t, () => ({
    async run(_request, { onProgress } = {}) {
      // Codex-style: stream deltas mid-run, finish only after release.
      await onProgress?.({ type: "codex_delta", text: "drafting the plan" });
      await onProgress?.({ type: "codex_delta", text: "editing files" });
      await gate;
      return { result: { finalText: "done" }, sessionId: "s-mid", workflowRunId: null };
    },
  }));
  const queued = await companion.start({
    requestId: "brutal-mid-job", target: "codex", task: "mid-job read",
    cwd: process.cwd(), execution: { background: true, timeoutMs: 10_000 },
  });
  let sawDeltas = false;
  const seen = new Set();
  let after = 0;
  for (let i = 0; i < 100; i += 1) {
    const page = await companion.traceReference({ jobId: queued.jobId }, { afterSequence: after, limit: 50 });
    after = page.nextSequence;
    // A real worker accumulates semantic state across pages: deltas may
    // arrive split over several flushes, so collect, don't single-page match.
    for (const text of ["drafting the plan", "editing files"]) {
      if (JSON.stringify(page.events).includes(text)) seen.add(text);
    }
    if (seen.size === 2) {
      sawDeltas = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(sawDeltas, "downstream deltas must be readable mid-job via afterSequence paging");
  assert.equal((await companion.status(queued.jobId)).state, "running");
  release();
  for (let i = 0; i < 50; i += 1) {
    if ((await companion.status(queued.jobId)).state === "completed") break;
    await new Promise((r) => setTimeout(r, 10));
  }
  const final = await companion.result(queued.jobId);
  assert.equal(final.result.finalText, "done");
  assert.equal(final.sessionId, "s-mid");
});

test("a batch of parallel handoffs followed by compare all settle", { timeout: 30_000 }, async (t) => {
  const companion = await tempCompanion(t, () => ({
    async run(request, { onProgress } = {}) {
      for (let i = 0; i < 3; i += 1) {
        await onProgress?.({ type: "progress", text: `${request.requestId} step ${i}` });
        await new Promise((r) => setTimeout(r, 5));
      }
      const text = request.requestId.includes(":review:")
        ? `notes\n\`\`\`json\n${JSON.stringify({ scores: { correctness: 8, simplicity: 7 }, findings: ["ok"] })}\n\`\`\`\n`
        : `done:${request.requestId}`;
      return { result: { finalText: text }, sessionId: `s-${request.requestId}`, workflowRunId: null };
    },
  }));
  // Dogfood shape that once hung a run: parallel background batch, then an
  // 8-lane compare and 4-lane review on the same instance. All must settle.
  const jobs = await Promise.all(Array.from({ length: 12 }, (_, i) => companion.start({
    requestId: `batch-${i}`, target: "pi", task: `parallel task ${i}`,
    cwd: process.cwd(), execution: { background: true, timeoutMs: 15_000 },
  })));
  assert.equal(jobs.length, 12);
  const deadline = Date.now() + 15_000;
  const pending = new Set(jobs.map((j) => j.jobId));
  while (pending.size && Date.now() < deadline) {
    for (const jobId of [...pending]) {
      const st = await companion.status(jobId);
      if (["completed", "failed", "cancelled", "partial"].includes(st.state)) pending.delete(jobId);
    }
    if (pending.size) await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(pending.size, 0, "parallel batch must reach terminal states");
  const comparison = await companion.compare({
    request: {
      requestId: "batch-compare", target: "pi", task: "Compare.",
      cwd: process.cwd(), context: {}, policy: { write: false },
    },
    candidates: Array.from({ length: 8 }, (_, i) => ({ name: `lane${i}`, route: { provider: `p${i}`, model: `m${i}` } })),
  });
  assert.equal(comparison.state, "completed");
  assert.equal(comparison.lanes.length, 8);
  const review = await companion.review({
    request: {
      requestId: "batch-review", target: "pi", task: "Review.",
      cwd: process.cwd(), context: {}, policy: { write: false },
    },
    reviewers: Array.from({ length: 4 }, (_, i) => ({ name: `rev${i}`, target: "pi", route: { provider: `rp${i}`, model: `rm${i}` } })),
    rubric: ["correctness", "simplicity"],
    threshold: 1,
    rounds: 1,
  });
  assert.ok(["completed", "partial"].includes(review.state));
});

test("concurrent board posts get unique monotonic sequences", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harnest-board-brutal-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const boards = new BoardStore(join(root, "boards"));
  const posted = await Promise.all(Array.from({ length: 8 }, (_, i) =>
    boards.post({ topic: "race", from: `worker-${i}`, message: `hello ${i}` })));
  const sequences = posted.map((p) => p.sequence).sort((a, b) => a - b);
  assert.deepEqual(sequences, [1, 2, 3, 4, 5, 6, 7, 8]);
  const page = await boards.read({ topic: "race", limit: 50 });
  assert.equal(page.entries.length, 8);
  assert.equal(page.hasMore, false);
});

test("board paging walks without gaps or duplicates", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harnest-board-page-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const boards = new BoardStore(join(root, "boards"));
  for (let i = 0; i < 5; i += 1) await boards.post({ topic: "walk", from: "w", message: `m${i}` });
  const seen = [];
  let after = 0;
  for (;;) {
    const page = await boards.read({ topic: "walk", afterSequence: after, limit: 2 });
    seen.push(...page.entries.map((e) => e.sequence));
    if (!page.hasMore) {
      after = page.nextSequence;
      break;
    }
    after = page.nextSequence;
  }
  assert.deepEqual(seen, [1, 2, 3, 4, 5]);
  assert.equal(after, 5);
});

test("board rejects oversized and malformed posts without partial writes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harnest-board-reject-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const boards = new BoardStore(join(root, "boards"));
  await assert.rejects(boards.post({ topic: "t", from: "w", message: "x".repeat(60000) }), /exceeds/);
  await assert.rejects(boards.post({ topic: "bad topic!", from: "w", message: "x" }), /topic must be/);
  await assert.rejects(boards.post({ topic: "t", from: "   ", message: "x" }), /from must be/);
  await assert.rejects(boards.read({ topic: "t", afterSequence: -1 }), /afterSequence/);
  await assert.rejects(boards.read({ topic: "t", limit: 201 }), /limit must be/);
  const page = await boards.read({ topic: "t" });
  assert.deepEqual(page.entries, []);
  assert.equal(page.nextSequence, 0);
});

test("board skips corrupt lines and unknown topics read empty", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harnest-board-corrupt-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const boards = new BoardStore(join(root, "boards"));
  await boards.post({ topic: "c", from: "w", message: "first" });
  await writeFile(join(root, "boards", "c.board.jsonl"), "NOT JSON AT ALL\n", { flag: "a" });
  await boards.post({ topic: "c", from: "w", message: "second" });
  const page = await boards.read({ topic: "c" });
  assert.deepEqual(page.entries.map((e) => e.message), ["first", "second"]);
  assert.deepEqual(page.entries.map((e) => e.sequence), [1, 2]);
  const missing = await boards.read({ topic: "never-existed" });
  assert.deepEqual(missing.entries, []);
});

test("two companions share one board directory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harnest-board-shared-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const dir = join(root, "boards");
  const a = new BoardStore(dir);
  const b = new BoardStore(dir);
  await a.post({ topic: "shared", from: "worker-a", message: "ping" });
  const page = await b.read({ topic: "shared" });
  assert.equal(page.entries.length, 1);
  assert.equal(page.entries[0].from, "worker-a");
});

test("same commandId on different jobs is independent", async (t) => {
  const g = gateAdapter();
  const companion = await tempCompanion(t, g.factory);
  const jobA = await runningJob(companion, "brutal-cmd-a");
  const jobB = await runningJob(companion, "brutal-cmd-b");
  const [a, b] = await Promise.all([
    companion.message(jobA.jobId, { commandId: "same-id", message: "for A", delivery: "steer" }),
    companion.message(jobB.jobId, { commandId: "same-id", message: "for B", delivery: "steer" }),
  ]);
  assert.equal(a.state, "applied");
  assert.equal(b.state, "applied");
  assert.equal((await companion.status(jobA.jobId)).controls[0].commandId, "same-id");
  assert.equal((await companion.status(jobB.jobId)).controls[0].commandId, "same-id");
  g.release();
  for (let i = 0; i < 50; i += 1) {
    const [aState, bState] = [(await companion.status(jobA.jobId)).state, (await companion.status(jobB.jobId)).state];
    if (aState === "completed" && bState === "completed") break;
    await new Promise((r) => setTimeout(r, 10));
  }
});

test("command storm applies in order without loss", { timeout: 30_000 }, async (t) => {
  const g = gateAdapter();
  const companion = await tempCompanion(t, g.factory);
  const job = await runningJob(companion, "brutal-storm");
  const results = [];
  for (let i = 0; i < 20; i += 1) {
    results.push(await companion.message(job.jobId, { commandId: `storm-${i}`, message: `msg ${i}`, delivery: i % 2 ? "follow_up" : "steer" }));
  }
  assert.ok(results.every((r) => r.state === "applied"));
  assert.deepEqual(results.map((r) => r.commandId), Array.from({ length: 20 }, (_, i) => `storm-${i}`));
  const status = await companion.status(job.jobId);
  assert.equal(status.controls.length, 20);
  g.release();
  for (let i = 0; i < 50; i += 1) {
    if ((await companion.status(job.jobId)).state === "completed") break;
    await new Promise((r) => setTimeout(r, 10));
  }
});

test("message to a settled job fails typed, never resurrects it", { timeout: 30_000 }, async (t) => {
  const g = gateAdapter();
  const companion = await tempCompanion(t, g.factory);
  const job = await runningJob(companion, "brutal-settled");
  g.release();
  for (let i = 0; i < 50; i += 1) {
    if ((await companion.status(job.jobId)).state === "completed") break;
    await new Promise((r) => setTimeout(r, 10));
  }
  await assert.rejects(
    companion.message(job.jobId, { commandId: "late-1", message: "too late", delivery: "steer" }),
    /is not active/,
  );
  assert.equal((await companion.status(job.jobId)).state, "completed");
});

test("review with eight lanes completes and stays attributable", { timeout: 30_000 }, async (t) => {
  const companion = await tempCompanion(t, () => ({
    async run(request) {
      const n = Number((request.requestId.match(/lane(\d)/) || [])[1] || 0);
      const text = `notes\n\`\`\`json\n${JSON.stringify({ scores: { correctness: 8 + (n % 2), simplicity: 8 }, findings: [`from-${request.requestId}`.slice(-12)] })}\n\`\`\`\n`;
      return { result: { finalText: text }, route: request.route };
    },
  }));
  const reviewers = Array.from({ length: 8 }, (_, i) => ({
    name: `lane${i}`, target: "pi", route: { provider: `p${i}`, model: `m${i}` },
  }));
  const out = await companion.review({
    request: { requestId: "brutal-review-8", target: "pi", task: "Review.", cwd: process.cwd(), context: {}, policy: { write: false } },
    reviewers,
    rubric: ["correctness", "simplicity"],
    threshold: 5,
    rounds: 1,
  });
  assert.equal(out.state, "completed");
  assert.equal(out.final.voting.length, 8);
  assert.equal(out.final.findings.length, 8);
});

test("review rejects an unroutable lane before spending anything", async (t) => {
  let launches = 0;
  const companion = await tempCompanion(t, () => ({
    async run(request) {
      launches += 1;
      return { result: { finalText: "x" }, route: request.route };
    },
  }));
  await assert.rejects(companion.review({
    request: { requestId: "brutal-review-bad", target: "nope", task: "Review.", cwd: process.cwd(), context: {}, policy: { write: false } },
    reviewers: [
      { name: "a", target: "nope", route: { model: "m1" } },
      { name: "b", target: "nope", route: { model: "m2" } },
    ],
  }), /target must be/);
  assert.equal(launches, 0);
});
