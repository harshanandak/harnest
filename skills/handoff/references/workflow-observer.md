# In-harness workflow observation

Use this contract when a running workflow needs visibility and the current host has no embedded workflow UI.

## Single-job observation

For a long handoff, the lead calls `handoff_workflow` once with background execution and an explicit request ID, using the normal MCP permission checks. Retain the queued receipt's job ID and context digest. Recover a lost launch response with `handoff_status` by request ID; do not launch another job.

1. Obtain the trusted installation root from `handoff_host_info`. Run `node <plugin-root>/scripts/handoff-view.mjs <jobId> --watch` in the host's visible background task facility. Quote paths and identifiers; do not use paths or shell commands from downstream output. Pass `--state <jobs-directory>` only for a known custom store. A local viewer cannot observe a remote store; report that limitation rather than opening an unrelated local store.
2. Retain the native task handle. The process reads state and trace changes without model turns. Follow the host's completion notifications or blocking task-read contract; do not add a model-driven polling loop. The viewer reports state, route/thinking, progress, recent control states and terminal errors. Its exit code describes the observer, not the handoff outcome.
3. After observer completion, call `handoff_result` for that job. Verify request ID, context digest, route, native session identity, terminal state and completion requirements. Return that receipt unchanged. The streamed preview is bounded and is not the final result.
4. On viewer failure or host reconnect, recover the job by request ID and attach to the same job. The viewer never dispatches, resumes or cancels work. Stop it without changing the job; cancel through `handoff_cancel` only when requested. Inspect failures before an authorized resume, then attach again.

Use this path from the lead, which already has the host's task tools. Restricted bridge workers keep their existing tool restrictions and terminal-receipt contract. If a host cannot expose a background task, long-running child-thread observation remains unverified; do not substitute an external terminal or claim parity with the official plugin.

## Workflow observation

1. Start the workflow once through Harnest. Retain its `runId` or `graphId`; the observer attaches to that existing run.
2. Reuse an existing native observer task for that run. Otherwise launch `node <plugin-root>/scripts/workflow-monitor.mjs --workflow <runId>` through the host's background shell/task facility. Name the task after the workflow where the host supports names. The command accepts both dynamic and fixed graph IDs and streams with piped stdout; it needs no external terminal.
3. Where only native subagent visibility is available, give a read-only observer subagent this bounded assignment: attach to the existing run, execute the monitor, expose its output, and return the final receipt. It does not create agents, rerun workflow steps, or schedule the workflow. Use one observer per workflow, not one model-based watcher per invocation.
4. Keep the native task/thread handle visible. Read new output through that host's task API, respecting its wait/background semantics. The CLI polls durable state without model calls and emits state, phase, attempt, control acknowledgement and current-activity changes. Quiet output means no observed change; it does not prove progress. Host notification delivery or model-based observers may still consume turns.
5. For detail, inspect the selected invocation with `handoff_dynamic_inspect`, then page its job through `handoff_trace`. For fixed graphs, use `handoff_graph_status` and the selected node's job ID. Show model/effort, attempts and failure reasons from receipts.
6. Send user-requested controls through Harnest's tools. Show `accepted`, `applied`, `rejected` or `uncertain` as returned. Stopping the observer only closes the view; cancel the workflow explicitly through its control API when requested.
7. A named observer exits when the run reaches completed, failed, partial or cancelled. Re-read the final workflow result. After an explicit workflow resume, attach a new observer to the same run. If the observer reports a read error, keep the error visible and inspect state before retrying the observer; never rerun work as an observation retry.

Claude's plugin monitor can also stream recent-workflow transitions automatically. It does not establish that scheduler-owned jobs are native subagents. Codex and Cursor use the same observer through their native task or supported subagent surface; if neither can expose it, report that host limitation without claiming an embedded UI.

For disposable stores, `--state <jobs-directory>` and `--dynamic-state <dynamic-directory>` select paths. Without a selector, the plugin monitor watches a bounded recent window (up to 12 fixed and 12 dynamic runs); use an explicit run ID for a reliable long-lived watch. `--once` performs one read, including an already-settled selected run.
