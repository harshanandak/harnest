// Canonical, additive usage metrics for handoff receipts.
//
// The provider payload stays in `usage` exactly as the adapter observed it;
// `usageSummary` is a separate normalized view so consumers can compare
// prompt-cache behavior across the seven harnesses without re-learning seven
// shapes. Nothing here replaces or reshapes a legacy field.
//
// Contract:
// - null always means "not reported by the harness/provider" — never a
//   synthesized zero. A provider-reported 0 (for example a cache miss) is 0.
// - inputTokens is an inclusive prompt total, and only where the harness
//   semantics prove one. Codex `input_tokens` already includes cached input;
//   Claude and OpenCode input counts exclude cache reads/writes, so the total
//   adds them back. A missing cache counter is NOT treated as zero: the total
//   is null unless every component was reported. The raw field semantics are
//   recorded in `inputSemantics`.
// - uncachedInputTokens is the newly processed input (the input count minus
//   the cache-read subset) where derivable; cache creation is reported
//   separately in `cacheWriteTokens` and is not subtracted from it. A cached
//   count larger than the input count is a provider contradiction, so the
//   derived value is null rather than clamped.
// - costUsd is null when unreported.
// - `cacheReadTokens`/`cacheWriteTokens` are provider-reported cache reads and
//   cache writes. Codex reports no write counter, so it stays null.

const SUMMARY_KEYS = [
  "inputTokens",
  "uncachedInputTokens",
  "inputSemantics",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "costUsd",
];

