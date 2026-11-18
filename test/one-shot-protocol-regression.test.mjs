import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ClaudeAdapter } from "../src/adapters/claude.mjs";
import { CodexAdapter } from "../src/adapters/codex.mjs";
import { CursorAdapter } from "../src/adapters/cursor.mjs";
import { Companion } from "../src/companion.mjs";
import { JobStore } from "../src/job-store.mjs";

class OutputChild extends EventEmitter {
  constructor(stdout) {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdin = { write() { return true; }, end() {} };
    queueMicrotask(() => {
      for (const chunk of Array.isArray(stdout) ? stdout : [stdout]) this.stdout.emit("data", Buffer.from(chunk));
      this.emit("close", 0, null);
    });
  }

  kill() {
    this.killed = true;
    queueMicrotask(() => this.emit("close", null, "SIGTERM"));
    return true;
  }
}

function request(target = "cursor") {
  return { requestId: `protocol-regression-${target}`, target, task: "Return a final answer.", cwd: process.cwd(),
    context: { requiredResultFields: ["finalText"] }, execution: { timeoutMs: 5000 } };
}

const fragments = [
  '{"type":"result","subtype":"success","result":"DONE"',
  '{"type":"system","subtype":"init"',
  '{\n  "type": "result",\n  "subtype": "success",\n  "result": "DONE"',
  '{"result":"DONE","type":"result"',
  '{"type":',
  '{',
  '{"',
  '{"type"',
];

for (const [index, fragment] of fragments.entries()) {
  for (const ending of ["", "\n"]) {
    test(`Cursor rejects incomplete protocol fragment ${index + 1} through Companion (${ending ? "newline" : "EOF"})`, async (t) => {
      const root = await mkdtemp(join(tmpdir(), "cursor-protocol-regression-"));
      t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
      const companion = new Companion({ store: new JobStore(root), routeResolver: async (value) => value,
        adapterFactory: () => new CursorAdapter({ command: "fake-cursor", spawnFn: () => new OutputChild(fragment + ending) }) });
      const receipt = await companion.start(request());
      assert.equal(receipt.state, "failed");
      assert.equal(receipt.error.details.kind, "downstream");
      assert.equal(receipt.result, null);
      assert.match(receipt.error.message, /without final output/);
    });
  }
}

test("Cursor keeps healthy prose and complete single-JSON compatibility", async () => {
  const prose = [
    "The billing screen is implemented and its tests passed.",
    'The example {"type":"result" illustrates the stream protocol.',
    "[Note] Authentication required is the login-form label.",
    "Use {name} as the template placeholder, then replace {value}.",
  ];
  const envelopes = [
    JSON.stringify({ type: "result", subtype: "success", result: "DONE" }),
    JSON.stringify({ result: "DONE" }, null, 2),
  ];
  for (const stdout of [...prose, ...envelopes]) {
    const output = await new CursorAdapter({ command: "fake-cursor", spawnFn: () => new OutputChild(stdout) }).run(request());
    assert.equal(output.result.finalText, prose.includes(stdout) ? stdout : "DONE");
  }
});

const canonical = {
  init: JSON.stringify({ type: "system", subtype: "init", session_id: "prefix-session" }),
  result: JSON.stringify({ type: "result", subtype: "success", result: "DONE ✓", session_id: "prefix-session" }),
};
const layouts = [
  { name: "bare", before: "", after: "" },
  { name: "whitespace", before: " \r\n\t", after: "\r\n" },
  { name: "banner", before: "Cursor fixture starting\n", after: "\n" },
  { name: "fence", before: "```json\n", after: "\n```" },
];
const chunkSizes = [Infinity, 1, 7];

function chunksOf(bytes, size) {
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += size) chunks.push(bytes.subarray(offset, offset + size));
  return chunks;
}

for (const [name, json] of Object.entries(canonical)) {
  for (const layout of layouts) {
    for (const chunkSize of chunkSizes) {
      test(`Cursor rejects every ${name} byte prefix (${layout.name}, chunks=${chunkSize})`, async () => {
        const bytes = Buffer.from(json);
        const accepted = [];
        for (let end = 1; end < bytes.length; end += 1) {
          const stdout = Buffer.concat([Buffer.from(layout.before), bytes.subarray(0, end), Buffer.from(layout.after)]);
          const adapter = new CursorAdapter({ command: "fake-cursor", spawnFn: () => new OutputChild(chunksOf(stdout, chunkSize)) });
          try {
            await adapter.run(request());
            accepted.push(end);
          } catch (error) {
            assert.equal(error.details?.kind, "downstream", `prefix length ${end}`);
            assert.match(error.message, /without final output/);
          }
        }
        assert.deepEqual(accepted, [], "no incomplete object may become a successful answer; values are accepted byte lengths");
      });
    }
  }
}

test("Cursor accepts complete result envelopes across the same wrappers and byte splits", async () => {
  for (const layout of layouts) {
    for (const chunkSize of chunkSizes) {
      const stdout = Buffer.from(`${layout.before}${canonical.result}${layout.after}`);
      const output = await new CursorAdapter({ command: "fake-cursor", spawnFn: () => new OutputChild(chunksOf(stdout, chunkSize)) }).run(request());
      assert.equal(output.result.finalText, "DONE ✓");
      assert.equal(output.sessionId, "prefix-session");
    }
  }
});

test("Cursor cannot complete from empty output, init envelopes or empty result objects", async () => {
  for (const stdout of ["", " \r\n\t", "{}", canonical.init, '{"result":""}', '{"type":"result","subtype":"success","result":""}']) {
    const adapter = new CursorAdapter({ command: "fake-cursor", spawnFn: () => new OutputChild(stdout) });
    await assert.rejects(adapter.run(request()), (error) => error.details.kind === "downstream" && /without final output/.test(error.message));
  }
});

for (const [target, Adapter] of Object.entries({ claude: ClaudeAdapter, cursor: CursorAdapter, codex: CodexAdapter })) {
  test(`${target} preserves the process helper's typed output-limit failure`, async () => {
    const adapter = new Adapter({
      command: `fake-${target}`,
      ...(target === "codex" ? {
        gitCheckFn: async () => true,
        quotaProbeFn: async () => ({ status: "unknown", source: "test", observedAt: 0, reason: "fixture" }),
      } : {}),
      spawnFn: () => new OutputChild("x".repeat(2 * 1024 * 1024 + 1)),
    });
    await assert.rejects(adapter.run(request(target)), (error) => error.details.kind === "output-limit");
  });
}
