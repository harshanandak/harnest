// RoutingSettings: chat-facing read/write/preview over the user routing file.
//
// One canonical file (default ~/.harnest/routing.json) holds both the
// advanced policy (defaults/candidates/rules, owned by the lead) and the
// simple front end (base simple keys + presets/activePreset, owned by chat).
// Writes go through the shared policy writer lock with optimistic revision
// checks; failed or stale edits leave file bytes unchanged. preview() runs the
// real route resolver with the saved policy but never invokes a harness.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { readLocalConfig } from "./config.mjs";
import { normalizeRequest } from "./protocol.mjs";
import { validatePolicyScopes } from "./routing-policy.mjs";
import { expandUserPolicy } from "./routing-presets.mjs";
import { createRouteResolver } from "./routing.mjs";
import { createModelCatalog } from "./model-catalog.mjs";
import {
  SIMPLE_KEYS,
  resolveUserPreset,
  validatePresetName,
  validateRoutingSettings,
} from "./routing-preferences.mjs";
import { updatePolicyJson } from "../scripts/policy-store.mjs";

export const MISSING_REVISION = "missing";

function revisionOf(raw) {
  if (raw == null) return MISSING_REVISION;
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepCopy(value) {
  return structuredClone(value);
}

function pickSimple(source) {
  const picked = {};
  for (const key of SIMPLE_KEYS) {
    if (Object.hasOwn(source ?? {}, key) && source[key] !== undefined) picked[key] = deepCopy(source[key]);
  }
  return picked;
}

function resolverSource(config, env) {
  return env?.HARNEST_ROUTER || config?.routing?.resolverModule || null;
}

export class RoutingSettings {
  constructor({ policyPath, config, env, modelCatalog } = {}) {
    this.config = config ?? readLocalConfig();
    this.env = env ?? process.env;
    this.modelCatalog = modelCatalog ?? createModelCatalog({ config: this.config, env: this.env });
    this.policyPath = policyPath
      ?? this.env.HARNEST_ROUTING_POLICY
      ?? this.config?.routing?.userPolicyFile
      ?? join(homedir(), ".harnest", "routing.json");
  }

  async #loadSaved() {
    let raw = null;
    try {
      raw = await readFile(this.policyPath, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (raw == null) return { raw: null, policy: {} };
    let policy;
    try {
      policy = JSON.parse(raw);
    } catch (error) {
      throw new TypeError(`routing settings file is malformed: ${error.message}`, { cause: error });
    }
    if (!isObject(policy)) throw new TypeError("routing settings file must contain a policy object");
    return { raw, policy };
  }

  // Read-only snapshot. Never prints full advanced policies, never mutates config.
  async get() {
    const { raw, policy } = await this.#loadSaved();
    const revision = revisionOf(raw);
    const resolved = resolveUserPreset(policy);
    validatePolicyScopes([{ name: "user", policy: expandUserPolicy(policy) }]);
    const activePreset = policy.activePreset ?? null;

    const presets = {};
    for (const [name, settings] of Object.entries(policy.presets ?? {})) presets[name] = deepCopy(settings);

    const settings = pickSimple(resolved);
    settings.modelVersion = resolved.modelVersion ?? resolved.defaults?.modelVersion ?? "latest";
    if (settings.thinking == null && resolved.defaults?.route?.thinking != null) {
      settings.thinking = resolved.defaults.route.thinking;
    }

    const warnings = [];
    if (raw == null) warnings.push(`no routing file at ${this.policyPath}; showing defaults`);
    if (activePreset) warnings.push(`preset "${activePreset}" is active over the base settings`);
    const resolver = resolverSource(this.config, this.env);
    if (resolver) warnings.push(`custom resolver configured (${resolver}); preview shows its final result and provenance`);

    return {
      path: this.policyPath,
      revision,
      activePreset,
      presets,
      settings,
      baseSettings: pickSimple(policy),
      advanced: {
        candidateCount: Array.isArray(policy.candidates) ? policy.candidates.length : 0,
        ruleCount: Array.isArray(policy.rules) ? policy.rules.length : 0,
        resolverConfigured: resolver != null,
      },
      warnings,
    };
  }

  // Mutating op. expectedRevision is required and compared inside the writer
  // lock; stale or invalid edits throw with file bytes unchanged. Returns the
  // fresh get() snapshot.
  async configure({ action, preset, settings, expectedRevision } = {}) {
    if (!["set", "save-preset", "use-preset", "delete-preset"].includes(action)) {
      throw new TypeError("action must be set, save-preset, use-preset, or delete-preset");
    }
    if (typeof expectedRevision !== "string" || !expectedRevision) {
      throw new TypeError("expectedRevision is required: re-read via get() and retry");
    }
    if ((action === "set" || action === "save-preset") && settings === undefined) {
      throw new TypeError(`${action} requires settings`);
    }
    if (action !== "set" && (typeof preset !== "string" || !preset) && action !== "use-preset") {
      throw new TypeError(`${action} requires a preset name`);
    }
    if (action === "use-preset" && preset !== undefined && preset !== null && typeof preset !== "string") {
      throw new TypeError("use-preset preset must be a preset name or null");
    }
    if (action === "use-preset" && preset === undefined) throw new TypeError("use-preset requires a preset name or explicit null for base settings");
    if (action === "set" && preset !== undefined) throw new TypeError("set changes base settings; use save-preset to edit a named preset");
    if (["use-preset", "delete-preset"].includes(action) && settings !== undefined) throw new TypeError(`${action} does not accept settings`);

    await updatePolicyJson(this.policyPath, async (policy, raw) => {
      if (revisionOf(raw) !== expectedRevision) {
        throw new Error(`routing settings changed since revision ${expectedRevision}; re-read via get() and retry`);
      }

      if (action === "set") {
        validateRoutingSettings(settings, { patch: true });
        for (const [key, value] of Object.entries(settings)) {
          if (value == null) {
            delete policy[key];
            continue;
          }
          if (key === "models") {
            const merged = { ...(isObject(policy.models) ? policy.models : {}) };
            for (const [target, model] of Object.entries(value)) {
              if (model == null) delete merged[target];
              else merged[target] = model;
            }
            if (Object.keys(merged).length) policy.models = merged;
            else delete policy.models;
            continue;
          }
          policy[key] = deepCopy(value);
        }
      } else if (action === "save-preset") {
        validatePresetName(preset);
        validateRoutingSettings(settings);
        policy.presets = isObject(policy.presets) ? policy.presets : {};
        policy.presets[preset] = deepCopy(settings);
      } else if (action === "use-preset") {
        if (preset == null) {
          policy.activePreset = null;
        } else {
          validatePresetName(preset);
          if (!isObject(policy.presets) || !Object.hasOwn(policy.presets, preset)) {
            throw new TypeError(`unknown routing preset: "${preset}"`);
          }
          policy.activePreset = preset;
        }
      } else {
        validatePresetName(preset);
        if (!isObject(policy.presets) || !Object.hasOwn(policy.presets, preset)) {
          throw new TypeError(`unknown routing preset: "${preset}"`);
        }
        if (policy.activePreset === preset) {
          throw new TypeError(`cannot delete active preset "${preset}": use the base policy first`);
        }
        delete policy.presets[preset];
      }

      // The shared writer validates the expanded policy before publication.
    });
    return this.get();
  }

  // Read-only dry run through the real resolver. Never invokes a harness or
  // job API; returns a bounded { target, route, decision, policy, warnings }.
  async preview(args = {}) {
    if (!isObject(args)) throw new TypeError("preview requires an object");
    const { request } = args;
    const presetSpecified = Object.hasOwn(args, "preset");
    const preset = presetSpecified ? args.preset : undefined;
    if (!isObject(request)) throw new TypeError("preview request must be an object");
    if (typeof request.task !== "string" || !request.task.trim()) {
      throw new TypeError("preview request task is required");
    }

    const { raw, policy: saved } = await this.#loadSaved().catch((error) => {
      throw new TypeError(`${error.message}; preview requires a valid saved policy, while a running resolver may still use its last-known-good policy`, { cause: error });
    });
    // The router applies the preset itself from metadata.routing.preset (or
    // the stored activePreset), so the provider hands over the actual saved
    // policy untouched. Resolve here only to fail fast on bad names and to
    // describe the effective settings in warnings.
    const requestedPreset = presetSpecified ? preset : request.metadata?.routing?.preset;
    const resolvedView = resolveUserPreset(saved, requestedPreset);
    const activePreset = saved.activePreset ?? null;
    const effectivePreset = requestedPreset === undefined ? activePreset : requestedPreset;

    const routingMeta = { ...(isObject(request.metadata?.routing) ? request.metadata.routing : {}) };
    if (presetSpecified) routingMeta.preset = preset ?? null;
    let target = request.target;
    if (target == null || target === "auto") {
      // The protocol has no "auto" target: keep a pi placeholder harness and
      // select across targets via mode auto, as graph nodes already do.
      target = "pi";
      routingMeta.mode = routingMeta.mode ?? "auto";
    }
    const input = normalizeRequest({
      ...request,
      requestId: typeof request.requestId === "string" && request.requestId.trim()
        ? request.requestId.trim()
        : "routing-preview",
      target,
      cwd: request.cwd ?? process.cwd(),
      metadata: { ...(isObject(request.metadata) ? request.metadata : {}), routing: routingMeta },
    });

    const resolver = createRouteResolver({
      config: this.config,
      env: this.env,
      loadUserPolicy: async () => ({ policy: saved, staleError: null }),
      modelCatalog: this.modelCatalog,
    });
    const resolved = await resolver(input);
    const decision = resolved.metadata?.harnest?.routingDecision ?? null;

    const warnings = [];
    const hook = resolverSource(this.config, this.env);
    if (hook) warnings.push(`custom resolver configured (${hook}); resolver status: ${decision?.resolver?.status ?? "unknown"}`);
    else if (decision?.resolver) warnings.push(`resolver status: ${decision.resolver.status}`);
    if (hook) warnings.push("preview uses an independent circuit breaker; a running resolver may have an open circuit. Executable hook code is cached until process restart.");
    if (decision?.modelFreshness?.warning) warnings.push(decision.modelFreshness.warning);
    const configuredModel = resolvedView.models?.[resolved.target];
    const slash = configuredModel?.indexOf("/") ?? -1;
    const expectedModel = slash > 0 ? configuredModel.slice(slash + 1) : configuredModel;
    const expectedProvider = slash > 0 ? configuredModel.slice(0, slash) : null;
    if (configuredModel && (resolved.route?.model !== expectedModel || (expectedProvider && resolved.route?.provider !== expectedProvider))) {
      const via = decision?.selected === "explicit-route"
        ? "an explicit route pin"
        : decision?.resolver?.applied ? "the custom resolver" : `policy selection (${decision?.selected ?? "unknown"})`;
      warnings.push(`final model ${resolved.route.model} differs from models.${resolved.target} (${configuredModel}) via ${via}`);
    }

    return {
      target: resolved.target,
      route: resolved.route,
      decision,
      policy: { path: this.policyPath, revision: revisionOf(raw), preset: effectivePreset ?? null },
      evaluation: {
        mode: "saved-policy-snapshot",
        runtimeStateShared: false,
        configRevision: revisionOf(JSON.stringify(this.config.routing ?? {})),
      },
      warnings,
    };
  }
}
