// T3 bridge: the Companion-side data boundary for the T3 Code Agents panel.
//
// The T3 disposable fork exposes an authenticated same-origin REST endpoint
// that loads this module once from a trusted operator module path and calls
// createT3Bridge({stateDir}).dispatch({operation, input}). Every operation is
// served by an existing Companion/dynamic-runner API — this module invents no
// display states, no native events and no persistence. Control/resume remain
// durable runner writes; "accepted" is never reported as "applied" here
// because the raw control summary carries both states verbatim.
//
// Deliberately absent: start/validate/invoke/save/list/get/delete. A T3
// panel must observe and steer existing runs, never launch external work
// through an HTTP surface. `result` is read-only and terminal-gated: the
// existing runner API refuses active runs, so it cannot bypass any state.
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { Companion } from "./companion.mjs";
import { workerAdapterFactory } from "./job-worker.mjs";
import { dynamicToolDefinitions, lazyDynamicRunner } from "./dynamic-tools.mjs";
import { bytes } from "./dynamic-protocol.mjs";
import { redactSecrets } from "./process.mjs";

// Largest accepted dispatch body. A 128 KiB ceiling covers every operation
// the bridge serves (control.message is capped at 50,000 characters by the
// tool schema; resume no longer accepts a source replacement, see below).
// T3's HTTP layer may cap below this, never above.
const MAX_REQUEST_BYTES = 128 * 1024;

// Operation -> scope classification. Read operations never dispatch a child
// adapter or mutate durable state; write operations are the two durable
// runner mutations (control, resume) with normal policy semantics preserved.
export const T3_BRIDGE_OPERATIONS = Object.freeze({
  history: "read",
  status: "read",
  inspect: "read",
  trace: "read",
  result: "read",
  control: "write",
  resume: "write",
});

// Identifier shapes fixed by the stores: dynamic run records live at
// runs/<dyn-64hex>.json (dynamic-store.mjs RUN_ID) and job records at
// <jobId>.json where JobStore.path allows only alphanumerics and dashes.
// The bridge checks the shape up front so a traversal attempt fails with a
// validation error before any filesystem path is built.
const RUN_ID = /^dyn-[a-f0-9]{64}$/;
const JOB_ID = /^[a-zA-Z0-9-]{1,100}$/;
const INVOCATION_ID = /^inv-\d{1,6}$/;
const ID_FIELDS = { runId: RUN_ID, jobId: JOB_ID, invocationId: INVOCATION_ID };

const bridgeError = (kind, message) =>
  Object.assign(new Error(redactSecrets(message)), { details: { kind, bridge: "t3" } });

// Reuse the exact zod schemas the dynamic MCP tools expose, so HTTP callers
// cannot widen inputs beyond what the tool surface accepts. The runner proxy
// is never called: only `inputSchema` is consumed.
const noopRunner = new Proxy({}, {});
const toolSchemas = Object.fromEntries(
  dynamicToolDefinitions(noopRunner).map(({ name, inputSchema }) => [
    name.replace(/^handoff_dynamic_/, ""),
    inputSchema,
  ]),
);

// Trace has no dynamic-tool equivalent; mirror job-store.readTrace's own
// bounds (limit 1..200, afterSequence >= 0) with jobId-only resolution so a
// trace can never be read for an arbitrary path.
const traceSchema = z.object({
  jobId: z.string().trim().min(1).max(200),
  afterSequence: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(200).optional(),
}).strict();

// Resume deliberately narrows the MCP tool schema: the dynamic tool accepts a
// `source` replacement, but a T3 panel must never replay (or silently
// substitute) workflow source over HTTP. Replay always uses the spec revision
// stored with the run; a changed source needs the normal approveWrites review
// path outside this bridge.
const resumeSchema = z.object({
  runId: z.string().trim().min(1).max(200),
  commandId: z.string().trim().min(1).max(200),
  approveWrites: z.boolean().optional(),
}).strict();

const envelopeSchema = z.object({
  operation: z.enum(Object.keys(T3_BRIDGE_OPERATIONS)),
  input: z.record(z.string(), z.unknown()).optional(),
}).strict();

