# Multi-agent workflow environment

A dynamic workflow is a harness built for one task, not a fixed pipeline. Use this playbook when the work is large, parallel, or needs independent verification. For ordinary edits and questions, use the default session — a workflow has to earn its coordination cost.

Harnest owns the environment and orchestration across OpenCode, Pi, Claude Code, Codex and Cursor. Claude Dynamic Workflows is the reference experience, not an execution dependency. Each harness owns an assigned agent; the lead retains planning, review and integration.

## JavaScript-owned orchestration

Use `handoff_dynamic_validate` then `handoff_dynamic_start` with `{workflow:{requestId,cwd,source,args,target,route,policy,context,execution}}`. The isolated JavaScript runtime owns branches, loops and bounded fan-out. Helpers are `agent(prompt, options)`, `pipeline(items, callback)`, `parallel(tasks)`, `phase(title)`, `log(message)` and read-only `args`. Agent options can select a different target/model per call. Keep deterministic state in the script rather than repeatedly asking the lead to coordinate batches.

Starts return a durable `runId`. Poll `handoff_dynamic_status` with `afterRevision` and `waitMs`; inspect individual job IDs with `handoff_trace`. Read `handoff_dynamic_result` for output and terminal health. A returned value does not erase failed agent attempts.

Controls use `handoff_dynamic_control` with a stable `commandId`: pause, continue, stop, stop-agent, restart-agent, steer and reroute. Agent actions identify an `invocationId`. Inspect applied/rejected/uncertain outcomes. Session transports use each harness's native API; unsupported controls reject. An accepted or queued message is not proof of consumption. Write retries require explicit user approval.

Recovery uses `handoff_dynamic_resume`: reuse the matching successful ordered prefix and invalidate later reuse after the first failed or changed invocation. Historical receipts remain inspectable through `handoff_dynamic_inspect`. Never describe script replay as fixed-DAG selective recovery.

Save reusable scripts with `handoff_dynamic_save`; discover them with list/get/revisions and invoke a reviewed source revision with fresh parameters through `handoff_dynamic_invoke`. Project scope takes precedence over user scope. OpenCode includes dynamic runs in its workflow switcher, and Pi offers the in-session `/harnest_dynamic` widget. For hosts without embedded workflow UI, follow [in-harness workflow observation](workflow-observer.md): keep a native task/subagent visible and stream `node scripts/workflow-monitor.mjs --workflow <runId>` within it.

The script limit is 1,000 agent calls, helpers accept up to 4,096 items, and dispatch concurrency is capped at six. Native process memory and provider quotas remain separate limits. Inspect usage counters; do not infer subscription savings from cache hits.

## Fixed graph patterns

Use `handoff_graph_start` when dependencies are known before dispatch and independently completed branches should survive selective recovery. In this mode the lead holds loops across runs. The remainder of this playbook describes that fixed-graph mode and its templates.

## Scale rules

- One graph holds 1–256 nodes. At most 6 run concurrently; everything else queues in waves. 200 nodes at concurrency 6 with ~2 minute nodes is about 34 ideal waves and ~70 minutes minimum, before skew, dependencies, and writer serialization.
- More than 256 work items: page across runs. Keep the deterministic state (bracket, page index, seen dedupe keys, running summary) in the lead, not in a node.
- Keep shared context small and dependencies direct. A synthesize node should depend on the lanes it merges, not on every node.
- Use `target:"auto"` with `metadata.routing` hints so cheap steps (extract, list, dedupe) run on quick lanes and judgment steps (verify, synthesize) on stronger ones. Mixing is the token-efficiency lever; parallelism alone is not.
- Poll with `handoff_graph_status({graphId, afterRevision, waitMs:25000})`. Inspect a node's child trace only when its state needs explaining.
- State canaries in `context.requiredText` and completion fields in `requiredResultFields` when a node's output must contain exact markers (for example `CONFIRMED_ONLY`). Canaries match only as standalone result lines (the token alone or `RESULT: TOKEN`); text that quotes the token mid-sentence does not satisfy the contract. Claude Code nodes refuse bare echo prompts as prompt injection, so give them real task text and ask for a final `RESULT: <canary>` line.

## Patterns

### Classify-and-act
One classifier node first. The lead reads its receipt, then builds and starts a second graph for the chosen class. The classifier's output is a decision, not an artifact.

