import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { digestContext } from "../src/protocol.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const targets = ["opencode", "pi", "cursor", "claude", "codex", "gemini", "amp", "acp"];
const context = { requiredResultFields: ["finalText"], requiredText: ["DONE"] };

async function connect(directory, modern) {
  const client = new Client({ name: "eight-target-regression", version: "1" }, modern ? { versionNegotiation: { mode: "auto" } } : {});
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [join(root, "scripts", "fixtures", "mcp-five-targets.mjs"), directory], cwd: root,
  }));
  return client;
}

async function call(client, name, args) {
  const response = await client.callTool({ name, arguments: args });
  assert.equal(Boolean(response.isError), false, response.content?.[0]?.text);
  return JSON.parse(response.content[0].text);
}

for (const modern of [false, true]) {
  // Runs eight fixture handoffs plus a restart roundtrip; process startup
  // dominates on a loaded machine (observed up to ~25s), so the budget is
  // explicit rather than tight. Assertions are unchanged.
  test(`MCP eight-target policy, progress, receipt and restart roundtrip (${modern ? "modern" : "legacy"})`, { timeout: 90_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "harnest-mcp-eight-"));
    let client;
    try {
      client = await connect(directory, modern);
      const host = await call(client, "handoff_host_info", {});
      for (const worker of ["opencode-worker", "pi-worker", "cursor-worker", "claude-worker", "codex-worker", "gemini-worker", "amp-worker", "acp-worker"]) {
        assert.match(host.launchPath.claude, new RegExp(`harnest:${worker}`), `Claude launch path must name ${worker}`);
      }
      assert.match(host.launchPath.codex, /For Codex-to-Codex, call handoff_workflow directly/);
      assert.doesNotMatch(host.launchPath.codex, /\bcodex_worker\b/);
      for (const target of targets.filter((target) => target !== "codex")) {
        assert.match(host.launchPath.codex, new RegExp(`\\b${target}_worker\\b`));
      }
      const receipts = await Promise.all(targets.map((target) => call(client, "handoff_workflow", { request: {
        requestId: `five-${target}`, target, cwd: root, task: "synthetic fixture", context,
        policy: { write: ["amp", "acp"].includes(target) }, execution: { background: false, timeoutMs: 5000 },
        route: target === "amp"
          ? { variant: "medium" }
          : target === "acp" ? { agent: "fixture-acp" }
          : { model: target === "gemini" ? "gemini-synthetic" : `synthetic-${target}`, ...(target === "opencode" ? { harnessVersion: "v2" } : {}) },
      } })));
      for (const [index, receipt] of receipts.entries()) {
        assert.equal(receipt.target, targets[index]);
        assert.equal(receipt.state, "completed");
        assert.equal(receipt.contextDigest, digestContext(context));
        assert.equal(receipt.result.finalText, `${targets[index]} fixture result\nDONE`);
        assert.equal(receipt.sessionId, `fixture-${targets[index]}`);
      }
      await client.close();
      client = await connect(directory, modern);
      for (const target of targets) {
        const receipt = await call(client, "handoff_result", { requestId: `five-${target}` });
        assert.equal(receipt.target, target);
        assert.equal(receipt.state, "completed");
        assert.equal(receipt.contextDigest, digestContext(context));
        assert.equal(receipt.result.finalText, `${target} fixture result\nDONE`);
        const trace = await call(client, "handoff_trace", { requestId: `five-${target}`, limit: 100 });
        assert.ok(trace.events.some((event) => JSON.stringify(event).includes(`${target} fixture progress`)));
        assert.equal(trace.events.at(-1).activity, "completed");
        assert.deepEqual(trace.events.map((event) => event.sequence), trace.events.map((_, index) => index + 1));
      }
    } finally {
      await client?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
