#!/usr/bin/env node
// Dynamic workflow runner scale probe (approved issue15 acceptance 140/143).
//
// Runs ONE real DynamicWorkflowRunner attempt with a real Companion and a fake
// in-process adapter for exactly 1000 agent calls at maxConcurrency 6, with an
// absolute 120s probe deadline. No native harness process, no network, no paid
// call. In-process execution (detachBackground false) is deliberate: RSS/heap,
// handles and disk numbers then describe the process that actually ran the
// workflow instead of a detached worker we cannot sample.
//
// Measurements recorded to <fixture>/scale-report.json:
//   - peak JS RSS/heap/external, live active handles, timers, child processes
//   - default and paginated status serialized bytes + page bounds
//   - retained disk bytes for the companion job store and the dynamic run store
//   - semantic evidence: observed calls, distinct indices, max in-flight
//     concurrency, final output, elapsed time, failures
//
// Usage:
//   node scripts/dynamic-runner-scale.mjs --root <repo> [--calls 1000]
//     [--concurrency 6] [--fixture <dir>] [--deadline-ms 120000] [--poll-ms 250]
//
// The probe never raises its own deadline and exits 1 on any failed assertion.
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, "..");
const TERMINAL = new Set(["completed", "failed", "cancelled", "partial"]);
const DEFAULT_CALLS = 1000;
const DEFAULT_CONCURRENCY = 6;
const DEFAULT_DEADLINE_MS = 120_000;
const DEFAULT_POLL_MS = 250;
const DEFAULT_INVOCATION_LIMIT = 200;

export function parseArgs(argv) {
  const result = {
    calls: DEFAULT_CALLS,
    concurrency: DEFAULT_CONCURRENCY,
    deadlineMs: DEFAULT_DEADLINE_MS,
    pollMs: DEFAULT_POLL_MS,
    invocationLimit: DEFAULT_INVOCATION_LIMIT,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const take = () => {
      const value = argv[++index];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      return value;
    };
    if (arg === "--root") result.root = resolve(take());
    else if (arg === "--fixture") result.fixture = resolve(take());
    else if (arg === "--calls") result.calls = Number(take());
    else if (arg === "--concurrency") result.concurrency = Number(take());
    else if (arg === "--deadline-ms") result.deadlineMs = Number(take());
    else if (arg === "--poll-ms") result.pollMs = Number(take());
    else if (arg === "--invocation-limit") result.invocationLimit = Number(take());
    else if (arg === "--help" || arg === "-h") result.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isInteger(result.calls) || result.calls < 1 || result.calls > 1000) throw new Error("--calls must be an integer between 1 and 1000");
  if (!Number.isInteger(result.concurrency) || result.concurrency < 1 || result.concurrency > 6) throw new Error("--concurrency must be an integer between 1 and 6");
  if (!Number.isInteger(result.deadlineMs) || result.deadlineMs < 1) throw new Error("--deadline-ms must be a positive integer");
  if (!Number.isInteger(result.pollMs) || result.pollMs < 100) throw new Error("--poll-ms must be at least 100 so the probe never busy-loops status");
  if (!Number.isInteger(result.invocationLimit) || result.invocationLimit < 1 || result.invocationLimit > 1000) throw new Error("--invocation-limit must be between 1 and 1000");
  return result;
}

export function buildWorkflowSource() {
  return [
    'export const meta = { name: "runner-scale", phases: ["scale"] };',
    'await phase("scale");',
    'const items = [];',
    'for (let index = 0; index < args.calls; index += 1) items.push(index);',
    'const observed = await pipeline(items, async (index) => {',
    '  const response = await agent(',
    '    JSON.stringify({ kind: "scale", index }),',
    '    { label: "call-" + index, target: "pi" },',
    '  );',
    '  return response ? JSON.parse(response.finalText).index : null;',
    '});',
    'const clean = observed.filter((value) => value !== null);',
    'return {',
    '  calls: args.calls,',
    '  observed: observed.length,',
    '  completed: clean.length,',
    '  sum: clean.reduce((total, value) => total + value, 0),',
    '};',
  ].join("\n");
}

