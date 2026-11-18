import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

const modules = [
  "../src/job-store.mjs",
  "../src/config.mjs",
  "../src/adapters/pi.mjs",
  "../src/adapters/opencode.mjs",
  "../src/adapters/index.mjs",
  "../src/companion.mjs",
];
const repetitions = 3;
for (const module of modules) {
  const samples = [];
  for (let i = 0; i < repetitions; i += 1) {
    const start = performance.now();
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      const start = performance.now();
      await import(${JSON.stringify(new URL(module, import.meta.url).href)});
      console.log(JSON.stringify({ importMs: performance.now() - start, rssMiB: process.memoryUsage().rss / 1024 ** 2 }));
    `], { encoding: "utf8", timeout: 30_000, windowsHide: true });
    if (child.error) throw child.error;
    if (child.status !== 0) throw new Error(child.stderr);
    samples.push({ ...JSON.parse(child.stdout), processMs: performance.now() - start });
  }
  console.log(JSON.stringify({ module, samples }));
}
