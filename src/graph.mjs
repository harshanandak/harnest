import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Companion } from "./companion.mjs";
import { digestContext, MAX_CONTEXT_BYTES, normalizeRequest, stableJson, TERMINAL_STATES } from "./protocol.mjs";
import { assertGraphLeaf, bytes, childIdFor, compactError, cwdOverlaps, GRAPH_TERMINAL, graphError, graphIdFor, normalizeGraph } from "./graph-protocol.mjs";
import { GraphStore, wait } from "./graph-store.mjs";

const active = (s) => s === "queued" || s === "running";
// A node is unsafe to retry only when a stop was requested and never
// acknowledged. `interrupted` proves the owner process is gone, and `timeout`
// is a terminal adapter failure whose abort the child already signaled; both
// must stay recoverable or a restart dead-ends the graph. `persistence` and
// `cancel-unacknowledged` remain failures with unknown child state. A
// completed receipt is settled by definition: stale cancellation metadata
// cannot make it "possibly still executing".
const uncertain = (r) => r?.state !== "completed" && (
  r?.cancellation?.state === "unacknowledged" || r?.cancellation?.state === "requested"
  || ["cancel-unacknowledged", "persistence"].includes(r?.error?.details?.kind) || r?.error?.details?.uncertain
  || r?.cleanupError || r?.error?.details?.unsafeResume || r?.error?.details?.cleanupError?.length
  || ((r?.state === "cancelled" || r?.error?.details?.aborted) && r?.cancellation?.state !== "acknowledged"));
const now = () => new Date().toISOString();

function view(record, outputs = false) {
  // Older interrupted snapshots can retain a running node's last observation.
  const stateOf = (node) => GRAPH_TERMINAL.has(record.state) && node.state === "running" ? "partial" : node.state;
  const counts = { total: record.nodes.length, pending: 0, running: 0, completed: 0, failed: 0, partial: 0, cancelled: 0, blocked: 0 };
  for (const node of record.nodes) counts[stateOf(node)]++;
  return {
    graphId: record.graphId, requestId: record.requestId, state: record.state,
    createdAt: record.createdAt, updatedAt: record.updatedAt, completedAt: record.completedAt ?? null,
    recoveryRequired: Boolean(record.recoveryRequired), cancellation: record.cancellation ?? null,
    generation: record.generation, revision: record.revision, commandId: record.commandId ?? null, counts,
    elapsedMs: Math.max(0, Date.parse(record.completedAt ?? record.updatedAt) - Date.parse(record.createdAt)),
    nodes: record.nodes.map((node) => ({
      id: node.id, target: node.target, dependsOn: node.dependsOn, state: stateOf(node),
      route: node.route, routingDecision: node.routingDecision ?? null, jobId: node.jobId, requestId: node.requestId,
      attempts: node.attempts, progress: node.progress ? {
        ...node.progress,
        activeTool: node.progress.activeTool ? { ...node.progress.activeTool, elapsedMs: Math.max(0, Date.now() - Date.parse(node.progress.activeTool.startedAt)) } : null,
      } : null, error: node.error ?? null,
      receipt: node.receipt ? { ...node.receipt, result: undefined } : null,
    })).map((node) => JSON.parse(JSON.stringify(node))),
    errors: [...record.errors, ...record.nodes.filter((node) => node.error).map((node) => ({ nodeId: node.id, ...node.error }))],
    ...(outputs ? { outputs: Object.fromEntries(record.spec.outputs.map((id) => [id, record.nodes.find((node) => node.id === id).receipt?.result ?? null])) } : {}),
  };
}

