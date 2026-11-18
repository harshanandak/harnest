import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRuntimeInfo } from "../src/runtime-info.mjs";

test("a loaded runtime reports source drift until it is restarted", async () => {
  const root = await mkdtemp(join(tmpdir(), "harnest-runtime-"));
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "package.json"), "{}");
    await writeFile(join(root, "src", "server.mjs"), "export const targets = ['pi'];");
    const loaded = createRuntimeInfo(root);
    const before = loaded();
    assert.equal(before.sourceStatus, "current");
    await writeFile(join(root, "src", "server.mjs"), "export const targets = ['pi', 'codex'];");
    const after = loaded();
    assert.equal(after.sourceStatus, "stale");
    assert.equal(after.loadedFingerprint, before.loadedFingerprint);
    assert.notEqual(after.diskFingerprint, before.loadedFingerprint);
    assert.match(after.hint, /Reconnect/);
    const restarted = createRuntimeInfo(root)();
    assert.equal(restarted.sourceStatus, "current");
    assert.equal(restarted.loadedFingerprint, after.diskFingerprint);
    assert.deepEqual(restarted.targets, ["opencode", "pi", "cursor", "claude", "codex", "gemini", "amp", "acp"]);
    await rm(join(root, "src"), { recursive: true });
    assert.equal(loaded().sourceStatus, "unknown");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
