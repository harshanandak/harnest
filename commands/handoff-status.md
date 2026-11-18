---
description: Check a Harnest job.
argument-hint: "<job-id|request-id>"
allowed-tools: mcp__plugin_harnest_harnest__handoff_status
---

Call `handoff_status` for the job ID in `$ARGUMENTS`, or use `requestId` when the original MCP response was lost. Lead with `trace.progress.phase`, `current`, recent milestones, and `lastMeaningfulAt`; distinguish meaningful progress from a heartbeat-only stall. Preserve identifiers, state, timestamps, trace/recovery metadata, route, session/workflow identity, and context digest.
