---
description: List recent Harnest handoff sessions
argument-hint: "[state=queued|running|completed|failed|cancelled|partial] [target=opencode|pi|cursor|claude|codex|gemini|amp|acp]"
allowed-tools: mcp__plugin_harnest_harnest__handoff_sessions
---

Call `handoff_sessions` to list durable jobs and their downstream session/workflow IDs, state, and semantic progress. Use `handoff_trace` for the selected job and `handoff_message` to add guidance when that harness supports live control. Generic ACP rejects live message/reroute control; resume its negotiated native session with `execution.sessionId` after the current run settles.
