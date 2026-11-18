import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { JobStore } from "../src/job-store.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "harnest-routing-mcp-"));
  const client = new Client({ name: "routing-regression", version: "1" }, {});
  t.after(async () => {
    await client.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const script = `
    import { appendFileSync } from "node:fs";
    import { join } from "node:path";
    import { serveStdio } from "@modelcontextprotocol/server/stdio";
    import { createServer } from "./src/mcp-server.mjs";
    const root = ${JSON.stringify(root)};
    await serveStdio(() => createServer({
      stateDir: join(root, "jobs"), boardDir: join(root, "boards"), graphDir: join(root, "graphs"),
      detachBackground: false,
      routing: { config: { routing: { global: { candidates: [
        { id: "first", target: "pi", route: { model: "primary", thinking: "medium" }, scores: { quality: 10 } },
        { id: "second", target: "codex", route: { model: "backup", thinking: "max" }, scores: { quality: 1 } },
      ] } } }, env: {}, userPolicy: {} },
      adapterFactory: () => ({ async run(request) {
        appendFileSync(join(root, "runs.jsonl"), JSON.stringify({ requestId: request.requestId, target: request.target, thinking: request.route.thinking }) + "\\n");
        if (request.target === "pi") throw Object.assign(new Error("synthetic failure"), {
          details: { kind: request.task === "policy failure" ? "policy" : "transport" },
        });
        return { result: { finalText: "backup succeeded" }, route: request.route };
      } }),
    }), { legacy: "serve" });
  `;
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: ["--input-type=module", "-e", script],
    cwd: join(import.meta.dirname, ".."), stderr: "pipe",
  }));
  return {
    store: new JobStore(join(root, "jobs")),
    async run(requestId, routing = {}, extra = {}) {
      const response = await client.callTool({ name: "handoff_workflow", arguments: { request: {
        requestId, target: "pi", task: "transport failure", cwd: root,
        policy: { write: false }, execution: { timeoutMs: 10_000 },
        metadata: { routing: { mode: "auto", ...routing } }, ...extra,
      } } });
      return { isError: Boolean(response.isError), body: JSON.parse(response.content[0].text) };
    },
    async runs() {
      const text = await readFile(join(root, "runs.jsonl"), "utf8").catch((error) => {
        if (error.code === "ENOENT") return "";
        throw error;
      });
      return text.trim() ? text.trim().split("\n").map((line) => JSON.parse(line)) : [];
    },
  };
}

test("MCP real routing accepts boolean fallbacks and false prevents an eligible retry", { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  for (const fallbacks of [false, true, undefined]) {
    const requestId = `fallbacks-${fallbacks}`;
    const response = await f.run(requestId, fallbacks === undefined ? {} : { fallbacks });
    assert.equal(response.isError, false, JSON.stringify(response.body));
    const receipt = response.body;
    assert.equal(receipt.state, fallbacks === false ? "failed" : "completed");
    assert.deepEqual(receipt.routingDecision.rankedRoutes.map((entry) => entry.id), ["first", "second"]);
    assert.deepEqual((await f.runs()).filter((run) => run.requestId === requestId).map((run) => run.target),
      fallbacks === false ? ["pi"] : ["pi", "codex"]);
    assert.equal((receipt.routingFallbacks ?? []).length, fallbacks === false ? 0 : 1);
  }
});

test("MCP real routing rejects malformed fallback values before allocating jobs", { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  for (const [index, fallbacks] of ["false", "true", 0, 1, null, [], {}].entries()) {
    const response = await f.run(`malformed-${index}`, { fallbacks });
    assert.equal(response.isError, true);
    assert.match(response.body.error.message, /fallbacks must be a boolean/);
  }
  assert.deepEqual(await f.runs(), []);
  assert.deepEqual(await f.store.listAllReceipts(), []);
});

test("MCP rejects incompatible pins before allocation and never retries adapter policy errors", { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  for (const [index, extra] of [
    { target: "cursor", route: { model: "opus" } },
    { target: "cursor", route: { model: "composer", thinking: "high" } },
  ].entries()) {
    const response = await f.run(`bad-pin-${index}`, { mode: "pin" }, extra);
    assert.equal(response.isError, true);
    assert.equal(response.body.error.kind, "policy");
  }
  assert.deepEqual(await f.runs(), []);
  assert.deepEqual(await f.store.listAllReceipts(), []);
  const response = await f.run("adapter-policy", { fallbacks: true }, { task: "policy failure" });
  assert.equal(response.isError, false);
  assert.equal(response.body.state, "failed");
  assert.equal(response.body.error.details.kind, "policy");
  assert.deepEqual((await f.runs()).map((run) => run.target), ["pi"]);
  assert.equal((response.body.routingFallbacks ?? []).length, 0);
});

test("MCP fallback preserves caller high effort over a candidate max effort", { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  const response = await f.run("thinking-fallback", { tier: "quick" }, { route: { thinking: "high" } });
  assert.equal(response.isError, false, JSON.stringify(response.body));
  assert.equal(response.body.state, "completed");
  assert.equal(response.body.route.thinking, "high");
  assert.deepEqual(await f.runs(), [
    { requestId: "thinking-fallback", target: "pi", thinking: "high" },
    { requestId: "thinking-fallback", target: "codex", thinking: "high" },
  ]);
});
