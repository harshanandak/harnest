---
description: Run or recover a mixed-harness agent workflow graph
---

Read the handoff skill's references/agent-graphs.md. Translate $ARGUMENTS into stable agent nodes with dependencies, validate using harnest_handoff_graph_validate, and start with harnest_handoff_graph_start. Retain graphId. Use revision-based handoff_graph_status with waitMs:25000, and read individual handoff_trace pages only when needed. Resume unsuccessful steps explicitly; completed steps remain intact. Report graph outputs and unresolved nodes truthfully.
