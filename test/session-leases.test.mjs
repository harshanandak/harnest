import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { acquireSessionLease } from "../src/session-lease.mjs";
import { listSessionLeases, reconcileSessionLease } from "../scripts/session-leases.mjs";

test("lease reconciliation refuses a live owner and preserves its lock", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harnest-lease-operator-"));
  const release = await acquireSessionLease(join(root, "native-sessions"), "native");
  t.after(async () => { await release(); await rm(root, { recursive: true, force: true }); });
  const [lease] = await listSessionLeases(root);
  assert.equal(lease.coordinator, "alive");
  await assert.rejects(reconcileSessionLease(root, { id: lease.id, expectedToken: lease.token, nativeStopped: true }), /coordinator is alive/);
  assert.equal((await listSessionLeases(root)).length, 1);
});

test("orphan reconciliation requires exact ownership and explicit native-stop evidence and archives the lock", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harnest-lease-orphan-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const module = new URL("../src/session-lease.mjs", import.meta.url).href;
  execFileSync(process.execPath, ["--input-type=module", "-e", `import { acquireSessionLease } from ${JSON.stringify(module)}; await acquireSessionLease(process.argv[1], 'native'); process.exit(0);`, join(root, "native-sessions")], { timeout: 10000, stdio: "pipe" });
  const [lease] = await listSessionLeases(root);
  assert.equal(lease.coordinator, "dead-native-state-unknown");
  await assert.rejects(reconcileSessionLease(root, { id: lease.id, expectedToken: lease.token }), /native session has stopped/);
  await assert.rejects(reconcileSessionLease(root, { id: lease.id, expectedToken: "0".repeat(36), nativeStopped: true }), /token changed/);
  const result = await reconcileSessionLease(root, { id: lease.id, expectedToken: lease.token, nativeStopped: true });
  assert.equal(result.nativeStopped, "operator-confirmed");
  assert.equal(JSON.parse(await readFile(result.backup, "utf8")).token, lease.token);
  assert.deepEqual(await listSessionLeases(root), []);
  assert.deepEqual(await readdir(join(root, "native-sessions")), ["reconciled"]);
  const release = await acquireSessionLease(join(root, "native-sessions"), "native");
  await release();
});
