import { link, lstat, mkdir, mkdtemp, open, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { hasUserOnlyWindowsAcl, protectWindowsPath } from "../src/windows-acl.mjs";

export function backupStamp() {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
}

export async function readExisting(path, encoding = "utf8") {
  try { return await readFile(path, encoding); } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function removeInstalledCopy(source, target) {
  const previous = await readExisting(target, null);
  if (!previous?.equals(await readFile(source))) return null;
  return replaceWithBackup(target, null, previous);
}

export async function isPrivateInstallerFile(path) {
  const stat = await lstat(path);
  if (!stat.isFile()) return false;
  if (process.platform === "win32") return hasUserOnlyWindowsAcl(path);
  return stat.uid === process.getuid() && (stat.mode & 0o777) === 0o600;
}

export async function writeInstallerFile(path, content, { sensitive = false } = {}) {
  if (!sensitive) return writeFile(path, content, { flag: "wx", mode: 0o600 });
  if (process.platform !== "win32") {
    const file = await open(path, "wx", 0o600);
    try {
      await file.chmod(0o600);
      await file.writeFile(content);
    } finally {
      await file.close();
    }
    return;
  }

  // Protect the directory before creating the file so no other user can open it
  // while it is empty. Protect the file itself so its ACL survives publication.
  const directory = await mkdtemp(join(dirname(path), ".harnest-private-"));
  const staging = join(directory, "staging");
  try {
    protectWindowsPath(directory, { directory: true });
    await writeFile(staging, "", { flag: "wx" });
    protectWindowsPath(staging);
    await writeFile(staging, content, { flag: "r+" });
    await link(staging, path);
  } finally {
    await unlink(staging).catch((error) => { if (error.code !== "ENOENT") throw error; });
    await rmdir(directory);
  }
}

const same = (a, b) => Buffer.isBuffer(a) ? Buffer.isBuffer(b) && a.equals(b) : a === b;

export async function replaceWithBackup(path, next, previous = undefined, {
  sensitive = false, keepBackup = true, beforeReplace = undefined,
} = {}) {
  const encoding = Buffer.isBuffer(next) || Buffer.isBuffer(previous) ? null : "utf8";
  if (previous === undefined) previous = await readExisting(path, encoding);
  const changed = !same(next, previous);
  if (!changed && (!sensitive || previous === null || await isPrivateInstallerFile(path))) return null;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const suffix = backupStamp();
  const backup = keepBackup && changed && previous !== null ? `${path}.bak-harnest-${suffix}` : null;
  if (backup) await writeInstallerFile(backup, previous, { sensitive });
  const verifyPrevious = async () => {
    if (!same(await readExisting(path, encoding), previous)) throw new Error(`Configuration changed during install: ${path}`);
  };
  if (next === null) {
    await verifyPrevious();
    await beforeReplace?.(backup);
    await unlink(path);
    return backup;
  }
  const temp = `${path}.${suffix}.tmp`;
  try {
    await writeInstallerFile(temp, next, { sensitive });
    await verifyPrevious();
    await beforeReplace?.(backup);
    if (beforeReplace) await verifyPrevious();
    await rename(temp, path);
    if (!same(await readExisting(path, encoding), next)) throw new Error(`Could not verify configuration: ${path}`);
  } finally {
    await unlink(temp).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
  return backup;
}
