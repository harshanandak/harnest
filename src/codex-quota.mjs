// Native Codex quota preflight. This opens a metadata-only app-server session
// and never starts a thread or model turn. Codex resolves its own native auth;
// Harnest neither reads nor forwards credential material.
import { spawnNativeCommand } from "./launch-command.mjs";
import { harnessLaunch } from "./config.mjs";
import { mergeProcessEnv } from "./process.mjs";
import { runCodexMetadata } from "./model-catalog.mjs";

export const CODEX_QUOTA_SOURCE = "codex app-server account/rateLimits/read";

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 1_048_576;

function unknown(reason, observedAt) {
  return {
    status: "unknown",
    source: CODEX_QUOTA_SOURCE,
    observedAt,
    reason,
  };
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function boundedId(value) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 80) : null;
}

function normalizedWindow(kind, value) {
  const raw = object(value);
  const usedPercent = raw?.usedPercent;
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) return null;
  const duration = raw.windowDurationMins;
  const reset = raw.resetsAt;
  if (duration != null && (!Number.isSafeInteger(duration) || duration <= 0)) return null;
  if (reset != null && (!Number.isSafeInteger(reset) || reset <= 0)) return null;
  return {
    kind,
    usedPercent,
    headroom: Math.max(0, Math.min(1, 1 - (usedPercent / 100))),
    windowDurationMins: Number.isSafeInteger(duration) && duration > 0 ? duration : null,
    resetsAt: Number.isSafeInteger(reset) && reset > 0 ? reset : null,
  };
}

function selectedSnapshot(result) {
  // `rateLimits` is the server-selected backward-compatible bucket. When it
  // is absent, use only the exact ordinary Codex bucket. Never combine
  // unrelated service/model buckets into one invented account allowance.
  const direct = object(result?.rateLimits);
  if (direct) return direct;
  return object(object(result?.rateLimitsByLimitId)?.codex);
}

export function normalizeCodexQuotaResponse(value, { observedAt = Date.now() } = {}) {
  const result = object(value);
  if (!result) return unknown("malformed-response", observedAt);
  const snapshot = selectedSnapshot(result);
  const windows = [
    normalizedWindow("primary", snapshot?.primary),
    normalizedWindow("secondary", snapshot?.secondary),
  ].filter(Boolean);
  const ordinaryUsageAllowed = typeof result.ordinaryUsageAllowed === "boolean"
    ? result.ordinaryUsageAllowed
    : null;
  if (!windows.length && ordinaryUsageAllowed !== false) return unknown("no-usable-window", observedAt);

  let constraining = null;
  for (const window of windows) {
    if (!constraining || window.headroom < constraining.headroom) constraining = window;
  }
  return {
    status: "available",
    source: CODEX_QUOTA_SOURCE,
    observedAt,
    ordinaryUsageAllowed,
    limitId: boundedId(snapshot?.limitId) || "codex",
    headroom: constraining?.headroom ?? null,
    usedPercent: constraining?.usedPercent ?? null,
    windowDurationMins: constraining?.windowDurationMins ?? null,
    resetsAt: constraining?.resetsAt ?? null,
    windows,
  };
}

/**
 * Read the current native Codex rate-limit snapshot without inference.
 * Every failure collapses to a small, non-sensitive unknown result.
 */
export async function probeCodexQuota({
  launch,
  spawnFn = spawnNativeCommand,
  cwd = process.cwd(),
  env = {},
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = () => Date.now(),
} = {}) {
  const observedAt = now();
  if (signal?.aborted) return unknown("aborted", observedAt);
  let resolvedLaunch;
  try {
    resolvedLaunch = launch || harnessLaunch("codex");
  } catch {
    return unknown("unavailable", observedAt);
  }

  const result = await runCodexMetadata({
    command: resolvedLaunch.command,
    args: [...(resolvedLaunch.args || []), "app-server"],
    env: mergeProcessEnv({ ...(resolvedLaunch.env || {}), ...env }),
    cwd, spawnFn, signal,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
    maxOutputBytes: MAX_OUTPUT_BYTES,
    method: "account/rateLimits/read",
  });
  if (result.status !== 0) return unknown(result.code === "spawn-failed" ? "unavailable" : result.code || "probe-failed", observedAt);
  return normalizeCodexQuotaResponse(result.result, { observedAt });
}
