#!/usr/bin/env node
// Detached dynamic workflow worker: claims one durable run and owns its
// interpreter and child handoffs. Launched by DynamicWorkflowRunner#spawnWorker
// as `node src/dynamic-worker.mjs <dynamicStateDir> <runId> [harnestStateDir]`.
// The spawning process does not need to stay alive: this worker holds its own
// lease and heartbeat, observes cross-process controls, and settles the run.
//
// Test seams (never used in production):
//   HARNEST_WORKER_ADAPTER     module exporting adapterFactory or run
//                                      (same contract as src/job-worker.mjs)
//   HARNEST_DYNAMIC_ENGINE     module exporting an engine with
//                                      validateScript/runScript, or a default
//   HARNEST_ROUTE_RESOLVER     module exporting a routeResolver
//                                      function, or a default
import { pathToFileURL } from "node:url";
import { Companion } from "./companion.mjs";
import { DynamicWorkflowRunner } from "./dynamic-runner.mjs";
import { workerAdapterFactory } from "./job-worker.mjs";
import { boundedProviderText } from "./process.mjs";

const USAGE = "usage: node src/dynamic-worker.mjs <dynamicStateDir> <runId> [harnestStateDir]";

async function importModule(path) {
  const url = path.startsWith("file:") ? path : pathToFileURL(path).href;
  return import(url);
}

export function dynamicEngineFrom(module) {
  const engine = module?.engine ?? module?.default?.engine ?? module?.default ?? module;
  if (typeof engine?.validateScript !== "function" || typeof engine?.runScript !== "function") {
    throw Object.assign(new TypeError("dynamic engine module must export validateScript and runScript"), { details: { kind: "validation" } });
  }
  return engine;
}

export async function runWorker(argv = process.argv.slice(2), env = process.env) {
  const [stateDir, runId, companionStateDir] = argv;
  if (!stateDir || !runId) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const options = { detachBackground: false };
  if (companionStateDir) options.stateDir = companionStateDir;
  const adapterPath = env.HARNEST_WORKER_ADAPTER;
  if (adapterPath) options.adapterFactory = workerAdapterFactory(await importModule(adapterPath));
  const resolverPath = env.HARNEST_ROUTE_RESOLVER;
  if (resolverPath) {
    const resolverModule = await importModule(resolverPath);
    const resolver = resolverModule?.routeResolver ?? resolverModule?.default?.routeResolver ?? resolverModule?.default;
    if (typeof resolver !== "function") {
      throw Object.assign(new TypeError("route resolver module must export routeResolver"), { details: { kind: "validation" } });
    }
    options.routeResolver = resolver;
  }
  const companion = new Companion(options);
  // Own shutdown only: release this worker's Companion resources (aborting
  // runs it owns) on completion or a termination signal. Never touches the
  // host process or unrelated agents.
  const closeCompanion = async () => {
    if (typeof companion.close !== "function") return;
    try { await companion.close(); } catch { /* best-effort cleanup */ }
  };
  let shuttingDown = false;
  const shutdown = (code) => {
    if (shuttingDown) return;
    shuttingDown = true;
    void (async () => {
      await closeCompanion();
      process.exit(code);
    })();
  };
  const onSigint = () => shutdown(130);
  const onSigterm = () => shutdown(143);
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  const runnerOptions = {
    companion,
    stateDir,
    detachBackground: false,
    pollIntervalMs: Number(env.HARNEST_DYNAMIC_POLL_MS) || 50,
    heartbeatIntervalMs: Number(env.HARNEST_DYNAMIC_HEARTBEAT_MS) || 1000,
    leaseTimeoutMs: Number(env.HARNEST_DYNAMIC_LEASE_MS) || 30_000,
  };
  const enginePath = env.HARNEST_DYNAMIC_ENGINE;
  if (enginePath) runnerOptions.engine = dynamicEngineFrom(await importModule(enginePath));
  const runner = new DynamicWorkflowRunner(runnerOptions);

  try {
    const status = await runner.execute(runId);
    process.stdout.write(`DYNAMIC_WORKER_OK runId=${runId} state=${status.state}\n`);
    return 0;
  } catch (error) {
    if (error?.details?.kind === "claim-conflict") {
      process.stdout.write(`DYNAMIC_WORKER_SKIP runId=${runId} reason=claimed\n`);
      return 0;
    }
    process.stderr.write(`DYNAMIC_WORKER_FAILED runId=${runId} error=${boundedProviderText(error?.message || String(error))}\n`);
    return 1;
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    await closeCompanion();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runWorker()
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      process.stderr.write(`harnest dynamic worker failed: ${boundedProviderText(error?.message || String(error))}\n`);
      process.exitCode = 1;
    });
}
