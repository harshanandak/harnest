import { randomUUID } from "node:crypto";
import { redactSecrets } from "./process.mjs";

export const cleanText = (value, max = 200) => String(value ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, max);
const amount = (value) => Number.isFinite(value) ? value.toLocaleString("en-US") : "unknown";

export function invocationTimeline(run, { now = Date.now(), width = 12 } = {}) {
  const calls = run.invocations ?? [];
  const starts = calls.map((call) => Date.parse(call.startedAt)).filter(Number.isFinite);
  if (!starts.length) return new Map();
  const base = Math.min(...starts);
  const end = Math.max(base + 1, ...calls.map((call) => Date.parse(call.completedAt) || (call.state === "running" ? now : Date.parse(call.startedAt) || base)));
  return new Map(calls.map((call) => {
    const start = Date.parse(call.startedAt);
    if (!Number.isFinite(start)) return [call.id, " ".repeat(width)];
    const finish = Date.parse(call.completedAt) || (call.state === "running" ? now : start);
    const left = Math.max(0, Math.min(width - 1, Math.floor((start - base) / (end - base) * width)));
    const right = Math.max(left + 1, Math.min(width, Math.ceil((finish - base) / (end - base) * width)));
    return [call.id, " ".repeat(left) + "=".repeat(right - left) + " ".repeat(width - right)];
  }));
}

export function dynamicRows(run) {
  return (run.invocations ?? []).map((call) => ({
    id: call.id, label: cleanText(call.label || `Agent ${call.ordinal + 1}`, 80),
    state: cleanText(call.state), phase: cleanText(call.phase?.title ?? call.phase),
    target: cleanText(call.target), model: cleanText(call.route?.model ?? "default"),
    thinking: cleanText(call.route?.thinking ?? call.route?.variant ?? "default"),
    jobId: call.jobId ?? null, sessionId: call.sessionId ?? null,
    activity: cleanText(call.progress?.current ?? call.error?.message ?? ""),
    attempts: typeof call.attempts === "number" ? call.attempts : call.attempts?.length ?? 0,
  }));
}

function phaseLines(phase) {
  const title = cleanText(phase.title ?? phase.name ?? phase, 40);
  if (!phase.counts) return [title];
  const { total, ...counts } = phase.counts;
  const states = Object.entries(counts).filter(([, count]) => count > 0).map(([state, count]) => `${count} ${state}`);
  const elapsed = phase.elapsed?.state === "settled" ? `${Math.floor(phase.elapsed.ms / 1000)}s`
    : phase.elapsed?.state === "not-started" ? "not started" : phase.elapsed?.state ?? "unknown";
  const usage = phase.usageTotals ?? {};
  return [
    `${title} | ${total} ${total === 1 ? "agent" : "agents"}${states.length ? ` (${states.join(", ")})` : ""} | Elapsed ${elapsed}`,
    `  Input ${amount(usage.inputTokens)} | Output ${amount(usage.outputTokens)} | Cache read ${amount(usage.cacheReadTokens)} | Cache write ${amount(usage.cacheWriteTokens)}${usage.partial ? " | partial totals" : ""}`,
  ];
}

