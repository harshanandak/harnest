---
description: Resume a terminal Harnest job.
argument-hint: "<job-id> [background=true|false]"
allowed-tools: mcp__plugin_harnest_harnest__handoff_resume
---

Call `handoff_resume` for the job in `$ARGUMENTS`. Preserve the complete returned receipt and its context digest. Resume automatically at most once and only for read-only jobs; write-capable retries need lead approval after trace review.
