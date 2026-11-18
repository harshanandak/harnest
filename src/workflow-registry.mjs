import { mkdir, readFile, readdir, open, rename, unlink, stat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { homedir, hostname } from "node:os";

const error = (kind, message) => Object.assign(new Error(message), { details: { kind } });
const digest = (source) => createHash("sha256").update(source).digest("hex");
const namePattern = /^[a-z][a-z0-9-]{0,63}$/;
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

async function readBounded(path, limit) {
  const handle = await open(path, "r");
  try {
    const size = (await handle.stat()).size;
    if (size > limit) throw error("output-limit", "saved workflow exceeds its byte limit");
    const buffer = Buffer.alloc(size + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (!chunk.bytesRead) break;
      bytesRead += chunk.bytesRead;
    }
    if (bytesRead > limit || bytesRead > size) throw error("persistence", "saved workflow changed during read");
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally { await handle.close(); }
}

async function atomic(path, text) {
  const temp = `${path}.${randomUUID()}.tmp`;
  const file = await open(temp, "wx", 0o600);
  try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
  try {
    for (let attempt = 0; ; attempt++) {
      try { await rename(temp, path); break; }
      catch (cause) {
        if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(cause.code) || attempt >= 10) throw cause;
        await pause(20 * (attempt + 1));
      }
    }
  } finally { await unlink(temp).catch(() => {}); }
}

async function locked(path, work) {
  const token = randomUUID();
  let handle;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      handle = await open(path, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ token, pid: process.pid, host: hostname() }));
      break;
    } catch (cause) {
      if (handle) { await handle.close(); await unlink(path).catch(() => {}); throw cause; }
      if (cause.code !== "EEXIST") throw cause;
      // Never steal an ambiguous lock. An exited local owner can be recovered.
      const owner = await readFile(path, "utf8").then(JSON.parse).catch(() => null);
      if (owner?.host === hostname() && Number.isInteger(owner.pid)) {
        try { process.kill(owner.pid, 0); }
        catch (failure) {
          if (failure.code === "ESRCH") {
            const recovery = await open(`${path}.recovery`, "wx", 0o600).catch(() => null);
            if (recovery) {
              try {
                const latest = await readFile(path, "utf8").then(JSON.parse).catch(() => null);
                if (latest?.token === owner.token) await unlink(path).catch(() => {});
              } finally { await recovery.close(); await unlink(`${path}.recovery`).catch(() => {}); }
            }
          }
        }
      }
      await pause(25);
    }
  }
  if (!handle) throw error("persistence", "saved workflow is locked; retry after its owner finishes");
  try { return await work(); }
  finally {
    await handle.close();
    const owner = await readFile(path, "utf8").then(JSON.parse).catch(() => null);
    if (owner?.token === token) await unlink(path);
  }
}

export class WorkflowRegistry {
  constructor({ userDir = join(homedir(), ".harnest", "workflows"), validateScript } = {}) {
    this.userDir = resolve(userDir);
    this.validateScript = validateScript;
  }

  directory(scope, cwd) {
    if (scope === "user") return this.userDir;
    if (scope !== "project" || !cwd) throw error("validation", "project scope requires cwd");
    return join(resolve(cwd), ".harnest", "workflows");
  }

  key(name) {
    if (typeof name !== "string" || !namePattern.test(name)) throw error("validation", "workflow name must be lowercase letters, digits or hyphens, starting with a letter (maximum 64 characters)");
    return digest(name);
  }

  async validate(source) {
    if (typeof source !== "string" || Buffer.byteLength(source) > 1_000_000) throw error("validation", "workflow source must be a string of at most 1 MB");
    const validate = this.validateScript ?? (await import("./dynamic-engine.mjs")).validateScript;
    return validate(source);
  }

  async record(directory, name) {
    try {
      const record = JSON.parse(await readBounded(join(directory, `${this.key(name)}.json`), 16_384));
      if (record.name !== name || !/^[a-f0-9]{64}$/.test(record.revision)) throw error("persistence", "invalid saved workflow record");
      return record;
    } catch (cause) {
      if (cause.code === "ENOENT") return null;
      throw cause;
    }
  }

  async save({ name, source, cwd, scope = cwd ? "project" : "user", expectedRevision } = {}) {
    const key = this.key(name);
    const { meta } = await this.validate(source);
    if (meta?.name && meta.name !== name) throw error("validation", "saved name must match script metadata");
    const directory = this.directory(scope, cwd);
    await mkdir(directory, { recursive: true });
    return locked(join(directory, `${key}.lock`), async () => {
      const old = await this.record(directory, name);
      const revision = digest(source);
      if (old && !old.deleted && old.revision === revision) return { ...old, scope };
      if (old && (!old.deleted || expectedRevision != null) && expectedRevision !== old.revision) throw error("conflict", "replacing a workflow requires its current expectedRevision");
      if (!old && expectedRevision != null) throw error("conflict", "saved workflow does not exist at the expected revision");
      const record = { name, revision, description: String(meta?.description ?? "").slice(0, 2000), createdAt: old?.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString(), deleted: false };
      await atomic(join(directory, `${key}.${revision}.js`), source);
      await atomic(join(directory, `${key}.json`), JSON.stringify(record));
      return { ...record, scope };
    });
  }

