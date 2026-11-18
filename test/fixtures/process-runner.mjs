import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { ProcessError, redactSecrets, runProcess } from "../../src/process.mjs";

if (process.argv[2] === "early-close") {
  for (let i = 0; i < 3; i++) {
    try {
      await runProcess(process.execPath, ["-e", "process.exit(0)"], {
        stdinLines: ["x".repeat(80_000)],
        timeoutMs: 5000,
      });
    } catch (error) {
      if (!(error instanceof ProcessError)) throw error;
    }
  }
  console.log("settled all early closes");
} else if (process.argv[2] === "volume") {
  global.gc?.();
  const before = process.memoryUsage().rss;
  const peakBefore = process.resourceUsage().maxRSS * 1024;
  let callbacks = 0;
  let lastLine;
  const output = await runProcess(process.execPath, [fileURLToPath(new URL("./process-child.mjs", import.meta.url)), "volume"], {
    timeoutMs: 10000,
    onStdoutLine(line) { callbacks++; lastLine = line; },
  });
  console.log(JSON.stringify({
    ...output,
    stdout: undefined,
    stderr: undefined,
    callbacks,
    lastLine,
    retainedStdoutBytes: Buffer.byteLength(output.stdout),
    retainedStderrBytes: Buffer.byteLength(output.stderr),
    terminalTail: output.stdout.endsWith(`${lastLine}\n`),
    stderrTail: output.stderr.endsWith("x\n"),
    rssGrowth: process.memoryUsage().rss - before,
    peakGrowth: process.resourceUsage().maxRSS * 1024 - peakBefore,
  }));
} else if (process.argv[2] === "redaction-cost") {
  const sentinel = "synthetic_review_sentinel";
  const input = '"' + '\\"'.repeat(64_000) + ` Authorization: Bearer ${sentinel}`;
  const start = performance.now();
  const redacted = redactSecrets(input);
  assert.equal(redacted.includes(sentinel), false);
  assert.equal(redacted.startsWith('"' + '\\"'.repeat(64_000)), true);
  console.log(JSON.stringify({ bytes: Buffer.byteLength(input), elapsedMs: performance.now() - start }));
} else if (process.argv[2] === "async-reject") {
  await assert.rejects(runProcess(process.execPath, ["-e", "console.log('ready')"], {
    timeoutMs: 3000,
    onStdoutLine: async () => { throw new Error("synthetic_async_callback_failure"); },
  }), (error) => error instanceof ProcessError && /synthetic_async_callback_failure/.test(error.message));
  console.log("handled async callback failure");
} else if (process.argv[2] === "async-after-close") {
  let rejectCallback;
  let closed = false;
  await assert.rejects(runProcess(process.execPath, ["-e", "process.stdout.write('ready')"], {
    timeoutMs: 3000,
    spawnFn(...args) {
      const child = spawn(...args);
      child.once("close", () => {
        closed = true;
        setTimeout(() => rejectCallback(new Error("synthetic_async_callback_failure")), 20);
      });
      return child;
    },
    onStdoutLine: () => new Promise((resolve, reject) => { rejectCallback = reject; }),
  }), (error) => error instanceof ProcessError && /synthetic_async_callback_failure/.test(error.message));
  assert.equal(closed, true);
  console.log("handled callback failure after close");
} else if (process.argv[2] === "async-deadline") {
  let closed = false;
  await assert.rejects(runProcess(process.execPath, ["-e", "process.stdout.write('ready')"], {
    timeoutMs: 300,
    spawnFn(...args) {
      const child = spawn(...args);
      child.once("close", () => { closed = true; });
      return child;
    },
    onStdoutLine: () => new Promise(() => {}),
  }), (error) => error instanceof ProcessError && error.details.timedOut);
  assert.equal(closed, true);
  console.log("deadline settled pending callback after close");
}
