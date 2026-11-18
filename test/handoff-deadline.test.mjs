import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { Companion } from "../src/companion.mjs";
import { JobStore } from "../src/job-store.mjs";

const resolver = async (request) => ({
  ...request,
  route: { model: "fixture-first" },
  metadata: { harnest: { routingDecision: {
    version: 2, mode: "auto", selected: "first",
    rankedRoutes: [
      { id: "first", target: "codex", route: { model: "fixture-first" }, score: 2 },
      { id: "second", target: "codex", route: { model: "fixture-second" }, score: 1 },
    ],
  } } },
});

async function fixture(t, run, Store = JobStore) {
  const root = await mkdtemp(join(tmpdir(), "harnest-overall-deadline-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return { root, companion: new Companion({ store: new Store(root), routeResolver: resolver, adapterFactory: () => ({ run }) }) };
}

function untilAborted(signal) {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error("fixture was never aborted")), 10_000);
    const abort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error("fixture aborted"), { details: { aborted: true } }));
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

function request(root, timeoutMs) {
  return { requestId: "overall-budget", target: "codex", task: "synthetic deadline fixture", cwd: root,
    policy: { write: false }, execution: { background: false, timeoutMs } };
}

test("an exhausted overall deadline never launches a fallback", async (t) => {
  const seen = [];
  const { root, companion } = await fixture(t, async (input, { signal }) => {
    seen.push(input.route.model);
    return untilAborted(signal);
  });
  const receipt = await companion.start(request(root, 100));
  assert.equal(receipt.state, "failed");
  assert.equal(receipt.error.details.kind, "timeout");
  assert.deepEqual(seen, ["fixture-first"]);
  assert.equal(receipt.routingFallbacks?.length ?? 0, 0);
});

test("an early failure gives the fallback only the remaining deadline", async (t) => {
  const budgets = [];
  const { root, companion } = await fixture(t, async (input, { signal }) => {
    budgets.push(input.execution.timeoutMs);
    if (budgets.length === 1) {
      await delay(80);
      throw Object.assign(new Error("fixture transport failure"), { details: { kind: "transport" } });
    }
    return untilAborted(signal);
  });
  const receipt = await companion.start(request(root, 1000));
  assert.equal(receipt.state, "failed");
  assert.equal(receipt.error.details.kind, "timeout");
  assert.equal(budgets.length, 2);
  assert.ok(budgets[1] < budgets[0] - 50, `fallback budgets: ${budgets}`);
});

test("fallback persistence cannot grant another attempt after deadline expiry", async (t) => {
  class SlowFallbackStore extends JobStore {
    async put(job, options) {
      if (job.receipt.routingFallbacks?.length) await delay(250);
      return super.put(job, options);
    }
  }
  const seen = [];
  const { root, companion } = await fixture(t, async (input) => {
    seen.push(input.route.model);
    throw Object.assign(new Error("fixture transport failure"), { details: { kind: "transport" } });
  }, SlowFallbackStore);
  const receipt = await companion.start(request(root, 200));
  assert.equal(receipt.state, "failed");
  assert.equal(receipt.error.details.kind, "timeout");
  assert.deepEqual(seen, ["fixture-first"]);
});
