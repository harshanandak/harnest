import { ACP_ROUTE_FIELDS, hasToolPolicy, routeControlError } from "./protocol.mjs";

export function isClaudeRoute(route) {
  const value = route && typeof route === "object" ? route : {};
  const provider = typeof value.provider === "string" ? value.provider.toLowerCase() : "";
  const models = [value.model, value.modelId, value.id].filter((model) => typeof model === "string");
  return /anthropic|claude/.test(provider) || models.some((model) => {
    const name = model.trim();
    return /anthropic|claude/i.test(name) || /^(sonnet|opus|haiku|fable)([-_].*)?$/i.test(name.split("/").at(-1));
  });
}

export function assertNoClaudeRoute(target, route) {
  if (target === "claude" || target === "acp" || !isClaudeRoute(route)) return;
  const name = ({ pi: "Pi", opencode: "OpenCode", codex: "Codex", cursor: "Cursor", gemini: "Gemini", amp: "Amp", acp: "ACP" })[target] ?? String(target || "Adapter");
  throw Object.assign(new Error(`${name} cannot run Claude models; request target "claude" (Claude Code CLI) instead`), {
    name: `${name}AdapterError`,
    details: { kind: "policy", hint: 'use target "claude" with route.model naming the Claude model or alias' },
  });
}

export function adapterRouteRejectionReasons(target, route) {
  const reasons = [];
  if (!["claude", "acp"].includes(target) && isClaudeRoute(route)) reasons.push("claude-model");
  if (target === "gemini") {
    const provider = typeof route?.provider === "string" ? route.provider.toLowerCase() : null;
    if (provider && !["google", "gemini", "google-gemini", "google/gemini"].includes(provider)) reasons.push("gemini-provider");
    const model = route?.model;
    if (model != null && (typeof model !== "string" || !/^[a-zA-Z0-9._/-]+$/.test(model) || !/^gemini-/i.test(model))) {
      reasons.push("gemini-model");
    }
    if (["agent", "variant", "harnessVersion", "serverUrl"].some((field) => route?.[field] != null)) {
      reasons.push("gemini-route-control");
    }
  }
  if (target === "amp") {
    const unsupported = ["provider", "model", "agent", "thinking", "harnessVersion", "serverUrl"]
      .filter((field) => route?.[field] != null);
    if (unsupported.length) reasons.push("amp-route-control");
    if (route?.variant != null && !["low", "medium", "high", "ultra"].includes(route.variant)) reasons.push("amp-variant");
  }
  if (target === "acp") {
    const unsupported = Object.keys(route ?? {}).filter((field) => !ACP_ROUTE_FIELDS.includes(field) && route[field] != null);
    if (unsupported.length || typeof route?.agent !== "string" || !route.agent.trim()) reasons.push("acp-route-control");
  }
  const thinking = route?.thinking;
  if (["cursor", "gemini"].includes(target) && thinking != null && (typeof thinking !== "string" || thinking.trim())) {
    reasons.push("thinking-control");
  }
  if (!reasons.includes(`${target}-route-control`) && routeControlError(target, route)) {
    reasons.push("native-route-control");
  }
  return reasons;
}

