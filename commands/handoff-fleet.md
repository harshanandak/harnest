---
description: Watch every running Harnest agent at once
argument-hint: "[state=queued|running|completed|failed|cancelled|partial] [target=opencode|pi|cursor|claude|codex|amp|acp]"
allowed-tools: mcp__plugin_harnest_harnest__handoff_fleet, mcp__plugin_harnest_harnest__handoff_message, mcp__plugin_harnest_harnest__handoff_resume
---

Call `handoff_fleet` to see how many agents are active, what each is doing (`progress`, last activity, recent messages), and how to steer it right now. Steer `live` agents with `handoff_message` and a fresh command ID; steer `resume` agents (one-shot targets, terminal jobs) with `handoff_resume` once settled — write-capable retries need lead approval. Generic ACP rejects live message/reroute control; resume its negotiated native session with `execution.sessionId` after the current run settles.
