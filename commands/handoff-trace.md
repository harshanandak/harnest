---
description: Read new semantic events from a Harnest handoff
argument-hint: "<job-id|request-id> [afterSequence]"
allowed-tools: mcp__plugin_harnest_harnest__handoff_trace, mcp__plugin_harnest_harnest__handoff_status
---

Call `handoff_trace` with a job or request ID. For live tracking, remember `nextSequence` and pass it as `afterSequence` on the next call. Summarize real semantic events; do not describe heartbeat-only activity as progress.
