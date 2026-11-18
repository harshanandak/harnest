import test from "node:test";
import assert from "node:assert/strict";
import { inspectDynamicInvocation } from "../src/dynamic-inspect.mjs";

test("invalidated invocation attempts remain individually discoverable in bounded pages", async () => {
  const attempts = Array.from({ length: 55 }, (_, index) => ({ attempt: index + 1, jobId: `job-${index}`, state: "failed" }));
  const lookedUp = [];
  const runner = {
    store: { readRun: async () => ({ calls: [{ id: "inv-0", label: "Review", state: "completed", invalidated: true, attempts }] }) },
    companion: { status: async (jobId) => { lookedUp.push(jobId); return { target: "pi", route: { model: "model" }, usageSummary: { inputTokens: 1 } }; } },
  };
  const found = [];
  let offset = 0;
  do {
    const page = await inspectDynamicInvocation(runner, { runId: "run", invocationId: "inv-0", offset, limit: 10 });
    assert.ok(page.attempts.length <= 10);
    assert.equal(page.invalidated, true);
    found.push(...page.attempts.map((attempt) => attempt.jobId));
    offset = page.nextOffset;
  } while (offset !== null);
  assert.deepEqual(found, attempts.map((attempt) => attempt.jobId));
  assert.deepEqual(lookedUp, found);
});
