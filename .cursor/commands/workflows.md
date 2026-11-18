---
name: workflows
description: Show the live Harnest workflow view (graph tree, models, thinking levels)
argument-hint: "[graphId] [--workflow <id>] [--list] [--watch] [--once|--plain] [--interval <ms>] [--width <n>] [--ascii]"
---

# Live workflow view

For live updates (`--watch`), launch this with Cursor's Shell tool as a native background task, retaining its task handle:

```bash
node scripts/workflow-monitor.mjs --workflow <runId>
```

Both `dyn-` and `graph-` IDs are supported. The observer streams meaningful changes through piped stdout until the run settles; use `--interval <ms>` to adjust frequency. Keep the updates in this task's output. If a native background task is unavailable, use a visible read-only observer subagent where supported. Follow `.cursor/skills/handoff/references/workflow-observer.md`.

For a JavaScript workflow snapshot, add `--once` to the observer. For fixed graph snapshots, use `node scripts/graph-view.mjs`: `--workflow <id>`, `--list`, `--once`, `--plain`, `--width <n>` and `--ascii` select and format the output. Resolve a run with the history/status tools when no ID was supplied.

Inspect attempts with `handoff_dynamic_inspect` and agent output with `handoff_trace`/`handoff_result`. Send requested controls through the matching workflow MCP tools, then show their acknowledged outcome. Stopping the observer only closes this view.
