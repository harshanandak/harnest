import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";
import { hostInfoSnapshot } from "../opencode-plugin/host-info.mjs";
import plugin from "../opencode-plugin/harnest.mjs";
import { installIntegration } from "../scripts/install-opencode-integration.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("host info snapshot describes the OpenCode launch path and control semantics", () => {
  const info = hostInfoSnapshot({ HARNEST_ROUTER: "C:\\resolvers\\route.mjs" });
  assert.equal(info.leadHost, "opencode");
  assert.equal(info.mcpServerName, "harnest");
  assert.ok(info.tools.includes("harnest_handoff_workflow"));
  assert.deepEqual(
    info.workers.map((w) => w.agent),
    ["opencode-worker", "pi-worker", "cursor-worker", "claude-worker", "codex-worker", "gemini-worker", "amp-worker", "acp-worker"],
  );
  assert.match(info.launchPath.nativeChild, /acp-worker/);
  const acp = info.workers.find((worker) => worker.target === "acp");
  assert.equal(acp?.agent, "acp-worker");
  assert.match(acp?.notes ?? "", /route\.agent/);
  assert.match(acp?.notes ?? "", /trusted/i);
  assert.match(acp?.notes ?? "", /write-only/i);
  assert.match(acp?.notes ?? "", /writeApproved=true/);
  assert.match(acp?.notes ?? "", /no live message\/reroute/i);
  assert.equal(info.routingResolverConfigured, true);
  assert.equal(info.routingResolverPath, "C:\\resolvers\\route.mjs");
  assert.match(info.routingResolverDiagnostics, /harnest_handoff_host_info/);
  assert.equal(info.writeApproval.marker, "metadata.harnest.writeApproved=true");
  assert.match(info.nestedHandoffs, /cannot widen/);
  assert.equal(info.controlSemantics.acknowledged, "applied");
  assert.match(info.controlSemantics.v1Opencode, /fail closed/);
  assert.match(info.controlSemantics.acp, /rejects live controls/);
});

test("host info snapshot reports an unconfigured routing resolver without inventing a path", () => {
  const info = hostInfoSnapshot({});
  assert.equal(info.routingResolverConfigured, false);
  assert.equal(info.routingResolverPath, null);
});

test("every OpenCode worker agent is a restricted subagent with a launch description", async () => {
  for (const name of ["opencode-worker.md", "pi-worker.md", "cursor-worker.md", "claude-worker.md", "codex-worker.md", "gemini-worker.md", "amp-worker.md", "acp-worker.md"]) {
    const raw = await readFile(join(root, "opencode-agents", name), "utf8");
    assert.match(raw, /^---\n[\s\S]+^---/m, `${name} must carry frontmatter`);
    assert.match(raw, /^mode: subagent$/m, `${name} must be a subagent`);
    assert.match(raw, /^description: /m, `${name} must describe when to use it`);
    assert.match(raw, /^  bash: deny$/m, `${name} must deny bash`);
    assert.match(raw, /^  edit: deny$/m, `${name} must deny edits`);
    assert.match(raw, /^  task: deny$/m, `${name} must not nest subagents`);
    assert.match(raw, /harnest_handoff_workflow/, `${name} must name the MCP tool with its prefix`);
  }
});

test("the OpenCode workers keep one-shot semantics", async () => {
  for (const name of ["cursor-worker.md", "claude-worker.md", "codex-worker.md", "gemini-worker.md", "amp-worker.md"]) {
    const raw = await readFile(join(root, "opencode-agents", name), "utf8");
    assert.match(raw, /one-shot/, `${name} must stay one-shot`);
    assert.match(raw, /fail closed as `unsupported-control`/, `${name} must fail live controls closed`);
    assert.match(raw, /resume it as a follow-up with execution\.sessionId/, `${name} must steer via resume`);
  }
});

test("the OpenCode workers share the single-builder spine: announce-first and live protocol", async () => {
  for (const name of ["opencode-worker.md", "pi-worker.md", "cursor-worker.md", "claude-worker.md", "codex-worker.md", "gemini-worker.md", "amp-worker.md"]) {
    const raw = await readFile(join(root, "opencode-agents", name), "utf8");
    assert.match(raw, /thin forwarder/, `${name} must stay a thin forwarder`);
    assert.match(raw, /first visible message announces the job ID and request ID/, `${name} must announce first`);
    assert.match(raw, /After EVERY poll, emit one short visible update/, `${name} must update per poll`);
    assert.match(raw, /heartbeat-only activity is stalled, not progress/, `${name} must not mistake heartbeats for progress`);
    assert.match(raw, /Never end the turn before terminal state/, `${name} must poll to terminal`);
  }
});

test("the OpenCode live targets steer via message while one-shots resume", async () => {
  for (const name of ["opencode-worker.md", "pi-worker.md"]) {
    const raw = await readFile(join(root, "opencode-agents", name), "utf8");
    assert.match(raw, /fresh `harnest_handoff_message` command ID/, `${name} must steer live`);
  }
});

test("the installer wires agents, skill, plugin, commands, and the MCP server entry", async (t) => {
  const configDir = await mkdtemp(join(tmpdir(), "harnest-opencode-wiring-"));
  t.after(() => rm(configDir, { recursive: true, force: true }));
  await installIntegration(configDir, { token: "fixture-token" });
  for (const target of ["pi", "opencode", "cursor", "claude", "codex", "gemini", "amp"]) {
    assert.equal(await readFile(join(configDir, "agents", `${target}-worker.md`), "utf8"), await readFile(join(root, "opencode-agents", `${target}-worker.md`), "utf8"));
  }
  for (const artifact of ["skills/handoff/SKILL.md", "plugins/harnest/host-info.mjs", "plugins/harnest/validate-workflow.mjs", "commands/handoff.md", "commands/handoff-status.md"]) {
    assert.ok((await readFile(join(configDir, artifact), "utf8")).length > 0, artifact);
  }
  const config = JSON.parse(await readFile(join(configDir, "opencode.json"), "utf8"));
  assert.deepEqual(config.mcp.servers.harnest.headers, { Authorization: "Bearer fixture-token" });
  assert.equal(config.mcp.servers.harnest.url, "http://127.0.0.1:41237/mcp");
});

test("the plugin module registers handoff_host_info as a custom tool", async () => {
  const tools = [];
  await plugin.setup({ tool: { transform: async (fn) => fn({ add: (tool) => tools.push(tool) }), hook: async () => {} }, session: { hook: async () => {} } });
  const info = tools.find((tool) => tool.name === "handoff_host_info");
  assert.ok(info);
  const result = await info.execute({}, { sessionID: "fixture-session" });
  assert.equal(JSON.parse(result.content).sessionID, "fixture-session");
  assert.equal(JSON.parse(result.content).workers.length, 8);
});