function rejectBadIds(input) {
  for (const [field, pattern] of Object.entries(ID_FIELDS)) {
    const value = input[field];
    if (value === undefined) continue;
    if (typeof value !== "string" || !pattern.test(value)) {
      throw bridgeError("validation", `${field} has an invalid shape`);
    }
  }
}

export async function createT3Bridge({ stateDir, adapterPath } = {}) {
  if (typeof stateDir !== "string" || !stateDir.trim()) {
    throw bridgeError("validation", "stateDir is required");
  }
  if (!isAbsolute(stateDir)) {
    throw bridgeError("validation", "stateDir must be an absolute path");
  }
  if (stateDir.split(/[\\/]+/).some((segment) => segment === "..")) {
    throw bridgeError("validation", "stateDir must not contain traversal segments");
  }
  // Trusted startup adapter seam (never reachable over HTTP): mirrors
  // src/dynamic-worker.mjs and src/job-worker.mjs. A resume dispatched here
  // executes its new attempt in this process, so the Companion that owns the
  // children must resolve adapters the operator chose at startup. Production
  // T3 servers leave the path unset and use the real harnesses; the zero-paid
  // demo sets HARNEST_WORKER_ADAPTER to the fake adapter fixture.
  const resolvedAdapterPath = adapterPath ?? process.env.HARNEST_WORKER_ADAPTER;
  const companionOptions = { stateDir, detachBackground: false };
  if (resolvedAdapterPath) {
    if (typeof resolvedAdapterPath !== "string" || !isAbsolute(resolvedAdapterPath)
      || resolvedAdapterPath.split(/[\\/]+/).some((segment) => segment === "..")) {
      throw bridgeError("validation", "adapterPath must be an absolute path without traversal segments");
    }
    companionOptions.adapterFactory = workerAdapterFactory(
      await import(resolvedAdapterPath.startsWith("file:") ? resolvedAdapterPath : pathToFileURL(resolvedAdapterPath).href),
    );
  }
  const companion = new Companion(companionOptions);
  const runner = lazyDynamicRunner({ companion });

  const dispatch = async (request) => {
    let body;
    try {
      body = bytes(request);
    } catch {
      throw bridgeError("validation", "request must be JSON");
    }
    if (body > MAX_REQUEST_BYTES) {
      throw bridgeError("limit", `request exceeds the ${MAX_REQUEST_BYTES}-byte bridge bound`);
    }
    const parsed = envelopeSchema.safeParse(request ?? {});
    if (!parsed.success) {
      throw bridgeError("validation", `invalid bridge request: ${redactSecrets(parsed.error.issues.map((issue) => `${issue.path.join(".") || "envelope"} ${issue.message}`).join("; "))}`);
    }
    const { operation, input = {} } = parsed.data;
    if (operation === "resume" && Object.hasOwn(input, "source")) {
      // Rejected before any store access or execution: replay always uses the
      // spec revision stored with the run.
      throw bridgeError("validation", "resume source replacement is not exposed over the bridge; replay uses the stored spec revision");
    }
    const schema = operation === "trace" ? traceSchema : operation === "resume" ? resumeSchema : toolSchemas[operation];
    const op = schema.safeParse(input);
    if (!op.success) {
      throw bridgeError("validation", `invalid ${operation} input: ${redactSecrets(op.error.issues.map((issue) => `${issue.path.join(".") || "input"} ${issue.message}`).join("; "))}`);
    }
    rejectBadIds(op.data);
    try {
      if (operation === "trace") {
        const { jobId, afterSequence, limit } = op.data;
        return await companion.traceReference(
          { jobId },
          { ...(afterSequence === undefined ? {} : { afterSequence }), ...(limit === undefined ? {} : { limit }) },
        );
      }
      return await runner[operation](op.data);
    } catch (error) {
      // Existing APIs already redact their own bounded surfaces; the bridge
      // only sanitizes the transport message so no secret escapes via HTTP.
      const kind = error?.details?.kind ?? "internal";
      throw Object.assign(
        new Error(redactSecrets(String(error?.message ?? "bridge operation failed")).slice(0, 1000)),
        { details: { kind: kind === "not-active" ? "persistence" : kind, bridge: "t3", operation } },
      );
    }
  };

  return { dispatch };
}