function observe(record, node, receipt) {
  if (!receipt || receipt.requestId !== node.requestId) throw graphError("identity", `child identity mismatch: ${node.id}`);
  node.jobId = receipt.jobId;
  node.progress = receipt.trace?.progress && bytes(receipt.trace.progress) <= 8_000 ? receipt.trace.progress : null;
  // Elapsed time changes on every read; persist timestamps so polling does not
  // advance the graph revision without a semantic change.
  if (node.progress?.activeTool) node.progress = { ...node.progress, activeTool: { ...node.progress.activeTool, elapsedMs: undefined } };
  const attempt = node.attempts.at(-1);
  if (attempt) { attempt.jobId = receipt.jobId; attempt.sessionId = receipt.sessionId ?? attempt.sessionId; attempt.state = receipt.state; }
  if (!TERMINAL_STATES.has(receipt.state)) return;
  node.state = receipt.state;
  node.error = receipt.error ? compactError(receipt.error) : null;
  node.uncertain = Boolean(uncertain(receipt));
  node.receipt = {
    jobId: receipt.jobId, requestId: receipt.requestId, target: receipt.target, route: receipt.route,
    contextDigest: receipt.contextDigest, state: receipt.state, sessionId: receipt.sessionId ?? null,
    workflowRunId: receipt.workflowRunId ?? null, trace: { ref: receipt.trace?.ref ?? `job:${receipt.jobId}:events` },
    execution: receipt.execution ?? null,
    cancellation: receipt.cancellation ?? null, error: node.error, result: receipt.result ?? null,
  };
  const resultBytes = record.nodes.reduce((total, item) => total + bytes(item.receipt?.result ?? null), 0);
  if (resultBytes > MAX_CONTEXT_BYTES) {
    node.receipt.result = null; node.state = "partial";
    node.error = compactError(graphError("output-too-large", "graph results exceed context byte limit; retrieve the child result by jobId"));
    node.receipt.state = "partial"; node.receipt.error = node.error;
  }
  if (attempt) { attempt.state = node.state; attempt.completedAt = now(); }
}

function interruptGraph(record, error) {
  for (const node of record.nodes) {
    if (node.state !== "running") continue;
    // Preserve the last observed attempt so resume can adopt the same child.
    node.state = "partial";
    node.uncertain = true;
  }
  if (record.cancellation?.state === "requested") record.cancellation.state = "unacknowledged";
  record.state = "partial";
  record.recoveryRequired = true;
  record.lease = null;
  record.errors.push(compactError(error));
  record.updatedAt = now();
}

export class GraphRunner {
  #runFences = new WeakMap();

  constructor({ companion = new Companion(), graphDir, pollIntervalMs = 100, heartbeatIntervalMs = 1_000, leaseTimeoutMs = 30_000 } = {}) {
    this.companion = companion;
    this.store = new GraphStore(graphDir ?? join(companion.store.root, "graphs"));
    for (const [key, value] of Object.entries({ pollIntervalMs, heartbeatIntervalMs, leaseTimeoutMs })) {
      if (!Number.isInteger(value) || value < 1) throw graphError("validation", `${key} must be a positive integer`);
      this[key] = value;
    }
    this.ownerId = randomUUID();
    this.running = new Map();
  }

