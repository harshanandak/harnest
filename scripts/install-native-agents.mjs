import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readExisting, replaceWithBackup } from "./install-files.mjs";

if (process.argv.length !== 3) throw new Error("Usage: node scripts/install-native-agents.mjs DESTINATION");
const destination = resolve(process.argv[2]);
const source = fileURLToPath(new URL("../codex-agents/", import.meta.url));
const workers = (await readdir(source)).filter((name) => name.endsWith("_worker.toml"));
const backups = [];
for (const worker of workers) {
  const bytes = await readFile(join(source, worker));
  const backup = await replaceWithBackup(join(destination, worker), bytes);
  if (backup) backups.push(backup);
}

// DSH was removed as a downstream target. Retain the old file for rollback.
const obsolete = join(destination, "dsh_worker.toml");
const previous = await readExisting(obsolete, null);
const removedBackup = await replaceWithBackup(obsolete, null, previous);
if (removedBackup) backups.push(removedBackup);

console.log("Installed native Codex agents: " + workers.join(", "));
for (const backup of backups) console.log("Worker backup: " + backup);
if (backups.length) console.log('Restore from the Harnest checkout with: node scripts/install-host-config.mjs --restore "<backup path>"');
console.log("Restart Codex so the new agents load.");