function number(value) {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function pick(source, keys) {
  for (const key of keys) {
    const value = number(source?.[key]);
    if (value !== null) return value;
  }
  return null;
}

function summary(fields) {
  const out = {};
  for (const key of SUMMARY_KEYS) out[key] = fields[key] ?? null;
  return out;
}

const TOTAL_KEYS = ["inputTokens", "uncachedInputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "costUsd"];

/**
 * True only when a summary carries at least one provider-reported metric.
 * `inputSemantics` alone is not usage evidence: an all-null summary is the
 * canonical shape for "nothing was reported" and must not read as confirmed.
 */
export function usageSummaryHasValues(value) {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && SUMMARY_KEYS.some((key) => key !== "inputSemantics" && value[key] != null);
}

export function emptyUsageTotals({ unknownAsNull = false } = {}) {
  const initial = unknownAsNull ? null : 0;
  return {
    inputTokens: initial,
    uncachedInputTokens: initial,
    outputTokens: initial,
    cacheReadTokens: initial,
    cacheWriteTokens: initial,
    costUsd: initial,
    reportedAttempts: 0,
    unreportedAttempts: 0,
    partial: false,
  };
}

/**
 * Fold one attempt summary into running totals. `partial` records that at
 * least one attempt (or one canonical field) was unreported, so the sums are a
 * lower bound rather than a full accounting.
 */
export function addUsageToTotals(totals, value) {
  const target = totals && typeof totals === "object" ? totals : emptyUsageTotals();
  if (!usageSummaryHasValues(value)) {
    target.unreportedAttempts += 1;
    target.partial = true;
    return target;
  }
  let missing = false;
  for (const key of TOTAL_KEYS) {
    if (typeof value[key] === "number") target[key] = (target[key] ?? 0) + value[key];
    else missing = true;
  }
  target.reportedAttempts += 1;
  if (missing) target.partial = true;
  return target;
}

/**
 * Normalize one harness's observed usage into the shared summary shape.
 *
 * @param {"opencode"|"pi"|"cursor"|"claude"|"codex"|"gemini"|"amp"|"acp"|string} host
 * @param {object|null} usage raw provider payload (legacy shape, unchanged)
 * @param {{reported?: object|null}} [options] For harnesses whose accumulator
 *   cannot distinguish "unreported" from an explicit 0 (OpenCode), `reported`
 *   is the set of keys an event actually supplied. When present, an unmarked
 *   key is reported as null instead of the accumulator's zero.
 */
export function summarizeUsage(host, usage = null, { reported = null } = {}) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const trusted = reported && typeof reported === "object";
  const allow = (key, value) => (trusted && reported[key] !== true ? null : value);

  switch (host) {
    case "claude": {
      // Anthropic: input_tokens excludes cache_read_input_tokens and
      // cache_creation_input_tokens; the inclusive total adds them back. A
      // missing counter is unreported, not zero, so the total stays null.
      const input = pick(usage, ["inputTokens", "input_tokens"]);
      const cacheRead = pick(usage, ["cacheReadTokens", "cache_read_input_tokens"]);
      const cacheWrite = pick(usage, ["cacheWriteTokens", "cache_creation_input_tokens"]);
      const total = input !== null && cacheRead !== null && cacheWrite !== null
        ? input + cacheRead + cacheWrite
        : null;
      return summary({
        inputTokens: total,
        uncachedInputTokens: input,
        inputSemantics: input === null ? null : "exclusive",
        outputTokens: pick(usage, ["outputTokens", "output_tokens"]),
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        costUsd: pick(usage, ["totalCostUsd", "total_cost_usd", "costUsd", "cost_usd"]),
      });
    }
    case "cursor": {
      // Cursor wraps several providers and its own usage counters do not prove
      // whether inputTokens excludes cache. Report the cache counters it did
      // supply, but never claim an inclusive input total or a derived uncached
      // count without a verified source format.
      const cacheRead = pick(usage, ["cacheReadTokens", "cache_read_input_tokens"]);
      const cacheWrite = pick(usage, ["cacheWriteTokens", "cache_creation_input_tokens"]);
      const input = pick(usage, ["inputTokens", "input_tokens"]);
      return summary({
        inputTokens: null,
        uncachedInputTokens: null,
        inputSemantics: input === null ? null : "unknown",
        outputTokens: pick(usage, ["outputTokens", "output_tokens"]),
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        costUsd: pick(usage, ["totalCostUsd", "total_cost_usd", "costUsd", "cost_usd"]),
      });
    }
    case "codex": {
      // OpenAI: input_tokens is the inclusive total and cached_input_tokens is
      // the cached subset; the uncached remainder is derivable unless the
      // cached count contradicts the input count.
      const input = pick(usage, ["input_tokens", "inputTokens"]);
      const cached = pick(usage, ["cached_input_tokens", "cachedInputTokens", "cacheReadTokens"]);
      const derivable = input !== null && cached !== null && cached <= input;
      return summary({
        inputTokens: input,
        uncachedInputTokens: derivable ? input - cached : null,
        inputSemantics: input === null ? null : "inclusive",
        outputTokens: pick(usage, ["output_tokens", "outputTokens"]),
        cacheReadTokens: cached,
        cacheWriteTokens: pick(usage, ["cache_write_tokens", "cacheWriteTokens"]),
        costUsd: pick(usage, ["total_cost_usd", "costUsd", "cost_usd"]),
      });
    }
    case "opencode": {
      // OpenCode accumulates per-run keys; `reported` separates a real 0 from
      // a key the provider never emitted. Its input count excludes cache, and
      // an unreported cache counter leaves the inclusive total null.
      const input = allow("input", pick(usage, ["input", "inputTokens", "input_tokens"]));
      const cacheRead = allow("cacheRead", pick(usage, ["cacheRead", "cacheReadTokens", "cache_read_input_tokens"]));
      const cacheWrite = allow("cacheWrite", pick(usage, ["cacheWrite", "cacheWriteTokens", "cache_creation_input_tokens"]));
      const total = input !== null && cacheRead !== null && cacheWrite !== null
        ? input + cacheRead + cacheWrite
        : null;
      return summary({
        inputTokens: total,
        uncachedInputTokens: input,
        inputSemantics: input === null ? null : "exclusive",
        outputTokens: allow("output", pick(usage, ["output", "outputTokens", "output_tokens"])),
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        costUsd: allow("cost", pick(usage, ["cost", "costUsd", "totalCostUsd"])),
      });
    }
    case "gemini":
    case "amp":
    case "acp":
      // Raw usage remains available on the receipt, but these native counter
      // semantics are not verified yet. Do not apply Pi's nested-token rules.
      return summary({});
    default: {
      // Installed Pi returns { tokens: { input, output, cacheRead, cacheWrite,
      // total }, cost, ... } from get_session_stats, where
      // total = input + output + cacheRead + cacheWrite proves the input count
      // excludes cache. Flat non-token shapes are not that format, so their
      // semantics stay unknown and no inclusive total is claimed.
      const tokens = usage.tokens && typeof usage.tokens === "object" && !Array.isArray(usage.tokens)
        ? usage.tokens
        : null;
      const cost = pick(usage, ["cost", "totalCostUsd", "total_cost_usd", "costUsd", "cost_usd"]);
      if (tokens) {
        const input = pick(tokens, ["input"]);
        const cacheRead = pick(tokens, ["cacheRead"]);
        const cacheWrite = pick(tokens, ["cacheWrite"]);
        const total = input !== null && cacheRead !== null && cacheWrite !== null
          ? input + cacheRead + cacheWrite
          : null;
        return summary({
          inputTokens: total,
          uncachedInputTokens: input,
          inputSemantics: input === null ? null : "exclusive",
          outputTokens: pick(tokens, ["output"]),
          cacheReadTokens: cacheRead,
          cacheWriteTokens: cacheWrite,
          costUsd: cost,
        });
      }
      const input = pick(usage, ["inputTokens", "input_tokens", "input"]);
      return summary({
        inputTokens: null,
        uncachedInputTokens: null,
        inputSemantics: input === null ? null : "unknown",
        outputTokens: pick(usage, ["outputTokens", "output_tokens", "output"]),
        cacheReadTokens: pick(usage, ["cacheReadTokens", "cache_read_input_tokens", "cacheRead"]),
        cacheWriteTokens: pick(usage, ["cacheWriteTokens", "cache_creation_input_tokens", "cacheWrite"]),
        costUsd: cost,
      });
    }
  }
}
