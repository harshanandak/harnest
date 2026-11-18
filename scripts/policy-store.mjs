// Shared policy-file writes: atomic temp-file + rename so a crash mid-write
// never truncates routing.json, and concurrent writers cannot interleave.
import { mkdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { expandUserPolicy } from "../src/routing-presets.mjs";
import { validatePolicyScopes } from "../src/routing-policy.mjs";

// Lock the entire read/modify/replace transaction, not only the final rename.
// A crashed owner leaves a visible lock; never steal a possibly live writer's lock.
export async function updatePolicyJson(path, update, { timeoutMs = 10000 } = {}) {
  await mkdir(dirname(path), { recursive: true });
  const lock = `${path}.lock`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { await mkdir(lock); break; }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Error(`Policy is locked: ${lock}; retry, or remove the lock after confirming its writer has stopped`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  try {
    const raw = await readFile(path, "utf8").catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    const policy = raw === null ? {} : JSON.parse(raw);
    if (!policy || typeof policy !== "object" || Array.isArray(policy)) throw new TypeError(`${path} does not contain a policy object`);
    const result = await update(policy, raw);
    if (result?.skipWrite) return result;
    validatePolicyScopes([{ name: "user", policy: expandUserPolicy(policy) }]);
    await atomicWriteJson(path, policy);
    return result;
  } finally { await rm(lock, { recursive: true }); }
}

export async function atomicWriteJson(path, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.tmp-${randomUUID()}.json`);
  try {
    await writeFile(tmp, text);
    await rename(tmp, path);
  } finally { await rm(tmp, { force: true }); }
  // Re-read to prove the file parses after the rename.
  JSON.parse(await readFile(path, "utf8"));
}
