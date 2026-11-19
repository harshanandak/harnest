// Single source of truth for every bridge worker:
//   agents/{pi,opencode,cursor,claude,codex,gemini,amp,acp}-worker.md (Claude shell)
//   codex-agents/{pi,opencode,cursor,claude,gemini,amp,acp}_worker.toml (Codex shell)
//   opencode-agents/{pi,opencode,cursor,claude,codex,gemini,amp,acp}-worker.md (OpenCode shell)
//
// Why one builder: the Claude subagent experience is the reference (visible
// child thread, streaming progress, steerable, clean verbatim receipt), and
// every harness must deliver exactly that from every lead host. Separate
// hand-edited copies drifted (Codex shells were less precise than Claude
// shells, neither had the live protocol or announce-first; the OpenCode
// shells predated both as well). Edit the shared template or per-target
// blocks here, run `node scripts/build-workers.mjs`, commit the regenerated
// files. Never hand-edit the outputs.
//
// Installers copy only `*_worker.toml` / `*.md`, never this script.
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const agentsDir = join(root, "agents");
const codexDir = join(root, "codex-agents");
const opencodeDir = join(root, "opencode-agents");

// Tool rendering per host shell: Claude names the bare `handoff_*` tool,
// OpenCode names the same tool behind its `harnest_` MCP prefix,
// Codex strips backticks (bare names, no prefix).
const code = (shell, name) =>
  shell === "codex" ? name : shell === "opencode" ? `\`harnest_${name}\`` : `\`${name}\``;
const HL = (shell, text) => (shell === "codex" ? text.replaceAll("`", "") : text);

// Reference experience: spawning the worker must feel like the Codex plugin
// for Claude Code — a live visible child, streaming progress, steerable at
// any point, cancellable, ending in one clean verbatim receipt.
function liveProtocol(shell) {
  const c = (name) => code(shell, name);
  return HL(shell, `Live transcript protocol — your thread is the operator's live screen; silence until the terminal state is a bug. Loop until terminal:
- Poll ${c("handoff_status")} for compact state, then page ${c("handoff_trace")} with afterSequence=<previous nextSequence>. Retain nextSequence; poll every 1-2s; follow hasMore pages before sleeping.
- After EVERY poll, emit one short visible update naming the job state plus trace.progress phase, current, recent milestones, and lastMeaningfulAt. New events: summarize the semantic delta in 1-3 lines. No new events: say so once — heartbeat-only activity is stalled, not progress — then keep polling. Never end the turn before terminal state.
- Never paste the raw unbounded transcript; summarize deltas only.`);
}

function announceFirst(shell) {
  const c = (name) => code(shell, name);
  return HL(shell, `Your first visible message announces the job ID and request ID from the queued ${c("handoff_workflow")} receipt, so the parent can steer or cancel this run from any point without recovery. If the initial tool response is lost, recover with ${c("handoff_status")} by request ID.`);
}

const TEXT_LEAF = `For an ordinary text leaf, set requiredResultFields to finalText only and use requiredText for exact canaries. A canary matches only as its own result line — the token alone or "RESULT: <canary>" — so prose that merely quotes it does not count. Do not require evidence, tests, or risks unless the caller explicitly needs those receipt arrays; prose labels in model text do not populate them. Claude Code nodes refuse bare echo prompts as prompt injection, so give them real task text and ask for a final "RESULT: <canary>" line.`;

const FAN_OUT = (shell) => HL(shell, `Fan-out belongs to the parent: at most 6 concurrent workers; queue the rest. This bridge owns exactly one handoff and never spawns workers. Keep each lane attributable; compare receipts without blending consensus. Parallel writers require one isolated worktree per writer; shared-checkout writes are rejected.`);

const NEVER_MERGE = `The downstream run never merges, deploys, or touches production data unless the request explicitly grants that authority.`;

