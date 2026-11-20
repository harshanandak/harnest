// MCP boundary: background jobs survive the caller/server exiting, and a
// foreground request whose declared budget exceeds the safe MCP foreground
// wait is converted into a durable background job instead of letting the
// client's own tool timeout fire. Fixture adapters never call real harnesses:
// the server fixture injects an in-process adapter, and detached jobs run the
// HARNEST_WORKER_ADAPTER module in the worker process.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const mcpServerUrl = pathToFileURL(join(root, "src", "mcp-server.mjs")).href;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TERMINAL_STATES = new Set(["completed", "failed", "cancelled", "partial"]);

async function until(read, predicate, { timeoutMs = 30_000, intervalMs = 250, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (predicate(last)) return last;
    await wait(intervalMs);
  }
  throw new Error(`${label} was not reached within ${timeoutMs}ms; last=${JSON.stringify(last)?.slice(0, 400)}`);
}

async function scratch(t, prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  return directory;
}

// The MCP fixture server runs as an eval module from the repo root so bare
// package specifiers resolve; the state dir comes from the environment.
function serverScript(deadlineFixture = false) {
  return `
import { join } from "node:path";
import { appendFileSync } from "node:fs";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
const { createServer } = await import(${JSON.stringify(mcpServerUrl)});
const dir = process.env.HARNEST_MCP_DETACH_DIR;
const deadlineFixture = ${JSON.stringify(deadlineFixture)};
await serveStdio(() => createServer({
  stateDir: join(dir, "jobs"),
  boardDir: join(dir, "boards"),
  graphDir: join(dir, "graphs"),
  routeResolver: async (request) => deadlineFixture ? {
    ...request,
    route: { model: "first" },
    metadata: { harnest: { routingDecision: {
      version: 2, mode: "auto", selected: "first",
      rankedRoutes: [
        { id: "first", target: "pi", route: { model: "first" }, score: 2 },
        { id: "second", target: "pi", route: { model: "second" }, score: 1 },
      ],
    } } },
  } : request,
  adapterFactory: (target) => ({
    async run(request, { signal }) {
      appendFileSync(join(dir, "in-process-runs.jsonl"), JSON.stringify({ pid: process.pid, requestId: request.requestId }) + "\\n");
      if (deadlineFixture) await new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error("fixture was not stopped")), 10000);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(Object.assign(new Error("fixture aborted"), { details: { aborted: true } }));
        }, { once: true });
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { sessionId: "in-process-" + target, result: { finalText: "IN_PROCESS_CANARY" } };
    },
  }),
}), { legacy: "serve" });
`;
}

// Worker fixture: optional gate mode holds the run until a release file
// appears so a test can prove the detached process owns the execution.
async function workerAdapterScript(directory) {
  const path = join(directory, "worker-adapter.mjs");
  await writeFile(path, `
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.env.HARNEST_MCP_DETACH_DIR;
export const adapterFactory = () => ({
  async run(request, { onProgress }) {
    await onProgress({ type: "text", text: "worker fixture progress" });
    appendFileSync(join(dir, "worker-runs.jsonl"), JSON.stringify({ pid: process.pid, requestId: request.requestId }) + "\\n");
    if (existsSync(join(dir, "gate"))) {
      writeFileSync(join(dir, "worker-started.json"), JSON.stringify({ pid: process.pid, requestId: request.requestId }));
      const release = join(dir, "release");
      while (!existsSync(release)) await new Promise((resolve) => setTimeout(resolve, 50));
    } else {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return { sessionId: "worker-session", result: { finalText: "WORKER_CANARY" } };
  },
});
`);
  return path;
}

async function connect(directory, adapterPath, deadlineFixture = false) {
  const client = new Client({ name: "mcp-detach-regression", version: "1" }, {});
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--input-type=module", "-e", serverScript(deadlineFixture)],
    cwd: root,
    stderr: "pipe",
    env: { ...process.env, HARNEST_MCP_DETACH_DIR: directory, HARNEST_WORKER_ADAPTER: adapterPath },
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => { stderr += chunk; });
  await client.connect(transport);
  return { client, transport, stderr: () => stderr };
}

async function call(client, name, args, error = false) {
  const response = await client.callTool({ name, arguments: args });
  assert.equal(Boolean(response.isError), error, response.content?.[0]?.text);
  return JSON.parse(response.content[0].text);
}

test("an over-budget foreground MCP request converts to a durable background receipt and completes", { timeout: 90_000 }, async (t) => {
  const directory = await scratch(t, "harnest-mcp-detach-convert-");
  const adapterPath = await workerAdapterScript(directory);
  const fixture = await connect(directory, adapterPath);
  t.after(() => fixture.client.close());

  const startedAt = Date.now();
  const receipt = await call(fixture.client, "handoff_workflow", { request: {
    requestId: "mcp-foreground-converted",
    target: "pi",
    task: "synthetic long audit",
    cwd: directory,
    execution: { timeoutMs: 120_000 },
  } });
  assert.ok(Date.now() - startedAt < 20_000, "a converted request must return without waiting out its budget");
  assert.equal(receipt.state, "queued");
  assert.equal(receipt.execution?.foregroundConverted, true);
  assert.equal(receipt.execution?.requestedTimeoutMs, 120_000);
  assert.equal(receipt.execution?.safeForegroundWaitMs, 55_000);
  assert.match(receipt.execution?.hint || "", /handoff_status/);

  const settled = await until(
    () => call(fixture.client, "handoff_status", { jobId: receipt.jobId }),
    (value) => TERMINAL_STATES.has(value.state),
    { timeoutMs: 60_000, label: "converted job terminal" },
  );
  assert.equal(settled.state, "completed");
  assert.equal(settled.result, undefined);
  const result = await call(fixture.client, settled.resultRef.tool, settled.resultRef.arguments);
  assert.equal(result.result.finalText, "WORKER_CANARY");
  assert.equal(settled.sessionId, "worker-session");
  assert.equal(settled.execution?.foregroundConverted, true, "the durable receipt keeps the conversion flag");
  assert.equal(await readFile(join(directory, "in-process-runs.jsonl"), "utf8").catch(() => ""), "", "the MCP server must not run a converted job");
  const workerRuns = (await readFile(join(directory, "worker-runs.jsonl"), "utf8")).trim().split(/\r?\n/);
  assert.equal(workerRuns.length, 1);
});

