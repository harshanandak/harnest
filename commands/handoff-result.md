---
description: Retrieve a terminal Harnest result.
argument-hint: "<job-id|request-id>"
allowed-tools: mcp__plugin_harnest_harnest__handoff_result
---

Call `handoff_result` for the job ID in `$ARGUMENTS`, or use `requestId` when recovering a lost response. Present the complete compact receipt, including errors, evidence, tests, route, usage, trace/recovery metadata, and unresolved risks.
