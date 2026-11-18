// Fixture engine for dynamic-runner tests. It implements the documented
// engine boundary (validateScript/runScript) over a tiny JSON plan so tests can
// exercise ordering, fan-out, races, pause/stop and replay without QuickJS.
//
// Source format (a JSON string):
//   {
//     "name": "...", "phases": ["plan", ...],
//     "plan": [
//       {"type":"agent","prompt":"...","options":{...}},
//       {"type":"parallel","calls":[{"prompt":"..."}, ...]},
//       {"type":"race","calls":[{"prompt":"..."}, ...]},
//       {"type":"log","message":"..."},
//       {"type":"phase","title":"..."},
//       {"type":"throw","message":"..."},
//       {"type":"sleep","ms":10}
//     ]
//   }
// The final value is { results, args, name }.
//
// Adapters receive the prompt string verbatim. Tests encode per-child behavior
// in that prompt as JSON (see dynamic-runner-adapter.mjs).

function abortError() {
  return Object.assign(new Error("fixture script aborted"), { name: "AbortError", details: { kind: "aborted" } });
}

export async function validateScript(source) {
  if (typeof source !== "string" || !source.trim()) throw Object.assign(new TypeError("script source is required"), { details: { kind: "validation" } });
  let parsed;
  try { parsed = JSON.parse(source); } catch { throw Object.assign(new TypeError("fixture engine expects a JSON script"), { details: { kind: "validation" } }); }
  if (!parsed || !Array.isArray(parsed.plan)) throw Object.assign(new TypeError("fixture script requires a plan array"), { details: { kind: "validation" } });
  return {
    meta: { name: parsed.name ?? "fixture", description: parsed.description ?? "", phases: parsed.phases ?? [] },
    body: parsed.plan,
  };
}

export async function runScript({ source, args = null, onAgent, onPhase, onLog, onIdle, signal, limits = {} } = {}) {
  const parsed = JSON.parse(source);
  const maxItems = Number.isInteger(limits.maxHelperItems) ? limits.maxHelperItems : 4096;
  const check = () => { if (signal?.aborted) throw abortError(); };
  // Model guest quiescence: callbacks are registered, then the guest has
  // nothing runnable while it awaits them, so the replay barrier can flush.
  const idle = async () => { check(); if (typeof onIdle === "function") await onIdle(); check(); };
  const call = (entry) => onAgent(String(entry.prompt ?? ""), entry.options ?? undefined);
  for (const title of parsed.phases ?? []) { check(); await onPhase(String(title)); }
  const results = [];
  for (const step of parsed.plan) {
    check();
    switch (step.type) {
      case "phase": await onPhase(String(step.title)); results.push(step.title); break;
      case "log": await onLog(String(step.message ?? "")); break;
      case "throw": throw new Error(String(step.message ?? "fixture failure"));
      case "sleep": await new Promise((resolve) => setTimeout(resolve, Number(step.ms) || 0)); break;
      case "agent": { const pending = call(step); await idle(); results.push(await pending); break; }
      case "value": results.push(step.value); break;
      case "parallel": {
        if (step.calls.length > maxItems) throw Object.assign(new Error(`collection exceeds ${maxItems} items`), { details: { kind: "limit" } });
        // Attach the join before quiescence, exactly like the real engine's
        // guest calling parallel(...) before awaiting: handler attachment order
        // is guest order, and the recorded resolution order decides the race.
        const joined = Promise.all(step.calls.map(call));
        await idle();
        results.push(await joined);
        break;
      }
      case "race": {
        if (step.calls.length > maxItems) throw Object.assign(new Error(`collection exceeds ${maxItems} items`), { details: { kind: "limit" } });
        const joined = Promise.race(step.calls.map(call));
        await idle();
        results.push(await joined);
        break;
      }
      default: throw new Error(`unknown fixture step: ${step.type}`);
    }
  }
  check();
  return { results, args, name: parsed.name ?? "fixture" };
}

export default { validateScript, runScript };
