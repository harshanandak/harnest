import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_LIMITS,
  DynamicEngineError,
  runScript,
  validateScript,
} from "../src/dynamic-engine.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** Minimal valid workflow wrapper. */
function workflow(body, meta = `{ name: "test" }`) {
  return `export const meta = ${meta};\n${body}`;
}

async function expectEngineError(action, kind) {
  try {
    await action();
  } catch (error) {
    assert.ok(error instanceof DynamicEngineError, `expected DynamicEngineError, got ${error}`);
    assert.equal(error.details.kind, kind, `expected kind ${kind}, got ${error.details.kind} (${error.message})`);
    return error;
  }
  assert.fail(`expected DynamicEngineError with kind ${kind}`);
}

function expectSyncError(action, kind) {
  let error = null;
  try {
    action();
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof DynamicEngineError, `expected DynamicEngineError, got ${error}`);
  assert.equal(error.details.kind, kind, `expected kind ${kind}, got ${error?.details?.kind} (${error?.message})`);
  return error;
}

test("validateScript parses a literal meta block and returns the stripped body", () => {
  const source = `export const meta = { name: "demo", description: "A demo", phases: ["scan", "fix"] };\nreturn 1;`;
  const { meta, body } = validateScript(source);
  assert.deepEqual(meta, { name: "demo", description: "A demo", phases: ["scan", "fix"] });
  assert.ok(!body.includes("export const meta"));
  assert.ok(body.includes("return 1;"));
  assert.equal(body.split("\n").length, source.split("\n").length);
});

test("validateScript allows a script without meta", () => {
  const { meta, body } = validateScript("return { ok: true };");
  assert.equal(meta, null);
  assert.equal(body, "return { ok: true };");
});

test("validateScript rejects static imports", () => {
  const error = expectSyncError(
    () => validateScript(`import fs from "node:fs";\nexport const meta = { name: "x" };`),
    "import_not_allowed",
  );
  assert.match(error.message, /import/i);
});

test("validateScript rejects dynamic import() and import.meta", () => {
  expectSyncError(
    () => validateScript(`export const meta = { name: "x" };\nconst fs = await import("node:fs");`),
    "import_not_allowed",
  );
  expectSyncError(
    () => validateScript(`export const meta = { name: "x" };\nconst url = import.meta.url;`),
    "import_not_allowed",
  );
  // Import-like text inside a string or comment is not an import and must pass.
  const { meta } = validateScript(
    `// import fs from "node:fs"\nexport const meta = { name: "ok" };\nconst s = "await import(\\"x\\")";\nreturn s;`,
  );
  assert.equal(meta.name, "ok");
});

test("validateScript rejects extra exports and non-literal meta", () => {
  expectSyncError(
    () => validateScript(`export const meta = { name: "x" };\nexport const other = 1;`),
    "export_not_allowed",
  );
  expectSyncError(() => validateScript(`const name = "x";\nexport const meta = { name };`), "invalid_metadata");
  expectSyncError(() => validateScript(`export const meta = { name: "x", extra: 1 };`), "invalid_metadata");
  expectSyncError(() => validateScript(`export const meta = { name: 42 };`), "invalid_metadata");
});

test("validateScript reports syntax errors before execution", () => {
  expectSyncError(() => validateScript(`export const meta = { name: "x" };\nconst = ;`), "syntax_error");
});

test("validateScript enforces the source byte limit", () => {
  expectSyncError(() => validateScript(`export const meta = { name: "x" };\nreturn 1;`, { maxSourceBytes: 10 }), "limit_exceeded");
  assert.ok(DEFAULT_LIMITS.maxSourceBytes >= 100_000);
});

test("DEFAULT_LIMITS exposes stable documented fields", () => {
  for (const field of [
    "maxSourceBytes",
    "maxInputBytes",
    "maxResultBytes",
    "maxCallbackBytes",
    "maxAgentResultBytes",
    "maxDepth",
    "maxAgents",
    "maxConcurrency",
    "maxOutstandingCallbacks",
    "maxHelperItems",
    "maxHelperCalls",
    "maxLogs",
    "maxLogMessageBytes",
    "maxLogBytes",
    "maxPhases",
    "memoryLimitBytes",
    "stackSizeBytes",
    "timeoutMs",
    "maxDriveTicks",
    "maxPendingJobsPerPump",
  ]) {
    assert.equal(typeof DEFAULT_LIMITS[field], "number", `${field} must be numeric`);
  }
  assert.ok(Object.isFrozen(DEFAULT_LIMITS));
  assert.equal(DEFAULT_LIMITS.maxAgents, 1000);
  assert.equal(DEFAULT_LIMITS.maxHelperItems, 4096);
});

