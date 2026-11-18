/**
 * Legacy family snapshot used by the advisory model-freshness command.
 * Runtime latest/pin selection uses model-selection.mjs and native catalogs;
 * it does not depend on this manually maintained snapshot.
 */
export const LATEST = {
  muse: "muse-spark-1.3-contributor",
  "deepseek-flash": "deepseek-v4.1-flash",
  "deepseek-pro": "deepseek-v4-pro",
  "deepseek-vision": "deepseek-v4-flash-vision-exp",
};

// Order matters: contributor before bare muse, vision before flash.
const FAMILY_PATTERNS = [
  [/^muse-spark-[\d.]+(?:-contributor)?(?:-free)?$/, "muse"],
  [/^deepseek-v[\d.]+(?:\.\d+)?-flash-vision-exp(?:-batch)?$/, "deepseek-vision"],
  [/^deepseek-v[\d.]+(?:\.\d+)?-flash(?:-free|-latest|-batch)?(?:-\d{4})?$/, "deepseek-flash"],
  [/^deepseek-v[\d.]+(?:\.\d+)?-pro(?:-free|-batch)?(?:-\d{4})?$/, "deepseek-pro"],
];

const PROVIDER_PREFIX = /^(opencode-go|opencode|anthropic|openai|codex|deepseek|openrouter)\//;

function bare(model) {
  return String(model ?? "").replace(PROVIDER_PREFIX, "");
}

export function familyOf(model) {
  const text = bare(model);
  for (const [pattern, family] of FAMILY_PATTERNS) if (pattern.test(text)) return family;
  return null;
}

/** Latest model of the caller's family+tier, or the input unchanged when untracked. */
export function latestModel(model) {
  const text = String(model ?? "");
  const family = familyOf(text);
  if (!family || !LATEST[family]) return text;
  // Preserve an embedded provider prefix: "opencode-go/deepseek-v4-flash" keeps
  // its provider identity and only the family generation is upgraded.
  const prefix = PROVIDER_PREFIX.exec(text)?.[0] ?? "";
  return `${prefix}${LATEST[family]}`;
}

/** Numeric version tuple of the first number run in the id ("muse-spark-1.3" -> [1,3]). */
export function versionOf(model) {
  const match = /(\d+(?:\.\d+)*)/.exec(bare(model));
  return match ? match[1].split(".").map(Number) : null;
}

export function compareVersions(left, right) {
  const a = Array.isArray(left) ? left : versionOf(left);
  const b = Array.isArray(right) ? right : versionOf(right);
  if (!a || !b) return 0;
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Compare LATEST against a catalog of model ids (one per line or an array).
 * Returns { current, updates } where updates name families whose catalog
 * generation is newer than the pinned value.
 */
export function freshnessReport(catalog) {
  const ids = (Array.isArray(catalog) ? catalog : String(catalog ?? "").split(/\r?\n/))
    .map((line) => bare(String(line).trim()))
    .filter(Boolean);
  const updates = [];
  for (const [family, pinned] of Object.entries(LATEST)) {
    const candidates = ids.filter((id) => familyOf(id) === family);
    if (!candidates.length) {
      // The pinned generation is absent from the catalog: retired or renamed.
      updates.push({ family, pinned, newest: null, missing: true });
      continue;
    }
    const newest = candidates.reduce((best, id) => (compareVersions(id, best) > 0 ? id : best), candidates[0]);
    if (compareVersions(newest, pinned) > 0) updates.push({ family, pinned, newest });
  }
  return { current: updates.length === 0, updates };
}
