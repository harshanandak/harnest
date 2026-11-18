#!/usr/bin/env node
import { mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { JobStore } from "../src/job-store.mjs";

const hash = /^[a-f0-9]{64}$/;
const tokenPattern = /^[a-f0-9-]{36}$/;
const failure = (message) => Object.assign(new Error(message), { details: { kind: "policy" } });

async function ownerAt(path) {
  const file = await open(path, "r");
  try {
    if ((await file.stat()).size > 2048) throw failure("lease record exceeds its limit");
    const owner = JSON.parse(await file.readFile("utf8"));
    if (!tokenPattern.test(owner.token) || !Number.isInteger(owner.pid) || owner.pid < 1 || typeof owner.host !== "string" || owner.host.length > 255) throw failure("invalid lease record");
    return { token: owner.token, pid: owner.pid, host: owner.host };
  } finally { await file.close(); }
}

function ownerState(owner) {
  if (owner.host !== hostname()) return "remote-unknown";
  try { process.kill(owner.pid, 0); return "alive"; }
  catch (error) { return error.code === "ESRCH" ? "dead-native-state-unknown" : "unknown"; }
}

export async function listSessionLeases(stateDir) {
  const directory = join(stateDir, "native-sessions");
  const entries = await readdir(directory).catch((error) => { if (error.code === "ENOENT") return []; throw error; });
  return Promise.all(entries.filter((name) => hash.test(name.slice(0, -5)) && name.endsWith(".lock")).sort().map(async (name) => {
    const id = name.slice(0, -5);
    try {
      const owner = await ownerAt(join(directory, name));
      return { id, ...owner, coordinator: ownerState(owner), nativeState: "unverified" };
    } catch { return { id, coordinator: "unreadable", nativeState: "unverified" }; }
  }));
}

export async function reconcileSessionLease(stateDir, { id, expectedToken, nativeStopped = false }) {
  if (!hash.test(id) || !tokenPattern.test(expectedToken ?? "")) throw failure("an exact lease ID and expected token are required");
  if (!nativeStopped) throw failure("verify the native session has stopped, then supply --native-stopped");
  const directory = join(stateDir, "native-sessions");
  const path = join(directory, `${id}.lock`);
  const guardPath = join(directory, `${id}.reconcile`);
  const guard = await open(guardPath, "wx", 0o600);
  try {
    const owner = await ownerAt(path);
    if (owner.token !== expectedToken) throw failure("lease token changed; inspect again");
    if (ownerState(owner) !== "dead-native-state-unknown") throw failure("coordinator is alive or its state cannot be proven; use its normal shutdown");
    const archive = join(directory, "reconciled");
    await mkdir(archive, { recursive: true });
    const backup = join(archive, `${id}.${expectedToken}.json`);
    const reservation = await open(backup, "wx", 0o600);
    await reservation.close();
    try { await rename(path, backup); }
    catch (error) { await unlink(backup).catch(() => {}); throw error; }
    return { id, state: "reconciled", nativeStopped: "operator-confirmed", backup };
  } finally { await guard.close(); await unlink(guardPath); }
}

export async function main(args = process.argv.slice(2)) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--native-stopped") options.nativeStopped = true;
    else if (["--state-dir", "--release", "--expected-token"].includes(arg)) {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw failure(`${arg} requires a value`);
      options[arg] = value;
    } else throw failure(`unknown option ${arg}`);
  }
  const stateDir = new JobStore(options["--state-dir"]).root;
  const result = options["--release"]
    ? await reconcileSessionLease(stateDir, { id: options["--release"], expectedToken: options["--expected-token"], nativeStopped: options.nativeStopped })
    : { leases: await listSessionLeases(stateDir) };
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
