import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { digestContext, MAX_CONTEXT_BYTES, MAX_TIMEOUT_MS, normalizeRequest, normalizeRoute, POLICY_FIELDS, stableJson, TARGETS } from "./protocol.mjs";
import { assertAdapterPolicy, assertAdapterRoute } from "./model-policy.mjs";

export const GRAPH_TERMINAL = new Set(["completed", "partial", "cancelled"]);
export const MAX_GRAPH_BYTES = 1_000_000;
export const MAX_NODE_ID_LENGTH = 64;
export const MAX_REQUEST_ID_LENGTH = 200;
const NODE_TARGETS = new Set([...TARGETS, "auto"]);
export const graphError = (kind, message) => Object.assign(new Error(message), { details: { kind } });
export const graphIdFor = (requestId) => `graph-${digestContext(requestId)}`;
export const childIdFor = (graphId, nodeId, attempt) => `${graphId}:${nodeId}:${attempt}`;
export const bytes = (value) => Buffer.byteLength(stableJson(value), "utf8");

export function assertGraphLeaf(request) {
  const { target, route, policy } = request;
  assertAdapterRoute(target, route);
  assertAdapterPolicy(target, policy);
  if (["claude", "codex", "cursor", "gemini", "amp", "acp"].includes(target) && policy.tools.length) throw graphError("policy", `${target} does not support granular policy.tools`);
  // Graph nodes are prompt-only. Pi's Taskflow budget is not enforced on this
  // path, and OpenCode has no prompt-only budget enforcement either.
  if (target !== "claude" && policy.maxCostUsd != null) throw graphError("policy", `${target} does not enforce maxCostUsd for prompt-only graph nodes`);
  if (target === "opencode" && !route.model) throw graphError("validation", "OpenCode graph node requires explicit route.model");
  if (target !== "acp" && route.model && !/^[a-zA-Z0-9._/[\]=,+-]+$/.test(route.model)) throw graphError("validation", `invalid ${target} route.model`);
  if (route.provider && !/^[a-zA-Z0-9._/-]+$/.test(route.provider)) throw graphError("validation", `invalid ${target} route.provider`);
  if (route.harnessVersion && !["v1", "v2"].includes(route.harnessVersion)) throw graphError("validation", "invalid harnessVersion");
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw graphError("validation", `${label} must be an object`);
  return value;
}

function only(value, keys, label) {
  object(value, label);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw graphError("validation", `${label}.${key} is unsupported; expected one of ${keys.join(", ")}`);
}

function text(value, label) {
  if (typeof value !== "string" || !value.trim()) throw graphError("validation", `${label} is required`);
  return value.trim();
}

function policy(input = {}, parent) {
  only(input, POLICY_FIELDS, "policy");
  const aliases = [input.write, input.readOnly === undefined ? undefined : !input.readOnly, input.allowWrites].filter((v) => v !== undefined);
  for (const key of ["write", "readOnly", "allowWrites"]) if (input[key] !== undefined && typeof input[key] !== "boolean") throw graphError("validation", `policy.${key} must be boolean`);
  if (aliases.some((v) => v !== aliases[0])) throw graphError("policy", "contradictory write policy aliases");
  const result = { write: aliases[0] ?? parent?.write ?? false, tools: input.tools ?? parent?.tools ?? [], maxCostUsd: input.maxCostUsd ?? parent?.maxCostUsd ?? null };
  if (!Array.isArray(result.tools) || result.tools.some((v) => typeof v !== "string" || !v.trim())) throw graphError("validation", "policy.tools must be an array of tool names");
  if (result.maxCostUsd !== null && (!Number.isFinite(result.maxCostUsd) || result.maxCostUsd <= 0)) throw graphError("validation", "policy.maxCostUsd must be positive");
  if (parent && result.write && !parent.write) throw graphError("policy", "node cannot escalate graph write policy");
  if (parent?.tools.length && (!result.tools.length || result.tools.some((tool) => !parent.tools.includes(tool)))) throw graphError("policy", "node cannot widen allowed tools");
  if (parent?.maxCostUsd != null && result.maxCostUsd > parent.maxCostUsd) throw graphError("policy", "node cannot increase cost ceiling");
  return result;
}

export function mergeData(root = {}, node = {}) {
  const result = { ...root, ...node };
  for (const key of Object.keys(node)) {
    if (root[key] && node[key] && typeof root[key] === "object" && typeof node[key] === "object" && !Array.isArray(root[key]) && !Array.isArray(node[key])) {
      Object.defineProperty(result, key, { value: mergeData(root[key], node[key]), enumerable: true, writable: true, configurable: true });
    }
  }
  for (const key of ["requiredResultFields", "requiredText"]) {
    if (root[key] !== undefined || node[key] !== undefined) {
      if (![root[key] ?? [], node[key] ?? []].every((v) => Array.isArray(v) && v.every((s) => typeof s === "string"))) throw graphError("validation", `${key} must be a string array`);
      result[key] = [...new Set([...(root[key] ?? []), ...(node[key] ?? [])])];
    }
  }
  return result;
}

async function directory(cwd) {
  if (typeof cwd !== "string" || !isAbsolute(cwd) || !(await stat(cwd).catch(() => null))?.isDirectory()) throw graphError("validation", "cwd must be an existing absolute directory");
  return realpath(cwd);
}