export function renderDynamicView({ runs = [], run, selectedId, message = "", readOnly = false }, { width = 110, height = 36 } = {}) {
  const lines = ["DYNAMIC WORKFLOWS", ""];
  if (!run) {
    const capacity = Math.max(1, height - 7);
    const selected = Math.max(0, runs.findIndex((row) => row.runId === selectedId));
    const start = Math.max(0, Math.min(selected - Math.floor(capacity / 2), runs.length - capacity));
    if (start) lines.push(`... ${start} earlier workflows`);
    lines.push(...runs.slice(start, start + capacity).map((row) => `${row.runId === selectedId ? ">" : " "} ${cleanText(row.name || row.requestId, 60)}  ${cleanText(row.state)}  ${cleanText(row.runId)}`));
    if (runs.length > start + capacity) lines.push(`... ${runs.length - start - capacity} later workflows`);
    if (!runs.length) lines.push("No workflows match this filter.");
  } else {
    const calls = run.invocations ?? [];
    const startTime = Date.parse(run.startedAt ?? run.createdAt);
    const endTime = run.completedAt ? Date.parse(run.completedAt) : Date.now();
    const elapsed = Number.isFinite(startTime) && Number.isFinite(endTime) ? `${Math.max(0, Math.floor((endTime - startTime) / 1000))}s` : "elapsed unavailable";
    const agents = run.invocationsTotal > calls.length ? `${calls.length}/${run.invocationsTotal} agent rows (paged)` : `${calls.filter((call) => call.state === "completed").length}/${calls.length} agents`;
    lines.push(`${cleanText(run.name || run.requestId)}  ${cleanText(run.state)}  ${agents}  ${elapsed}  attempt ${run.attempt ?? 1}`);
    const usage = run.usageTotals ?? {};
    lines.push(`Input ${amount(usage.inputTokens)} | Output ${amount(usage.outputTokens)} | Cache ${amount(usage.cacheReadTokens)}${usage.partial ? " | partial totals" : ""}`);
    if (run.error) lines.push(`Reason: ${cleanText(run.error.message)}`);
    if (run.controls?.length) lines.push(`Controls: ${run.controls.slice(-3).map((control) => `${cleanText(control.action)} ${cleanText(control.state)}`).join(" | ")}`);
    if (run.phases?.length) {
      const capacity = Math.max(0, Math.floor((height - lines.length - 9) / 2));
      const selectedPhase = calls.find((call) => call.id === selectedId)?.phase;
      const index = run.phases.findIndex((phase) => (phase.title ?? phase) === selectedPhase);
      const start = Math.max(0, index - capacity + 1);
      for (const phase of run.phases.slice(start, start + capacity)) lines.push(...phaseLines(phase));
      if (run.phases.length > capacity) lines.push(`... ${run.phases.length - capacity} more phases in workflow status`);
    }
    lines.push("Observed invocation order (not dependency edges)", "");
    const rows = dynamicRows(run);
    const timeline = invocationTimeline(run);
    const selected = Math.max(0, rows.findIndex((row) => row.id === selectedId));
    const capacity = Math.max(1, height - lines.length - 5);
    const start = Math.max(0, Math.min(selected - Math.floor(capacity / 2), rows.length - capacity));
    if (start) lines.push(`... ${start} earlier agents`);
    for (const row of rows.slice(start, start + capacity)) lines.push(`${row.id === selectedId ? ">" : " "} ${timeline.size ? `[${timeline.get(row.id)}] ` : ""}${row.phase ? `[${row.phase}] ` : ""}${row.label} | ${row.state} | ${row.target}/${row.model} (${row.thinking}) | ${row.activity}`);
    if (rows.length > start + capacity) lines.push(`... ${rows.length - start - capacity} later agents`);
    if (run.invocationsNextCursor !== undefined) lines.push("More agent rows: :next | previous page: :back");
  }
  lines.push("", cleanText(message), readOnly ? "up/down select | enter detail | esc history | q quit (read-only)" : "up/down select | enter detail | p pause | c continue | s stop | : command | ? help | q quit");
  return lines.slice(0, height).map((line) => line.slice(0, width)).join("\n");
}

export class DynamicViewController {
  constructor({ runner, companion, registry, readOnly = false }) {
    Object.assign(this, { runner, companion, registry, readOnly });
    this.runs = [];
    this.run = null;
    this.selectedId = null;
    this.filter = undefined;
    this.message = "";
  }

  async refresh({ next = false, previous = false } = {}) {
    if (this.run) {
      let changedPage = false;
      if (next && this.run.invocationsNextCursor !== undefined) {
        this.invocationPages ??= [];
        this.invocationPages.push(this.invocationCursor ?? null);
        this.invocationCursor = this.run.invocationsNextCursor;
        changedPage = true;
      } else if (previous && this.invocationPages?.length) {
        this.invocationCursor = this.invocationPages.pop();
        changedPage = true;
      }
      const update = await this.runner.status({ runId: this.run.runId, ...(changedPage ? {} : { afterRevision: this.run.revision }), ...(this.invocationCursor == null ? {} : { invocationCursor: this.invocationCursor }) });
      if (!update.unchanged && update.invocations) this.run = update;
      const calls = this.run.invocations ?? [];
      if (!calls.some((call) => call.id === this.selectedId)) this.selectedId = calls[0]?.id ?? null;
    } else {
      if (next && this.nextCursor) this.historyCursor = this.nextCursor;
      const page = await this.runner.history({ limit: 50, state: this.filter, ...(this.historyCursor ? { cursor: this.historyCursor } : {}) });
      this.runs = page.runs;
      this.nextCursor = page.nextCursor;
      if (!this.runs.some((run) => run.runId === this.selectedId)) this.selectedId = this.runs[0]?.runId ?? null;
    }
    return this;
  }