test("a foreground MCP request within the safe wait still waits for the terminal receipt", { timeout: 60_000 }, async (t) => {
  const directory = await scratch(t, "harnest-mcp-detach-in-budget-");
  const adapterPath = await workerAdapterScript(directory);
  const fixture = await connect(directory, adapterPath);
  t.after(() => fixture.client.close());

  const receipt = await call(fixture.client, "handoff_workflow", { request: {
    requestId: "mcp-foreground-in-budget",
    target: "pi",
    task: "synthetic short task",
    cwd: directory,
    execution: { timeoutMs: 10_000 },
  } });
  assert.equal(receipt.state, "completed");
  assert.equal(receipt.result.finalText, "IN_PROCESS_CANARY");
  assert.equal(receipt.execution, undefined, "an in-budget foreground receipt carries no conversion note");
  const inProcess = (await readFile(join(directory, "in-process-runs.jsonl"), "utf8")).trim().split(/\r?\n/);
  assert.equal(inProcess.length, 1);
  assert.equal(await readFile(join(directory, "worker-runs.jsonl"), "utf8").catch(() => ""), "");
});

test("invalid foreground budgets remain validation errors and never spawn a worker", { timeout: 60_000 }, async (t) => {
  const directory = await scratch(t, "harnest-mcp-detach-invalid-");
  const adapterPath = await workerAdapterScript(directory);
  const fixture = await connect(directory, adapterPath);
  t.after(() => fixture.client.close());

  const cases = [0, 1.5, 86_400_001];
  for (const [index, timeoutMs] of cases.entries()) {
    const body = await call(fixture.client, "handoff_workflow", { request: {
      requestId: `mcp-invalid-budget-${index}`,
      target: "pi",
      task: "invalid budget",
      cwd: directory,
      execution: { timeoutMs },
    } }, true);
    assert.equal(body.error?.kind, "validation", `timeoutMs=${timeoutMs} must stay a validation error`);
    assert.match(body.error?.message || "", /timeoutMs/);
  }
  assert.equal(await readFile(join(directory, "worker-runs.jsonl"), "utf8").catch(() => ""), "");
  assert.equal(await readFile(join(directory, "in-process-runs.jsonl"), "utf8").catch(() => ""), "");
});

test("an in-budget foreground MCP call cannot restart its deadline through fallback", { timeout: 60_000 }, async (t) => {
  const directory = await scratch(t, "harnest-mcp-deadline-");
  const adapterPath = await workerAdapterScript(directory);
  const fixture = await connect(directory, adapterPath, true);
  t.after(() => fixture.client.close());
  const receipt = await call(fixture.client, "handoff_workflow", { request: {
    requestId: "mcp-shared-deadline", target: "pi", task: "synthetic deadline",
    cwd: directory, execution: { background: false, timeoutMs: 200 }, policy: { write: false },
  } });
  assert.equal(receipt.state, "failed");
  assert.equal(receipt.error.details.kind, "timeout");
  assert.equal(receipt.routingFallbacks?.length ?? 0, 0);
  const runs = (await readFile(join(directory, "in-process-runs.jsonl"), "utf8")).trim().split(/\r?\n/);
  assert.equal(runs.length, 1);
});

test("an MCP background job survives client/server exit and completes for a fresh client", { timeout: 120_000 }, async (t) => {
  const directory = await scratch(t, "harnest-mcp-detach-survive-");
  const adapterPath = await workerAdapterScript(directory);
  await writeFile(join(directory, "gate"), "gate");
  const first = await connect(directory, adapterPath);
  const serverPid = first.transport.pid;

  const receipt = await call(first.client, "handoff_workflow", { request: {
    requestId: "mcp-detach-survival",
    target: "pi",
    task: "survive the MCP server",
    cwd: directory,
    execution: { background: true, timeoutMs: 60_000 },
  } });
  assert.equal(receipt.state, "queued");
  const workerStarted = await until(
    () => readFile(join(directory, "worker-started.json"), "utf8").then(JSON.parse, () => null),
    Boolean,
    { timeoutMs: 30_000, label: "detached worker start" },
  );
  assert.notEqual(workerStarted.pid, serverPid, "the job must not run inside the MCP server");

  // Closing the client kills the MCP server process; the release file is
  // written only afterwards, so only the detached worker can complete the job.
  await first.client.close();
  await writeFile(join(directory, "release"), "release");

  const second = await connect(directory, adapterPath);
  t.after(() => second.client.close());
  const settled = await until(
    () => call(second.client, "handoff_status", { jobId: receipt.jobId }),
    (value) => TERMINAL_STATES.has(value.state),
    { timeoutMs: 60_000, label: "survived job terminal" },
  );
  assert.equal(settled.state, "completed");
  assert.equal(settled.result, undefined);
  const result = await call(second.client, settled.resultRef.tool, settled.resultRef.arguments);
  assert.equal(result.result.finalText, "WORKER_CANARY");
  assert.equal(settled.sessionId, "worker-session");
});
