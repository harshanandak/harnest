# Agent workflow graphs

## How graphs work

Harnest coordinates a directed acyclic graph (DAG). Each node is one complete handoff owned by a supported named target or an explicitly trusted registered ACP agent. Targets can differ between nodes while every individual handoff retains one downstream owner. Existing single-harness handoffs keep their behavior.

## Acceptance contract

- Agents submit a graph through the host's tools; users can describe the workflow in ordinary language.
- Each node names its task, target harness, model route, dependencies, and optional working directory and narrower permissions.
- A node can use `target:"auto"` with `metadata.routing` task hints. Existing policy selects that node's harness/model without an LLM routing call; record the resolved route and explanation. Explicit targets/models remain selectable. A missing viable route fails validation before dispatch.
- Validate the complete graph and all routes before starting any node. Reject cycles, duplicate node names, unknown dependencies, oversized graphs, and permission escalation.
- Run ready nodes concurrently up to a bounded limit. A dependent node starts only after every prerequisite completes successfully.
- Pass direct dependencies' outputs as attributed context data. Preserve the graph identity, node identity, child request ID, job ID, model route, and downstream session identity.
- Persist graph state and dispatch intent before launching children. Repeated starts and repeated resume commands cannot launch duplicate work. A process restart exposes interrupted graphs and allows explicit recovery.
- Show every node's state, dependencies, attempts, progress, and child trace references. Completed graphs expose selected output nodes and their results.
- A failed node blocks its dependents while independent branches finish. The graph settles as partial. Resume selected unsuccessful nodes and continue newly unblocked nodes, preserving completed nodes.
- Cancellation stops future dispatch and requests cancellation of active nodes. Do not claim downstream execution stopped without a settled child receipt.
- Shared-directory writes are serialized, including overlapping parent/child directories. Independent writers use explicitly supplied isolated working directories. Graph code does not create, merge, or delete worktrees automatically.
- Existing routing rules apply per node. Claude models use Claude Code. Read-only graphs cannot launch write-capable children. Retrying any write-capable step requires explicit approval.
- Supply equivalent MCP and Pi extension entry points, host discovery, agent instructions, a reusable example, and executable fake-harness end-to-end coverage on Node and Bun.
- Scheduling uses code, not model turns. Status omits task text and full outputs; revision-based long polling suppresses unchanged responses. Dependencies carry direct upstream results only. Verify concurrency and recovery without duplicated model work, and measure scheduling/status overhead separately from inference time.

## First version boundary

This version is an agent-callable DAG runner. Visual drag-and-drop editing, dynamically generated nodes, conditional branches, cycles, and automatic implementation/review loops are separate additions. Loops and dynamic fan-out are lead-held multi-run patterns: the scheduler never creates nodes and never cycles, so the lead starts follow-up runs with fresh request IDs while carrying compact state. Native host child panels are host-dependent; graph status and child receipts are the portable view. On OpenCode hosts, graph nodes attach to the shared background service by default, so every node is a native session in the OpenCode sidebar when the TUI is opened in the graph's working directory; pass `route.serverUrl` to isolate a node on a private server instead. The sidebar widget names a workflow by its `task` (keep that short and human) and renders nodes by prettified id, so use short readable node ids such as `collect`, `analyze-a`, `publish`; it shows the selected workflow as a left-justified waterfall, and `/workflows` switches between concurrently running workflows. The pattern playbook and copyable templates live in [dynamic workflows](../skills/handoff/references/dynamic-workflows.md).

## Tool contract

- `handoff_graph_validate({graph})` validates without dispatch.
- `handoff_graph_start({graph})` creates or recovers an idempotent graph run.
- `handoff_graph_status({graphId,afterRevision?,waitMs?})` returns every node's compact state. Use the prior revision and up to 25,000ms wait to receive changes; unchanged responses are small. Read full node traces only when needed.
- `handoff_graph_result({graphId})` returns a settled graph with selected outputs.
- `handoff_graph_cancel({graphId})` requests cancellation.
- `handoff_graph_resume({graphId,commandId,nodeIds?,approveWrites?,background?})` explicitly retries unsuccessful nodes; the caller-owned command ID makes retries idempotent.

Graph input: `{requestId,cwd,task?,context?,policy?,metadata?,execution?,nodes,outputs?}`. Graph execution contains `background` (default true), `timeoutMs`, and `maxConcurrency` (default 4, maximum 6). A graph holds 1 to 256 nodes. Batch larger workloads across runs.

Nodes contain `{id,target,task,dependsOn?,route?,cwd?,context?,policy?,metadata?,execution?}` and run as prompt-only handoffs in the chosen harness. Node execution accepts `timeoutMs`, `sessionId`, and the [native execution controls](users/mcp-usage.md#native-execution-controls) supported by the resolved target. Overlapping directories, including `addDirs`, serialize when either node can write. A retry resumes the forked session once the harness has reported its ID. To run a harness's own compatibility workflow, use an explicit Taskflow handoff with `workflow.spec` (optional package required).

For task-aware routing, a node can be:

```json
{
  "id": "extract",
  "target": "auto",
  "task": "Extract the component names and file paths. Return a compact list.",
  "metadata": { "routing": { "difficulty": "trivial", "tier": "quick" } }
}
```

A dependent review can use `difficulty:"hard"` and `tier:"review"`, or an explicit target/model. Policy chooses among configured eligible candidates; the graph does not invent availability or quota. This permits cheap extraction and stronger review in the same workflow without adding a model-driven router.

Graph lifecycle: queued → running → completed / partial / cancelled. Node lifecycle: pending → running → completed / failed / partial / cancelled; unsuccessful prerequisites produce blocked dependents. Resume returns eligible unsuccessful and blocked nodes to pending and retains prior attempts. Completed nodes are immutable within a graph run. A child timeout or owner-crash `interrupted` receipt remains retryable; a stop that was requested but never acknowledged fails closed until reconciled.

The [example graph](../examples/agent-graph.json) pins user-selected Claude, Cursor, and OpenCode routes to demonstrate cross-provider review. Check those pins against the native catalogs before running it.

## Verification commands

`node scripts/demo-agent-graph.mjs` exercises a five-harness diamond, failed step, and selective resume using the real coordinator/store with fake adapters. It asserts six dispatches: five nodes and one failed-node retry. It prints a retained evidence path, peak concurrency, and elapsed time; no model calls occur.

`node scripts/live-agent-graph.mjs --live` explicitly invokes two bounded read-only models in a disposable repository. Codex emits a canary, then OpenCode verifies it through the dependency context. A fresh coordinator re-fetches every node before the command reports success. `--resume <graphId> --state <jobsDir>` recovers an interrupted run in place: completed nodes are retained and only the unsuccessful node is retried. The live command is never part of the normal test suite.