/** In-process fake adapter: records concurrency and exactly which indices ran. */
export function createScaleAdapter() {
  const stats = { inflight: 0, maxInflight: 0, observed: 0, indices: new Set(), errors: [] };
  const factory = () => ({
    async run(request, { signal } = {}) {
      let instruction = {};
      try {
        instruction = JSON.parse(request.task);
      } catch {
        /* a malformed task is still counted below */
      }
      stats.inflight += 1;
      if (stats.inflight > stats.maxInflight) stats.maxInflight = stats.inflight;
      try {
        if (signal?.aborted) {
          throw Object.assign(new Error("scale adapter aborted"), { details: { kind: "aborted", aborted: true } });
        }
        await new Promise((done) => setImmediate(done));
        stats.observed += 1;
        stats.indices.add(instruction.index);
        return { result: { finalText: JSON.stringify({ index: instruction.index }) } };
      } catch (error) {
        stats.errors.push(error?.message ?? String(error));
        throw error;
      } finally {
        stats.inflight -= 1;
      }
    },
  });
  return { factory, stats };
}

export function resourceSnapshot() {
  let usage;
  try {
    usage = process.memoryUsage();
  } catch {
    usage = {};
  }
  let handles = [];
  try {
    handles = process._getActiveHandles?.() ?? [];
  } catch {
    handles = [];
  }
  const resources = process.getActiveResourcesInfo?.() ?? [];
  const counts = {};
  for (const name of resources) counts[name] = (counts[name] ?? 0) + 1;
  return {
    rssBytes: usage.rss ?? 0,
    heapUsedBytes: usage.heapUsed ?? 0,
    heapTotalBytes: usage.heapTotal ?? 0,
    externalBytes: usage.external ?? 0,
    arrayBuffersBytes: usage.arrayBuffers ?? 0,
    activeHandles: handles.length,
    timers: counts.Timeout ?? 0,
    immediates: counts.Immediate ?? 0,
    childProcesses: handles.filter((handle) => handle?.constructor?.name === "ChildProcess").length,
  };
}

export function measureTree(root) {
  let bytes = 0;
  let files = 0;
  let largestFileBytes = 0;
  let largestFile = null;
  const walk = (current) => {
    let entries = [];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        try {
          const size = statSync(full).size;
          bytes += size;
          files += 1;
          if (size > largestFileBytes) {
            largestFileBytes = size;
            largestFile = full;
          }
        } catch {
          /* a file that vanished during measurement is not fatal */
        }
      }
    }
  };
  walk(root);
  return { bytes, files, largestFileBytes, largestFile };
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function collectInvocations(runner, runId, limit, deadlineAt) {
  const pages = [];
  const invocations = [];
  let cursor = null;
  for (;;) {
    const status = await runner.status({ runId, invocationLimit: limit, invocationCursor: cursor });
    const bytes = Buffer.byteLength(JSON.stringify(status), "utf8");
    pages.push({ count: status.invocations.length, bytes, nextCursor: status.invocationsNextCursor ?? null });
    invocations.push(...status.invocations);
    cursor = status.invocationsNextCursor ?? null;
    if (cursor === null) break;
    if (pages.length > 100) throw new Error("status pagination did not terminate");
    if (Date.now() > deadlineAt) throw new Error("status pagination exceeded the probe deadline");
  }
  return { invocations, pages };
}

async function stopIfActive(runner, runId, state, timeoutMs = 20_000) {
  if (TERMINAL.has(state)) return state;
  try {
    await runner.control({ runId, commandId: `scale-stop-${Date.now().toString(36)}`, action: "stop" });
  } catch {
    /* the run may already have settled */
  }
  const deadlineAt = Date.now() + timeoutMs;
  for (;;) {
    const status = await runner.status({ runId }).catch(() => null);
    if (!status || TERMINAL.has(status.state)) return status?.state ?? null;
    if (Date.now() >= deadlineAt) return null;
    await sleep(250);
  }
}

