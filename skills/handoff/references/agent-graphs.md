# Mixed-harness agent graphs

Use `handoff_graph_*` when tasks depend on other agents' results. Use `handoff_compare` for independent opinions on the same task and `handoff_workflow` for a single handoff.

## Build and run

1. Translate the user's goal into a DAG with stable node IDs. Each node needs `id`, `target`, `task`; optional fields are `route`, `dependsOn`, `cwd`, `context`, `policy`, `metadata`, and `execution.timeoutMs`. Explicit routes use the existing routing rules. Claude models use `target: "claude"`.
2. Put the nodes in `{requestId,cwd,task,context,policy,execution,nodes,outputs}`. Default to `policy.write:false` and `execution:{background:true,maxConcurrency:4}`. One graph holds 1 to 256 nodes and at most 6 concurrent children; larger work batches across runs (see [dynamic workflows](dynamic-workflows.md)). Use `outputs` to select final result nodes; otherwise use sinks. Nodes are prompt-only handoffs, not nested graph definitions.
3. Call `handoff_graph_validate({graph})`, then `handoff_graph_start({graph})`. Retain the returned `graphId` and `requestId`. Repeating the identical start reattaches; changing the task needs a fresh request ID.
4. Call `handoff_graph_status({graphId,afterRevision:previousRevision,waitMs:25000})`. A small `unchanged` response means no new model work needs interpreting. Do not burn repeated agent turns polling each node. Inspect `handoff_trace({jobId,afterSequence})` only for a relevant child.
5. After settlement, call `handoff_graph_result({graphId})`. Report successful output nodes and unsuccessful/blocked nodes separately. Graph completion requires all nodes to complete; a successful independent branch cannot hide a failed one.

Dependency results arrive as attributed `context.graph.upstream` data. Do not copy the entire transcript or every graph result into every node's task. Write the task to use only its declared prerequisites. Harnest computes child request IDs and context digests; do not invent them manually.

## Task-aware routing

Set a node's `target` to `auto` when the user wants the routing policy to choose. Put task-specific hints under `metadata.routing` (for example `tier:"quick"`, `difficulty:"trivial"`, or `tier:"review"`, `difficulty:"hard"`). The graph resolves each node independently before any agent starts and records the selected route. Choose an explicit target and model when the user names one. Automatic selection requires usable configured candidates; do not substitute an arbitrary model after validation fails.

Avoid duplicating expensive review agents for low-value steps. Parallelism reduces elapsed time, not token use by itself. Keep shared context short, declare only the dependencies each task needs, and use selected output nodes for the final answer.

## Resume and cancel

For a partial graph, inspect unsuccessful node receipts. Call `handoff_graph_resume({graphId,commandId,nodeIds:["failed-step"],background:true})` to retry that step and continue newly unblocked dependents. Use a stable command ID when retrying a lost tool response. Completed nodes and their outputs remain intact. Retrying write-capable nodes needs explicit `approveWrites:true` after approval of the retry scope. A child timeout or an owner-crash `interrupted` node is retryable; only an unacknowledged stop requires reconciliation before starting replacement work.

Call `handoff_graph_cancel({graphId})` to stop future dispatch and request cancellation of active children. Poll until settled. Cancellation intent alone is not proof the downstream process stopped.

Concurrent nodes that touch the same or overlapping directory are serialized whenever one writes. To parallelize implementation, provide a separate existing worktree as each writer's `cwd`. Graph execution does not merge branches. Preserve the user's approval boundary for merges and deployment.

Graph status is the portable operator view. Child job IDs expose the existing receipt and trace tools. Do not promise that each CLI invocation automatically appears as a native child panel in every host.
