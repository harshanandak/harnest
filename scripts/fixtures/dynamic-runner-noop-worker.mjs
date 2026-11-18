// Fixture worker that exits without claiming the run. Used by
// test/dynamic-worker.test.mjs to prove the bounded queued-redispatch path.
process.stdout.write("DYNAMIC_WORKER_SKIP reason=noop\n");
process.exitCode = 0;