### Fan-out-and-synthesize
N independent lanes plus one synthesis node that `dependsOn` all of them. Direct upstream results arrive as `context.graph.upstream[<id>]`. Keep lane tasks self-contained; give each its own clean context instead of sharing one giant brief.

### Adversarial verification
For each produced artifact, add verifier nodes that depend on the producer and try to falsify it against a rubric. A producer with two independent verifiers and a fixer that depends on both is the smallest useful unit.

### Per-item pipeline (implement → verify → fix)
One chain per work item: `implementer` (write, isolated `cwd`) → two `verifier`s (read-only) → `fixer` (write, depends on both verifiers) → one `synthesize` depending on all fixers. N can be in the hundreds, so the lead pages items across runs. Every writer needs its own existing directory; the scheduler serializes overlapping writers and never merges.

### Generate-and-filter
N generators → one filter node that depends on all of them and dedupes against a rubric. Return the survivors plus why each lost; never delete findings silently.

### Tournament
Pairwise comparison nodes, each judging exactly two candidates, are more reliable than absolute scoring. The lead holds the bracket between runs: round 1 pairs, round 2 pairs of winners, and so on. Each comparison is a read-only node; do not ask one node to rank 1000 items.

### Loop until done
Graphs are acyclic. A loop is the lead starting another run with a fresh `requestId` while the stop condition is unmet (no new findings, build clean, budget spent). Carry forward only the compact state, and stop on a stated bound.

### Deep verification
`extract` (claims, each with an id) → one `check-<id>` per claim → optional `audit-<id>` depending on its checker → `report` depending on all checkers/auditors. The audit layer exists only when source quality is contested.

### Rule adherence
One verifier per rule, all depending on the artifact. A `skeptic` node depends on every verifier and re-reads each flagged violation against the diff, classifying it real, false positive, or uncertain. Report confirmed violations only.

### Triage and quarantine
Readers of untrusted content (tickets, web pages, logs) are strictly read-only nodes that emit structured summaries. A separate trusted actor node acts only on summaries, never on raw untrusted content. Never put raw untrusted content in graph-level `context`: it is merged into every node, including the actor. Give each reader its own `context.item`; the actor sees only the dedupe result. The lead enables `write` for the actor explicitly and reviews before anything ships. Repeated triage is a loop-until-done across runs.

### Sorting at scale
Pairwise tournament with paged rounds — comparisons are cheap lanes, the bracket lives in the lead. Selecting one winner from 1000 candidates takes 999 comparisons (500 in the first round); fully ordering 1000 items takes at least ~8,500. Confirm the spend before starting, or bucket-rank with a rubric first.

### Paged map-reduce (100+ items)
Bounded leaf batches produce compact, schema-checked summaries with a stable item key and provenance. Reducers take at most 10–20 direct upstream results at a time and recurse until one final output remains. Keep a lead-held page ledger: input snapshot hash, settled and unresolved items, dedupe keys, graph/request IDs, and upstream fingerprints. A changed input fingerprint requires a fresh graph, never a resume.

## Safety and budget

- Keep every reviewer, reader, and judge `write:false`. Writers get an isolated existing directory and never a shared checkout.
- Retrying a write node requires explicit user approval of the retry scope; the lead passes `approveWrites:true` only after that, never on the user's behalf. Merges and deploys stay with the lead.
- Reserve per-run `timeoutMs` and a node count that matches the spend you intend. A failed node blocks dependents; resume only the unsuccessful nodes — completed nodes never rerun.
- Watch runs with `node scripts/graph-view.mjs <graphId>` (or `--once` for a static frame): phases, per-node state, model, tokens, tool calls, attempts, and drill-in to the prompt, attempts, response, and recent trace. On an OpenCode host, every node is also a native session in the OpenCode sidebar when the TUI is opened in the graph's working directory (`route.serverUrl` opts into a private, non-sidebar server instead).

## Templates

Copy a template from this directory, replace `requestId` and `cwd`, and adapt the tasks. Validate with `handoff_graph_validate` before starting.

- `workflow-fanout-verify.json` — independent research lanes, verification, synthesis.
- `workflow-adversarial-review.json` — one artifact, three reviewer angles, skeptic, consolidation.
- `workflow-per-item-pipeline.json` — implement → verify → fix per item, then synthesize (writers).
- `workflow-quarantine-triage.json` — read-only untrusted readers, dedupe, trusted actor.
- `workflow-tournament-round.json` — one pairwise judging round; the lead advances winners.
