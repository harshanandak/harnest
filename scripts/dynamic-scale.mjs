import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { runScript } from "../src/dynamic-engine.mjs";

const before = process.memoryUsage();
const started = performance.now();
let launches = 0;
let active = 0;
let maxActive = 0;
let peakRss = before.rss;
const output = await runScript({
  source: "const values = await pipeline(Array.from({length: 1000}, (_, i) => i), i => agent(String(i))); const helpers = await pipeline(Array.from({length: 4096}, (_, i) => i), i => i + 1); return {total: values.length, helperItems: helpers.length, last: values[999]};",
  onAgent: async (prompt) => {
    launches++;
    maxActive = Math.max(maxActive, ++active);
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    await new Promise((resolve) => setImmediate(resolve));
    active--;
    return { value: Number(prompt) };
  },
  limits: { maxConcurrency: 6, timeoutMs: 30000 },
});
assert.deepEqual(output, { total: 1000, helperItems: 4096, last: { value: 999 } });
assert.equal(launches, 1000);
assert.ok(maxActive <= 6);
peakRss = Math.max(peakRss, process.memoryUsage().rss);
console.log(JSON.stringify({ scope: "QuickJS engine with fake callbacks; no adapter processes", launches, maxActive, elapsedMs: Math.round(performance.now() - started), rssBefore: before.rss, sampledPeakRss: peakRss, rssAfter: process.memoryUsage().rss, output }, null, 2));