test("runScript requires an onAgent callback", async () => {
  await expectEngineError(() => runScript({ source: "return 1;" }), "config_error");
});

test("runScript executes branches, loops and a reduction entirely in the runtime", async () => {
  const out = await runScript({
    source: workflow(`
const values = [];
for (let i = 0; i < 5; i += 1) {
  if (i % 2 === 0) values.push(i * 2);
  else values.push(i * 3);
}
const total = values.reduce((sum, value) => sum + value, 0);
return { values, total, branch: total > 20 ? "high" : "low" };
`),
    onAgent: async () => null,
    limits: { timeoutMs: 5000 },
  });
  assert.deepEqual(out, { values: [0, 3, 4, 9, 8], total: 24, branch: "high" });
});

test("runScript returns null for undefined bodies and JSON for top-level return", async () => {
  const undefinedResult = await runScript({
    source: workflow("const x = 1;"),
    onAgent: async () => null,
    limits: { timeoutMs: 5000 },
  });
  assert.equal(undefinedResult, null);
  const jsonResult = await runScript({
    source: workflow(`return [1, "two", true, null, { nested: { ok: 1 } }];`),
    onAgent: async () => null,
    limits: { timeoutMs: 5000 },
  });
  assert.deepEqual(jsonResult, [1, "two", true, null, { nested: { ok: 1 } }]);
});

test("the guest is a full JavaScript engine, not a subset", async () => {
  const out = await runScript({
    source: workflow(`
class Counter {
  #value = 0;
  increment() { this.#value += 1; return this.#value; }
}
const counter = new Counter();
const map = new Map([["a", 1], ["b", 2]]);
const set = new Set([1, 1, 2]);
function* gen() { yield 1; yield 2; }
const optional = { a: { b: { c: 3 } } }?.a?.b?.c ?? 0;
const tagged = (strings, value) => strings[0] + value;
counter.increment();
return {
  privateField: counter.increment(),
  mapEntry: map.get("b"),
  setSize: set.size,
  gen: [...gen()],
  optional,
  tagged: tagged\`v=\${optional}\`,
  asyncValue: await Promise.resolve("awaited"),
};
`),
    onAgent: async () => null,
    limits: { timeoutMs: 5000 },
  });
  assert.deepEqual(out, {
    privateField: 2,
    mapEntry: 2,
    setSize: 2,
    gen: [1, 2],
    optional: 3,
    tagged: "v=3",
    asyncValue: "awaited",
  });
});

test("agent callbacks bridge async host work and receive JSON options", async () => {
  const calls = [];
  const out = await runScript({
    source: workflow(`
const first = await agent("alpha", { label: "Alpha", schema: { type: "object" } });
const second = await agent("beta");
return { first, second };
`),
    onAgent: async (prompt, options) => {
      calls.push({ prompt, options });
      await tick();
      return { prompt, label: options?.label ?? null };
    },
    limits: { timeoutMs: 5000 },
  });
  assert.deepEqual(calls, [
    { prompt: "alpha", options: { label: "Alpha", schema: { type: "object" } } },
    { prompt: "beta", options: null },
  ]);
  assert.deepEqual(out, {
    first: { prompt: "alpha", label: "Alpha" },
    second: { prompt: "beta", label: null },
  });
  // Host objects never cross the boundary: options are a fresh plain object.
  assert.equal(Object.getPrototypeOf(calls[0].options), Object.prototype);
});

test("guest mutation of an agent result cannot mutate the host object", async () => {
  const hostResult = { list: [1, 2, 3] };
  const out = await runScript({
    source: workflow(`
const result = await agent("mutable");
result.list.push(99);
return result.list.length;
`),
    onAgent: async () => hostResult,
    limits: { timeoutMs: 5000 },
  });
  assert.equal(out, 4);
  assert.deepEqual(hostResult.list, [1, 2, 3]);
});

test("pipeline preserves input order under concurrent completion", async () => {
  const out = await runScript({
    source: workflow(`
const results = await pipeline(["a", "b", "c", "d"], async (item, index) => {
  const result = await agent(item, { label: String(index) });
  return result.value;
});
return results;
`),
    onAgent: async (prompt) => {
      const delay = prompt === "a" ? 4 : prompt === "b" ? 3 : prompt === "c" ? 2 : 1;
      await new Promise((resolve) => setTimeout(resolve, delay * 10));
      return { value: prompt.toUpperCase() };
    },
    limits: { timeoutMs: 5000 },
  });
  assert.deepEqual(out, ["A", "B", "C", "D"]);
});

