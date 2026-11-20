import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, parse, resolve } from "node:path";
import { setupDaemon } from "./install-daemon.mjs";
import { bridgeEntry, cursorUserConfig, installHostConfig, installJsonServer, readJsonServer, removeJsonServer } from "./install-host-config.mjs";
import { readExisting, replaceWithBackup } from "./install-files.mjs";

// Idempotent Cursor installer.
//
// Layout (per Cursor docs):
//   ~/.cursor/mcp.json                 user MCP servers (stdio bridge)
//   .cursor/skills/handoff/SKILL.md   full playbook, loaded on demand by the agent
//   .cursor/skills/handoff/references/  condensed routing + trace-loop references
//   .cursor/rules/harnest-router.mdc  thin agent-requested pointer (no playbook inline)
//   .cursor/agents/cursor-worker.md   Cursor-schema subagent (name/description/model/readonly/is_background)
//   .cursor/commands/workflows.md      /workflows slash command → scripts/graph-view.mjs
//
// The playbook lives in exactly one place (the skill). Rules only point at it:
// an alwaysApply playbook would tax every prompt for an occasional workflow.
const root = dirname(dirname(fileURLToPath(import.meta.url)));

async function canonicalPath(path, { create = false } = {}) {
  try { return await realpath(path); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!create) return resolve(path);
  await mkdir(path, { recursive: true });
  return realpath(path);
}

export async function defaultCursorProject() {
  const project = await realpath(process.cwd());
  const home = await canonicalPath(homedir());
  if (project === home || project === parse(project).root) {
    throw new Error("Cursor setup cannot use your home directory or a filesystem root by default. Pass --project DIR or run from your project.");
  }
  return project;
}

const ROUTER_RULE = `---
description: Route multi-agent delegation through harnest handoff tools and the handoff skill
alwaysApply: false
---

When the user asks to delegate a bounded task to another harness
(OpenCode, Pi, Cursor, Claude, Codex, Amp, or a registered ACP agent), compare models, or fan out parallel
research lanes or dependency graphs, invoke the \`handoff\` skill (\`/handoff\`) and call the
\`harnest\` MCP tools (\`handoff_workflow\`, \`handoff_status\`,
\`handoff_trace\`, \`handoff_result\`, \`handoff_compare\`,
\`handoff_review\`, \`handoff_message\`, \`handoff_reroute\`,
\`handoff_fleet\`, \`handoff_post\`, \`handoff_read\`). Do not paste the playbook into chat;
read \`.cursor/skills/handoff/SKILL.md\` when the skill fires.
For graphs use \`handoff_graph_validate/start/status/result/cancel/resume\`;
read \`references/agent-graphs.md\` for per-task routing and selective recovery.
For live workflow visibility inside Cursor, use \`/workflows --watch --workflow <runId>\`.
Read \`references/workflow-observer.md\`: a native task streams the CLI observer,
while Harnest remains responsible for execution and controls.
`;

const CURSOR_WORKER = `---
name: cursor-worker
description: Thin forwarder for one harnest handoff. Use when a task should run as a durable background handoff with status/trace polling, returning the receipt verbatim.
model: inherit
readonly: false
is_background: true
---

You are a thin forwarder for exactly one harnest handoff, not an
orchestrator. Make one \`handoff_workflow\` call with \`target\` set by the
parent, a caller-owned \`requestId\`, absolute cwd, context, timeout, and
policy. Start in background, retain jobId + context digest.

Supported targets include OpenCode, Pi, Cursor, Claude, Codex, Amp,
and trusted machine-local ACP registrations. Amp is a prompt-only attached one-shot target. Live controls
and \`execution.transport=session\` are unsupported. Resume follow-ups only
with the native session identity in \`execution.sessionId\`. Amp is write-only,
requires explicit write approval with empty tools and no cost budget, and
runs natively on Linux or macOS, or when the entire MCP server is inside WSL;
native Windows downstream launch is rejected.

Your first visible message announces the jobId and requestId from the
queued \`handoff_workflow\` receipt, so the parent can steer or cancel this
run from any point. If the first tool response is lost, recover with
\`handoff_status\` by requestId.

Then poll \`handoff_status\` and page \`handoff_trace\` with
\`afterSequence\` (previous \`nextSequence\`, every 1-2s). After EVERY poll,
emit one short visible update naming the job state plus
\`trace.progress.phase\`, \`current\`, recent milestones,
\`lastMeaningfulAt\`. Heartbeat-only activity is stalled, not progress.
Never end the turn before terminal state. IDE subagents inherit MCP
tools from the parent; cloud/automation subagents may not — prefer direct
\`handoff_workflow\` calls there.

Cursor print mode is one-shot (cursor-agent --trust -p --output-format
stream-json) with no live message/reroute controls:
\`handoff_message\`/\`handoff_reroute\` fail closed as
\`unsupported-control\`. When the parent steers this child mid-run, do not
message the one-shot run — resume it as a follow-up with
\`execution.sessionId\` set to the receipt's Cursor \`sessionId\` once it
settles, or record the guidance for the parent.

Close out with \`handoff_result\`, verify requestId, context digest, resolved
route, session identity, final text, usage. Return the receipt verbatim.
Never weaken policy: granular \`tools\`/\`maxCostUsd\` are rejected on
cursor targets — pass them through and surface the rejection. Generic ACP requires
route.agent plus explicit write approval; registry trust permits native configuration
imports and does not establish read-only containment.
`;

