import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION, TARGETS } from "./protocol.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function fingerprint(directory) {
  const files = [];
  function visit(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && entry.name.endsWith(".mjs")) files.push(full);
    }
  }
  visit(join(directory, "src"));
  files.push(join(directory, "package.json"));
  const hash = createHash("sha256");
  for (const file of files.sort()) {
    hash.update(relative(directory, file).replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function createRuntimeInfo(directory = root) {
  const startedAt = new Date().toISOString();
  let loadedFingerprint = null;
  try { loadedFingerprint = fingerprint(directory); } catch { /* diagnostics remain available */ }
  return () => {
    let diskFingerprint = null;
    try { diskFingerprint = fingerprint(directory); } catch { /* report unknown, not current */ }
    const sourceStatus = !loadedFingerprint || !diskFingerprint ? "unknown"
      : loadedFingerprint === diskFingerprint ? "current" : "stale";
    return {
      pid: process.pid,
      startedAt,
      root: directory,
      node: process.version,
      protocolVersion: PROTOCOL_VERSION,
      routingPolicyVersion: 2,
      targets: [...TARGETS],
      loadedFingerprint,
      diskFingerprint,
      sourceStatus,
      ...(sourceStatus === "stale" ? {
        hint: "Source files changed since this MCP runtime loaded. Reconnect this MCP server after active jobs settle; re-check handoff_host_info before dispatching.",
      } : {}),
    };
  };
}

// Capture at module load, not at the first diagnostic call after an edit.
export const runtimeInfo = createRuntimeInfo();
