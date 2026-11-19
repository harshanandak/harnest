import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { installCursorIntegration } from "../scripts/install-cursor-integration.mjs";
import { bridgeEntry, restoreHostConfig } from "../scripts/install-host-config.mjs";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "harnest-cursor-install-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("installer copies handoff skill, router, worker, workflows command, and registers MCP", async (t) => {
  const dir = await fixture(t);
  const first = await installCursorIntegration(dir, { home: dir });
  assert.ok(first.docs.some((line) => line.includes("commands/workflows.md")));
  assert.ok(existsSync(join(dir, ".cursor", "commands", "workflows.md")));
  const workflows = await readFile(join(dir, ".cursor", "commands", "workflows.md"), "utf8");
  for (const script of ["graph-view", "workflow-monitor"]) {
    assert.ok(workflows.includes('node "' + join(repoRoot, "scripts", script + ".mjs").replaceAll("\\", "/") + '"'));
  }
  assert.ok(existsSync(join(dir, ".cursor", "skills", "handoff", "SKILL.md")));
  assert.equal(await readFile(join(dir, ".cursor", "skills", "handoff", "agents", "openai.yaml"), "utf8"),
    await readFile(join(repoRoot, "skills", "handoff", "agents", "openai.yaml"), "utf8"));
  const installedSkill = await readFile(join(dir, ".cursor", "skills", "handoff", "SKILL.md"), "utf8");
  assert.match(installedSkill, /Session selection comes from .*generic ACP resume/);
  assert.match(installedSkill, /generic ACP follow-ups resume with `execution\.sessionId`/);
  assert.match(installedSkill, /One-shot targets \(Cursor, Claude, Codex, Amp, and generic ACP\)/);
  assert.match(installedSkill, /Launch the handoff.*harnest:acp-worker/);
  assert.match(installedSkill, /On Codex.*acp_worker/);
  assert.match(installedSkill, /On OpenCode.*acp-worker/);
  assert.match(installedSkill, /Read-only review:.*generic ACP reject[s]? read-only/i);
  assert.match(installedSkill, /Fix in place:.*generic ACP requires.*route\.agent.*writeApproved/i);
  const sourceRefs = (await readdir(join(repoRoot, "skills", "handoff", "references"))).sort();
  const installedRefs = (await readdir(join(dir, ".cursor", "skills", "handoff", "references"))).sort();
  assert.deepEqual(installedRefs, sourceRefs, "every handoff reference file must be copied, not a hardcoded subset");
  assert.ok(installedRefs.includes("agent-graphs.md"));
  assert.ok(existsSync(join(dir, ".cursor", "agents", "cursor-worker.md")));
  const router = await readFile(join(dir, ".cursor", "rules", "harnest-router.mdc"), "utf8");
  assert.match(router, /\/workflows/);
  assert.match(router, /Amp/);
  assert.match(router, /ACP/);
  const worker = await readFile(join(dir, ".cursor", "agents", "cursor-worker.md"), "utf8");
  assert.match(worker, /Amp/);
  assert.match(worker, /ACP/);
  const mcp = JSON.parse(await readFile(join(dir, ".cursor", "mcp.json"), "utf8"));
  assert.deepEqual(mcp.mcpServers.harnest, bridgeEntry());
  const second = await installCursorIntegration(dir, { home: dir });
  for (const label of ["rules/harnest-router.mdc", "agents/cursor-worker.md", "commands/workflows.md"]) {
    assert.ok(second.docs.some((line) => line === `${label} already current`), label);
  }
  assert.equal(second.mcp.backup, null);
});

test("installer preserves unrelated MCP servers in mcp.json", async (t) => {
  const dir = await fixture(t);
  await mkdir(join(dir, ".cursor"), { recursive: true });
  const prior = {
    mcpServers: {
      other: { command: "echo", args: ["hi"] },
    },
  };
  await writeFile(join(dir, ".cursor", "mcp.json"), JSON.stringify(prior, null, 2));
  const result = await installCursorIntegration(dir, { home: dir });
  assert.deepEqual(JSON.parse(await readFile(result.mcp.backup, "utf8")), prior);
  const next = JSON.parse(await readFile(join(dir, ".cursor", "mcp.json"), "utf8"));
  assert.deepEqual(next.mcpServers.other, prior.mcpServers.other);
  assert.ok(next.mcpServers["harnest"]);
  await restoreHostConfig(result.mcp.backup);
  assert.deepEqual(JSON.parse(await readFile(result.mcp.path, "utf8")), prior);
});
