---
description: Hand off the current task to a downstream worker with a durable receipt
agent: build
subtask: false
---

Hand off this task via Harnest. Call `harnest_handoff_host_info`
to pick the launch path, then `harnest_handoff_workflow` in background with a
caller-owned request ID, the exact cwd, and one leaf phase. Poll
`harnest_handoff_status` / `harnest_handoff_trace` (afterSequence)
and return the terminal receipt verbatim. Task: $ARGUMENTS
