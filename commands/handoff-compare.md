---
description: Compare the same read-only task across multiple model routes.
argument-hint: "<task> <candidate-name=provider/model>..."
allowed-tools: mcp__plugin_harnest_harnest__handoff_compare
---

Build one read-only request from `$ARGUMENTS` and call `handoff_compare` once with two or more named candidates. Keep the task, context, workflow, policy, and completion contract identical across lanes. Compare the returned receipts by resolved route, evidence, final answer, usage, and failure state; surface agreements and disagreements without blending them into unsupported consensus.