test("nested pipelines and fan-out reductions work", async () => {
  const out = await runScript({
    source: workflow(`
const groups = await pipeline([["a", "b"], ["c"]], async (group) => {
  const values = await parallel(group.map((item) => async () => (await agent(item)).value));
  return values.join("+");
});
return groups;
`),
    onAgent: async (prompt) => ({ value: prompt.toUpperCase() }),
    limits: { timeoutMs: 5000 },
  });
  assert.deepEqual(out, ["A+B", "C"]);
});

test("parallel preserves order and requires zero-argument tasks", async () => {
  const out = await runScript({
    source: workflow(`
const results = await parallel([
  () => agent("slow"),
  () => agent("fast"),
  () => 42,
  async () => "async",
]);
return results;
`),
    onAgent: async (prompt) => {
      await new Promise((resolve) => setTimeout(resolve, prompt === "slow" ? 40 : 1));
      return { prompt };
    },
    limits: { timeoutMs: 5000 },
  });
  assert.deepEqual(out, [{ prompt: "slow" }, { prompt: "fast" }, 42, "async"]);
  await expectEngineError(
    () =>
      runScript({
        source: workflow(`return parallel([() => 1, (x) => x]);`),
        onAgent: async () => null,
        limits: { timeoutMs: 5000 },
      }),
    "invalid_argument",
  );
});

test("pipeline and parallel reject oversized collections before invoking callbacks", async () => {
  for (const helper of [
    `pipeline(new Array(5).fill(1), async () => agent("should-not-run"))`,
    `parallel(new Array(5).fill(0).map(() => () => agent("should-not-run")))`,
  ]) {
    let agentCalls = 0;
    const error = await expectEngineError(
      () =>
        runScript({
          source: workflow(`return await ${helper};`),
          onAgent: async () => {
            agentCalls += 1;
            return null;
          },
          limits: { timeoutMs: 5000, maxHelperItems: 4 },
        }),
      "limit_exceeded",
    );
    assert.match(error.message, /4/);
    assert.equal(agentCalls, 0);
  }
});

test("pipeline rejects non-array input and non-JSON items", async () => {
  await expectEngineError(
    () =>
      runScript({
        source: workflow(`return await pipeline("nope", async (x) => x);`),
        onAgent: async () => null,
        limits: { timeoutMs: 5000 },
      }),
    "invalid_argument",
  );
  await expectEngineError(
    () =>
      runScript({
        source: workflow(`const fn = () => 1;\nreturn await pipeline([fn], async (x) => x);`),
        onAgent: async () => null,
        limits: { timeoutMs: 5000 },
      }),
    "invalid_json",
  );
});

test("maxConcurrency bounds simultaneous pipeline callbacks and agents", async () => {
  let inFlight = 0;
  let peak = 0;
  const out = await runScript({
    source: workflow(`
const results = await pipeline(new Array(12).fill(0).map((_, i) => i), async (item) => {
  return await agent(String(item));
});
return results.length;
`),
    onAgent: async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return null;
    },
    limits: { timeoutMs: 10_000, maxConcurrency: 3 },
  });
  assert.equal(out, 12);
  assert.ok(peak <= 3, `peak concurrency ${peak} exceeded 3`);
  assert.ok(peak >= 2, `expected some parallelism, saw ${peak}`);
});

test("phase and log callbacks fire in guest order and are awaitable", async () => {
  const events = [];
  const out = await runScript({
    source: workflow(`
log("start");
await phase("scan");
const answer = await agent("work");
log("after-agent");
await phase("report");
return answer;
`),
    onAgent: async () => {
      events.push("agent");
      return "done";
    },
    onPhase: async (title) => {
      await tick();
      events.push(`phase:${title}`);
    },
    onLog: (message) => {
      events.push(`log:${message}`);
    },
    limits: { timeoutMs: 5000 },
  });
  assert.equal(out, "done");
  assert.deepEqual(events, ["log:start", "phase:scan", "agent", "log:after-agent", "phase:report"]);
});

