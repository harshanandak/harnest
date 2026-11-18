import { digestContext } from "./protocol.mjs";
import { acquireSessionLease } from "./session-lease.mjs";

const keyFor = (target, sessionId) => JSON.stringify([target, sessionId]);
const identity = (request) => digestContext({ cwd: request.cwd, policy: request.policy, route: request.route });
const failure = (message) => Object.assign(new Error(message), { details: { kind: "policy" } });

export class SessionAdapterPool {
  constructor({ limit = 6, idleMs = 60_000, closeMs = 5000, lockDir } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(closeMs) || closeMs < 1) throw failure("invalid session pool limits");
    this.limit = limit;
    this.idleMs = idleMs;
    this.closeMs = closeMs;
    this.lockDir = lockDir;
    this.entries = new Map();
    this.owned = new Set();
    this.admission = Promise.resolve();
  }

  acquire(request, create) {
    const operation = this.admission.then(() => this.admit(request, create));
    this.admission = operation.catch(() => {});
    return operation;
  }

  async admit(request, create) {
    if (this.closed) throw failure("session pool is closed");
    const sessionId = request.execution?.sessionId;
    const key = sessionId ? keyFor(request.target, sessionId) : null;
    let entry = key && this.entries.get(key);
    if (entry?.busy) throw failure("native session already has an active owner; steer its existing job");
    const fingerprint = identity(request);
    if (entry && entry.fingerprint !== fingerprint) throw failure("live session cwd, policy or route changed; close it before explicit native resume");
    if (!entry) {
      if (this.owned.size >= this.limit) {
        const idle = [...this.owned].find((item) => !item.busy);
        if (!idle) throw failure("session pool capacity reached; wait for an active owner to finish");
        await this.remove(idle);
      }
      if (this.closed) throw failure("session pool is closed");
      const unlock = key && this.lockDir ? await acquireSessionLease(this.lockDir, key) : null;
      try { entry = { adapter: create(), fingerprint, key, busy: false, timer: null, unlock }; }
      catch (error) { await unlock?.(); throw error; }
      this.owned.add(entry);
    }
    clearTimeout(entry.timer);
    entry.busy = true;
    if (key) this.entries.set(key, entry);
    let releasePromise;
    const bindEntry = async (nativeId) => {
      if (this.closed || entry.closing) throw failure("session pool is closed");
      if (typeof nativeId !== "string" || !nativeId.trim() || nativeId.length > 1000) throw failure("invalid native session identity");
      const next = keyFor(request.target, nativeId);
      if (entry.key === next) return;
      if (entry.key) throw failure("native session identity changed during its owned turn");
      if (this.entries.has(next)) throw failure("native session already has an active owner; steer its existing job");
      if (this.lockDir) entry.unlock = await acquireSessionLease(this.lockDir, next);
      entry.key = next;
      this.entries.set(next, entry);
    };
    return {
      adapter: entry.adapter,
      bind: (nativeId) => {
        if (releasePromise) return Promise.reject(failure("native turn was already released"));
        const binding = this.admission.then(() => bindEntry(nativeId));
        this.admission = binding.catch(() => {});
        return binding;
      },
      release: (output) => {
        if (releasePromise) return releasePromise;
        releasePromise = this.admission.then(async () => {
          if (entry.closing) return entry.closing;
          if (this.closed || !output?.sessionId) { await this.remove(entry); return; }
          try { await bindEntry(output.sessionId); }
          catch (error) { await this.remove(entry); throw error; }
          entry.busy = false;
          entry.timer = setTimeout(() => { void this.remove(entry).catch(() => {}); }, this.idleMs);
          entry.timer.unref?.();
        });
        this.admission = releasePromise.catch(() => {});
        return releasePromise;
      },
    };
  }

  async remove(entry) {
    if (entry.closing) return entry.closing;
    clearTimeout(entry.timer);
    entry.busy = true;
    entry.closing = (async () => {
      let timer;
      try {
        await Promise.race([
          Promise.resolve().then(() => entry.adapter.close?.()),
          new Promise((_, reject) => { timer = setTimeout(() => reject(failure("native session cleanup was not acknowledged")), this.closeMs); }),
        ]);
        if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
        await entry.unlock?.();
        this.owned.delete(entry);
      } finally { clearTimeout(timer); }
    })();
    return entry.closing;
  }

  async close() {
    this.closed = true;
    await this.admission;
    return Promise.allSettled([...this.owned].map((entry) => this.remove(entry)));
  }
}
