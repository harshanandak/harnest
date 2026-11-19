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
2. Call `handoff_trace` with the job ID and `afterSequence` set to the previous response's `nextSequence` for new progress only.
3. Call `handoff_result` after the job settles and retain the terminal receipt.
4. Use `handoff_cancel` to request cancellation. Continue polling until the downstream owner acknowledges settlement.
5. Use `handoff_resume` for a failed or partial read-only handoff after reviewing its trace.

Ask for file and line evidence in the task or acceptance criteria. Add receipt arrays such as `evidence` to `requiredResultFields` only when the selected adapter is configured to populate them; prose in the agent's final text does not create a structured receipt array.

A foreground timeout above the safe MCP wait is converted to a background job. Prefer `background: true` for work that can take more than one tool turn.

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

Do not combine contradictory `write`, `readOnly`, and `allowWrites` values. Harnest validates policy before launch. A write-capable retry also needs renewed lead approval.

## Narrow the tool policy

`policy.tools` accepts an object with `allow`, `deny`, or both. Use exact native tool names. Deny wins when both lists name a tool. An empty allow list selects no tools on targets that support it. The existing array form keeps its previous behavior.

For example, a read-only Gemini handoff can use `"policy": { "write": false, "tools": { "allow": ["read_file", "glob"], "deny": ["glob"] } }` to keep only `read_file`. Claude print also supports both lists, with `allow` limited to `Read`, `Glob`, and `Grep`. Pi and fresh local OpenCode V1 runs accept `deny` only. See the [per-target tool names and limits](supported-agents.md#per-run-policy-controls).

Use `"policy": { "write": false, "mode": "plan", "sandbox": true }` with Cursor print to request read-only planning and enable its shell sandbox. Plan mode takes precedence over agent mode even with approved write access. Sandbox can also be enabled without selecting plan mode. Omit `sandbox` to inherit Cursor's settings. Harnest rejects `sandbox: false` because it could turn off configured isolation.

These controls preserve the existing write authorization and approval checks. Unsupported targets, transports, and CLI versions fail before inference.
For JavaScript workflows, set `execution.transport: "oneshot"` on Claude or Cursor calls using these controls.

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
