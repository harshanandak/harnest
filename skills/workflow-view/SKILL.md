---
name: workflow-view
description: Show the live Harnest workflow view - running workflows, node states, models and thinking levels - as a terminal tree, and stream changes while they happen. Use when the user asks to see running workflows, graph progress, or what the delegated agents are doing.
argument-hint: "[graphId] [--workflow <id>] [--list] [--watch] [--once|--plain] [--interval <ms>] [--width <n>] [--ascii]"
---

# Workflow view

Keep workflow visibility inside the calling harness. Use a native workflow UI where supported; otherwise show the workflow as a named native background task or observer subagent with continuously streamed CLI output. Read [the observer contract](../handoff/references/workflow-observer.md) before starting a watch.

Run from the harnest plugin root:

- Snapshot: `node "${CLAUDE_PLUGIN_ROOT}/scripts/graph-view.mjs" [graphId]` renders the newest active workflow, or the given `graph-<id>`; `--list` prints the switcher list of recent workflows and marks the selected one.
- Live: `node <plugin-root>/scripts/workflow-monitor.mjs --workflow <runId>` streams dynamic or fixed-workflow changes through the native task's stdout, including non-TTY output. It stops when the selected run settles. `--interval <ms>` changes the refresh period; `--once` prints a snapshot. Use the installed skill's package root when `CLAUDE_PLUGIN_ROOT` is unavailable.
- Options: `--workflow <graphId|requestId>` to pick a specific run, `--width <n>` to force the render width, `--plain` for no ANSI, `--ascii` for a fully ASCII frame; `--state <dir>` points the viewer at a non-default durable store (testing/internal).
- In-session drill-in: use `handoff_dynamic_inspect` for invocation attempts, `handoff_trace` for a job's bounded transcript, and the matching dynamic/graph status/result tools. Workflow controls go through the matching MCP control/cancel/resume tools, not the observer process.
- One job's live transcript: `node "${CLAUDE_PLUGIN_ROOT}/scripts/handoff-view.mjs" <jobId|requestId> --watch` tails deltas and state changes until the job is terminal — the same data `handoff_trace` pages, as a terminal screen.

When the skill is used outside the plugin (a plain checkout or another host), run the same commands from the repository root.

The observer is read-only. It reads the same durable job/workflow store as Harnest. Stopping its native task never stops the workflow. Verify host task visibility separately from execution-adapter acceptance.