export function assertAdapterRoute(target, route) {
  assertNoClaudeRoute(target, route);
  const reasons = adapterRouteRejectionReasons(target, route);
  if (reasons.includes("gemini-provider")) {
    throw Object.assign(new Error("Gemini route.provider must be google, gemini, google-gemini, or google/gemini"), {
      name: "GeminiAdapterError",
      details: { kind: "policy", hint: "omit route.provider or use the native Google/Gemini provider" },
    });
  }
  if (reasons.includes("gemini-model")) {
    throw Object.assign(new Error("Gemini route.model must be a safe native Gemini model ID beginning with gemini-"), {
      name: "GeminiAdapterError",
      details: { kind: "policy", hint: "use a native model ID such as gemini-3-pro" },
    });
  }
  if (reasons.includes("gemini-route-control")) {
    throw Object.assign(new Error("Gemini route supports only provider and model; agent, variant, harnessVersion, and serverUrl are unsupported"), {
      name: "GeminiAdapterError",
      details: { kind: "policy", hint: "remove unsupported route controls" },
    });
  }
  if (reasons.includes("amp-route-control")) {
    throw Object.assign(new Error("Amp route supports only route.variant; model, provider, agent, thinking, harnessVersion, and serverUrl are unsupported"), {
      name: "AmpAdapterError",
      details: { kind: "policy", hint: "use route.variant low, medium, high, or ultra" },
    });
  }
  if (reasons.includes("amp-variant")) {
    throw Object.assign(new Error("Amp route.variant must be low, medium, high, or ultra"), {
      name: "AmpAdapterError",
      details: { kind: "policy", hint: "use a native Amp mode: low, medium, high, or ultra" },
    });
  }
  if (reasons.includes("acp-route-control")) {
    throw Object.assign(new Error("ACP requires route.agent and supports only advertised model, variant, and options controls"), {
      name: "AcpAdapterError",
      details: { kind: "policy", hint: "select a trusted registration and omit unsupported route controls" },
    });
  }
  if (reasons.includes("thinking-control")) {
    const name = ({ cursor: "Cursor", gemini: "Gemini", amp: "Amp" })[target] ?? "Adapter";
    throw Object.assign(new Error(`${name} route.thinking is not supported by this adapter`), {
      name: `${name}AdapterError`,
      details: { kind: "policy", hint: target === "cursor" ? "set route.model to a thinking-capable model ID instead of route.thinking" : "omit route.thinking" },
    });
  }
  if (reasons.includes("native-route-control")) {
    throw Object.assign(new Error(routeControlError(target, route)), { details: { kind: "policy" } });
  }
}

export function adapterPolicyRejectionReasons(target, policy = {}, execution = {}) {
  const reasons = [];
  if (["amp", "acp"].includes(target) && policy.write !== true) reasons.push("read-only");
  if (hasToolPolicy(policy.tools)) {
    const legacy = Array.isArray(policy.tools);
    if (["amp", "acp", "codex", "cursor"].includes(target)
      || (["claude", "gemini"].includes(target) && (legacy || execution.transport === "session"))
      || (["opencode", "pi"].includes(target) && !legacy && policy.tools.allow !== undefined)) reasons.push("granular-tools");
  }
  if (policy.mode !== undefined && (target !== "cursor" || execution.transport === "session")) reasons.push("policy.mode");
  if (policy.sandbox !== undefined && (target !== "cursor" || execution.transport === "session" || policy.sandbox === false)) reasons.push("policy.sandbox");
  if (["gemini", "amp", "acp"].includes(target) && policy.maxCostUsd != null) reasons.push("cost-budget");
  return reasons;
}

export function assertAdapterPolicy(target, policy = {}, execution) {
  const reasons = adapterPolicyRejectionReasons(target, policy, execution);
  if (reasons.includes("read-only")) {
    const name = target === "acp" ? "ACP" : "Amp";
    throw Object.assign(new Error(`${name} cannot enforce a read-only request; set policy.write true only when workspace writes are intended`), {
      name: `${target === "acp" ? "Acp" : "Amp"}AdapterError`,
      details: { kind: "policy", hint: "choose another target for read-only work" },
    });
  }
  if (reasons.includes("granular-tools")) {
    const name = target === "acp" ? "ACP" : target[0].toUpperCase() + target.slice(1);
    throw Object.assign(new Error(`${name} does not support granular policy.tools in this form or transport`), {
      name: `${name}AdapterError`,
      details: { kind: "policy", field: "policy.tools" },
    });
  }
  const cursorControl = reasons.find((reason) => reason.startsWith("policy."));
  if (cursorControl) {
    throw Object.assign(new Error(`${cursorControl} is unsupported for ${target} with this value or transport; Cursor print mode supports plan and sandbox=true`), {
      details: { kind: "policy", field: cursorControl },
    });
  }
  if (reasons.includes("cost-budget")) {
    const name = target === "gemini" ? "Gemini" : target === "acp" ? "Acp" : "Amp";
    throw Object.assign(new Error(`${name === "Acp" ? "ACP" : name} does not enforce policy.maxCostUsd`), {
      name: `${name}AdapterError`,
      details: { kind: "policy", hint: "omit policy.maxCostUsd or choose a target with native budget enforcement" },
    });
  }
}

export function assertNoClaudeWorkflow(target, workflow) {
  if (!workflow || typeof workflow !== "object") return;
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (!Array.isArray(value)) {
      assertNoClaudeRoute(target, { model: value.model, modelId: value.modelId, provider: value.provider });
      if (value.model && typeof value.model === "object") assertNoClaudeRoute(target, value.model);
    }
    for (const child of Object.values(value)) if (child && typeof child === "object") visit(child);
  };
  visit(workflow);
}