const TARGETS = {
  pi: {
    role: "Pi worker or Pi Taskflow workflow",
    request: (c) => `Build one durable Harnest request with target pi, a caller-owned request ID, the exact cwd, context, workflow, permissions, timeout, and the requested route or Pi profile default. Start it in the background and retain the returned job ID and context digest.`,
    mechanics: `Do not inherit the lead's reasoning effort as Pi's thinking level. Pass a level supported by the selected model; current DeepSeek V4 routes use high or xhigh, never medium.\n\nClaude models never run here — they run only with target claude (Claude Code CLI). Pi requests naming them are rejected as policy, so do not construct them.\n\nNever submit an empty workflow. For a single leaf task, create exactly one phase with a stable ID, the full downstream task as its prompt, and an empty dependency list. Preserve an explicitly supplied multi-phase or node graph instead of flattening it.`,
    ladder: `File-edit ladder: read-only review uses policy.write false; fixes use policy.write true only with explicit parent authorization.`,
    steering: (c) => `When the parent steers this child, forward guidance with a fresh ${c("handoff_message")} command ID. Forward route changes with ${c("handoff_reroute")} for the next model request. Treat only applied as acknowledged.`,
    verify: (c) => `At terminal state, call ${c("handoff_result")}, verify request ID, context digest, resolved route, Pi session or workflow identity, final text, usage, evidence, tests, and risks, then return the complete receipt to the parent.`,
    claude: {
      description: "Native Claude subagent bridge for Pi work. Use proactively when a task should run through Pi or Pi Taskflow while remaining visible and steerable in Claude's subagent transcript.",
      maxTurns: 80, color: "purple",
    },
    codex: {
      description: "Native Codex child-thread bridge for Pi or Pi Taskflow work. Use when external Pi work must remain visible, inspectable, and steerable in Codex's subagent panel.",
      effort: "high",
    },
    opencode: {
      description: "Native OpenCode subagent bridge for Pi work. Use proactively when a task should run through Pi or Pi Taskflow while remaining visible and steerable in an OpenCode child session.",
      color: "accent",
      steps: 120,
    },
  },
  opencode: {
    role: "OpenCode worker or OpenCode Taskflow workflow",
    request: (c) => `Build one durable Harnest request with target "opencode" (or auto), a caller-owned request ID, the exact cwd, context, workflow, permissions, and timeout. Name the target and let policy select the route; set an explicit provider/model only when the user names one. Start it in the background and retain the returned job ID and context digest.`,
    mechanics: `Never submit an empty workflow. For a single leaf task, create exactly one phase with a stable ID, the full downstream task as its prompt, and an empty dependency list. Preserve an explicitly supplied multi-phase or node graph instead of flattening it.`,
    ladder: `File-edit ladder: read-only review uses policy.write false; fixes use policy.write true only with explicit parent authorization. Leave route.model unset unless the user names a model; a bare target pins the harness and policy selects the model (mode auto selects across targets). Pass an explicitly requested provider/model through.`,
    steering: (c) => `When the parent steers this child, forward task guidance with a fresh ${c("handoff_message")} command ID. Forward provider/model changes with ${c("handoff_reroute")}; they apply only to the next model request. Treat only applied as acknowledged. Live steer/reroute requires route.harnessVersion v2; V1 controls fail closed.`,
    verify: (c) => `At terminal state, call ${c("handoff_result")}, verify request ID, context digest, resolved route, OpenCode session or workflow identity, final text, usage, evidence, tests, and risks, then return the complete receipt to the parent.`,
    claude: {
      description: "Native Claude subagent bridge for OpenCode work. Use proactively when a task should run on an explicitly selected OpenCode provider/model while remaining visible and steerable in Claude's subagent transcript.",
      maxTurns: 80, color: "cyan",
    },
    codex: {
      description: "Native Codex child-thread bridge for OpenCode or OpenCode Taskflow work. Use when external OpenCode work must remain visible, inspectable, and steerable in Codex's subagent panel.",
      effort: "high",
    },
    opencode: {
      description: "Native OpenCode subagent bridge for downstream OpenCode work. Use proactively when a task should run on an explicitly selected OpenCode provider/model while remaining visible and steerable in an OpenCode child session.",
      color: "info",
      steps: 120,
    },
  },
  cursor: {
    role: "Cursor print-mode run",
    request: (c) => `Build one durable Harnest request with target "cursor", a caller-owned request ID, the exact cwd, context, timeout, and the downstream task. Start it in the background and retain the returned job ID and context digest.`,
    mechanics: `Cursor print mode is one-shot (cursor-agent --trust -p --output-format stream-json). It has no Taskflow graph and no live message/reroute controls: handoff_message/handoff_reroute fail closed as unsupported-control. Resume a follow-up with execution.sessionId set to the receipt's Cursor sessionId, never by inventing steering. Read-only requests map to --mode ask; write requests map to default agent mode with --force. Leave route.model unset unless the parent explicitly names a Cursor model (see cursor-agent --list-models); the adapter passes it as --model verbatim. Never weaken policy: granular tools lists and maxCostUsd budgets are rejected rather than silently ignored.`,
    ladder: `File-edit ladder: read-only review uses policy.write false (--mode ask); fixes use policy.write true only with explicit parent authorization.`,
    steering: (c) => `When the parent steers this child mid-run, do not message the one-shot run — resume it as a follow-up with execution.sessionId set to the receipt's Cursor sessionId once it settles, or record the guidance for the parent.`,
    verify: (c) => `At terminal state, call ${c("handoff_result")}, verify request ID, context digest, resolved route, Cursor session/workflow identity, final text, and usage, then return the complete receipt to the parent verbatim.`,
    claude: {
      description: "Native Claude subagent bridge for one-shot Cursor (cursor-agent print mode) work. Use proactively when Cursor should execute a bounded task while its status and durable receipt remain visible in Claude's subagent transcript.",
      maxTurns: 40, color: "orange",
    },
    codex: {
      description: "Native Codex child-thread bridge for one-shot Cursor (cursor-agent print mode) work. Use when Cursor work must remain visible, inspectable, and resumable in Codex's subagent panel.",
      effort: "high",
    },
    opencode: {
      description: "Native OpenCode subagent bridge for Cursor (cursor-agent print mode) work. Use proactively when a task should run through Cursor while remaining visible in an OpenCode child session.",
      color: "accent",
      steps: 60,
    },
  },
  claude: {
    role: "Claude Code print-mode run",
    request: (c) => `Build one durable Harnest request with target "claude", a caller-owned request ID, the exact cwd, context, timeout, and the downstream task. Start it in the background and retain the returned job ID and context digest.`,
    mechanics: `Claude print mode is one-shot (claude -p --output-format stream-json). It has no Taskflow graph and no live message/reroute controls: handoff_message/handoff_reroute fail closed as unsupported-control. Resume a follow-up with execution.sessionId set to the receipt's Claude sessionId. Read-only requests map to --permission-mode plan; write requests map to acceptEdits, both with --permission-prompts none. route.thinking maps to claude --effort (low, medium, high, xhigh, max; off and minimal are dropped because Claude has no equivalent). policy.maxCostUsd maps to --max-budget-usd (a client-side estimate). Leave route.model unset unless the parent explicitly names a Claude model alias or full ID (e.g. sonnet, opus, claude-opus-5); the adapter passes it as --model verbatim and the actual model is verified from modelUsage after the run. Forward route.agent for a named Claude agent via --agent. Forward route.serviceTier fast when requested. It uses the native print-mode fast setting and requires the CLI to confirm fast mode. Never weaken policy: granular tools lists are rejected rather than silently ignored.`,
    ladder: `File-edit ladder: read-only review uses policy.write false (plan mode); fixes use policy.write true only with explicit parent authorization.`,
    steering: (c) => `When the parent steers this child mid-run, do not message the one-shot run — resume it as a follow-up with execution.sessionId set to the receipt's Claude sessionId once it settles, or record the guidance for the parent.`,
    verify: (c) => `At terminal state, call ${c("handoff_result")}, verify request ID, context digest, resolved route, Claude session/workflow identity, final text, and usage (including totalCostUsd when a budget was set), then return the complete receipt to the parent verbatim.`,
    claude: {
      description: "Native Claude subagent bridge for one-shot Claude Code (claude print mode) work. Use proactively when Claude Code should execute a bounded task while its status and durable receipt remain visible in Claude's subagent transcript.",
      maxTurns: 40, color: "yellow",
    },
    codex: {
      description: "Native Codex child-thread bridge for one-shot Claude Code (claude print mode) work. Use when Claude Code work must remain visible, inspectable, and resumable in Codex's subagent panel.",
      effort: "high",
    },
    opencode: {
      description: "Native OpenCode subagent bridge for Claude Code (claude print mode) work. Use proactively when a task should run through Claude Code while remaining visible in an OpenCode child session.",
      color: "accent",
      steps: 60,
    },
  },
  codex: {
    role: "Codex CLI exec run",
    request: (c) => `Build one durable Harnest request with target "codex", a caller-owned request ID, the exact cwd, context, timeout, and the downstream task. Start it in the background and retain the returned job ID and context digest.`,
    mechanics: `Codex exec is one-shot (codex exec --json -o <last-message-file>). It has no Taskflow graph and no live message/reroute controls: handoff_message/handoff_reroute fail closed as unsupported-control. Resume a follow-up with execution.sessionId set to the receipt's Codex sessionId (codex exec resume). Read-only requests map to --sandbox read-only; write requests map to workspace-write (never danger-full-access, never --dangerously-bypass-approvals). Forward the parent's route unchanged, including route.profile for --profile and route.serviceTier for native service_tier. Leave route.model absent if the parent omitted it. Never weaken policy: granular tools lists and maxCostUsd budgets are rejected rather than silently ignored.`,
    ladder: `File-edit ladder: read-only review uses policy.write false (read-only sandbox); fixes use policy.write true only with explicit parent authorization.`,
    steering: (c) => `When the parent steers this child mid-run, do not message the one-shot run — resume it as a follow-up with execution.sessionId set to the receipt's Codex sessionId once it settles, or record the guidance for the parent.`,
    verify: (c) => `At terminal state, call ${c("handoff_result")}, verify request ID, context digest, resolved route, Codex session/workflow identity, final text, and usage, then return the complete receipt to the parent verbatim.`,
    claude: {
      description: "Native Claude subagent bridge for one-shot Codex CLI (codex exec) work. Use for bounded Codex implementation, review, investigation, and read-only research while its status and durable receipt remain visible in Claude's subagent transcript.",
      maxTurns: 40, color: "blue",
    },
    codex: null, // No Codex-to-Codex self-handoff: call handoff_workflow directly.
    opencode: {
      description: "Native OpenCode subagent bridge for Codex CLI (codex exec) work. Use proactively when a task should run through Codex while remaining visible in an OpenCode child session.",
      color: "accent",
      steps: 60,
    },
  },
  gemini: {
    role: "Gemini CLI one-shot run",
    request: (c) => `Build one durable Harnest request with target "gemini", a caller-owned request ID, the exact cwd, context, timeout, policy, and downstream task. Start it in the background and retain the returned job ID and context digest.`,
    mechanics: `Gemini runs as a prompt-only attached one-shot. execution.transport=session is unsupported and must be rejected before inference. Resume a follow-up only with execution.sessionId set to the receipt's native Gemini session identity. handoff_message/handoff_reroute fail closed as unsupported-control. Leave route.model unset unless the parent explicitly names a model supported by the Gemini adapter; an execution mode is not an arbitrary model pin. The adapter requires exactly Gemini CLI v0.62.0, launches with temporary settings and admin policy while retaining native authentication, and refuses any OS system-policy TOML before inference; never request YOLO or approval bypass. Read-only uses a fixed safe read-tool allowlist and excludes shell and writes. Write policy adds the verified standard coding tools, including run_shell_command for build/test plus write_file and replace. Unknown tools, plan exit, MCP, extensions, and hooks stay denied. The cwd is the process directory, but inherited includeDirectories cannot be cleared, so this policy is not a filesystem sandbox or read boundary. Pass policy fields through so unsupported restrictions are rejected before launch rather than silently ignored.`,
    transport: `This target supports only attached one-shot transport. execution.transport=session is unsupported. JavaScript scripts belong to the parent's handoff_dynamic tools, not this single-handoff bridge.`,
    ladder: `File-edit ladder: read-only review uses policy.write false with the fixed safe read-tool allowlist; fixes use policy.write true only with explicit parent authorization and may use the verified standard coding tools, including run_shell_command for build/test, write_file, and replace. Gemini rejects unsupported tool requirements before launch.`,
    steering: (c) => `When the parent steers this child mid-run, do not message the one-shot run — resume it as a follow-up with execution.sessionId set to the receipt's Gemini sessionId once it settles, or record the guidance for the parent.`,
    verify: (c) => `At terminal state, call ${c("handoff_result")}, verify request ID, context digest, resolved route, Gemini session/workflow identity, final text, usage, and policy outcome, then return the complete receipt to the parent verbatim.`,
    claude: {
      description: "Native Claude subagent bridge for one-shot Gemini CLI work. Use proactively when Gemini should execute a bounded task while its status and durable receipt remain visible in Claude's subagent transcript.",
      maxTurns: 40, color: "green",
    },
    codex: {
      description: "Native Codex child-thread bridge for one-shot Gemini CLI work. Use when Gemini work must remain visible, inspectable, and resumable in Codex's subagent panel.",
      effort: "high",
    },
    opencode: {
      description: "Native OpenCode subagent bridge for one-shot Gemini CLI work. Use proactively when a task should run through Gemini while remaining visible in an OpenCode child session.",
      color: "accent",
      steps: 60,
    },
  },
  amp: {
    role: "Amp CLI attached one-shot run",
    request: (c) => `Build one durable Harnest request with target "amp", a caller-owned request ID, the exact cwd, context, timeout, policy, and downstream task. Start it in the background and retain the returned job ID and context digest.`,
    mechanics: `Amp runs as a prompt-only attached one-shot; detached orbs are outside this bridge. execution.transport=session is unsupported and must be rejected before inference. Resume a follow-up only with execution.sessionId set to the receipt's native Amp thread identity. handoff_message/handoff_reroute fail closed as unsupported-control. Amp supports only explicit policy.write=true with empty tools and null maxCostUsd. Native read-only is not enforceable because workspace settings outrank custom settings and execute mode loads local plugins, so read-only requests fail before spawn. route.variant may be low, medium, high, or ultra; arbitrary model, provider, and thinking fields are rejected. Generated restrictive settings reduce risk but are not a containment boundary. Amp supports native Linux and macOS, or the entire MCP server running inside WSL; native Windows requests fail before inference.`,
    transport: `This target supports only attached one-shot transport. execution.transport=session is unsupported. JavaScript scripts belong to the parent's handoff_dynamic tools, not this single-handoff bridge.`,
    ladder: `Amp accepts write-capable work only: policy.write must be true with explicit parent authorization, tools must be empty, and maxCostUsd must be null. Use another target for read-only review.`,
    steering: (c) => `When the parent steers this child mid-run, do not message the one-shot run — resume it as a follow-up with execution.sessionId set to the receipt's Amp sessionId once it settles, or record the guidance for the parent.`,
    verify: (c) => `At terminal state, call ${c("handoff_result")}, verify request ID, context digest, resolved route, Amp session/workflow identity, final text, usage, and policy outcome, then return the complete receipt to the parent verbatim.`,
    claude: {
      description: "Native Claude subagent bridge for one-shot attached Amp CLI work. Use proactively when Amp should execute a bounded Linux, macOS, or WSL task while its status and durable receipt remain visible in Claude's subagent transcript.",
      maxTurns: 40, color: "pink",
    },
    codex: {
      description: "Native Codex child-thread bridge for one-shot attached Amp CLI work. Use when Amp work must remain visible, inspectable, and resumable in Codex's subagent panel.",
      effort: "high",
    },
    opencode: {
      description: "Native OpenCode subagent bridge for one-shot attached Amp CLI work. Use proactively when a task should run through Amp on Linux, macOS, or WSL while remaining visible in an OpenCode child session.",
      color: "accent",
      steps: 60,
    },
  },
  acp: {
    role: "trusted machine-local ACP agent session",
    request: (c) => `Build one durable Harnest request with target "acp", route.agent set to the operator-selected local registration, a caller-owned request ID, the exact cwd, context, timeout, and the downstream task. Preserve the parent's explicit authorization for the write scope, then set policy.write=true and metadata.harnest.writeApproved=true only for that approved work. Start it in the background and retain the returned job ID and context digest.`,
    mechanics: `Generic ACP is an explicitly trusted, write-only route. route.agent selects one machine-local registration from acp.agents; never accept executable commands, arguments, modules, or environment secrets from the request, registry metadata, or prompt. A registration's trusted:true is consent to native configuration imports, not a read-only guarantee or sandbox: native hooks, plugins, and MCP configuration can run before ACP initialization. Native authentication remains native and must never be read, copied, or forwarded. Read-only requests, structured Taskflow, persistent session transport, live message/reroute controls, provider and thinking fields, granular tool policy, and budgets fail before launch. Forward route.model, route.variant, and route.options when requested. The session must advertise the model ID, mode ID, and option IDs and values before Harnest can use them. Unsupported negotiated capabilities or client callbacks fail explicitly when discovered or requested. Follow-ups require execution.sessionId so the adapter can load or resume the observed native ACP session; never silently start a fresh session.`,
    transport: `This target supports only the attached generic ACP transport; execution.transport=session is unsupported. JavaScript scripts belong to the parent's handoff_dynamic tools, not this single-handoff bridge.`,
    ladder: `ACP accepts write-capable work only: preserve the parent's explicit authorization, then set policy.write=true and metadata.harnest.writeApproved=true only for that approved work; never synthesize either approval signal. Registry trust allows the named local executable to load its native configuration; it does not constrain that configuration to the request cwd.`,
    steering: (c) => `When the parent steers this child mid-run, do not message the active ACP prompt — resume it as a follow-up with execution.sessionId set to the receipt's native session ID once it settles, or record the guidance for the parent. handoff_message/handoff_reroute fail closed as unsupported-control.`,
    verify: (c) => `At terminal state, call ${c("handoff_result")}, verify request ID, context digest, resolved route, ACP agent and native session identity, final text, usage without invented cost fields, and policy outcome, then return the complete receipt to the parent verbatim.`,
    claude: {
      description: "Native Claude subagent bridge for one trusted machine-local ACP agent. Use when a registered ACP agent should execute explicitly authorized write-capable work while its status and durable receipt remain visible in Claude's subagent transcript.",
      maxTurns: 40, color: "purple",
    },
    codex: {
      description: "Native Codex child-thread bridge for one trusted machine-local ACP agent. Use when registered ACP work must remain visible, inspectable, and resumable in Codex's subagent panel.",
      effort: "high",
    },
    opencode: {
      description: "Native OpenCode subagent bridge for one trusted machine-local ACP agent. Use when explicitly authorized registered ACP work should remain visible in an OpenCode child session.",
      color: "accent",
      steps: 60,
    },
  },
};

