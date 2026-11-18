import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const DAEMON_HOST = "127.0.0.1";
export const DAEMON_PORT = 41237;
export const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

export function clientPort() {
  const fixturePort = Number(process.env.HARNEST_DAEMON_FIXTURE_PORT);
  return process.env.HARNEST_STATE_DIR && Number.isInteger(fixturePort) && fixturePort > 0 && fixturePort < 65536
    ? fixturePort : DAEMON_PORT;
}

export function daemonAddress(port = DAEMON_PORT) {
  return `http://${DAEMON_HOST}:${port}`;
}

export function jobStateDirectory({ env = process.env, platform = process.platform, home = homedir() } = {}) {
  if (env.HARNEST_LOGIN_JOB_DIR) return env.HARNEST_LOGIN_JOB_DIR;
  if (env.HARNEST_STATE_DIR) return env.HARNEST_STATE_DIR;
  if (platform === "win32") return join(env.LOCALAPPDATA || tmpdir(), "harnest", "jobs");
  return join(env.XDG_STATE_HOME || join(home, ".local", "state"), "harnest", "jobs");
}

export function daemonDirectory({ env = process.env, platform = process.platform, home = homedir() } = {}) {
  if (env.HARNEST_LOGIN_DAEMON_DIR) return env.HARNEST_LOGIN_DAEMON_DIR;
  if (env.HARNEST_STATE_DIR) return join(dirname(resolve(env.HARNEST_STATE_DIR)), "daemon");
  if (platform === "win32") return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "harnest", "daemon");
  if (platform === "darwin") return join(home, "Library", "Application Support", "harnest", "daemon");
  return join(env.XDG_STATE_HOME || join(home, ".local", "state"), "harnest", "daemon");
}

export function privatePath(path, stat, directory) {
  if (!(directory ? stat.isDirectory() : stat.isFile()) ||
      (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))) {
    throw new Error(`Harnest daemon requires a private ${directory ? "directory" : "token file"} at ${path}`);
  }
}

export async function readDaemonToken(directory = daemonDirectory()) {
  const path = join(directory, "token");
  privatePath(directory, await lstat(directory), true);
  const stat = await lstat(path);
  privatePath(path, stat, false);
  if (stat.size !== 64) throw new Error("Invalid Harnest daemon token file");
  const token = await readFile(path, "utf8");
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Invalid Harnest daemon token file");
  return token;
}

export function daemonProof(token, challenge) {
  return createHmac("sha256", token).update(`harnest-daemon:${challenge}`).digest("hex");
}
