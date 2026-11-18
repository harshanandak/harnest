---
description: Send acknowledged guidance to a running Harnest job.
argument-hint: "<job-id> <command-id> [steer|follow_up] <message>"
allowed-tools: mcp__plugin_harnest_harnest__handoff_message
---

Call `handoff_message` with the job, command ID, delivery mode, and message in `$ARGUMENTS`. Return the complete control acknowledgement unchanged. `applied` is delivered; `uncertain` requires session-trace reconciliation. One-shot targets (Cursor, Claude, Codex, Gemini, Amp) return `unsupported-control` for any live control.