const executionControls = {
  claude: 'Forward supported execution fields in print mode: addDirs, instructions, maxTurns, and sessionAction: "fork" with a sessionId. Confirm the write scope of any external directories.',
  codex: 'Forward supported execution fields in one-shot mode: image attachments, sessionAction: "fork" with a sessionId, and addDirs with approved write scope.',
  cursor: 'Forward execution.addDirs in print mode. Confirm the write scope of any external directories.',
  gemini: 'Forward execution.addDirs when requested. Confirm the write scope of any external directories.',
  opencode: 'Forward execution.attachments and sessionAction: "fork" with a sessionId in prompt-only handoffs. Omit the workflow for these controls.',
  pi: 'Forward execution.instructions, image attachments, and sessionAction: "fork" with a sessionId. Use a prompt-only handoff for images and forks.',
  acp: 'Forward execution.attachments when requested. The registered agent must advertise support for each attachment type.',
};

function workerBody(shell, key, target) {
  const c = (name) => code(shell, name);
  const owner = shell === "claude" ? "Claude's" : shell === "opencode" ? "this OpenCode session's" : "Codex's";
  const thread =
    shell === "claude"
      ? "Your Claude subagent thread"
      : shell === "opencode"
        ? "Your OpenCode child session"
        : "Your Codex agent thread";
  const body = [
    `You are ${owner} native bridge to exactly one ${target.role}. ${thread} is the operator-visible child session; do not perform the delegated repository work yourself. You are a thin forwarder, not an orchestrator: make exactly one ${c("handoff_workflow")} call, then poll, then return the receipt verbatim with no paraphrase of machine fields.`,
    ``,
    target.request(c),
    ...(executionControls[key] ? [``, executionControls[key]] : []),
    ``,
    announceFirst(shell),
    ``,
    HL(shell, target.mechanics),
    ``,
    target.transport || `When the parent explicitly selects execution.transport=session, preserve it. Claude uses Agent SDK streaming input, Codex uses app-server, and Cursor uses ACP. Inspect native acknowledgement evidence: delivery or queue acceptance does not establish consumption. Cursor active-turn messages remain unsupported. The one-shot guidance applies when session transport was not selected. JavaScript scripts belong to the parent's handoff_dynamic tools, not this single-handoff bridge.`,
    ``,
    TEXT_LEAF,
    ``,
    liveProtocol(shell),
    ``,
    FAN_OUT(shell),
    ``,
    `${target.ladder} ${NEVER_MERGE}`,
    ``,
    `${HL(shell, target.steering(c))} Stop or resume only the identified job and follow the handoff skill retry boundary.`,
    ``,
    HL(shell, target.verify(c)),
  ].join("\n");
  if (shell !== "opencode") return body;
  // The one-shot mechanics name the message/reroute controls in static text
  // (not via the tool-name helper), so prefix them for the OpenCode shell
  // here. Claude/Codex output above is untouched by this branch.
  return body.replaceAll(
    "handoff_message/handoff_reroute fail closed as unsupported-control",
    "`harnest_handoff_message`/`harnest_handoff_reroute` fail closed as `unsupported-control`",
  );
}

