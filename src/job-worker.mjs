#!/usr/bin/env node
// Detached background executor: claims one queued job and runs it with the
// same semantics as an in-process Companion run (fenced lease claim,
// heartbeat, attempts, fallback, terminal receipt). Companion#spawnWorker
// launches it as `node src/job-worker.mjs <stateDir> <jobId>`; nothing about
// the spawning process needs to stay alive. Exits 0 once the job is terminal
// or another worker owns it; an unexpected failure is recorded with
// Companion#failQueued before exiting 1, so the job does not wait out its
// lease to become reclaimable.
import { pathToFileURL } from "node:url";
import { Companion } from "./companion.mjs";
import { boundedProviderText } from "./process.mjs";

const USAGE = "usage: node src/job-worker.mjs <stateDir> <jobId>";

// Test seam: HARNEST_WORKER_ADAPTER points at a module exporting
// adapterFactory (or a plain run function) that replaces real harnesses.
export function workerAdapterFactory(module) {
  const factory = module?.adapterFactory ?? module?.default?.adapterFactory;
  if (typeof factory === "function") return factory;
  const run = module?.run ?? module?.default?.run;
  if (typeof run === "function") return () => ({ run });
  throw Object.assign(new TypeError("worker adapter module must export adapterFactory or run"), {
    details: { kind: "validation" },
  });
}

export async function runWorker(argv = process.argv.slice(2), env = process.env) {
  const [stateDir, jobId] = argv;
  if (!stateDir || !jobId) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const options = { stateDir, detachBackground: false };
  const adapterPath = env.HARNEST_WORKER_ADAPTER;
  if (adapterPath) {
    const url = adapterPath.startsWith("file:") ? adapterPath : pathToFileURL(adapterPath).href;
    options.adapterFactory = workerAdapterFactory(await import(url));
  }
  const companion = new Companion(options);
  let receipt;
  try {
    receipt = await companion.runQueued(jobId);
  } catch (error) {
    // Another worker claimed the job between the queued check and the fenced
    // claim. That is a no-op for this worker, not a failure.
    if (error?.details?.kind === "claim-conflict") {
      process.stdout.write(`JOB_WORKER_SKIP jobId=${jobId} reason=claimed\n`);
      return 0;
    }
    // Unexpected failure outside the adapter path: terminalize the job
    // durably before exiting 1 so it does not sit running until its lease
    // goes stale. Best effort: recording must never mask the original error.
    let recorded = "unrecorded";
    try {
      recorded = (await companion.failQueued(jobId, error))?.state || "unrecorded";
    } catch (recordingError) {
      process.stderr.write(`harnest: could not record failure for job ${jobId}: ${boundedProviderText(recordingError?.message || String(recordingError))}\n`);
    }
    process.stderr.write(`JOB_WORKER_FAILED jobId=${jobId} recorded=${recorded}\n`);
    throw error;
  } finally {
    const cleanup = await companion.close();
    if (cleanup.cleanupFailures.length) process.stderr.write(`JOB_WORKER_CLEANUP_UNCERTAIN jobId=${jobId} count=${cleanup.cleanupFailures.length}\n`);
  }
  process.stdout.write(`JOB_WORKER_OK jobId=${jobId} state=${receipt.state}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runWorker()
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      process.stderr.write(`harnest job worker failed: ${boundedProviderText(error?.message || String(error))}\n`);
      process.exitCode = 1;
    });
}
