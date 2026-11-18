import { redactSecrets } from "./process.mjs";
import { projectPhases } from "./dynamic-protocol.mjs";

const fail = (kind, message) => Object.assign(new Error(message), { details: { kind } });

export async function inspectDynamicInvocation(runner, { runId, invocationId, offset = 0, limit = 20 }) {
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 50) throw fail("validation", "invalid attempt page");
  const record = await runner.store.readRun(runId);
  if (!record) throw fail("not-found", "workflow was not found");
  const call = record.calls.find((item) => item.id === invocationId);
  if (!call) throw fail("not-found", "invocation was not found");
  const phase = (record.phases ?? []).find((item) => (item.title ?? item) === call.phase);
  const attempts = await Promise.all(call.attempts.slice(offset, offset + limit).map(async (attempt) => {
    const receipt = attempt.jobId ? await runner.companion.status(attempt.jobId).catch((error) => ({ unavailable: redactSecrets(error.message).slice(0, 500) })) : null;
    return {
      attempt: attempt.attempt, requestId: attempt.requestId ?? null,
      jobId: attempt.jobId ?? null, sessionId: attempt.sessionId ?? null,
      state: attempt.state, startedAt: attempt.startedAt ?? null, completedAt: attempt.completedAt ?? null,
      route: receipt?.route ?? null,
      target: receipt?.target ?? null,
      usageSummary: receipt?.usageSummary ?? null,
      error: receipt?.error ? { message: redactSecrets(receipt.error.message).slice(0, 1000), kind: receipt.error.details?.kind ?? null } : null,
      ...(receipt?.unavailable ? { unavailable: receipt.unavailable } : {}),
    };
  }));
  return {
    runId, invocationId, label: call.label, state: call.state, phase: call.phase,
    phaseSummary: phase === undefined ? null : projectPhases(record, [phase])[0],
    invalidated: Boolean(call.invalidated), reused: Boolean(call.reused),
    attempts, totalAttempts: call.attempts.length,
    nextOffset: offset + limit < call.attempts.length ? offset + limit : null,
  };
}
