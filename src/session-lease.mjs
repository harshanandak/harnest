import { mkdir, open, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";

const conflict = () => Object.assign(new Error("native session is leased by another owner; reconcile or close it before reuse"), { details: { kind: "policy" } });
const readOwner = async (path) => {
  const file = await open(path, "r");
  try {
    if ((await file.stat()).size > 2048) throw conflict();
    return JSON.parse(await file.readFile("utf8"));
  } finally { await file.close(); }
};

export async function acquireSessionLease(directory, key) {
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${createHash("sha256").update(key).digest("hex")}.lock`);
  const token = randomUUID();
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(JSON.stringify({ token, pid: process.pid, host: hostname() }));
    await handle.sync();
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      await handle.close();
      const current = await readOwner(path).catch(() => null);
      if (current?.token === token) await unlink(path);
    };
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
      await unlink(path).catch(() => {});
      throw error;
    }
    // A dead coordinator can leave a live native subprocess. PID death alone
    // cannot authorize a second owner of the same conversation.
    if (error.code === "EEXIST") throw conflict();
    throw error;
  }
}
