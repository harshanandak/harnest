import { mkdir, readFile, readdir, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { setupDaemon } from "./install-daemon.mjs";
import { backupStamp, readExisting, replaceWithBackup } from "./install-files.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
export const piConfigDir = () => process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");

/** Timestamped sibling backup of whatever this install replaces, matching the settings backup scheme. */
async function backupAndWrite(path, content, label) {
  const previous = await readExisting(path);
  if (previous === content) return `${label} already current`;
  const backup = await replaceWithBackup(path, content, previous);
  if (backup) console.log(`backed up ${label} to ${backup}`);
  return `installed ${label}`;
}

async function installExtension(piDir) {
  const extDir = join(piDir, "extensions");
  const source = await readFile(join(root, "pi-extension", "harnest.mjs"), "utf8");
  const baked = source.replace("__HARNEST_DAEMON_CLIENT_URL__", pathToFileURL(join(root, "src", "daemon-client.mjs")).href)
    .replace("__HARNEST_DAEMON_SETTINGS_URL__", pathToFileURL(join(root, "src", "daemon-settings.mjs")).href)
    .replace("__HARNEST_DYNAMIC_VIEW_URL__", pathToFileURL(join(root, "src", "dynamic-view.mjs")).href)
    .replace("__HARNEST_LAUNCH_COMMAND_URL__", pathToFileURL(join(root, "src", "launch-command.mjs")).href)
    .replace("__HARNEST_GRAPH_VIEW_URL__", pathToFileURL(join(root, "scripts", "graph-view.mjs")).href);
  // A missed placeholder is a broken import at session start, not a cosmetic gap.
  const unbaked = /__HARNEST_[A-Z_]+__/.exec(baked);
  if (unbaked) throw new Error(`extension still contains ${unbaked[0]}; installer placeholders and extension constants have drifted`);
  const target = join(extDir, "harnest.mjs");
  await backupAndWrite(target, baked, "extensions/harnest.mjs");
  return target;
}

/** Drop previous registrations of this extension (moved checkout or drive-case change) before adding the current path. */
export const isLegacyPiExtension = (entry) => typeof entry === "string" && /(?:^|[\\/])agent-companion(?:\.(?:m?js|ts))?[\\/]?$/i.test(entry);

export function mergeExtensionList(list, extensionPath) {
  const kept = (Array.isArray(list) ? list : []).filter((entry) => !isLegacyPiExtension(entry)
    && (typeof entry !== "string" || !/(?:^|[\\/])harnest\.mjs$/i.test(entry)));
  kept.push(extensionPath);
  return kept;
}

async function registerInSettings(piDir, extensionPath) {
  const settingsPath = join(piDir, "settings.json");
  const previousRaw = await readExisting(settingsPath);
  let settings;
  try { settings = JSON.parse(previousRaw?.replace(/^\uFEFF/, "") ?? "{}"); }
  catch { throw new Error("Invalid Pi configuration: " + settingsPath); }
  const migrated = Array.isArray(settings.extensions) && settings.extensions.some(isLegacyPiExtension) ? ["settings.extensions agent-companion"] : [];
  settings.extensions = mergeExtensionList(settings.extensions, extensionPath);
  const status = await backupAndWrite(settingsPath, JSON.stringify(settings, null, 2) + "\n", "settings.extensions");
  return { status, migrated };
}

async function installSkill(piDir) {
  const sourceDir = join(root, "skills", "handoff");
  const skillDir = join(piDir, "skills", "handoff");
  await mkdir(skillDir, { recursive: true });
  await backupAndWrite(join(skillDir, "SKILL.md"), await readFile(join(sourceDir, "SKILL.md"), "utf8"), "skills/handoff/SKILL.md");
  const refs = join(skillDir, "references");
  await mkdir(refs, { recursive: true });
  for (const file of await readdir(join(sourceDir, "references"))) {
    await backupAndWrite(join(refs, file), await readFile(join(sourceDir, "references", file), "utf8"), `skills/handoff/references/${file}`);
  }
  return "skills/handoff/SKILL.md";
}

export async function installPiIntegration(piDir = piConfigDir()) {
  const extensionPath = await installExtension(piDir);
  const { status: settings, migrated } = await registerInSettings(piDir, extensionPath);
  const skill = await installSkill(piDir);
  const extensionDir = dirname(extensionPath);
  const backups = [];
  // Pi loads extensions from this directory even without a settings entry.
  for (const item of await readdir(extensionDir)) {
    if (!isLegacyPiExtension(item)) continue;
    const oldPath = join(extensionDir, item);
    const backup = join(piDir, `.bak-harnest-${backupStamp()}`, item);
    await mkdir(dirname(backup), { mode: 0o700 });
    await rename(oldPath, backup);
    migrated.push(`extensions/${item}`);
    backups.push({ path: oldPath, backup });
  }
  return { extensionPath, settings, skill, migrated, backups };
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) {
  await setupDaemon({ noAutostart: process.argv.includes("--no-autostart") });
  console.log(JSON.stringify(await installPiIntegration(), null, 2));
}