  async #prepare(graph, normalized) {
    const spec = normalized ?? await normalizeGraph(graph);
    const graphId = graphIdFor(spec.requestId);
    const digest = digestContext({ ...spec, execution: { ...spec.execution, background: true } });
    // Every resolver finishes before the first durable dispatch intent.
    const prepared = [];
    for (const node of spec.nodes) {
      const automatic = node.requestedTarget === "auto";
      const { pendingExecution, ...preparedNode } = node;
      const { sessionId = node.request.execution.sessionId, ...controls } = pendingExecution ?? {};
      const execution = { ...node.request.execution, sessionId };
      if (controls.sessionAction === "resume") {
        execution.sessionAction = controls.sessionAction;
        delete controls.sessionAction;
      }
      const base = normalizeRequest({ ...node.request, execution, contextDigest: undefined, context: {
        ...node.request.context, graph: { graphId, nodeId: node.id, requestId: spec.requestId, task: spec.task, upstream: {} },
      } });
      let resolved = normalizeRequest(await this.companion.routeResolver(base));
      // The resolver selects target/model for automatic nodes only. Every
      // caller-owned pin, identity, cwd, context, timeout and policy bound must
      // survive unchanged; a resolver that rewrites them is rejected before any
      // durable dispatch intent.
      if (resolved.requestId !== base.requestId || resolved.contextDigest !== base.contextDigest || resolved.task !== base.task) throw graphError("identity", `resolved node ${node.id} changed request identity`);
      if (resolved.cwd !== node.request.cwd) throw graphError("validation", `resolved node ${node.id} changed the prevalidated cwd`);
      if (resolved.execution.timeoutMs !== base.execution.timeoutMs) throw graphError("validation", `resolved node ${node.id} changed the requested timeout`);
      if (stableJson(resolved.execution) !== stableJson(base.execution)) throw graphError("validation", `resolved node ${node.id} changed the requested execution controls`);
      if (!automatic && resolved.target !== node.request.target) throw graphError("routing", `resolved node ${node.id} changed an explicit target`);
      // Every route field the caller actually supplied is a pin, including
      // serverUrl and thinking; presence, not truthiness, decides. An auto
      // node with an empty route is fully policy-selected; once the caller
      // supplies a field it is protected the same way.
      for (const [key, value] of Object.entries(node.request.route)) {
        if (stableJson(resolved.route[key]) !== stableJson(value)) throw graphError("routing", `resolved node ${node.id} changed an explicit route.${key}`);
      }
      if (automatic && resolved.target === "acp" && !resolved.route.agent) throw graphError("routing", `automatic node ${node.id} has no usable agent route`);
      if (automatic && !["acp", "amp"].includes(resolved.target) && !resolved.route.model) throw graphError("routing", `automatic node ${node.id} has no usable model route`);
      assertGraphLeaf(resolved);
      if (resolved.workflow != null) throw graphError("policy", `resolved node ${node.id} added a workflow`);
      if (stableJson(resolved.policy) !== stableJson(node.request.policy)) throw graphError("policy", `resolved node ${node.id} changed graph policy`);
      if (Object.keys(controls).length) {
        resolved = normalizeRequest({ ...resolved, execution: { ...resolved.execution, ...controls } });
      }
      prepared.push({ ...preparedNode, request: resolved });
    }
    return { spec: { ...spec, nodes: prepared }, graphId, digest };
  }

  async validate(graph) {
    const { spec, graphId, digest } = await this.#prepare(graph);
    return { valid: true, graphId, requestId: spec.requestId, digest, maxConcurrency: spec.execution.maxConcurrency, nodes: spec.nodes.map((n) => ({ id: n.id, target: n.request.target, route: n.request.route, routingDecision: n.request.metadata?.harnest?.routingDecision ?? null, dependsOn: n.dependsOn })), outputs: spec.outputs };
  }

  #claim(record) {
    record.generation++;
    record.lease = { ownerId: this.ownerId, fence: record.generation, heartbeatAt: Date.now(), timeoutMs: this.leaseTimeoutMs };
    record.state = "running"; record.recoveryRequired = false; record.updatedAt = now();
    record.deadlineAt = Date.now() + record.spec.execution.timeoutMs;
    record.completedAt = null;
  }

  #owned(record, fence) { return record?.lease?.ownerId === this.ownerId && record.lease.fence === fence && active(record.state); }

  #leaseExpired(record) {
    if (!active(record.state)) return false;
    const run = this.running.get(record.graphId);
    // This runner can verify its own live fence even if disk I/O delayed a heartbeat.
    if (run && this.#owned(record, this.#runFences.get(run))) return false;
    return !record.lease || Date.now() - record.lease.heartbeatAt > record.lease.timeoutMs;
  }

  async start(graph) {
    const normalized = await normalizeGraph(graph);
    const existing = await this.store.read(graphIdFor(normalized.requestId));
    if (existing) {
      if (existing.digest !== digestContext({ ...normalized, execution: { ...normalized.execution, background: true } })) throw graphError("request-conflict", "requestId already belongs to a different graph");
      return normalized.execution.background ? this.status(existing.graphId) : this.#wait(existing.graphId);
    }
    const { spec, graphId, digest } = await this.#prepare(graph, normalized);
    let claimed = false;
    const record = await this.store.transact(graphId, async (existing, save) => {
      if (existing) {
        if (existing.digest !== digest) throw graphError("request-conflict", "requestId already belongs to a different graph");
        return existing;
      }
      const record = { graphId, requestId: spec.requestId, digest, spec, state: "queued", generation: 0, lease: null,
        createdAt: now(), updatedAt: now(), errors: [], commands: [], nodes: spec.nodes.map((node) => ({
          id: node.id, dependsOn: node.dependsOn, target: node.request.target, route: node.request.route, routingDecision: node.request.metadata?.harnest?.routingDecision ?? null,
          state: "pending", jobId: null, requestId: null, attempts: [], receipt: null,
        })) };
      this.#claim(record); await save(record); claimed = true; return record;
    });
    if (claimed) this.#launch(record);
    if (!spec.execution.background) return this.#wait(graphId);
    return this.status(graphId);
  }

  async #lookup(node) {
    if (!node.requestId) return null;
    try { return node.jobId ? await this.companion.status(node.jobId) : await this.companion.statusByRequestId(node.requestId); }
    catch (error) { if (error.code === "ENOENT" || error.details?.kind === "not-found") return null; throw error; }
  }

  async status(graphId, { afterRevision, waitMs = 0 } = {}) {
    if (afterRevision !== undefined && (!Number.isSafeInteger(afterRevision) || afterRevision < 0)) throw graphError("validation", "afterRevision must be a nonnegative safe integer");
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 25_000) throw graphError("validation", "waitMs must be between 0 and 25000");
    const deadline = Date.now() + waitMs;
    for (;;) {
      let record = await this.store.read(graphId);
      if (!record) throw graphError("not-found", "graph not found");
      if (this.#leaseExpired(record)) {
        record = await this.store.transact(graphId, async (current, save) => {
          if (!current) throw graphError("not-found", "graph not found");
          if (this.#leaseExpired(current)) {
            interruptGraph(current, graphError("interrupted", "graph owner lease expired; explicit resume required"));
            current.generation++;
            await save(current);
          }
          return current;
        });
      }
      if (afterRevision !== record.revision) return view(record);
      if (Date.now() >= deadline || GRAPH_TERMINAL.has(record.state)) return { graphId, requestId: record.requestId, state: record.state, revision: record.revision, unchanged: true };
      await wait(Math.min(250, Math.max(10, this.pollIntervalMs), deadline - Date.now()));
    }
  }

  async result(graphId) {
    const status = await this.status(graphId);
    if (!GRAPH_TERMINAL.has(status.state)) throw graphError("not-terminal", `graph is ${status.state}; poll status before result`);
    const record = await this.store.read(graphId);
    if (!GRAPH_TERMINAL.has(record.state)) throw graphError("not-terminal", "graph resumed before result was read");
    return view(record, true);
  }

  async cancel(graphId) {
    const stopJobs = [];
    await this.store.transact(graphId, async (record, save) => {
      if (!record) throw graphError("not-found", "graph not found");
      if (record.state === "completed" || record.state === "cancelled") return;
      record.cancellation ??= { state: "requested", requestedAt: now() };
      // Reserve each child stop while holding the graph mutation lock. A
      // separate dispatch marker lets the owner replay a caller that dies
      // after this save and before the child cancellation intent is stored.
      for (const node of record.nodes) {
        const interrupted = record.recoveryRequired && node.state === "partial" && node.uncertain;
        if (!node.jobId || (node.state !== "running" && !interrupted)) continue;
        const attempt = node.attempts.at(-1);
        if (attempt && !attempt.stopDispatchedAt) {
          attempt.stopRequestedAt ??= now();
          stopJobs.push({ attempt: attempt.attempt, jobId: node.jobId, nodeId: node.id });
        }
      }
      record.updatedAt = now(); await save(record);
    });
    for (const stop of stopJobs) {
      await this.#stop(stop.jobId);
      await this.store.transact(graphId, async (record, save) => {
        const attempt = record?.nodes.find((node) => node.id === stop.nodeId)?.attempts.find((item) => item.attempt === stop.attempt);
        if (!attempt || attempt.stopDispatchedAt) return;
        attempt.stopDispatchedAt = now(); record.updatedAt = now(); await save(record);
      });
    }
    return this.status(graphId);
  }

  async #stop(jobId) {
    let requested = true;
    if (this.companion.store?.transition) {
      requested = Boolean(await this.companion.store.transition(jobId, (job) => {
        if (!active(job.receipt.state) || job.receipt.cancellation) return null;
        job.receipt.cancellation = { state: "requested", requestedAt: now(), requestedBy: this.ownerId, acknowledgedAt: null };
        return job;
      }));
    }
    return requested ? this.companion.cancel(jobId) : this.companion.status(jobId);
  }

  async resume({ graphId, commandId, nodeIds, approveWrites = false, background = true } = {}) {
    if (typeof commandId !== "string" || !commandId.trim() || commandId.length > 200) throw graphError("validation", "commandId is required and at most 200 characters");
    if (typeof approveWrites !== "boolean" || typeof background !== "boolean") throw graphError("validation", "resume flags must be boolean");
    if (nodeIds !== undefined && (!Array.isArray(nodeIds) || nodeIds.length > 256 || nodeIds.some((id) => typeof id !== "string" || !id.trim() || id.length > 64) || new Set(nodeIds).size !== nodeIds.length)) throw graphError("validation", "nodeIds must be at most 256 unique node ids of at most 64 characters");
    await this.status(graphId);
    const identity = digestContext({ nodeIds: nodeIds ? [...nodeIds].sort() : null, approveWrites });
    let claimed = false;
    const record = await this.store.transact(graphId, async (record, save) => {
      const prior = record.commands.find((c) => c.commandId === commandId);
      if (prior) {
        if (prior.identity !== identity) throw graphError("resume-conflict", "commandId already belongs to another resume request");
        return record;
      }
      if (active(record.state)) throw graphError("resume-conflict", "graph already has an active attempt");
      if (record.state === "completed") throw graphError("resume-conflict", "completed graph cannot be resumed");
      if (nodeIds?.some((id) => !record.nodes.some((node) => node.id === id))) throw graphError("validation", "unknown resume node id");
      // Reconcile even unselected intents: an old active child is adopted, never
      // relaunched. Completed descendants and native sessions survive recovery.
      for (const node of record.nodes) {
        if (node.state === "completed") { node.uncertain = false; continue; }
        if (!node.requestId) continue;
        const receipt = await this.#lookup(node);
        if (receipt) {
          observe(record, node, receipt);
          // A dispatch-time error may have set uncertain before the child was
          // findable; a confirmed-active child is known, not unknown. The
          // terminal observation recomputes uncertainty either way.
          if (active(receipt.state)) { node.state = "running"; node.uncertain = false; }
        }
        else if (node.state === "running" || !node.jobId) { node.state = "partial"; node.uncertain = false; }
      }
      const unresolved = record.nodes.find((node) => node.uncertain);
      if (unresolved) throw graphError("unsafe-resume", `node ${unresolved.id} may still be executing; reconcile its native stop before retrying`);
      const selected = record.nodes.filter((node) => node.state !== "completed" && node.state !== "running" && (!nodeIds || nodeIds.includes(node.id) || node.state === "blocked"));
      for (const node of selected) {
        if (node.error?.details?.kind === "output-too-large") throw graphError("unsafe-resume", `node ${node.id} already completed but its output exceeds the graph bound; retrieve its child receipt`);
        if (node.uncertain) throw graphError("unsafe-resume", `node ${node.id} may still be executing; reconcile its native stop before retrying`);
        if (node.attempts.length && record.spec.nodes.find((n) => n.id === node.id).request.policy.write && !approveWrites) throw graphError("policy", `retrying write node ${node.id} requires approveWrites`);
      }
      for (const node of selected) { node.state = "pending"; node.receipt = null; node.error = null; node.progress = null; node.jobId = null; node.requestId = null; }
      // Restore unstarted cancelled nodes like blocked ones; a node that already
      // ran keeps its cancelled attempt and waits for an explicit retry.
      for (const node of record.nodes) if (node.state === "blocked" || (node.state === "cancelled" && node.attempts.length === 0)) node.state = "pending";
      record.errors = []; record.cancellation = null; record.commandId = commandId;
      this.#claim(record);
      record.commands.push({ commandId, identity, generation: record.generation });
      await save(record); claimed = true; return record;
    });
    if (claimed) this.#launch(record);
    return background ? this.status(graphId) : this.#wait(graphId);
  }

  #launch(record) {
    const fence = record.lease.fence, id = record.graphId;
    const promise = this.#run(id, fence).catch(async (error) => {
      await this.store.transact(id, async (current, save) => {
        if (!this.#owned(current, fence)) return;
        interruptGraph(current, error);
        await save(current);
      }).catch(() => {});
    }).finally(() => { if (this.running.get(id) === promise) this.running.delete(id); });
    this.#runFences.set(promise, fence);
    this.running.set(id, promise);
  }

  async #wait(id) {
    for (;;) {
      const status = await this.status(id);
      if (GRAPH_TERMINAL.has(status.state)) return this.result(id);
      await wait(this.pollIntervalMs);
    }
  }

  async #run(id, fence) {
    let heartbeatBusy = false;
    const heartbeat = setInterval(() => {
      if (heartbeatBusy) return;
      heartbeatBusy = true;
      void this.store.transact(id, async (record, save) => {
        if (!this.#owned(record, fence)) return;
        record.lease.heartbeatAt = Date.now(); await save(record);
      }).catch(() => {}).finally(() => { heartbeatBusy = false; });
    }, this.heartbeatIntervalMs);
    try {
      for (;;) {
        const current = await this.store.read(id);
        if (!this.#owned(current, fence)) return;
        const observations = await Promise.all(current.nodes.filter((node) => node.state === "running").map(async (node) => [node.id, await this.#lookup(node)]));
        const keepGoing = await this.store.transact(id, async (record, save) => {
          if (!this.#owned(record, fence)) return false;
          record.lease.heartbeatAt = Date.now();
          for (const [nodeId, receipt] of observations) if (receipt) observe(record, record.nodes.find((node) => node.id === nodeId), receipt);
          if (Date.now() >= record.deadlineAt && !record.cancellation) {
            record.cancellation = { state: "requested", reason: "timeout", requestedAt: now() };
            record.errors.push(compactError(graphError("timeout", "graph wall-clock timeout exceeded")));
          }
          if (record.cancellation) {
            for (const node of record.nodes) if (["pending", "blocked"].includes(node.state)) node.state = "cancelled";
            const stopJobs = [];
            for (const node of record.nodes.filter((item) => item.state === "running" && item.jobId)) {
              const attempt = node.attempts.at(-1);
              if (attempt && !attempt.stopDispatchedAt) {
                attempt.stopRequestedAt ??= now();
                stopJobs.push({ attempt, node, jobId: node.jobId });
              }
            }
            await save(record);
            for (const { attempt, node, jobId } of stopJobs) {
              const receipt = await this.#stop(jobId);
              attempt.stopDispatchedAt = now();
              if (receipt) observe(record, node, receipt);
            }
            const cancelGraceMs = Math.max(5_000, this.companion.cancelAckTimeoutMs ?? 5_000) + this.leaseTimeoutMs;
            for (const node of record.nodes.filter((item) => item.state === "running")) {
              const attempt = node.attempts.at(-1);
              if (attempt?.stopDispatchedAt && Date.now() - Date.parse(attempt.stopDispatchedAt) > cancelGraceMs) {
                node.state = "partial"; node.uncertain = true; node.error = compactError(graphError("cancel-unacknowledged", "child stop has not been acknowledged"));
              }
            }
          } else {
            const dispatches = [];
            for (const node of record.nodes) {
              if (node.state !== "pending") continue;
              const dependencies = node.dependsOn.map((dep) => record.nodes.find((n) => n.id === dep));
              if (dependencies.some((dep) => ["failed", "partial", "cancelled", "blocked"].includes(dep.state))) { node.state = "blocked"; continue; }
              if (!dependencies.every((dep) => dep.state === "completed")) continue;
              const running = record.nodes.filter((n) => n.state === "running");
              if (running.length >= record.spec.execution.maxConcurrency) break;
              const spec = record.spec.nodes.find((n) => n.id === node.id);
              if (Date.now() >= record.deadlineAt) break;
              const previous = node.attempts.at(-1);
              const { execution } = spec.request;
              const sessionId = previous?.sessionId ?? execution.sessionId;
              const sessionAction = execution.sessionAction === "fork" && sessionId !== execution.sessionId
                ? "resume" : execution.sessionAction;
              const roots = [spec.request.cwd, ...(execution.addDirs ?? [])];
              if (running.some((active) => {
                const other = record.spec.nodes.find((n) => n.id === active.id).request;
                if (sessionId && other.target === spec.request.target && active.attempts.at(-1)?.sessionId === sessionId) return true;
                if (!spec.request.policy.write && !other.policy.write) return false;
                return [other.cwd, ...(other.execution.addDirs ?? [])].some((root) => roots.some((path) => cwdOverlaps(root, path)));
              })) continue;
              const requestId = childIdFor(id, node.id, node.attempts.length + 1);
              const upstream = Object.fromEntries(dependencies.map((dep) => [dep.id, { jobId: dep.jobId, target: dep.receipt.target, route: dep.receipt.route, result: dep.receipt.result }]));
              let request;
              try {
                request = normalizeRequest({ ...spec.request, contextDigest: undefined, requestId, execution: { ...execution, background: true, sessionId, sessionAction }, context: {
                  ...spec.request.context, graph: { graphId: id, nodeId: node.id, requestId: record.requestId, task: record.spec.task, upstream },
                } });
              } catch (error) { node.state = "failed"; node.error = compactError(error); continue; }
              node.state = "running"; node.requestId = requestId;
              node.attempts.push({ attempt: node.attempts.length + 1, requestId, jobId: null, sessionId, continuation: sessionId ? "native-session" : "fresh", state: "dispatching", scheduledAt: now(), startedAt: null });
              dispatches.push({ node, request });
            }
            // One durable intent batch precedes concurrent leaf launches. Hold
            // the mutation lock across spawn so recovery cannot fence halfway.
            if (dispatches.length) {
              await save(record);
              await Promise.all(dispatches.map(async ({ node, request }) => {
                if (Date.now() >= record.deadlineAt) {
                  // companion.start is not called below; drop the prepared
                  // attempt so resume sees an unstarted node, not a stopped run.
                  node.attempts.pop();
                  node.jobId = null; node.requestId = null; node.state = "cancelled";
                  return;
                }
                node.attempts.at(-1).startedAt = now();
                try { observe(record, node, await this.companion.start(request, { routeResolved: true })); }
                catch (error) { node.state = "partial"; node.uncertain = true; node.error = compactError(error); }
              }));
            }
          }
          if (!record.nodes.some((node) => node.state === "running")) {
            // A non-topological input can leave blocked propagation for the next
            // pass. No runnable roots means settle all remaining pending nodes.
            const ready = record.nodes.some((node) => node.state === "pending" && node.dependsOn.every((dep) => record.nodes.find((n) => n.id === dep).state === "completed"));
            if (!ready || record.cancellation) {
              for (const node of record.nodes) if (node.state === "pending") node.state = "blocked";
              record.state = record.nodes.every((node) => node.state === "completed") ? "completed"
                : record.cancellation && record.cancellation.reason !== "timeout" && !record.nodes.some((node) => node.uncertain || ["failed", "partial"].includes(node.state)) ? "cancelled" : "partial";
              if (record.cancellation) record.cancellation.state = record.nodes.some((node) => node.uncertain) ? "unacknowledged" : "acknowledged";
              record.lease = null; record.completedAt = now();
            }
          }
          // Native start/stop calls above run while this transaction holds the
          // mutation lock, so the interval heartbeat may have been unable to
          // persist. Commit a current heartbeat (when still owned) before the
          // save so a racing status cannot fence a live owner.
          if (record.lease) record.lease.heartbeatAt = Date.now();
          record.updatedAt = now(); await save(record);
          return active(record.state);
        });
        if (!keepGoing) return;
        await wait(this.pollIntervalMs);
      }
    } finally { clearInterval(heartbeat); }
  }
}
