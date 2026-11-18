---
description: Change a running Harnest job's next model route.
argument-hint: "<job-id> <command-id> <provider> <model> [steer|follow_up] [message]"
allowed-tools: mcp__plugin_harnest_harnest__handoff_reroute
---

Call `handoff_reroute` with the job, command ID, provider/model, optional delivery mode, and optional guidance in `$ARGUMENTS`. State that the route applies to the next model request and return the acknowledgement unchanged. One-shot targets (Cursor, Claude, Codex, Gemini, Amp) return `unsupported-control`.