test("phase/log callback effects complete before a following agent is dispatched", async () => {
  const events = [];
  const phaseStarted = deferred();
  const phaseDone = deferred();
  const run = runScript({
    source: workflow(`
phase("gate");
const answer = await agent("after-gate");
return answer;
`),
    onAgent: async () => {
      events.push("agent-dispatched");
      return "ok";
    },
    onPhase: () => {
      events.push("phase-started");
      phaseStarted.resolve();
      return phaseDone.promise.then(() => events.push("phase-finished"));
    },
    limits: { timeoutMs: 5000 },
  });
  await phaseStarted.promise;
  // The phase callback is still pending; the agent must not have been dispatched.
  assert.deepEqual(events, ["phase-started"]);
  phaseDone.resolve();
  assert.equal(await run, "ok");
  assert.deepEqual(events, ["phase-started", "phase-finished", "agent-dispatched"]);
});

test("args are exposed read-only through the args global", async () => {
  const args = { nested: { list: [1, 2] } };
  const out = await runScript({
    source: workflow(`
const before = JSON.stringify(args);
try { args.nested.list.push(3); } catch (error) { /* frozen in strict mode */ }
try { args = "replaced"; } catch (error) { /* not writable */ }
return { before, after: JSON.stringify(args) };
`),
    args,
    onAgent: async () => null,
    limits: { timeoutMs: 5000 },
  });
  assert.equal(out.before, '{"nested":{"list":[1,2]}}');
  assert.equal(out.after, out.before);
  assert.deepEqual(args, { nested: { list: [1, 2] } });
});

test("the guest has no ambient host capabilities", async () => {
  const out = await runScript({
    source: workflow(`
const functionEscape = Function("return typeof process")();
return {
  process: typeof process,
  require: typeof require,
  module: typeof module,
  buffer: typeof Buffer,
  setInterval: typeof setInterval,
  fetch: typeof fetch,
  xmlHttpRequest: typeof XMLHttpRequest,
  console: typeof console,
  globalThisEscape: (function () { return typeof this; })(),
  evalEscape: eval("typeof require"),
  functionEscape,
};
`),
    onAgent: async () => null,
    limits: { timeoutMs: 5000 },
  });
  assert.deepEqual(out, {
    process: "undefined",
    require: "undefined",
    module: "undefined",
    buffer: "undefined",
    setInterval: "undefined",
    fetch: "undefined",
    xmlHttpRequest: "undefined",
    console: "undefined",
    globalThisEscape: "undefined",
    evalEscape: "undefined",
    functionEscape: "undefined",
  });
});

test("Date and Math.random are blocked for call, construct and rebound references", async () => {
  const out = await runScript({
    source: workflow(`
const probes = {};
const attempt = (name, fn) => { try { probes[name] = fn(); } catch (error) { probes[name] = "blocked"; } };
attempt("dateCall", () => Date());
attempt("dateNew", () => new Date());
attempt("dateNewArg", () => new Date(0));
attempt("dateNow", () => Date.now());
attempt("dateParse", () => Date.parse("2020-01-01"));
attempt("random", () => Math.random());
attempt("randomRebound", () => { const random = Math.random; return random(); });
attempt("dateRebound", () => { const D = Date; return D.now(); });
attempt("descriptorWritable", () => Object.getOwnPropertyDescriptor(Math, "random").writable);
attempt("reassignRandom", () => { Math.random = () => 0.5; return "reassigned"; });
attempt("reassignDate", () => { Date = () => 0; return "reassigned"; });
return probes;
`),
    onAgent: async () => null,
    limits: { timeoutMs: 5000 },
  });
  for (const [key, value] of Object.entries(out)) {
    if (key === "descriptorWritable") {
      assert.equal(value, false);
    } else {
      assert.equal(value, "blocked", `${key} should be blocked`);
    }
  }
});

test("returning a host-like object with functions is rejected, not silently dropped", async () => {
  await expectEngineError(
    () =>
      runScript({
        source: workflow(`return { fn: () => 1 };`),
        onAgent: async () => null,
        limits: { timeoutMs: 5000 },
      }),
    "invalid_json",
  );
  await expectEngineError(
    () =>
      runScript({
        source: workflow(`return [1, undefined, 3];`),
        onAgent: async () => null,
        limits: { timeoutMs: 5000 },
      }),
    "invalid_json",
  );
});

