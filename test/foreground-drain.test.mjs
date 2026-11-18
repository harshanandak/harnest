// A foreground handoff must settle even when the host process has no other
// live handles (bare node script): the terminal trace event flush cannot
// depend solely on the unref'd batch timer, or the loop drains first.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const execFileAsync = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("foreground handoff settles with a drained event loop", async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    [join(root, "test", "fixtures", "foreground-drain.mjs")],
    { timeout: 30000, windowsHide: true },
  );
  assert.match(stdout, /SETTLED completed/);
});
