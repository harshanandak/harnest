---
description: Run or recover a mixed-harness agent workflow graph
argument-hint: "<workflow goal or graphId>"
---

Use the `harnest:handoff` skill and read its agent-graphs reference. For a new goal in $ARGUMENTS, define agent nodes and dependencies, validate the graph, then call handoff_graph_start once. Keep graphId, requestId and child job IDs. Watch revisions with handoff_graph_status using afterRevision and waitMs rather than repetitive polling. Inspect individual traces as needed and return the settled graph outputs. For an existing graph, inspect status first and resume only explicitly requested unsuccessful steps; completed work must not run again.