test("prototype pollution through args is rejected before guest execution", async () => {
  const pollutedArgs = JSON.parse('{"__proto__":{"polluted":true}}');
  await expectEngineError(
    () =>
      runScript({
        source: workflow(`return args.polluted;`),
        args: pollutedArgs,
        onAgent: async () => null,
        limits: { timeoutMs: 5000 },
      }),
    "invalid_json",
  );
  assert.equal({}.polluted, undefined);
  const out = await runScript({
    source: workflow(`return { ctor: args.constructor, plainCtor: ({}).constructor === Object };`),
    args: { constructor: "literal" },
    onAgent: async () => null,
    limits: { timeoutMs: 5000 },
  });
  assert.deepEqual(out, { ctor: "literal", plainCtor: true });
});

test("an infinite CPU loop is interrupted by the deadline", async () => {
  const started = Date.now();
  const error = await expectEngineError(
    () =>
      runScript({
        source: workflow(`let n = 0;\nwhile (true) { n += 1; }`),
        onAgent: async () => null,
        limits: { timeoutMs: 250 },
      }),
    "timeout",
  );
  assert.ok(Date.now() - started < 10_000, "interrupt should be prompt");
  assert.equal(error.code, "timeout");
});

test("a promise storm is bounded by the engine", async () => {
  const started = Date.now();
  const error = await expectEngineError(
    () =>
      runScript({
        source: workflow(`
async function spin() { for (;;) { await null; } }
await spin();
`),
        onAgent: async () => null,
        limits: { timeoutMs: 1500 },
      }),
    "limit_exceeded",
  );
  assert.ok(Date.now() - started < 15_000);
  assert.ok(["limit_exceeded", "timeout"].includes(error.details.kind));
});

test("the guest heap limit surfaces an explicit out-of-memory error", async () => {
  const error = await expectEngineError(
    () =>
      runScript({
        source: workflow(`const held = new Array(2_000_000).fill(0); return held.length;`),
        onAgent: async () => null,
        limits: { timeoutMs: 20_000, memoryLimitBytes: 4 * 1024 * 1024 },
      }),
    "out_of_memory",
  );
  assert.equal(error.code, "out_of_memory");
});

test("the guest stack cap surfaces an explicit stack-overflow error", async () => {
  await expectEngineError(
    () =>
      runScript({
        source: workflow(`function recurse(n) { return recurse(n + 1); }\nreturn recurse(0);`),
        onAgent: async () => null,
        limits: { timeoutMs: 10_000, stackSizeBytes: 128 * 1024 },
      }),
    "stack_overflow",
  );
});

test("aborting the signal cancels a run with details.kind aborted", async () => {
  const controller = new AbortController();
  const run = runScript({
    source: workflow(`const result = await agent("slow");\nreturn result;`),
    onAgent: () => new Promise(() => {}),
    signal: controller.signal,
    limits: { timeoutMs: 10_000 },
  });
  setTimeout(() => controller.abort(), 50);
  const error = await expectEngineError(() => run, "aborted");
  assert.equal(error.code, "aborted");
});

test("an already-aborted signal fails before guest execution", async () => {
  const controller = new AbortController();
  controller.abort();
  await expectEngineError(
    () =>
      runScript({
        source: workflow(`return agent("never");`),
        onAgent: async () => null,
        signal: controller.signal,
        limits: { timeoutMs: 5000 },
      }),
    "aborted",
  );
});

test("aborting with an in-flight helper does not leak or re-enter the disposed VM", async () => {
  const controller = new AbortController();
  const lateAgent = deferred();
  const run = runScript({
    source: workflow(`
const values = await pipeline([1, 2], async (item) => {
  return await agent(String(item));
});
return values;
`),
    onAgent: () => lateAgent.promise,
    signal: controller.signal,
    limits: { timeoutMs: 10_000 },
  });
  setTimeout(() => controller.abort(), 50);
  await expectEngineError(() => run, "aborted");
  // The host callback finishes long after the VM was disposed.
  lateAgent.resolve({ ok: true });
  await tick();
  await tick();
  // A fresh run still works, proving no corrupted global state or unhandled rejection.
  const out = await runScript({
    source: workflow(`return { recovered: true };`),
    onAgent: async () => null,
    limits: { timeoutMs: 5000 },
  });
  assert.deepEqual(out, { recovered: true });
});

test("a workflow may not return while unawaited agent calls are still running", async () => {
  let settled = 0;
  const out = await runScript({
    source: workflow(`agent("background");\nreturn "returned";`),
    onAgent: async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      settled += 1;
      return null;
    },
    limits: { timeoutMs: 5000 },
  });
  assert.equal(out, "returned");
  assert.equal(settled, 1, "the engine must drain in-flight agent calls before returning");
});