export async function runScale(options) {
  const fixture = options.fixture ?? join(tmpdir(), "harnest-scale", new Date().toISOString().replace(/[:.]/g, "-"));
  const companionDir = join(fixture, "companion");
  const dynamicDir = join(fixture, "dynamic");
  for (const dir of [fixture, companionDir, dynamicDir]) mkdirSync(dir, { recursive: true });

  const importFromRoot = (relative) => import(pathToFileURL(join(options.root, relative)).href);
  const { Companion } = await importFromRoot("src/companion.mjs");
  const { DynamicWorkflowRunner } = await importFromRoot("src/dynamic-runner.mjs");
  const { factory, stats } = createScaleAdapter();
  const companion = new Companion({ stateDir: companionDir, detachBackground: false, adapterFactory: factory });
  const runner = new DynamicWorkflowRunner({
    companion,
    stateDir: dynamicDir,
    detachBackground: false,
    pollIntervalMs: 50,
    heartbeatIntervalMs: 1_000,
    leaseTimeoutMs: 30_000,
  });

  const startedAt = Date.now();
  const deadlineAt = startedAt + options.deadlineMs;
  const expectedSum = (options.calls * (options.calls - 1)) / 2;
  const spec = {
    requestId: `scale-${startedAt.toString(36)}`,
    name: "runner-scale",
    source: buildWorkflowSource(),
    args: { calls: options.calls },
    cwd: fixture,
    target: "pi",
    route: {},
    policy: { write: false, tools: [], maxCostUsd: null },
    execution: { background: true, timeoutMs: options.deadlineMs, maxConcurrency: options.concurrency, maxAgents: 1000, prefixStaggerMs: 0 },
  };

  const baseline = resourceSnapshot();
  const peak = { ...baseline };
  let peakStatusBytes = 0;
  let polls = 0;
  let elapsedMs = 0;
  let runId = null;
  let lastStatus = null;
  let failure = null;
  let paged = { invocations: [], pages: [] };
  let disk = {
    companion: { bytes: 0, files: 0, largestFileBytes: 0, largestFile: null },
    dynamic: { bytes: 0, files: 0, largestFileBytes: 0, largestFile: null },
    total: { bytes: 0, files: 0 },
  };

  try {
    const started = await runner.start(spec);
    runId = started.runId;
    lastStatus = started;
    while (!TERMINAL.has(lastStatus.state)) {
      if (Date.now() > deadlineAt) {
        throw new Error(`probe deadline ${options.deadlineMs}ms exceeded while the run was ${lastStatus.state}`);
      }
      await sleep(options.pollMs);
      lastStatus = await runner.status({ runId, invocationLimit: options.invocationLimit });
      const bytes = Buffer.byteLength(JSON.stringify(lastStatus), "utf8");
      if (bytes > peakStatusBytes) peakStatusBytes = bytes;
      const sample = resourceSnapshot();
      for (const key of Object.keys(peak)) {
        if (typeof sample[key] === "number" && sample[key] > peak[key]) peak[key] = sample[key];
      }
      polls += 1;
    }
    elapsedMs = Date.now() - startedAt;
    const result = await runner.result({ runId, invocationLimit: options.invocationLimit });
    const defaultStatusBytes = Buffer.byteLength(JSON.stringify(await runner.status({ runId })), "utf8");
    paged = await collectInvocations(runner, runId, options.invocationLimit, deadlineAt);
    disk = {
      companion: measureTree(companionDir),
      dynamic: measureTree(dynamicDir),
      total: { bytes: 0, files: 0 },
    };
    disk.total = { bytes: disk.companion.bytes + disk.dynamic.bytes, files: disk.companion.files + disk.dynamic.files };
    const failures = [];
    const output = result.output ?? null;
    if (stats.observed !== options.calls) failures.push(`adapter observed ${stats.observed} of ${options.calls} calls`);
    if (stats.indices.size !== options.calls) failures.push(`adapter saw ${stats.indices.size} distinct call indices`);
    if (stats.maxInflight > options.concurrency) failures.push(`max in-flight ${stats.maxInflight} exceeded concurrency ${options.concurrency}`);
    if (stats.errors.length) failures.push(`adapter errors: ${stats.errors.slice(0, 3).join("; ")}`);
    if (lastStatus.state !== "completed") failures.push(`run settled ${lastStatus.state}`);
    if ((lastStatus.invocationsTotal ?? 0) !== options.calls) failures.push(`status reports ${lastStatus.invocationsTotal} invocations`);
    if (paged.invocations.length !== options.calls) failures.push(`pagination returned ${paged.invocations.length} invocations`);
    if (!paged.pages.every((page) => page.count <= options.invocationLimit)) failures.push("a status page exceeded invocationLimit");
    if (!output || output.calls !== options.calls || output.observed !== options.calls || output.completed !== options.calls) {
      failures.push(`final output incomplete: ${JSON.stringify(output)}`);
    } else if (output.sum !== expectedSum) {
      failures.push(`final sum ${output.sum} != ${expectedSum}`);
    }
    if (elapsedMs > options.deadlineMs) failures.push(`elapsed ${elapsedMs}ms exceeded the ${options.deadlineMs}ms deadline`);
    if (peak.childProcesses > 0) failures.push(`probe spawned ${peak.childProcesses} child process(es)`);
    if (defaultStatusBytes > 5_000_000) failures.push(`default status serialized ${defaultStatusBytes} bytes`);
    if (paged.pages.some((page) => page.bytes > 5_000_000)) failures.push("a paginated status page serialized over 5 MB");

    const report = {
      passed: failures.length === 0,
      failures,
      calls: options.calls,
      concurrency: options.concurrency,
      deadlineMs: options.deadlineMs,
      pollMs: options.pollMs,
      invocationLimit: options.invocationLimit,
      elapsedMs,
      polls,
      state: lastStatus.state,
      statusError: lastStatus.error ?? null,
      invocationsSeen: paged.invocations.length,
      invocationsTotal: lastStatus.invocationsTotal ?? null,
      throughputPerSecond: elapsedMs > 0 ? Number((stats.observed / (elapsedMs / 1000)).toFixed(2)) : 0,
      runRecordBytes: disk.dynamic.largestFileBytes,
      deadlineExceeded: false,
      observed: stats.observed,
      distinctIndices: stats.indices.size,
      maxInflight: stats.maxInflight,
      finalOutput: output,
      peakMemory: {
        rssBytes: peak.rssBytes,
        heapUsedBytes: peak.heapUsedBytes,
        heapTotalBytes: peak.heapTotalBytes,
        externalBytes: peak.externalBytes,
        arrayBuffersBytes: peak.arrayBuffersBytes,
      },
      peakHandles: {
        activeHandles: peak.activeHandles,
        timers: peak.timers,
        immediates: peak.immediates,
        childProcesses: peak.childProcesses,
      },
      statusBytes: {
        default: defaultStatusBytes,
        peakDefault: peakStatusBytes,
        pages: paged.pages.length,
        pageCounts: paged.pages.slice(0, 6).map((page) => page.count),
        pageMax: paged.pages.reduce((max, page) => Math.max(max, page.bytes), 0),
        pageTotal: paged.pages.reduce((total, page) => total + page.bytes, 0),
      },
      diskBytes: disk,
      runnerRoot: options.root,
      fixture,
      measuredAt: new Date().toISOString(),
    };
    writeFileSync(join(fixture, "scale-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return report;
  } catch (error) {
    failure = error?.message ?? String(error);
    if (runId && lastStatus && !TERMINAL.has(lastStatus.state)) {
      await stopIfActive(runner, runId, lastStatus.state).catch(() => undefined);
    }
    if (!elapsedMs) elapsedMs = Date.now() - startedAt;
    if (runId) {
      paged = await collectInvocations(runner, runId, options.invocationLimit, Date.now() + 30_000).catch(() => paged);
    }
    disk = {
      companion: measureTree(companionDir),
      dynamic: measureTree(dynamicDir),
      total: { bytes: 0, files: 0 },
    };
    disk.total = { bytes: disk.companion.bytes + disk.dynamic.bytes, files: disk.companion.files + disk.dynamic.files };
    const report = {
      passed: false,
      failures: [failure],
      calls: options.calls,
      concurrency: options.concurrency,
      deadlineMs: options.deadlineMs,
      elapsedMs,
      polls,
      state: lastStatus?.state ?? "unknown",
      statusError: lastStatus?.error ?? null,
      invocationsSeen: paged.invocations.length,
      invocationsTotal: lastStatus?.invocationsTotal ?? null,
      throughputPerSecond: elapsedMs > 0 ? Number((stats.observed / (elapsedMs / 1000)).toFixed(2)) : 0,
      runRecordBytes: disk.dynamic.largestFileBytes,
      deadlineExceeded: /deadline/i.test(failure ?? ""),
      observed: stats.observed,
      distinctIndices: stats.indices.size,
      maxInflight: stats.maxInflight,
      finalOutput: null,
      peakMemory: {
        rssBytes: peak.rssBytes,
        heapUsedBytes: peak.heapUsedBytes,
        heapTotalBytes: peak.heapTotalBytes,
        externalBytes: peak.externalBytes,
        arrayBuffersBytes: peak.arrayBuffersBytes,
      },
      peakHandles: {
        activeHandles: peak.activeHandles,
        timers: peak.timers,
        immediates: peak.immediates,
        childProcesses: peak.childProcesses,
      },
      statusBytes: {
        default: peakStatusBytes,
        peakDefault: peakStatusBytes,
        pages: paged.pages.length,
        pageCounts: paged.pages.slice(0, 6).map((page) => page.count),
        pageMax: paged.pages.reduce((max, page) => Math.max(max, page.bytes), 0),
        pageTotal: paged.pages.reduce((total, page) => total + page.bytes, 0),
      },
      diskBytes: disk,
      runnerRoot: options.root,
      fixture,
      measuredAt: new Date().toISOString(),
    };
    writeFileSync(join(fixture, "scale-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return report;
  }
}

const USAGE = "usage: node scripts/dynamic-runner-scale.mjs --root <repo> [--calls 1000] [--concurrency 6] [--fixture <dir>] [--deadline-ms 120000] [--poll-ms 250]";

export async function main(argv = process.argv.slice(2), io = {}) {
  const out = io.stdout ?? process.stdout;
  const args = parseArgs(argv);
  if (args.help) {
    out.write(`${USAGE}\n`);
    return 0;
  }
  const report = await runScale(args);
  const summary = {
    passed: report.passed,
    calls: report.calls,
    concurrency: report.concurrency,
    state: report.state,
    statusError: report.statusError ?? null,
    observed: report.observed,
    maxInflight: report.maxInflight,
    elapsedMs: report.elapsedMs,
    peakRssBytes: report.peakMemory.rssBytes,
    peakHeapUsedBytes: report.peakMemory.heapUsedBytes,
    peakActiveHandles: report.peakHandles.activeHandles,
    childProcesses: report.peakHandles.childProcesses,
    statusBytes: report.statusBytes,
    diskTotalBytes: report.diskBytes.total.bytes,
    failures: report.failures,
  };
  out.write(`SCALE_FIXTURE ${report.fixture}\n`);
  out.write(`SCALE_RESULT ${JSON.stringify(summary)}\n`);
  return report.passed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      process.stderr.write(`scale probe failed: ${error?.message ?? String(error)}\n`);
      process.exitCode = 1;
    });
}

