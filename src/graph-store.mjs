import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import { graphError } from "./graph-protocol.mjs";
import { stableJson } from "./protocol.mjs";

export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function dead(owner) {
  if (owner?.host !== hostname() || !Number.isInteger(owner?.pid)) return false;
  try { process.kill(owner.pid, 0); return false; } catch (error) { return error.code === "ESRCH"; }
}

export class GraphStore {
  #platform;

  constructor(root, { rename: renameFile = rename, platform = process.platform } = {}) {
    if (typeof renameFile !== "function") throw graphError("validation", "graph store rename must be a function");
    this.root = root;
    this.specs = new Map();
    this.rename = renameFile;
    this.#platform = platform;
  }
  #transient(error) {
    return this.#platform === "win32" && ["EPERM", "EACCES", "EBUSY"].includes(error?.code);
  }
  async #retry(work) {
    for (let n = 0; ; n++) {
      try { return await work(); } catch (error) {
        // Windows can hold EPERM/EACCES/EBUSY past a second of contention (AV
        // scans, concurrent readers); budget ~12s of backed-off retries so a
        // transient rename cannot orphan a whole graph.
        if (!this.#transient(error) || n >= 30) throw error;
        await wait(Math.min(10 * 2 ** n, 500));
      }
    }
  }
  path(id) {
    if (typeof id !== "string" || !/^graph-[a-f0-9]{64}$/.test(id)) throw graphError("not-found", "invalid graphId");
    return join(this.root, `${id}.json`);
  }
  async read(id) {
    try {
      const record = JSON.parse(await this.#retry(() => readFile(this.path(id), "utf8")));
      if (!record.spec) {
        let spec = this.specs.get(record.digest);
        if (!spec) {
          const stored = JSON.parse(await this.#retry(() => readFile(`${this.path(id)}.spec`, "utf8")).catch(() => { throw graphError("persistence", "graph specification is missing or unreadable"); }));
          if (stored.digest !== record.digest) throw graphError("persistence", "graph specification digest reference mismatch");
          spec = stored.spec;
          if (this.specs.size >= 32) this.specs.delete(this.specs.keys().next().value);
          this.specs.set(record.digest, spec);
        }
        record.spec = spec;
      }
      if (record.lease) {
        // The .lease sidecar is an optional freshness hint, but an unreadable
        // hint must not be mistaken for an absent one: status would then see
        // only the stale snapshot heartbeat and could falsely fence a live
        // owner. Absent and torn-parse cases degrade to "no hint" (the next
        // successful write repairs them); transient I/O failures fail the
        // read closed so no expiry decision is made from an unknown state.
        const lease = await this.#retry(() => readFile(`${this.path(id)}.lease`, "utf8")).then(JSON.parse).catch((error) => {
          if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
          throw graphError("persistence", `graph lease sidecar is unreadable: ${error?.code ?? error?.message ?? error}`);
        });
        if (lease?.ownerId === record.lease.ownerId && lease.fence === record.lease.fence) record.lease.heartbeatAt = Math.max(record.lease.heartbeatAt, lease.heartbeatAt);
      }
      return record;
    }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }
  async #write(path, value) {
    const temp = `${path}.${randomUUID()}.tmp`;
    const handle = await this.#retry(() => open(temp, "wx", 0o600));
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
    try { await this.#retry(() => this.rename(temp, path)); } finally { await unlink(temp).catch(() => {}); }
  }
  async transact(id, work) {
    await this.#retry(() => mkdir(this.root, { recursive: true }));
    const lock = `${this.path(id)}.lock`;
    let handle;
    const token = randomUUID();
    for (let n = 0; n < 1000; n++) {
      try {
        handle = await open(lock, "wx", 0o600);
        await handle.writeFile(JSON.stringify({ token, pid: process.pid, host: hostname() }));
        break;
      } catch (error) {
        if (error.code !== "EEXIST" && !this.#transient(error)) throw error;
        // Never steal a live process's mutation lock, even if its graph lease
        // expired. A paused executor must finish its fenced dispatch first.
        let recovery;
        try {
          recovery = await open(`${lock}.recovery`, "wx", 0o600);
          const owner = await readFile(lock, "utf8").then(JSON.parse).catch(() => null);
          const info = owner ? null : await stat(lock).catch(() => null);
          if (dead(owner) || (!owner && info && Date.now() - info.mtimeMs > 120_000)) await unlink(lock).catch(() => {});
        } catch (error) { if (error.code !== "EEXIST" && !this.#transient(error)) throw error; }
        finally { if (recovery) { await recovery.close(); await unlink(`${lock}.recovery`).catch(() => {}); } }
        await wait(10);
      }
    }
    if (!handle) throw graphError("persistence", "timed out acquiring graph mutation lock");
    try {
      let value = await this.read(id);
      const semantic = (record) => record ? stableJson({ ...record, spec: undefined, revision: undefined, updatedAt: undefined, lease: record.lease ? { ...record.lease, heartbeatAt: undefined } : null }) : null;
      let previous = semantic(value), revision = value?.revision ?? 0, heartbeatAt = value?.lease?.heartbeatAt ?? 0;
      const save = async (next) => {
        const current = semantic(next);
        const snapshotWritten = current !== previous;
        if (snapshotWritten) {
          if (revision >= Number.MAX_SAFE_INTEGER) throw graphError("persistence", "graph revision exhausted");
          next.revision = ++revision;
          // Immutable input/routes live separately: progress updates never
          // rewrite root prompts and shared context. The snapshot is committed
          // last, so an orphan spec after a crash cannot authorize dispatch.
          if (!value) await this.#write(`${this.path(id)}.spec`, { digest: next.digest, spec: next.spec });
          await this.#write(this.path(id), { ...next, spec: undefined }); previous = current;
        } else next.revision = revision;
        if (next.lease && next.lease.heartbeatAt - heartbeatAt >= Math.min(1000, next.lease.timeoutMs / 3)) {
          try {
            await this.#write(`${this.path(id)}.lease`, next.lease);
          } catch {
            // .lease is only a cross-process freshness hint. When its write
            // fails, persist the authoritative snapshot so fencing sees the
            // current heartbeat. The in-memory heartbeat must not be trusted
            // as persisted: a just-written snapshot (snapshotWritten) already
            // carries next.lease, but a heartbeat-only save does not.
            if (!snapshotWritten) await this.#write(this.path(id), { ...next, spec: undefined });
          }
          heartbeatAt = next.lease.heartbeatAt;
        }
        value = next;
      };
      return await work(value, save);
    } finally {
      await handle.close();
      const owner = await readFile(lock, "utf8").then(JSON.parse).catch(() => null);
      if (owner?.token === token) await this.#retry(() => unlink(lock));
    }
  }
}