test("a failed unawaited agent call surfaces an explicit error", async () => {
  const error = await expectEngineError(
    () =>
      runScript({
        source: workflow(`agent("forgotten");\nreturn "returned";`),
        onAgent: async () => {
          await new Promise((resolve) => setTimeout(resolve, 60));
          throw new Error("late failure");
        },
        limits: { timeoutMs: 5000 },
      }),
    "unawaited_agent_failed",
  );
  assert.match(error.message, /late failure/);
});

test("a rejected agent call becomes a catchable guest data error", async () => {
  class HostBoom extends Error {
    constructor() {
      super("host boom");
      this.name = "HostBoom";
      this.hostOnly = true;
    }
  }
  const out = await runScript({
    source: workflow(`
try {
  await agent("fails");
  return { caught: false };
} catch (error) {
  return {
    caught: true,
    name: error.name,
    message: error.message,
    isGuestError: error instanceof Error,
    hasHostOnly: Object.prototype.hasOwnProperty.call(error, "hostOnly"),
  };
}
`),
    onAgent: async () => {
      throw new HostBoom();
    },
    limits: { timeoutMs: 5000 },
  });
  assert.deepEqual(out, {
    caught: true,
    name: "HostBoom",
    message: "host boom",
    isGuestError: true,
    hasHostOnly: false,
  });
});

test("a caught limit error carries an explicit guest-visible message", async () => {
  const out = await runScript({
    source: workflow(`
try {
  await agent("one");
  await agent("two");
  await agent("three");
  return { caught: false };
} catch (error) {
  return {
    caught: true,
    isGuestError: error instanceof Error,
    message: error.message,
    hasName: typeof error.name === "string",
  };
}
`),
    onAgent: async () => null,
    limits: { timeoutMs: 5000, maxAgents: 2 },
  });
  assert.equal(out.caught, true);
  assert.equal(out.isGuestError, true);
  assert.match(out.message, /2/);
  assert.equal(out.hasName, true);
});

test("maxAgents counts every agent call and fails explicitly", async () => {
  let calls = 0;
  const error = await expectEngineError(
    () =>
      runScript({
        source: workflow(`for (let i = 0; i < 5; i += 1) { await agent(String(i)); }\nreturn "done";`),
        onAgent: async () => {
          calls += 1;
          return null;
        },
        limits: { timeoutMs: 5000, maxAgents: 2 },
      }),
    "limit_exceeded",
  );
  assert.match(error.message, /2/);
  assert.equal(calls, 2);
});

test("maxOutstandingCallbacks bounds simultaneous agent calls", async () => {
  const pending = [];
  const error = await expectEngineError(
    () =>
      runScript({
        source: workflow(`
const first = agent("1");
const second = agent("2");
const third = agent("3");
return await Promise.all([first, second, third]);
`),
        onAgent: () => new Promise((resolve) => pending.push(resolve)),
        limits: { timeoutMs: 5000, maxOutstandingCallbacks: 2 },
      }),
    "limit_exceeded",
  );
  assert.match(error.message, /2/);
  for (const resolve of pending) resolve(null);
});

test("callback serialization limits reject oversized prompts and results", async () => {
  await expectEngineError(
    () =>
      runScript({
        source: workflow(`return await agent("x".repeat(200));`),
        onAgent: async () => null,
        limits: { timeoutMs: 5000, maxCallbackBytes: 64 },
      }),
    "limit_exceeded",
  );
  await expectEngineError(
    () =>
      runScript({
        source: workflow(`return await agent("small");`),
        onAgent: async () => ({ big: "y".repeat(500) }),
        limits: { timeoutMs: 5000, maxAgentResultBytes: 64 },
      }),
    "limit_exceeded",
  );
});

test("input, output and depth limits are explicit", async () => {
  await expectEngineError(
    () =>
      runScript({
        source: workflow(`return args;`),
        args: { big: "z".repeat(500) },
        onAgent: async () => null,
        limits: { timeoutMs: 5000, maxInputBytes: 64 },
      }),
    "limit_exceeded",
  );
  await expectEngineError(
    () =>
      runScript({
        source: workflow(`return "w".repeat(500);`),
        onAgent: async () => null,
        limits: { timeoutMs: 5000, maxResultBytes: 64 },
      }),
    "limit_exceeded",
  );
  await expectEngineError(
    () =>
      runScript({
        source: workflow(`return args;`),
        args: { a: { b: { c: { d: 1 } } } },
        onAgent: async () => null,
        limits: { timeoutMs: 5000, maxDepth: 2 },
      }),
    "invalid_json",
  );
});

