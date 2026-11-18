// Fixture child adapter for dynamic-runner tests. Prompt is a JSON instruction:
//   {
//     "delayMs": 10,
//     "result": { "finalText": "ok" },
//     "usage": { "input_tokens": 3, "output_tokens": 2 },   // optional
//     "fail": false,                                         // throw instead of resolve
//     "ignoreAbort": false                                   // never ack a stop
//   }
// It honours the adapter contract: run(request, { signal, onProgress }).

function abortError() {
  return Object.assign(new Error("fixture adapter aborted"), { name: "AbortError", details: { kind: "aborted", aborted: true } });
}

function parse(prompt) {
  try { return JSON.parse(prompt); } catch { return {}; }
}

export function adapterFactory(target) {
  return {
    async run(request, { signal, onProgress } = {}) {
      const instruction = parse(request.task);
      if (instruction.preProgress && typeof onProgress === "function") await onProgress({ phase: "starting", target });
      const delayMs = Number(instruction.delayMs) || 0;
      const sleep = new Promise((resolve) => setTimeout(resolve, delayMs));
      if (delayMs && !instruction.ignoreAbort) {
        await Promise.race([
          sleep,
          new Promise((_, reject) => {
            if (signal?.aborted) reject(abortError());
            signal?.addEventListener?.("abort", () => reject(abortError()), { once: true });
          }),
        ]);
      } else {
        await sleep;
      }
      if (signal?.aborted && !instruction.ignoreAbort) throw abortError();
      if (instruction.fail) throw new Error(instruction.failMessage || "fixture adapter failure");
      return {
        sessionId: `fixture-${target}-${Math.random().toString(16).slice(2, 8)}`,
        result: instruction.result ?? { finalText: `ok:${target}` },
        ...(instruction.usage ? { usage: instruction.usage } : {}),
      };
    },
  };
}

export default adapterFactory;
