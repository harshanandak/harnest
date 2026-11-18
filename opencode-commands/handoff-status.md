---
description: Show status and recent trace for a Harnest handoff
agent: build
subtask: false
---

Call `harnest_handoff_status` for job `$ARGUMENTS`, then page
`harnest_handoff_trace` with afterSequence for new events. Report
`trace.progress.phase`, `current`, recent milestones, and `lastMeaningfulAt`.
Heartbeat-only activity is stalled, not progress.