const digest = (bytes) => bytes === null ? null : createHash("sha256").update(bytes).digest("hex");
const managedFile = /^(?:skills\/handoff\/(?:SKILL\.md|agents\/openai\.yaml|references\/[a-z0-9][a-z0-9.-]*)|rules\/harnest-router\.mdc|agents\/cursor-worker\.md|commands\/workflows\.md)$/i;

async function cursorProjectState(projectRoot, home) {
  const path = join(home, ".cursor", "harnest-projects", digest(projectRoot) + ".json");
  let raw = await readExisting(path);
  const state = raw === null ? { files: {} } : JSON.parse(raw);
  const save = async () => {
    const next = Object.keys(state.files).length || state.mcp ? JSON.stringify(state) + "\n" : null;
    await replaceWithBackup(path, next, raw, { keepBackup: false });
    raw = next;
  };
  return { state, save };
}

async function installDocs(projectRoot, { state, save }) {
  const cursorDir = join(projectRoot, ".cursor");
  const installed = [];
  const writeExact = async (relative, content) => {
    const path = join(cursorDir, relative);
    const previous = await readExisting(path, null);
    if (previous?.equals(content)) return `${relative} already current`;
    const before = digest(previous);
    const after = digest(content);
    // Record ownership before publishing the file so an interrupted setup can still be reversed.
    await replaceWithBackup(path, content, previous, {
      beforeReplace: async (backup) => {
        const record = state.files[relative];
        state.files[relative] = record?.installed.includes(before)
          ? { ...record, installed: [...new Set([...record.installed, after])] }
          : { backup, before, installed: [after] };
        await save();
      },
    });
    return `installed ${relative}`;
  };
  const skill = "skills/handoff/";
  const refs = await readdir(join(root, skill, "references"));
  for (const name of ["SKILL.md", "agents/openai.yaml", ...refs.map((name) => "references/" + name)]) {
    installed.push(await writeExact(skill + name, await readFile(join(root, skill, name))));
  }
  installed.push(await writeExact("rules/harnest-router.mdc", Buffer.from(ROUTER_RULE)));
  installed.push(await writeExact("agents/cursor-worker.md", Buffer.from(CURSOR_WORKER)));
  const workflowsSource = await readFile(join(root, ".cursor", "commands", "workflows.md"), "utf8");
  const workflows = resolve(projectRoot) === root ? workflowsSource : workflowsSource.replace(
    /node scripts\/(workflow-monitor|graph-view)\.mjs/g,
    (_command, name) => `node "${join(root, "scripts", `${name}.mjs`).replaceAll("\\", "/")}"`,
  );
  installed.push(await writeExact("commands/workflows.md", Buffer.from(workflows)));
  return installed;
}

/** @param {string} [projectRoot] repository root containing `.cursor/` */
export async function installCursorIntegration(projectRoot = root, { home = homedir() } = {}) {
  projectRoot = await canonicalPath(projectRoot, { create: true });
  const project = await cursorProjectState(projectRoot, home);
  const docs = await installDocs(projectRoot, project);
  const mcp = await installHostConfig("cursor", { home });
  const projectPath = resolve(projectRoot, ".cursor", "mcp.json");
  let projectMcp = null;
  if (projectPath !== resolve(mcp.path) && await readJsonServer(projectPath, "mcpServers") !== undefined) {
    const entry = bridgeEntry();
    project.state.mcp = entry;
    await project.save();
    projectMcp = await installJsonServer(projectPath, "mcpServers", entry, { existingOnly: true });
  }
  return { projectPath: projectRoot, docs, mcp, projectMcp };
}

export async function removeCursorProject(projectRoot, home = homedir()) {
  projectRoot = await canonicalPath(projectRoot);
  const { state, save } = await cursorProjectState(projectRoot, home);
  const cursorDir = join(projectRoot, ".cursor");
  const restored = [];
  const preserved = [];
  for (const [relative, record] of Object.entries(state.files)) {
    if (!managedFile.test(relative)) throw new Error(`Invalid Cursor install record: ${relative}`);
    const path = join(cursorDir, relative);
    const current = await readExisting(path, null);
    const hash = digest(current);
    if (hash !== record.before && !record.installed.includes(hash)) {
      preserved.push(relative);
      continue;
    }
    if (hash !== record.before) {
      const original = record.backup === null ? null : await readFile(record.backup);
      if (digest(original) !== record.before) throw new Error(`Cursor backup changed: ${record.backup}`);
      await replaceWithBackup(path, original, current);
      restored.push(relative);
    }
    delete state.files[relative];
  }
  let projectMcp = null;
  if (state.mcp) {
    projectMcp = await removeJsonServer({
      path: join(cursorDir, "mcp.json"), key: cursorUserConfig(home).key, expectedEntry: state.mcp,
    });
    if (projectMcp.status === "entry-changed") preserved.push("mcp.json");
    else delete state.mcp;
  }
  await save();
  return { path: projectRoot, restored, preserved, mcp: projectMcp };
}

export function cursorProject(args) {
  if (!args.length) return root;
  if (args[0] !== "--project" || !args[1] || args[1].startsWith("--") || args.length !== 2) {
    throw new Error("Usage: node scripts/install-cursor-integration.mjs [--project DIR] [--no-autostart]");
  }
  return resolve(args[1]);
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) {
  const project = cursorProject(process.argv.slice(2).filter((arg) => arg !== "--no-autostart"));
  await setupDaemon({ noAutostart: process.argv.includes("--no-autostart") });
  console.log(JSON.stringify(await installCursorIntegration(project)));
}
