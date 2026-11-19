import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { pluginRoot, readLocalConfig } from "./config.mjs";
import { hasNativeRouteControls, normalizeRequest } from "./protocol.mjs";
import { attachRoutingDecision, resolvePolicyRoute, validatePolicyScopes } from "./routing-policy.mjs";
import { expandUserPolicy } from "./routing-presets.mjs";
import { hasModelFamily, isLatestAlias, selectLatestModel } from "./model-selection.mjs";
import { assertAdapterPolicy, assertAdapterRoute } from "./model-policy.mjs";

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function immutableClone(value) {
  const clone = structuredClone(value);
  const freeze = (item) => {
    if (!item || typeof item !== "object" || Object.isFrozen(item)) return item;
    Object.freeze(item);
    for (const child of Object.values(item)) freeze(child);
    return item;
  };
  return freeze(clone);
}

function validateDecision(decision) {
  if (decision == null) return null;
  if (typeof decision !== "object" || Array.isArray(decision)) {
    throw new TypeError("routing resolver must return null or an object containing target and/or route");
  }
  const allowed = new Set(["target", "route", "explanation"]);
  const unknown = Object.keys(decision).filter((key) => !allowed.has(key));
  if (unknown.length) throw new TypeError(`routing resolver returned unsupported fields: ${unknown.join(", ")}`);
  if (decision.route != null && (typeof decision.route !== "object" || Array.isArray(decision.route))) {
    throw new TypeError("routing resolver route must be an object");
  }
  for (const key of ["provider", "model", "agent", "variant", "thinking", "harnessVersion"]) {
    if (decision.route?.[key] != null && (typeof decision.route[key] !== "string" || !decision.route[key].trim())) {
      throw new TypeError(`routing resolver route.${key} must be a non-empty string`);
    }
  }
  if (decision.explanation != null && (typeof decision.explanation !== "object" || Array.isArray(decision.explanation))) {
    throw new TypeError("routing resolver explanation must be an object");
  }
  return decision;
}

function withTimeout(promise, timeoutMs, label) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function resolveModulePath(configured) {
  return isAbsolute(configured) ? configured : resolve(pluginRoot(), configured);
}

function createModuleLoader(modulePath) {
  let loaded;
  let loadedFingerprint = null;
  let loadedAt = null;
  let lastError = null;
  const fingerprint = async () => createHash("sha256").update(await readFile(modulePath)).digest("hex");
  const load = async () => {
    if (!loaded) {
      const pending = (async () => {
        let sourceFingerprint = null;
        try { sourceFingerprint = await fingerprint(); } catch { /* The import reports the actionable error. */ }
        try {
          const module = await import(pathToFileURL(modulePath).href);
          loadedFingerprint = sourceFingerprint ?? await fingerprint().catch(() => null);
          loadedAt = new Date().toISOString();
          lastError = null;
          return module;
        } catch (error) {
          lastError = error?.message || String(error);
          throw error;
        }
      })();
      loaded = pending;
      pending.catch(() => {
        if (loaded === pending) loaded = undefined;
      });
    }
    return loaded;
  };
  load.diagnostics = async () => {
    const diskFingerprint = await fingerprint().catch(() => null);
    const loadStatus = loadedAt ? "loaded" : lastError ? "failed" : "not-loaded";
    const sourceStatus = !loadedAt ? "not-loaded"
      : !loadedFingerprint || !diskFingerprint ? "unknown"
      : loadedFingerprint === diskFingerprint ? "current" : "stale";
    const hint = sourceStatus === "stale"
      ? "resolver policy changed after this MCP process loaded it; restart the MCP process to load the current policy"
      : sourceStatus === "not-loaded"
        ? "resolver policy has not been loaded by this MCP process yet"
        : sourceStatus === "unknown"
          ? "resolver policy fingerprint is unavailable; loaded/current status is unknown"
          : null;
    return {
      configured: true,
      loadStatus,
      sourceStatus,
      loadedFingerprint,
      diskFingerprint,
      loadedAt,
      ...(hint ? { hint } : {}),
    };
  };
  return load;
}

function isTransientRead(error) {
  return process.platform === "win32" && ["EPERM", "EACCES", "EBUSY"].includes(error?.code);
}

