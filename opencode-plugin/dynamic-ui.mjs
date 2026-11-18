import * as graphs from "./graph-render.mjs";

let runtime;
const snapshots = new Map();
async function runner() {
  const url = "__HARNEST_DYNAMIC_CLIENT_URL__";
  runtime ??= import(url.startsWith("__") ? new URL("../src/daemon-client.mjs", import.meta.url).href : url)
    .then(async ({ ensureDaemon, createDaemonClient }) => {
      await ensureDaemon();
      const client = createDaemonClient();
      return Object.fromEntries(["history", "status", "resume", "control"].map((method) => [
        method, async (args) => (await client.call(`handoff_dynamic_${method}`, args)).workflow,
      ]));
    }).catch((error) => {
      runtime = null;
      throw error;
    });
  return runtime;
}
const text = (value) => String(value ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 200);

export async function listGraphs(options = {}) {
  const [fixed, dynamic] = await Promise.all([graphs.listGraphs(), (await runner()).history({ limit: 50 })]);
  const runs = await Promise.all(dynamic.runs.map(async (summary, index) => {
    const previous = snapshots.get(summary.runId);
    let record = previous?.revision === summary.revision && previous?.updatedAt === summary.updatedAt ? previous : summary;
    if ((index < 6 || summary.runId === options.selected) && (!record.invocations || record === summary)) {
      record = await (await runner()).status({ runId: summary.runId, invocationLimit: 1000 });
      snapshots.set(summary.runId, record);
    }
    return { id: record.runId, kind: "dynamic", record };
  }));
  const retained = new Set(dynamic.runs.map((run) => run.runId));
  for (const id of snapshots.keys()) if (!retained.has(id)) snapshots.delete(id);
  return [...fixed, ...runs].sort((a, b) => String(b.record.updatedAt ?? "").localeCompare(String(a.record.updatedAt ?? "")));
}

export function graphTitle(workflow) {
  return workflow.kind === "dynamic" ? text(workflow.record.name || workflow.record.requestId) : graphs.graphTitle(workflow);
}

export function graphForSession(workflows, sessionId) {
  return workflows.find((workflow) => workflow.kind === "dynamic" && workflow.record.invocations?.some((call) => call.sessionId === sessionId)) ?? graphs.graphForSession(workflows, sessionId);
}

export function graphWaterfallRows(workflow) {
  if (workflow.kind !== "dynamic") return graphs.graphWaterfallRows(workflow);
  const calls = workflow.record.invocations ?? [];
  return [[{ text: `${graphTitle(workflow)}  ${text(workflow.record.state)}`, color: graphs.MUTED }],
    [{ text: "JavaScript · observed order", color: graphs.MUTED }],
    ...calls.slice(0, 30).map((call) => [
      { text: `${graphs.GLYPH[call.state] ?? "·"} ${call.phase ? `[${text(call.phase.title ?? call.phase)}] ` : ""}${text(call.label || `Agent ${call.ordinal + 1}`)}`, color: graphs.COLOR[call.state] ?? graphs.MUTED },
      { spacer: true },
      { text: `${text(call.route?.model ?? call.target)} · ${text(call.route?.thinking ?? call.route?.variant ?? "default")}`, color: graphs.MUTED },
    ]), ...(calls.length > 30 ? [[{ text: `${calls.length - 30} more agents · open dynamic viewer`, color: graphs.MUTED }]] : [])];
}

export function graphListRows(workflows, options) {
  return graphs.graphListRows(workflows.map((workflow) => workflow.kind === "dynamic" ? {
    ...workflow, spec: { task: graphTitle(workflow) }, record: { ...workflow.record, nodes: workflow.record.invocations ?? [] },
  } : workflow), options);
}

export async function controlWorkflow(runId, action, options = {}) {
  const api = await runner();
  const input = { ...options, runId, commandId: globalThis.crypto.randomUUID() };
  return action === "resume" ? api.resume(input) : api.control({ ...input, action });
}

export async function workflowAction(workflow, action, ui, dispatch = controlWorkflow) {
  const options = {};
  if (["stop-agent", "restart-agent", "steer", "reroute", "session"].includes(action)) {
    const callId = await ui.dialog.select({ title: "Select agent", options: (workflow.record.invocations ?? []).map((call) => ({ title: text(call.label || `Agent ${call.ordinal + 1}`), value: call.id, description: `${text(call.state)} · ${text(call.target)} · ${text(call.route?.model)}` })) });
    if (!callId) return null;
    options.invocationId = callId;
    if (action === "session") {
      const call = workflow.record.invocations.find((item) => item.id === callId);
      if (call.target === "opencode" && call.sessionId) ui.router.navigate({ type: "session", sessionID: call.sessionId });
      else await ui.dialog.alert({ title: text(call.label), message: `Native ${text(call.target)} session: ${text(call.sessionId || "not assigned")}\nJob: ${text(call.jobId || "not dispatched")}` });
      return null;
    }
  }
  if (action === "steer") {
    options.message = await ui.dialog.prompt({ title: "Guide selected agent", placeholder: "Guidance for the current work" });
    if (!options.message?.trim()) return null;
  }
  if (action === "reroute") {
    const input = await ui.dialog.prompt({ title: "Change selected agent route", placeholder: '{"provider":"...","model":"...","thinking":"..."}' });
    if (!input?.trim()) return null;
    options.route = JSON.parse(input);
    if (!options.route || typeof options.route !== "object" || Array.isArray(options.route)) throw new Error("Route must be a JSON object");
  }
  try { return await dispatch(workflow.id, action, options); }
  catch (error) {
    if (!["resume", "restart-agent"].includes(action) || !/approv.*writ|writ.*approv/i.test(error.message)) throw error;
    const approved = await ui.dialog.confirm({ title: "Retry write-capable work?", message: "This retry can repeat file changes. Approve only after reviewing the prior attempt.", label: { confirm: "Approve retry", cancel: "Keep stopped" } });
    if (!approved) return null;
    return dispatch(workflow.id, action, { ...options, approveWrites: true });
  }
}