export function cwdOverlaps(a, b) {
  if (process.platform === "win32") { a = a.toLowerCase(); b = b.toLowerCase(); }
  const contains = (left, right) => { const rel = relative(left, right); return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel)); };
  return contains(a, b) || contains(b, a);
}

export async function normalizeGraph(input) {
  try { if (bytes(input) > MAX_GRAPH_BYTES) throw new Error(); } catch { throw graphError("validation", `graph must be JSON and at most ${MAX_GRAPH_BYTES} bytes`); }
  only(input, ["requestId", "cwd", "task", "context", "policy", "metadata", "execution", "nodes", "outputs"], "graph");
  const requestId = text(input.requestId, "requestId");
  if (requestId.length > MAX_REQUEST_ID_LENGTH) throw graphError("validation", `requestId must be at most ${MAX_REQUEST_ID_LENGTH} characters`);
  const cwd = await directory(input.cwd);
  const rootPolicy = policy(input.policy);
  const execution = input.execution ?? {};
  only(execution, ["background", "timeoutMs", "maxConcurrency"], "execution");
  if (execution.background !== undefined && typeof execution.background !== "boolean") throw graphError("validation", "execution.background must be boolean");
  const maxConcurrency = execution.maxConcurrency ?? 4;
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 6) throw graphError("validation", "maxConcurrency must be between 1 and 6");
  const timeoutMs = execution.timeoutMs ?? 3_600_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) throw graphError("validation", "invalid graph timeoutMs");
  const context = object(input.context ?? {}, "context");
  const metadata = object(input.metadata ?? {}, "metadata");
  if (input.task !== undefined) text(input.task, "task");
  if (bytes(context) > MAX_CONTEXT_BYTES) throw graphError("validation", "graph context exceeds context byte limit");
  if (!Array.isArray(input.nodes) || input.nodes.length < 1 || input.nodes.length > 256) throw graphError("validation", "graph requires 1 to 256 nodes");
  const ids = new Set();
  const nodes = [];
  for (const node of input.nodes) {
    only(node, ["id", "target", "task", "dependsOn", "route", "cwd", "context", "policy", "metadata", "execution"], "node");
    const id = text(node.id, "node.id");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id) || ["__proto__", "constructor", "prototype"].includes(id)) throw graphError("validation", `invalid node id: ${id}`);
    if (ids.has(id)) throw graphError("validation", `duplicate node id: ${id}`);
    ids.add(id);
    if (!NODE_TARGETS.has(node.target)) throw graphError("validation", `node ${id} requires an explicit target (opencode, pi, cursor, claude, codex, gemini, amp, acp, or auto)`);
    const dependsOn = node.dependsOn ?? [];
    if (!Array.isArray(dependsOn) || dependsOn.some((v) => typeof v !== "string") || new Set(dependsOn).size !== dependsOn.length) throw graphError("validation", `invalid dependencies: ${id}`);
    if (dependsOn.length > 256) throw graphError("validation", `node ${id} has more than 256 dependencies`);
    only(node.execution ?? {}, ["timeoutMs"], "node.execution");
    const nodeTimeoutMs = node.execution?.timeoutMs;
    if (nodeTimeoutMs !== undefined && (!Number.isInteger(nodeTimeoutMs) || nodeTimeoutMs < 1 || nodeTimeoutMs > MAX_TIMEOUT_MS)) throw graphError("validation", `node ${id} execution.timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}`);
    normalizeRoute(node.route ?? {}, "node.route");
    const request = normalizeRequest({
      requestId: childIdFor(graphIdFor(requestId), id, 1), target: node.target === "auto" ? "pi" : node.target, task: node.task,
      cwd: node.cwd === undefined ? cwd : await directory(node.cwd),
      context: mergeData(context, object(node.context ?? {}, "node.context")),
      metadata: mergeData(metadata, object(node.metadata ?? {}, "node.metadata")),
      policy: policy(node.policy, rootPolicy), route: node.route ?? {},
      execution: { ...node.execution, background: true },
    });
    if (node.target === "auto") request.metadata = { ...request.metadata, routing: { ...request.metadata.routing, mode: "auto" } };
    nodes.push({ id, dependsOn, requestedTarget: node.target, request });
  }
  const visiting = new Set(), visited = new Set();
  const visit = (id) => {
    if (!ids.has(id)) throw graphError("validation", `unknown dependency: ${id}`);
    if (visiting.has(id)) throw graphError("validation", `cycle at node: ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of nodes.find((n) => n.id === id).dependsOn) visit(dep);
    visiting.delete(id); visited.add(id);
  };
  for (const id of ids) visit(id);
  const outputs = input.outputs ?? nodes.filter((node) => !nodes.some((other) => other.dependsOn.includes(node.id))).map((n) => n.id);
  if (!Array.isArray(outputs) || new Set(outputs).size !== outputs.length || outputs.some((id) => !ids.has(id))) throw graphError("validation", "outputs must reference unique known nodes");
  return { requestId, cwd, task: input.task ?? null, context, policy: rootPolicy, metadata, execution: { background: execution.background ?? true, timeoutMs, maxConcurrency }, nodes, outputs };
}

export function compactError(error) {
  const unsafeResume = Boolean(error?.details?.unsafeResume || error?.details?.cleanupError?.length);
  return { name: error?.name ?? "Error", message: String(error?.message ?? error).slice(0, 1000), details: { kind: error?.details?.kind ?? "graph", uncertain: Boolean(error?.details?.uncertain || unsafeResume), unsafeResume } };
}
