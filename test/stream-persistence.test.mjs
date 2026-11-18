import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { ClaudeAdapter } from "../src/adapters/claude.mjs";
import { Companion } from "../src/companion.mjs";
import { JobStore } from "../src/job-store.mjs";

test("a fast real producer respects slow durable progress without losing transcript events", { timeout: 15000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harnest-stream-persistence-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  class SlowStore extends JobStore {
    async commitBatch(job, records, options) {
      if (records.some((record) => record.event.type === "progress")) await delay(30);
      return super.commitBatch(job, records, options);
    }
  }
  const script = `
    const { once } = require('node:events');
    (async () => {
      for (let i = 0; i < 400; i++) {
        const event = { type: 'assistant', message: { content: [{ type: 'text', text: String(i) + ':' + 'x'.repeat(1000) }] } };
        if (!process.stdout.write(JSON.stringify(event) + '\\n')) await once(process.stdout, 'drain');
      }
      process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'DONE', session_id: 'bounded-stream' }) + '\\n');
    })();
  `;
  let pending = 0;
  let peakPending = 0;
  const store = new SlowStore(root);
  const companion = new Companion({ store, routeResolver: async (request) => request,
    adapterFactory: () => ({ run(request, context) {
      const adapter = new ClaudeAdapter({ launch: { command: process.execPath, args: ["-e", script, "--"] } });
      return adapter.run(request, { ...context, onProgress(event) {
        peakPending = Math.max(peakPending, ++pending);
        return Promise.resolve(context.onProgress(event)).finally(() => { pending--; });
      } });
    } }),
  });
  const receipt = await companion.start({ requestId: "bounded-progress", target: "claude", cwd: root,
    task: "synthetic producer", policy: { write: false }, execution: { timeoutMs: 10000 } });
  assert.equal(receipt.state, "completed", receipt.error?.message);
  assert.equal(receipt.result.finalText, "DONE");
  assert.equal(pending, 0);
  assert.ok(peakPending <= 128, `producer retained ${peakPending} uncommitted callbacks`);
  const reader = new JobStore(root);
  const deltas = [];
  let cursor = 0;
  for (;;) {
    const page = await reader.readTrace(receipt.jobId, { afterSequence: cursor, limit: 100 });
    for (const record of page.events) if (record.event?.data?.type === "claude_delta") deltas.push(Number(record.event.data.text.split(":")[0]));
    cursor = page.nextSequence;
    if (!page.hasMore) break;
  }
  assert.deepEqual(deltas, Array.from({ length: 400 }, (_, index) => index));
  t.diagnostic(`peak uncommitted callbacks=${peakPending}; persisted ordered deltas=${deltas.length}`);
});