test("log and phase limits are explicit", async () => {
  await expectEngineError(
    () =>
      runScript({
        source: workflow(`log("a");\nlog("b");\nlog("c");\nreturn 1;`),
        onAgent: async () => null,
        onLog: () => {},
        limits: { timeoutMs: 5000, maxLogs: 2 },
      }),
    "limit_exceeded",
  );
  await expectEngineError(
    () =>
      runScript({
        source: workflow(`log("x".repeat(200));\nreturn 1;`),
        onAgent: async () => null,
        onLog: () => {},
        limits: { timeoutMs: 5000, maxLogMessageBytes: 32 },
      }),
    "limit_exceeded",
  );
  await expectEngineError(
    () =>
      runScript({
        source: workflow(`log("aaaa");\nlog("bbbb");\nreturn 1;`),
        onAgent: async () => null,
        onLog: () => {},
        limits: { timeoutMs: 5000, maxLogBytes: 6 },
      }),
    "limit_exceeded",
  );
  await expectEngineError(
    () =>
      runScript({
        source: workflow(`await phase("one");\nawait phase("two");\nreturn 1;`),
        onAgent: async () => null,
        onPhase: () => {},
        limits: { timeoutMs: 5000, maxPhases: 1 },
      }),
    "limit_exceeded",
  );
});

test("helper call count is bounded", async () => {
  await expectEngineError(
    () =>
      runScript({
        source: workflow(`
await pipeline([1], async (x) => x);
await pipeline([2], async (x) => x);
return 1;
`),
        onAgent: async () => null,
        limits: { timeoutMs: 5000, maxHelperCalls: 1 },
      }),
    "limit_exceeded",
  );
});

test("meta is parsed literally and never executed", async () => {
  let executed = false;
  const out = await runScript({
    source: `export const meta = { name: "literal", phases: ["a", "b"] };\nreturn { ok: true };`,
    onAgent: async () => {
      executed = true;
      return null;
    },
    limits: { timeoutMs: 5000 },
  });
  assert.deepEqual(out, { ok: true });
  assert.equal(executed, false);
});

test("a saved workflow fixture runs from disk through validateScript and runScript", async () => {
  const path = fileURLToPath(new URL("../scripts/fixtures/dynamic-engine-saved-workflow.js", import.meta.url));
  const source = readFileSync(path, "utf8");
  const { meta } = validateScript(source);
  assert.deepEqual(meta, {
    name: "fixture-dynamic-workflow",
    description: "Fan out over args.items and reduce the agent results",
    phases: ["fan-out", "reduce"],
  });
  const phases = [];
  const logs = [];
  const out = await runScript({
    source,
    args: { items: [1, 2, 3] },
    onAgent: async (prompt, options) => ({ value: options.label === "item-1" ? 10 : 20 }),
    onPhase: (title) => phases.push(title),
    onLog: (message) => logs.push(message),
    limits: { timeoutMs: 10_000 },
  });
  assert.equal(out, 50);
  assert.deepEqual(phases, ["fan-out", "reduce"]);
  assert.deepEqual(logs, ["starting 3 items"]);
});




// --- bounded guest CPU slices ----------------------------------------------

test("a pure guest loop fails fast with an explicit cpu-limit, not the wall deadline", { timeout: 30_000 }, async () => {
  let ticks = 0;
  const interval = setInterval(() => { ticks += 1; }, 20);
  const started = Date.now();
  try {
    await assert.rejects(
      () => runScript({
        source: "while (true) {}",
        onAgent: async () => null,
        limits: { timeoutMs: 3_600_000, maxCpuSliceMs: 100 },
      }),
      (error) => {
        assert.equal(error.details?.kind, "cpu-limit");
        assert.equal(error.details?.limit, 100);
        return true;
      },
    );
    assert.ok(Date.now() - started < 5_000, "the wall deadline must not be what stopped the loop");
    // The slice bounds uninterrupted blocking; once it trips, the host must be
    // responsive again immediately.
    const before = ticks;
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.ok(ticks > before, "host timers must recover right after the cpu-limit interruption");
  } finally {
    clearInterval(interval);
  }
});

