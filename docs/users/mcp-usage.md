# MCP usage and examples

Harnest exposes durable handoff, graph, routing, transcript, and JavaScript workflow tools. Start with one background handoff and use the job ID or stable request ID to recover it from a fresh MCP process.

## One durable handoff

Call `handoff_workflow` with a `request` object. `requestId`, `target`, `task`, and an absolute `cwd` are required.

```json
{
  "request": {
    "requestId": "review-auth-001",
    "target": "claude",
    "task": "Review the authentication change for correctness and security. Do not edit files.",
    "cwd": "/absolute/path/to/project",
    "context": {
      "goal": "Find release-blocking defects",
      "acceptanceCriteria": ["Cite file and line for every finding"],
      "requiredResultFields": ["finalText"]
    },
    "execution": {
      "background": true,
      "timeoutMs": 1800000
    },
    "policy": {
      "write": false
    }
  }
}
```

Use the returned `jobId` in the lifecycle tools:

1. Call `handoff_status` with `{ "jobId": "..." }` for compact state.
2. Call `handoff_trace` with the job ID. Follow `page.continuation` when present, then use the last `nextSequence` as `afterSequence` when polling for new progress.
3. Call `handoff_result` after the job settles. Assemble all pages before retaining the terminal receipt.
4. Use `handoff_cancel` to request cancellation. Continue polling until the downstream owner acknowledges settlement.
5. Use `handoff_resume` for a failed or partial read-only handoff after reviewing its trace.

Ask for file and line evidence in the task or acceptance criteria. Add receipt arrays such as `evidence` to `requiredResultFields` only when the selected adapter is configured to populate them; prose in the agent's final text does not create a structured receipt array.

A foreground timeout above the safe MCP wait is converted to a background job. Prefer `background: true` for work that can take more than one tool turn.

## Response limits and continuations

`handoff_status` has a 16 KiB UTF-8 response budget. Result, trace, session, and board pages have a 64 KiB budget. The budget includes the JSON and its MCP text copy, with room reserved for protocol framing.

Status, session lists, and the receipt on each trace page expose job state, identity, cancellation, recovery, and errors. These views omit `result` and replace nonempty `controls` with `controlCount`. Use `resultRef.tool` with `resultRef.arguments` once the job settles. A compact row with `projection.continuation` links to status for its full metadata. An unusually large status itself can span multiple pages.

- **Receipt pages.** A normal `handoff_result` returns the original receipt. A large result or status puts `page` alongside the displayed receipt fields. Call the named tool with `page.continuation.arguments`, including its opaque `cursor`. Join the `page.chunk` strings in order and parse the JSON once `continuation` is null. The displayed state is the durable state throughout pagination. If the receipt changes and invalidates the cursor, start again without a cursor.
- **Trace and board pages.** For a full history, start with `afterSequence: 0`. Omitting it starts from a recent window, so earlier entries may exist. When a page has `page.continuation`, call that tool with its arguments as supplied. If `page.item` is present, join its `chunk` strings for that sequence and parse the complete item once `omittedBytes` is zero. `nextSequence` advances past the item when its last fragment is returned. Once the continuation is exhausted, resume polling with `afterSequence: nextSequence`. An oversized `handoff_post` echo returns the posted entry's identity and a `handoff_read` continuation.
- **Session lists.** Follow the continuation to read the rest of the requested list. The offset tracks positions in the current recently updated list, so a new or updated job can move rows between calls.

`originalBytes` counts UTF-8 bytes of the compact JSON before paging. On trace, board, and session lists it measures the requested window's array. `omittedCount` counts items from that window whose delivery is still incomplete. For receipt and item fragments, `offset` and `omittedBytes` are byte counts within the JSON being assembled. A null continuation means the page sequence is complete. Trace paging recovers the items as exposed by the redacted trace API.

## Native execution controls

Set these fields in the `execution` object of a single `handoff_workflow` request. Omit fields the downstream target cannot honor. Harnest rejects unsupported combinations before sending the prompt.

| Field | How to use it |
| --- | --- |
| `addDirs` | Pass up to eight existing, absolute directories to Claude, Codex, or Cursor. When write policy is enabled, confirm the scope of any directory outside `cwd` and set `metadata.harnest.writeApproved: true`. With read-only policy, Claude exposes only Read, Glob, and Grep and disables configured MCP servers for this launch. Cursor keeps Ask mode. Codex requires write policy because its native flag adds writable roots. |
| `attachments` | Pass up to four entries such as `{"type":"image","path":"/absolute/path/to/screenshot.png"}`. Each must be a regular local file at most 256 KiB. Images use PNG, JPEG, GIF, or WebP extensions, and the selected model must support the format. Codex and Pi accept images. OpenCode accepts images and files. ACP requires the agent to advertise image or embedded resource support for the corresponding type. Use a prompt-only handoff. |
| `instructions` | Append nonempty text up to 8,000 UTF-8 bytes to the system prompt in Claude print mode or Pi RPC. |
| `sessionAction` | With `sessionId` set, omit this field or use `"resume"` to continue the session. Use `"fork"` with Claude, Codex, OpenCode, or Pi to start a new native session from it. Use a prompt-only handoff and read the new ID from the receipt. |
| `maxTurns` | Set a positive integer to cap Claude agentic turns through the installed print CLI. |

These native controls use the default transport. The persistent `execution.transport: "session"` path accepts ordinary resume.

## Approved write work

Use one normalized policy field and include the guarded-host approval marker after the lead has confirmed the exact scope:

