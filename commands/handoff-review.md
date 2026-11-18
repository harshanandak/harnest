---
description: Review work with multiple models against a rubric
argument-hint: "<request-id|task> <reviewer,..> [threshold=9]"
allowed-tools: mcp__plugin_harnest_harnest__handoff_review, mcp__plugin_harnest_harnest__handoff_result
---

Use the `harnest:handoff` skill's review loop. Call `handoff_review` with the work, 2-8 named reviewer routes, an explicit rubric, and a threshold (default 9/10 average). Reviewers score independently, then see the shared board and answer each other for up to 3 rounds. The tool never implements: on `partial`, apply the consolidated findings yourself and re-invoke with `previous` carrying the last summary and scores. Recover lanes individually with `handoff_result` by job ID.