test("a pure guest Promise-job spin is bounded the same way", { timeout: 30_000 }, async () => {
  await assert.rejects(
    () => runScript({
      source: "const spin = async () => { while (true) {} }; await spin();",
      onAgent: async () => null,
      limits: { timeoutMs: 3_600_000, maxCpuSliceMs: 100 },
    }),
    (error) => error.details?.kind === "cpu-limit",
  );
});

test("host helper waits never consume the guest CPU slice", { timeout: 30_000 }, async () => {
  const result = await runScript({
    source: "await phase('slow'); return 'after-wait';",
    onAgent: async () => null,
    onPhase: async () => { await new Promise((resolve) => setTimeout(resolve, 300)); },
    limits: { timeoutMs: 3_600_000, maxCpuSliceMs: 100 },
  });
  assert.equal(result, "after-wait");
});

test("the engine stays usable after a cpu-limit interruption", { timeout: 30_000 }, async () => {
  await assert.rejects(
    () => runScript({ source: "while (true) {}", onAgent: async () => null, limits: { maxCpuSliceMs: 100 } }),
    (error) => error.details?.kind === "cpu-limit",
  );
  const value = await runScript({ source: "return await agent('after');", onAgent: async () => ({ ok: true }) });
  assert.deepEqual(value, { ok: true });
});

test("nested host validation cannot renew an uninterrupted guest CPU slice", async () => {
  const error = await expectEngineError(() => runScript({
    source: 'for (;;) { try { agent("probe", {}); } catch {} }',
    onAgent: async () => null,
    limits: { maxAgents: 1, maxCpuSliceMs: 50, timeoutMs: 1000 },
  }), "cpu-limit");
  assert.equal(error.details.kind, "cpu-limit");
});

test("host waiting and completed callbacks do not exhaust the guest no-progress guard", async () => {
  let completed = 0;
  const result = await runScript({
    source: 'return await pipeline(args, async (item) => await agent(String(item)));',
    args: Array.from({ length: 40 }, (_, index) => index),
    onAgent: async (prompt) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      completed++;
      return Number(prompt);
    },
    limits: { maxDriveTicks: 4, timeoutMs: 5000 },
  });
  assert.equal(completed, 40);
  assert.deepEqual(result, Array.from({ length: 40 }, (_, index) => index));
});

test("an expired deadline inside the host-callback loop aborts instead of trapping the WASM engine", { timeout: 30_000 }, () => {
  // Issue 15 regression: with a clock that jumps past the deadline while the
  // guest spins in `for (;;) { try { agent(...) } catch {} }`, the engine used
  // to trap inside QTS_Eval ("memory access out of bounds") once the interrupt
  // fired while host callbacks kept creating guest promises. The run must fail
  // with a controlled timeout and leave the engine usable. This runs in a child
  // process because a WASM trap poisons the shared module for the whole process.
  const engineUrl = new URL("../src/dynamic-engine.mjs", import.meta.url).href;
  const child = `
    const { runScript } = await import(${JSON.stringify(engineUrl)});
    await runScript({ source: 'return 1;', onAgent: async () => null });
    const realNow = Date.now;
    const results = [];
    for (const threshold of [10, 100]) {
      let calls = 0;
      const base = realNow();
      Date.now = () => { calls++; return base + (calls >= threshold ? 1100 : 0); };
      let outcome;
      try {
        await runScript({
          source: 'for (;;) { try { agent("probe", {}); } catch {} }',
          onAgent: async () => null,
          limits: { maxAgents: 1, maxCpuSliceMs: 50, timeoutMs: 1000 },
        });
        outcome = { name: null, kind: 'completed' };
      } catch (error) {
        outcome = { name: error.name, kind: error.details?.kind };
      } finally {
        Date.now = realNow;
      }
      let usable = null;
      try {
        usable = await runScript({ source: 'return 42;', onAgent: async () => null });
      } catch (error) {
        usable = { name: error.name };
      }
      results.push({ threshold, outcome, usable });
    }
    console.log(JSON.stringify(results));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", child], {
    encoding: "utf8",
    timeout: 20_000,
    windowsHide: true,
  });
  assert.equal(result.status, 0, `child exited ${result.status}: ${(result.stderr || "").slice(0, 400)}`);
  const results = JSON.parse(result.stdout.trim());
  for (const { threshold, outcome, usable } of results) {
    assert.deepEqual(
      outcome,
      { name: "DynamicEngineError", kind: "timeout" },
      `threshold ${threshold} must fail with a controlled timeout`,
    );
    assert.equal(usable, 42, `engine must stay usable after the interruption at threshold ${threshold}`);
  }
});