  select(offset) {
    const ids = this.run ? (this.run.invocations ?? []).map((call) => call.id) : this.runs.map((run) => run.runId);
    if (ids.length) this.selectedId = ids[Math.max(0, Math.min(ids.length - 1, ids.indexOf(this.selectedId) + offset))];
  }

  async open(runId = this.selectedId) {
    this.invocationCursor = null;
    this.invocationPages = [];
    this.run = await this.runner.status({ runId });
    this.selectedId = this.run.invocations?.[0]?.id ?? null;
    return this;
  }

  async detail() {
    const call = this.run?.invocations?.find((item) => item.id === this.selectedId);
    if (!call?.jobId) return { invocation: call ?? null, detail: "No child job has been dispatched." };
    const [job, trace, result, history] = await Promise.all([
      this.companion.store.get(call.jobId),
      this.companion.traceReference({ jobId: call.jobId }, { limit: 20 }),
      this.companion.result(call.jobId).catch((error) => ({ unavailable: error.message })),
      this.runner.inspect?.({ runId: this.run.runId, invocationId: call.id, limit: 20 }),
    ]);
    return { invocation: call, controls: this.run.controls ?? [], milestones: call.progress?.recent ?? [], tasklist: trace.receipt?.trace?.progress?.tasklist ?? call.progress?.tasklist ?? [], history: history ?? null, prompt: redactSecrets(job.request.task).slice(0, 20000), trace, result };
  }

  async control(action, options = {}) {
    if (this.readOnly) throw new Error("This viewer is read-only.");
    if (!this.run) throw new Error("Open a workflow first.");
    const input = { ...options, runId: this.run.runId, commandId: randomUUID() };
    if (["stop-agent", "restart-agent", "steer", "reroute"].includes(action)) {
      if (!this.selectedId) throw new Error("Select an agent first.");
      input.invocationId = this.selectedId;
    }
    const result = action === "resume" ? await this.runner.resume(input) : await this.runner.control({ ...input, action });
    this.message = `${action}: ${result.state ?? "recorded; inspect status"}`;
    await this.refresh();
    return result;
  }
}

export function watchDynamicView({ runner, runId, sessionId, render, onError, intervalMs = 2000 }) {
  let stopped = false;
  let refreshing = false;
  let failures = 0;
  let previous;
  const refresh = async () => {
    if (stopped || refreshing) return;
    refreshing = true;
    try {
      let selected = runId;
      if (!selected) {
        const page = await runner.history({ limit: 20 });
        if (sessionId) {
          for (const row of page.runs) {
            const status = await runner.status({ runId: row.runId, invocationLimit: 1000 });
            if (status.invocations?.some((call) => call.sessionId === sessionId)) { selected = row.runId; break; }
          }
        }
        selected ??= page.runs.find((row) => ["running", "queued", "paused", "waiting"].includes(row.state))?.runId ?? page.runs[0]?.runId;
        if (!selected) { if (!stopped) render({ runs: [] }); return; }
      }
      const update = await runner.status({ runId: selected, ...(sessionId ? { invocationLimit: 1000 } : {}), ...(previous?.runId === selected ? { afterRevision: previous.revision } : {}) });
      if (stopped) return;
      if (!update.unchanged) previous = update;
      failures = 0;
      render({ run: previous, selectedId: previous?.invocations?.find((call) => call.sessionId === sessionId)?.id, readOnly: true });
    } catch (error) {
      if (!stopped) onError?.(error);
      if (++failures >= 3) stop();
    } finally { refreshing = false; }
  };
  const timer = setInterval(() => { void refresh(); }, intervalMs);
  timer.unref?.();
  const stop = () => { stopped = true; clearInterval(timer); };
  void refresh();
  return stop;
}
