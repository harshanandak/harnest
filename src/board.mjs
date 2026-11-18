// Shared message board: durable subagent-to-subagent talk without job IDs.
// Any worker posts to a topic; any worker reads from it. Topics are plain
// strings (a requestId, a feature name, a lane name) agreed out of band —
// typically the parent hands every spawned worker the same topic, or workers
// discover topics by naming convention. Reads are sequence-addressable pages,
// same shape as trace reads, so the same poll loop applies.
//
// This is deliberately NOT routed through handoffs: steering (handoff_message)
// talks to a downstream RUN; the board talks to PEERS. No delivery
// guarantees beyond durable append + monotonic per-topic sequences; slow
// readers re-read from their last nextSequence.
import { appendFile, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const BOARD_TOPIC_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
export const BOARD_FROM_MAX = 120;
export const BOARD_MESSAGE_MAX_BYTES = 50_000;
export const BOARD_READ_MAX_LIMIT = 200;

function defaultBoardDir() {
  if (process.env.HARNEST_STATE_DIR) return join(process.env.HARNEST_STATE_DIR, "boards");
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA || tmpdir(), "harnest", "boards");
  }
  return join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "harnest", "boards");
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function checkTopic(topic) {
  if (typeof topic !== "string" || !BOARD_TOPIC_PATTERN.test(topic)) {
    throw Object.assign(new TypeError("topic must be 1-64 chars of letters, numbers, dot, underscore, or hyphen"), {
      details: { kind: "validation" },
    });
  }
  return topic;
}

export class BoardStore {
  constructor(root = defaultBoardDir()) {
    this.root = root;
  }

  path(topic) {
    checkTopic(topic);
    return join(this.root, `${topic}.board.jsonl`);
  }

  async #withLock(lockPath, work) {
    await mkdir(dirname(lockPath), { recursive: true });
    let handle;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        handle = await open(lockPath, "wx", 0o600);
        break;
      } catch (error) {
        const exists = error?.code === "EEXIST";
        const transient = process.platform === "win32" && ["EPERM", "EACCES", "EBUSY"].includes(error?.code);
        if (!exists && !transient) throw error;
        if (exists) {
          const info = await stat(lockPath).catch(() => null);
          if (info && Date.now() - info.mtimeMs > 120_000) {
            await unlink(lockPath).catch(() => undefined);
            continue;
          }
        }
        await wait(10);
      }
    }
    if (!handle) {
      throw Object.assign(new Error(`timed out acquiring board lock: ${lockPath}`), {
        details: { kind: "persistence", hint: "another writer holds the topic lock; retry the post" },
      });
    }
    try {
      return await work();
    } finally {
      await handle.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
    }
  }

  async post({ topic, from, message }) {
    checkTopic(topic);
    if (typeof from !== "string" || !from.trim() || from.trim().length > BOARD_FROM_MAX) {
      throw Object.assign(new TypeError(`from must be 1-${BOARD_FROM_MAX} chars naming the sender`), {
        details: { kind: "validation" },
      });
    }
    if (typeof message !== "string" || !message.trim()) {
      throw Object.assign(new TypeError("message is required"), { details: { kind: "validation" } });
    }
    if (Buffer.byteLength(message, "utf8") > BOARD_MESSAGE_MAX_BYTES) {
      throw Object.assign(new TypeError(`message exceeds ${BOARD_MESSAGE_MAX_BYTES} bytes; split it across posts`), {
        details: { kind: "validation" },
      });
    }
    const path = this.path(topic);
    return this.#withLock(`${path}.lock`, async () => {
      // Re-scan under lock so concurrent writers get unique monotonic sequences.
      let sequence = 0;
      try {
        const raw = await readFile(path, "utf8");
        for (const line of raw.split(/\r?\n/)) {
          if (!line.trim()) continue;
          try {
            sequence = Math.max(sequence, Number(JSON.parse(line).sequence) || 0);
          } catch { /* skip corrupt lines, keep the max valid checkpoint */ }
        }
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      const entry = {
        entryId: randomUUID(),
        sequence: sequence + 1,
        at: new Date().toISOString(),
        topic,
        from: from.trim(),
        message,
      };
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
      return entry;
    });
  }

  async read({ topic, afterSequence = null, limit = 50 } = {}) {
    checkTopic(topic);
    if (afterSequence !== null && afterSequence !== undefined
      && (!Number.isInteger(afterSequence) || afterSequence < 0)) {
      throw Object.assign(new TypeError("afterSequence must be an integer >= 0"), { details: { kind: "validation" } });
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > BOARD_READ_MAX_LIMIT) {
      throw Object.assign(new TypeError(`limit must be an integer between 1 and ${BOARD_READ_MAX_LIMIT}`), { details: { kind: "validation" } });
    }
    // Lock-free read: writers hold the lock across read-max + append, so a
    // torn tail is not observable; a reader racing an append simply sees the
    // pre-append prefix and catches up next poll.
    const raw = await readFile(this.path(topic), "utf8").catch((error) => {
      if (error?.code === "ENOENT") return "";
      throw error;
    });
    const entries = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (typeof entry.sequence === "number") entries.push(entry);
      } catch { /* skip corrupt lines */ }
    }
    entries.sort((a, b) => a.sequence - b.sequence);
    if (afterSequence == null) {
      const fresh = entries.slice(-limit);
      return {
        topic,
        entries: fresh,
        nextSequence: fresh.at(-1)?.sequence ?? 0,
        hasMore: entries.length > fresh.length,
      };
    }
    const fresh = entries.filter((e) => e.sequence > afterSequence).slice(0, limit);
    const last = fresh.at(-1);
    return {
      topic,
      entries: fresh,
      nextSequence: last ? last.sequence : afterSequence,
      hasMore: last ? entries.some((e) => e.sequence > last.sequence) : entries.some((e) => e.sequence > afterSequence),
    };
  }
}