const NICKNAMES = `["bridge-1", "bridge-2", "bridge-3", "bridge-4", "bridge-5", "bridge-6", "bridge-7", "bridge-8"]`;
const DISALLOWED = `Agent, Bash, PowerShell, Read, Write, Edit, Glob, Grep, WebFetch, WebSearch, NotebookEdit`;

function renderClaude(key, target) {
  const front = target.claude;
  return `---\nname: ${key}-worker\ndescription: ${front.description}\ndisallowedTools: ${DISALLOWED}\nskills:\n  - harnest:handoff\nmodel: inherit\neffort: low\nmaxTurns: ${front.maxTurns}\nbackground: true\ncolor: ${front.color}\n---\n\n${workerBody("claude", key, target)}\n`;
}

function renderCodex(key, target) {
  return `# GENERATED by scripts/build-workers.mjs — do not hand-edit.\n# Edit the shared template / per-target blocks in that script and re-run it.\nname = "${key}_worker"\ndescription = "${target.codex.description}"\nmodel_reasoning_effort = "${target.codex.effort}"\nsandbox_mode = "read-only"\nnickname_candidates = ${NICKNAMES}\ndeveloper_instructions = """\n${workerBody("codex", key, target)}\n"""\n`;
}

const OPENCODE_PERMISSIONS = `  read: deny
  edit: deny
  glob: deny
  grep: deny
  list: deny
  bash: deny
  webfetch: deny
  websearch: deny
  task: deny
  todowrite: deny
  lsp: deny
  skill: deny`;