async function readFileTransient(path) {
  // Windows AV/indexer locks make stat/readFile flake under parallel load;
  // retry transient errors briefly rather than failing the whole resolution.
  for (let attempt = 0; ; attempt += 1) {
    try {
      const info = await stat(path);
      return { info, text: await readFile(path, "utf8") };
    } catch (error) {
      if (error?.code === "ENOENT") throw error;
      if (!isTransientRead(error) || attempt >= 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(10 * (2 ** attempt), 100)));
    }
  }
}

function createPolicyFileLoader(filePath, routing) {
  let lastStamp = null;
  let lastGood = null;
  let lastError = null;
  return async () => {
    if (!filePath) return { policy: null, staleError: null };
    try {
      const { text } = await readFileTransient(filePath);
      const stamp = text;
      if (stamp === lastStamp && lastGood) return { policy: lastGood, staleError: lastError };
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError("policy root must be an object");
      validatePolicyScopes([
        ...(routing.global ? [{ name: "global", policy: routing.global }] : []),
        { name: "user", policy: expandUserPolicy(parsed) },
      ]);
      lastStamp = stamp;
      lastGood = parsed;
      lastError = null;
      return { policy: parsed, staleError: null };
    } catch (error) {
      if (error?.code === "ENOENT") return { policy: null, staleError: null };
      const message = `routing policy file is invalid: ${error.message}`;
      if (lastGood) {
        lastError = message;
        return { policy: lastGood, staleError: message };
      }
      throw new TypeError(message, { cause: error });
    }
  };
}

function policyScopes(routing, request, userPolicy) {
  const sessionId = request.execution?.sessionId;
  const { preset, ...requestPolicy } = object(request.metadata?.routing);
  const scopes = [
    { name: "global", policy: routing.global },
    { name: "user", policy: userPolicy },
    { name: "project", policy: routing.project ?? routing.policy },
    { name: "session", policy: sessionId ? routing.sessions?.[sessionId] : null },
    { name: "request", policy: Object.keys(requestPolicy).length ? requestPolicy : null },
  ];
  return scopes.filter(({ policy }) => policy && typeof policy === "object" && !Array.isArray(policy));
}

function appendResolverExplanation(request, patch) {
  const metadata = object(request.metadata);
  const harnest = object(metadata.harnest);
  const current = object(harnest.routingDecision);
  return normalizeRequest({
    ...request,
    metadata: {
      ...metadata,
      harnest: {
        ...harnest,
        routingDecision: {
          ...current,
          resolver: { ...object(current.resolver), ...patch },
        },
      },
    },
  });
}

// Doctor exercises the real declarative engine without loading executable hooks.
export function validateRoutingConfiguration(routing = {}, userPolicy = null) {
  const request = normalizeRequest({ requestId: "doctor-routing", target: "pi", task: "routing diagnostic", cwd: process.cwd() });
  const expanded = userPolicy === null ? null : expandUserPolicy(userPolicy);
  for (const [name, policy] of [["global", routing.global], ["project", routing.project ?? routing.policy], ["user", expanded]]) {
    if (policy !== undefined && policy !== null && (!policy || typeof policy !== "object" || Array.isArray(policy))) throw new TypeError(`${name} routing policy must be an object`);
  }
  const scopes = policyScopes(routing, request, expanded);
  resolvePolicyRoute(request, scopes);
  for (const [sessionId, policy] of Object.entries(routing.sessions || {})) {
    resolvePolicyRoute({ ...request, execution: { ...request.execution, sessionId } }, [...scopes, { name: `session:${sessionId}`, policy }]);
  }
}

