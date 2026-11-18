---
description: Show the live Harnest workflow view (graph tree, models, thinking levels)
argument-hint: "[graphId] [--workflow <id>] [--list] [--watch] [--once|--plain] [--interval <ms>] [--width <n>] [--ascii]"
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/graph-view.mjs" *), Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-monitor.mjs" *)
---

For live updates (`--watch`), keep the observer in Claude's native background task: `node "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-monitor.mjs" --workflow <runId>`. It supports both `dyn-` and `graph-` IDs, streams through piped output and exits when that run settles. Retain the host task handle and show its output in this session. Use `--interval <ms>` to change the refresh period. Follow [the observer contract](../skills/handoff/references/workflow-observer.md).

For a JavaScript workflow snapshot, use that observer with `--once`. For a fixed graph snapshot, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/graph-view.mjs" $ARGUMENTS`: `--list` shows recent graphs; `--workflow <id>`, `--once`, `--plain`, `--width <n>` and `--ascii` select and format the snapshot. With no selector, use the configured plugin monitor's recent-workflow updates or discover runs with the history tools. Reuse an existing observer for the same run.