function renderOpencode(key, target) {
  const front = target.opencode;
  return `---\n# GENERATED by scripts/build-workers.mjs — do not hand-edit.\n# Edit the shared template / per-target blocks in that script and re-run it.\ndescription: ${front.description}\nmode: subagent\ncolor: ${front.color}\nsteps: ${front.steps}\ntemperature: 0.1\npermission:\n${OPENCODE_PERMISSIONS}\n---\n\n${workerBody("opencode", key, target)}\n`;
}

function rescueBody(shell) {
  const c = (name) => code(shell, name);
  return [
    `You are a thin durable-workflow forwarder. Convert the parent task into one Harnest request, call ${c("handoff_workflow")} exactly once, and return its complete terminal receipt unchanged.`,
    ``,
    announceFirst(shell),
    ``,
    `Default to background execution so the queued receipt and job ID persist before downstream model work begins. Preserve the task, context, acceptance criteria, cwd, target harness, route, policy, workflow graph, and explicitly requested execution controls. Perform no repository investigation or implementation yourself.`,
    ``,
    `Translate explicit completion requirements into context.requiredResultFields and exact canaries into context.requiredText. A downstream response that omits either is not a successful handoff.`,
    ``,
    liveProtocol(shell),
    ``,
    HL(shell, `After the queued receipt, call ${c("handoff_status")} using its job ID until terminal, then call ${c("handoff_result")}. Track and report the semantic phase, current activity, recent milestones, and last meaningful timestamp from trace.progress; never describe a fresh heartbeat alone as progress. The requested wall-clock timeout is a hard deadline. If a read-only job becomes failed or partial, call ${c("handoff_resume")} at most once; never automatically resume a write-capable job. A missing terminal receipt is a failed handoff.`),
  ].join("\n");
}

const built = [];
for (const [key, target] of Object.entries(TARGETS)) {
  await writeFile(join(agentsDir, `${key}-worker.md`), renderClaude(key, target));
  built.push(`agents/${key}-worker.md`);
  if (target.codex) {
    await writeFile(join(codexDir, `${key}_worker.toml`), renderCodex(key, target));
    built.push(`codex-agents/${key}_worker.toml`);
  }
  await writeFile(join(opencodeDir, `${key}-worker.md`), renderOpencode(key, target));
  built.push(`opencode-agents/${key}-worker.md`);
}
await writeFile(
  join(agentsDir, "workflow-rescue.md"),
  `---\nname: workflow-rescue\ndescription: Hand a substantial complete workflow to a supported harness or registered ACP agent and return its receipt. Use proactively when the lead should retain planning, review, and integration ownership while a downstream harness executes the whole workflow.\ndisallowedTools: ${DISALLOWED}\nskills:\n  - harnest:handoff\nmodel: inherit\neffort: low\nmaxTurns: 80\nbackground: true\n---\n\n${rescueBody("claude")}\n`,
);
built.push("agents/workflow-rescue.md");
for (const file of built) console.log(`built ${file}`);