```json
{
  "request": {
    "requestId": "fix-parser-001",
    "target": "codex",
    "task": "Implement the approved parser fix and run the focused tests.",
    "cwd": "/absolute/path/to/project",
    "execution": { "background": true },
    "policy": { "write": true },
    "metadata": {
      "harnest": { "writeApproved": true }
    }
  }
}
```

A write-capable retry needs renewed lead approval.

## Native route controls

Set these fields on `request.route` for the named target.

| Target | Field | Native selection |
| --- | --- | --- |
| Codex | `serviceTier` | `default`, `fast`, `priority`, or `flex` via `-c service_tier=...`. `fast` and `priority` both request priority processing. The model and account must support the tier. |
| Codex | `profile` | `--profile <name>` loads the named `<name>.config.toml` in the native Codex home. |
| Claude | `serviceTier` | `fast` via `--settings '{"fastMode":true}'`. Harnest requires a native result that confirms fast mode. |
| Claude | `agent` | `--agent <name>` selects the named Claude Code agent. Use a plugin-qualified name where needed. |

These Codex and Claude settings require one-shot execution. In a JavaScript workflow, set `execution.transport` to `"oneshot"` on the agent call. Codex route controls require CLI 0.170.0 or later. Claude fast mode requires Claude Code 2.1.219 or later so Harnest can check its reported state.

## Narrow the tool policy

`policy.tools` accepts an object with `allow`, `deny`, or both. Use exact native tool names. Deny wins when both lists name a tool. An empty allow list selects no tools on targets that support it. The existing array form keeps its previous behavior.

Claude print accepts both lists. For example, `"policy": { "write": false, "tools": { "allow": ["Read", "Glob"], "deny": ["Glob"] } }` keeps only `Read`. The allow list accepts `Read`, `Glob`, and `Grep`. Pi accepts `deny` only. OpenCode V2 rejects nonempty tool lists and any explicit allow list. See the [per-target tool names and limits](supported-agents.md#per-run-policy-controls).

Use `"policy": { "write": false, "mode": "plan", "sandbox": true }` with Cursor print to request read-only planning and enable its shell sandbox. Plan mode takes precedence over agent mode even with approved write access. Sandbox can also be enabled without selecting plan mode. Omit `sandbox` to inherit Cursor's settings. Harnest rejects `sandbox: false` because it could turn off configured isolation.

These controls preserve the existing write authorization and approval checks. Unsupported targets, transports, and CLI versions fail before inference.
JavaScript workflows default to `execution.transport: "oneshot"` for these Claude and Cursor controls. Automatic validation checks the policy shape. The runner checks whether the resolved target can enforce it before dispatch.

## Generic ACP handoff

The generic route is selected by both `target: "acp"` and the trusted registration ID in `route.agent`:

```json
{
  "request": {
    "requestId": "acp-approved-001",
    "target": "acp",
    "task": "Implement and test the approved change.",
    "cwd": "/absolute/path/to/project",
    "route": { "agent": "registered-agent-id" },
    "execution": { "background": true },
    "policy": { "write": true },
    "metadata": {
      "harnest": { "writeApproved": true }
    }
  }
}
```

The registration supplies the executable and arguments. Requests cannot supply a command, environment secrets, or registry install command. Read [the ACP trust boundary](../acp-agents.md) before using this route.

Add `route.model` or `route.variant` to select a model or mode ID advertised during native session setup. Use `route.options` for up to 16 advertised configuration IDs, each up to 128 characters, mapped to a boolean or an advertised string of up to 256 characters. Use each model or mode control once. Harnest applies the selections before prompting and rejects missing, unadvertised, or unconfirmed choices.

## Multi-agent graph

For a fixed dependency graph across agents:

1. Call `handoff_graph_validate` with the complete graph.
2. Call `handoff_graph_start` and retain its `graphId`.
3. Poll `handoff_graph_status`. Pass the previous `revision` as `afterRevision` and use `waitMs` for change-based waiting.
4. Call `handoff_graph_result` after the graph settles.
5. Use `handoff_graph_resume` with a stable `commandId` to retry selected unsuccessful nodes. Completed nodes are retained.

```json
{
  "graph": {
    "requestId": "release-review-001",
    "cwd": "/absolute/path/to/project",
    "nodes": [
      {
        "id": "correctness",
        "target": "codex",
        "task": "Review the change for correctness.",
        "policy": { "write": false }
      },
      {
        "id": "security",
        "target": "claude",
        "task": "Review the change for security risks.",
        "policy": { "write": false }
      },
      {
        "id": "synthesis",
        "target": "codex",
        "task": "Combine the two reviews into one prioritized report.",
        "dependsOn": ["correctness", "security"],
        "policy": { "write": false }
      }
    ],
    "outputs": ["synthesis"]
  }
}
```

Use separate working directories for concurrent writers. Harnest serializes overlapping write paths but does not create, merge, or delete worktrees. See the [full graph contract](../agent-graphs.md).

## Routing and advanced workflows

- `handoff_routing_get`, `handoff_routing_configure`, and `handoff_routing_preview` inspect and change user routing. See [Routing preferences](../preferences.md).
- `handoff_host_info` reports the calling host's launch path, worker names, routing state, and target control semantics.
- `handoff_message` and `handoff_reroute` need caller-owned `commandId` values and only work where the selected transport acknowledges them.
- `handoff_dynamic_*` tools run JavaScript-owned loops, branches, and dynamic fan-out in isolated QuickJS. See [JavaScript workflows](../javascript-workflows.md).

Keep secrets out of task text, context, traces, and receipts. Durable local state can contain the request and downstream tool output in plaintext.
