import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Companion } from "../src/companion.mjs";
import { JobStore } from "../src/job-store.mjs";
import { boundedProviderText } from "../src/process.mjs";

for (const scheme of ["Bearer", "Basic"]) for (const encoding of ["header", "escaped", "incomplete"]) {
  test(`${scheme} ${encoding} authorization is absent from durable errors and parent-visible progress`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "harnest-redaction-boundary-"));
    t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
    const sentinel = "synthetic-audit-payload";
    const raw = encoding === "escaped" ? JSON.stringify({ message: `Authorization: ${scheme} "${sentinel}"` })
      : encoding === "incomplete" ? `Authorization: ${scheme} "${sentinel}`
      : `HTTP 401 Authorization: ${scheme} ${sentinel}`;
    const store = new JobStore(root);
    const companion = new Companion({
      store,
      routeResolver: async (request) => request,
      adapterFactory: () => ({ async run(_request, { onProgress }) {
        await onProgress({ type: "provider-error", text: raw, headers: { authorization: `${scheme} ${sentinel}` } });
        throw Object.assign(new Error(boundedProviderText(raw)), {
          details: { kind: "provider-auth", stderr: raw, hint: raw },
        });
      } }),
    });
    const receipt = await companion.start({ requestId: `redaction-${scheme}`, target: "codex",
      task: "synthetic redaction check", cwd: root, policy: { write: false }, execution: { timeoutMs: 5000 } });
    assert.equal(receipt.state, "failed");
    const stored = await new JobStore(root).get(receipt.jobId);
    const status = await companion.status(receipt.jobId);
    const trace = await companion.traceReference({ jobId: receipt.jobId }, { limit: 50 });
    for (const [label, value] of [["durable error", stored.receipt.error], ["status", status], ["trace", trace]]) {
      assert.equal(JSON.stringify(value).includes(sentinel), false, `${label} retains synthetic authorization payload`);
    }
    stored.traceCheckpoint.version = 1;
    stored.traceCheckpoint.summary.progress.current = raw;
    await writeFile(join(root, `${receipt.jobId}.json`), JSON.stringify(stored));
    const recovered = await new Companion({ store: new JobStore(root) }).status(receipt.jobId);
    assert.equal(JSON.stringify(recovered.trace).includes(sentinel), false, "old checkpoint must replay with current redaction");
    await store.commit(stored, { at: new Date().toISOString(), activity: raw, event: { type: "diagnostic", text: raw } });
    const listed = await companion.sessions();
    assert.equal(JSON.stringify(listed).includes(sentinel), false, "session summaries must redact activity strings");
  });
}