  async delete({ name, cwd, scope = cwd ? "project" : "user", expectedRevision } = {}) {
    const directory = this.directory(scope, cwd);
    const key = this.key(name);
    await mkdir(directory, { recursive: true });
    return locked(join(directory, `${key}.lock`), async () => {
      const old = await this.record(directory, name);
      if (!old) throw error("not-found", "saved workflow was not found");
      if (expectedRevision !== old.revision) throw error("conflict", "deleting a workflow requires its current expectedRevision");
      const record = { ...old, deleted: true, updatedAt: new Date().toISOString() };
      await atomic(join(directory, `${key}.json`), JSON.stringify(record));
      return { ...record, scope };
    });
  }

  async get({ name, cwd, scope, revision } = {}) {
    this.key(name);
    if (revision !== undefined && !/^[a-f0-9]{64}$/.test(revision)) throw error("validation", "invalid workflow revision");
    const scopes = scope ? [scope] : cwd ? ["project", "user"] : ["user"];
    for (const selected of scopes) {
      const directory = this.directory(selected, cwd);
      const record = await this.record(directory, name);
      if (!record || (record.deleted && !revision)) continue;
      const selectedRevision = revision ?? record.revision;
      let source;
      try { source = await readBounded(join(directory, `${this.key(name)}.${selectedRevision}.js`), 1_000_000); }
      catch (cause) { if (cause.code === "ENOENT" && revision) continue; if (cause.code === "ENOENT") throw error("persistence", "saved workflow source is missing"); throw cause; }
      if (digest(source) !== selectedRevision) throw error("persistence", "saved workflow source digest mismatch");
      const { meta } = await this.validate(source);
      return { ...record, description: String(meta?.description ?? "").slice(0, 2000), scope: selected, revision: selectedRevision, source };
    }
    throw error("not-found", `saved workflow ${name} was not found`);
  }

  async list({ cwd, scope, limit = 50, cursor } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw error("validation", "limit must be between 1 and 100");
    if (cursor !== undefined) this.key(cursor);
    const scopes = scope ? [scope] : cwd ? ["project", "user"] : ["user"];
    const records = new Map();
    const errors = [];
    for (const selected of scopes) {
      const directory = this.directory(selected, cwd);
      const files = await readdir(directory).catch((cause) => { if (cause.code === "ENOENT") return []; throw cause; });
      for (const file of files) {
        if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
        try {
          const row = JSON.parse(await readBounded(join(directory, file), 16_384));
          if (file !== `${this.key(row.name)}.json` || !/^[a-f0-9]{64}$/.test(row.revision)) throw error("persistence", "invalid saved workflow index");
          if (!row.deleted && !records.has(row.name)) records.set(row.name, { ...row, scope: selected });
        } catch {
          if (errors.length < 100) errors.push({ scope: selected, index: file, kind: "persistence" });
        }
      }
    }
    const rows = [...records.values()].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0).filter((row) => !cursor || row.name > cursor);
    return { workflows: rows.slice(0, limit), nextCursor: rows.length > limit ? rows[limit - 1].name : null, errors };
  }

  async revisions({ name, cwd, scope = cwd ? "project" : "user", limit = 50, cursor } = {}) {
    const key = this.key(name);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (cursor !== undefined && !/^[a-f0-9]{64}$/.test(cursor))) throw error("validation", "invalid revision page");
    const directory = this.directory(scope, cwd);
    const record = await this.record(directory, name);
    if (!record) throw error("not-found", "saved workflow was not found");
    const names = (await readdir(directory)).filter((file) => file.startsWith(`${key}.`) && /^[a-f0-9]{64}\.[a-f0-9]{64}\.js$/.test(file)).map((file) => file.slice(65, 129)).sort().filter((revision) => !cursor || revision > cursor);
    const revisions = await Promise.all(names.slice(0, limit).map(async (revision) => {
      const file = await stat(join(directory, `${key}.${revision}.js`));
      return { revision, bytes: file.size, savedAt: file.mtime.toISOString(), current: record.revision === revision };
    }));
    return { name, scope, deleted: record.deleted, revisions, nextCursor: names.length > limit ? names[limit - 1] : null };
  }
}