export function createRouteResolver(options = {}) {
  const config = options.config ?? readLocalConfig();
  const env = options.env ?? process.env;
  const routing = object(config.routing);
  const configured = options.resolverModule ?? env.HARNEST_ROUTER ?? routing.resolverModule;
  if (configured != null && (typeof configured !== "string" || !configured.trim())) {
    throw new TypeError("routing.resolverModule must be a non-empty path string");
  }
  const modulePath = configured ? resolveModulePath(configured) : null;
  const loadModule = modulePath ? createModuleLoader(modulePath) : null;
  const policyFile = options.policyFile
    ?? env.HARNEST_ROUTING_POLICY
    ?? routing.userPolicyFile
    ?? join(homedir(), ".harnest", "routing.json");
  const loadUserPolicy = options.loadUserPolicy ?? createPolicyFileLoader(policyFile, routing);
  const configuredTimeout = options.resolverTimeoutMs ?? routing.resolverTimeoutMs ?? 5_000;
  // A non-positive or non-finite timeout would silently disable the resolver
  // deadline; clamp to the default instead of hanging the handoff.
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 5_000;
  const failureMode = options.failureMode ?? routing.resolverFailureMode ?? "closed";
  if (!new Set(["closed", "passthrough"]).has(failureMode)) {
    throw new TypeError("routing.resolverFailureMode must be closed or passthrough");
  }
  const breaker = object(routing.circuitBreaker);
  const failureThreshold = Math.max(1, breaker.failureThreshold ?? 3);
  const cooldownMs = Math.max(1_000, breaker.cooldownMs ?? 30_000);
  let failures = 0;
  let openUntil = 0;

  const resolveOnce = async (input) => {
    const request = normalizeRequest(input);
    let userPolicy = options.userPolicy ?? null;
    let stalePolicyError = null;
    if (!userPolicy) {
      const loaded = await loadUserPolicy();
      userPolicy = loaded.policy;
      stalePolicyError = loaded.staleError;
    }
    // Compile the simple preference sugar (harnessOrder/models) into
    // engine-native candidates before scopes are built. No-op otherwise.
    const selectedPreset = Object.hasOwn(request.metadata?.routing ?? {}, "preset")
      ? request.metadata.routing.preset : userPolicy?.activePreset;
    userPolicy = expandUserPolicy(userPolicy, selectedPreset);
    const scopes = policyScopes(routing, request, userPolicy);
    let routed = request;
    if (scopes.length) {
      const decision = resolvePolicyRoute(request, scopes, { now: options.now?.() ?? Date.now() });
      routed = normalizeRequest(attachRoutingDecision({
        ...request,
        target: decision.target,
        route: decision.route,
        metadata: {
          ...request.metadata,
          ...(typeof decision.explanation.fallbacks === "boolean" ? {
            routing: { ...request.metadata?.routing, fallbacks: decision.explanation.fallbacks },
          } : {}),
        },
      }, {
        ...decision.explanation,
        ...(selectedPreset != null ? { preset: selectedPreset } : {}),
        ...(stalePolicyError ? { warning: "using last-known-good user policy" } : {}),
      }));
    }
    if (!loadModule) return routed;

    const now = options.now?.() ?? Date.now();
    if (now < openUntil) {
      const error = new Error(`routing resolver circuit is open until ${new Date(openUntil).toISOString()}`);
      if (failureMode === "passthrough") return appendResolverExplanation(routed, { applied: false, status: "circuit-open" });
      throw new TypeError(`local routing resolver failed: ${error.message}`, { cause: error });
    }

    try {
      const module = await withTimeout(loadModule(), timeoutMs, "routing resolver import");
      const resolver = module.resolveRoute || module.default;
      if (typeof resolver !== "function") {
        throw new TypeError("resolver module must export resolveRoute or a default function");
      }
      const decision = validateDecision(await withTimeout(Promise.resolve(resolver({
        request: immutableClone(routed),
        options: immutableClone(routing.options ?? {}),
      })), timeoutMs, "routing resolver"));
      failures = 0;
      openUntil = 0;
      if (!decision) return appendResolverExplanation(routed, { applied: false, status: "no-decision" });
      const pinned = hasNativeRouteControls(request.target, request.route)
        || (request.route.model || request.route.provider) && !["auto", "prefer"].includes(request.metadata?.routing?.mode);
      const resolved = normalizeRequest({
        ...routed,
        target: pinned ? request.target : decision.target ?? routed.target,
        route: {
          ...routed.route, ...decision.route,
          ...(pinned ? request.route : {}),
          ...(request.route.thinking != null ? { thinking: request.route.thinking } : {}),
        },
      });
      assertAdapterRoute(resolved.target, resolved.route);
      return appendResolverExplanation(resolved, {
        applied: true,
        status: "ok",
        ...(decision.explanation ? { explanation: decision.explanation } : {}),
      });
    } catch (error) {
      if (error?.details?.kind === "policy") throw error;
      failures += 1;
      if (failures >= failureThreshold) openUntil = (options.now?.() ?? Date.now()) + cooldownMs;
      if (failureMode === "passthrough") {
        return appendResolverExplanation(routed, {
          applied: false,
          status: failures >= failureThreshold ? "circuit-open" : "failed",
          failureCount: failures,
        });
      }
      throw new TypeError(`local routing resolver failed: ${error.message}`, { cause: error });
    }
  };

  const resolveRoute = async (input) => {
    const resolved = await resolveOnce(input);
    assertAdapterRoute(resolved.target, resolved.route);
    if (resolved.target === "opencode") assertAdapterPolicy(resolved.target, resolved.policy, resolved.execution, resolved.workflow);
    if (resolved.target === "acp") return resolved;
    const model = resolved?.route?.model;
    const mode = resolved.metadata?.harnest?.routingDecision?.modelVersion ?? "latest";
    if (!model) {
      if (mode === "pin") throw new TypeError("modelVersion pin requires an exact model ID, not a harness default");
      return resolved;
    }
    const finish = (selection, catalog) => {
      const result = { ...resolved, route: { ...resolved.route, model: selection.model } };
      assertAdapterRoute(result.target, result.route);
      return normalizeRequest(attachRoutingDecision(result, {
        ...resolved.metadata?.harnest?.routingDecision,
        modelVersion: mode,
        modelFreshness: {
          mode, status: selection.status, requested: model, resolved: selection.model,
          ...(catalog?.source ? { source: catalog.source } : {}),
          ...(catalog?.at ? { checkedAt: catalog.at } : {}),
          ...(selection.reason ? { warning: selection.reason } : {}),
        },
      }));
    };
    if (mode === "pin") {
      if (isLatestAlias(model)) throw new TypeError("modelVersion pin requires an exact model ID, not a latest alias or auto selector");
      return finish({ model, status: "pinned" });
    }
    if (resolved.target === "claude") {
      const alias = /^(?:claude-)?(sonnet|opus|fable)(?:-\d[\d.-]*)?$/.exec(model)?.[1];
      if (alias) return finish({ model: alias, status: "managed-latest" }, { source: "claude native alias" });
    }
    if (!hasModelFamily(model)) return resolved;
    const slash = !resolved.route.provider ? model.indexOf("/") : -1;
    const prefix = slash > 0 ? model.slice(0, slash + 1) : "";
    const lookupRoute = prefix ? { ...resolved.route, provider: prefix.slice(0, -1), model: model.slice(slash + 1) } : resolved.route;
    let catalog;
    try {
      catalog = await options.modelCatalog?.({ target: resolved.target, route: lookupRoute, cwd: resolved.cwd });
    } catch {
      catalog = { reason: "native model catalog refresh failed" };
    }
    if (catalog?.status === "stale") return finish({ model, status: "unavailable", reason: "model catalog is stale; latest release is unverified" }, catalog);
    const decision = resolved.metadata?.harnest?.routingDecision;
    const excluded = decision?.versionAvoidModels ?? [];
    const allowedCatalog = catalog?.models ? { ...catalog, models: catalog.models.filter((entry) => !excluded.includes(entry.id) && !excluded.includes(`${prefix}${entry.id}`)) } : catalog;
    const selection = selectLatestModel(lookupRoute, allowedCatalog);
    if (selection.status === "updated" && decision?.versionUpgradeRestricted) {
      return finish({ model, status: "unavailable", reason: "latest upgrade cannot verify the configured budget or required model capabilities; retaining the selected model" }, catalog);
    }
    return finish({ ...selection, model: `${prefix}${selection.model}` }, catalog);
  };
  resolveRoute.diagnostics = async () => loadModule?.diagnostics?.() ?? ({
    configured: false,
    loadStatus: "unconfigured",
    sourceStatus: "unconfigured",
    loadedFingerprint: null,
    diskFingerprint: null,
    loadedAt: null,
  });
  return resolveRoute;
}
