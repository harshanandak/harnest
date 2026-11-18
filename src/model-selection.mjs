// Version selection is separate from route scoring: only replace a model with
// a newer catalog entry in the same family, tier and provider namespace.
import { compareVersions } from "./model-families.mjs";

const ALIASES = new Set(["sol", "astra", "luna", "terra", "sonnet", "opus", "haiku", "fable", "composer"]);

export function isLatestAlias(model) {
  const id = String(model).split("/").at(-1);
  return ALIASES.has(id) || id === "auto" || /(?:^|-)latest$/.test(id);
}

export function modelIdentity(model) {
  const text = String(model ?? "");
  const dated = /-(\d{8}|\d{4}-\d{2}-\d{2})$/.exec(text);
  const base = dated ? text.slice(0, dated.index) : text;
  const match = /\d+(?:[.-]\d+)*/.exec(base);
  if (!match) return null;
  const version = match[0].split(/[.-]/).map(Number);
  return {
    family: `${base.slice(0, match.index)}{version}${base.slice(match.index + match[0].length)}`,
    version,
    date: dated ? Number(dated[1].replaceAll("-", "")) : 0,
  };
}

export function hasModelFamily(model) {
  return modelIdentity(model) !== null || ALIASES.has(String(model).split("/").at(-1));
}

function isFree(entry) {
  return entry?.cost?.input === 0 && entry?.cost?.output === 0;
}

export function selectLatestModel(route, catalog) {
  const original = route.model;
  const unchanged = (status, reason) => ({ model: original, status, ...(reason ? { reason } : {}) });
  if (catalog?.status === "unavailable") return unchanged("unavailable", catalog.reason ?? "model catalog unavailable");
  if (!Array.isArray(catalog?.models)) return unchanged("unavailable", catalog?.reason ?? "model catalog unavailable");
  const scoped = catalog.models.filter((entry) => entry && typeof entry.id === "string"
    && (!route.provider || entry.provider === route.provider));
  const source = scoped.find((entry) => entry.id === original);
  const models = scoped.filter((entry) => entry.available !== false);
  const identity = modelIdentity(original);
  const alias = String(original).split("/").at(-1);
  if (!identity && !ALIASES.has(alias)) return unchanged("untracked");
  const compatible = models.filter((entry) => {
    const candidate = modelIdentity(entry.id);
    if (!candidate) return false;
    if (identity) return candidate.family === identity.family;
    return entry.id.split(/[/_-]/).includes(alias);
  });
  const families = new Set(compatible.map((entry) => `${entry.provider ?? ""}:${modelIdentity(entry.id).family}`));
  if (families.size > 1 && (!identity || !route.provider)) {
    return unchanged("unavailable", "model family or provider is ambiguous in this catalog");
  }
  const freeOnly = isFree(source) || /(?:-free|:free)$/.test(original);
  const candidates = compatible.filter((entry) => {
    if (source?.provider && entry.provider !== source.provider) return false;
    if (freeOnly && !isFree(entry)) return false;
    if (route.thinking && entry.id !== original && !entry.thinking?.includes(route.thinking)) return false;
    return true;
  }).sort((a, b) => {
    const left = modelIdentity(a.id), right = modelIdentity(b.id);
    return compareVersions(right.version, left.version) || right.date - left.date || a.id.localeCompare(b.id);
  });
  const newest = candidates[0];
  if (!newest) return unchanged("unavailable", "no verified compatible release in the catalog");
  const next = modelIdentity(newest.id);
  if (identity && (compareVersions(next.version, identity.version) < 0
    || (compareVersions(next.version, identity.version) === 0 && next.date < identity.date))) {
    return unchanged("unavailable", "catalog has only older releases; refusing to downgrade");
  }
  return { model: newest.id, status: newest.id === original ? "current" : "updated" };
}
