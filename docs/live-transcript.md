# Live transcript streaming

Harnest has two complementary views of a running handoff. Use the right one
per host; never copy an unbounded transcript into the parent prompt.

## 1. Native child transcript (canonical where it exists)

Claude subagents, Codex child threads, and OpenCode child sessions each own a live
transcript the operator opens directly (agent view / panel / child-session navigation).
Intermediates stay in the child; only the terminal receipt returns to the parent
context. Bridge workers (`opencode-worker`, `pi-worker`, `cursor-worker`, `claude-worker`, `codex-worker`, `amp-worker`, `acp-worker`)
exist precisely to give every handoff one of these live views: the worker thread IS the
operator screen, and it returns the receipt verbatim at the end.

## 2. Durable trace mirror (pollable everywhere)

Every handoff appends redacted, sequence-addressable events to
`<state-dir>/<job-id>.events.jsonl`. `handoff_trace` exposes bounded pages:

- First read: `handoff_trace { jobId }` returns the tail plus `nextSequence`.
- Live loop: retain `nextSequence`, poll every 1-2s with
  `handoff_trace { jobId, afterSequence: <previous nextSequence> }`.
- Each response carries `hasMore` (keep paging when true) and `limit` caps at 200
  (default 50). Strings truncate at 4,000 chars; secrets redact; depth caps at 6.
- Every parent update must name `trace.progress.phase`, `current`, recent milestones,
  and `lastMeaningfulAt`. Heartbeat-only activity is stalled, not progress.

This mirror is the primary live view for hosts without a child surface (Pi, Cursor IDE
direct calls) and the recovery path when the lead context dies: re-fetch by `requestId`
via `handoff_status`/`handoff_result` and continue polling from the last `nextSequence`.

Session and workflow IDs observed in adapter progress are also persisted in the receipt.
The receipt retains the latest observed cumulative `usage` snapshot, including on timeout,
failure, cancellation, and stale-worker recovery. Repeated cumulative snapshots are not
added together. Usage is what the adapter has reported so far, not a guarantee that final
billing has arrived. Partial assistant text stays in the trace; it does not become a
successful `result.finalText`.

With session transport, Claude, Codex, and Cursor emit text progress per completed
message. Cursor also reports completed thought blocks. Cursor recognizes a changed message
ID, a switch between thought and message chunks, or the prompt response as a text boundary.
Adapters redact the complete text before clipping its preview.
Claude and Cursor omit a text preview if its buffer overflows. Tool, status, and usage
updates still report as they arrive.

Terminal provider failures surface classified `provider-auth` / `unavailable` reasons
(bounded, credential-redacted, with the provider status) so a polling parent can tell a
missing or rejected provider authorization from a genuinely unavailable model. For a
read-only auto run both kinds are eligible failover triggers alongside `transport`,
`timeout`, `downstream`, and `completion-contract`: the run retries once on the next
ranked route and records the switch with its `errorKind` in `receipt.routingFallbacks`.

## Fleet visibility and control ownership

`handoff_fleet` scans all durable jobs matching the target filter, recovers stale active
jobs, then applies the state filter. Its `active`, `byState`, and `total` counts cover all
matching jobs even when the displayed `agents` list is capped. `limit` defaults to 20 and
caps at 100. `displayed`, `hasMore`, and `countsScope: "all-matching-jobs"` distinguish
the displayed list from the counts. This is a polling view, not an atomic snapshot.

Each displayed agent includes `ownership.ownerId`, `pid`, `host`, and `local`. Pi and
OpenCode V2 report `steer.mode: "live"` only in the Harnest process that owns their
adapter. Other processes report `owner-required`. Send message/reroute calls through
the originating Harnest process; another MCP connection can inspect the job and request
cancellation but cannot forward live controls. Rejected cross-process controls include
the owner details and do not deliver or queue a command. Older leases may lack `host`.

## Resume and cancellation recovery

One settled job can produce one resume child. Concurrent calls and retries of
`handoff_resume` on that same parent return the existing child, including after it settles.
Different task/route/policy overrides for an already-claimed child conflict rather than
launching another execution. Request-ID lookup tracks the latest attempt; late writes from
older attempts cannot move it backwards.

Completed-session follow-ups remain supported, but a bare resume of completed work is
rejected with `follow-up-required`. Through MCP, start a new handoff with an explicit task,
a fresh request ID, and `execution.sessionId` from the completed receipt. Library callers
can use `Companion.resume(jobId, { task: "next turn" })`; this keeps the downstream session
and caller request IDs while giving the follow-up a new job ID. Repeating that same
parent/task call recovers its child. For another turn, resume the child with another
explicit task.

A cancellation requested from another Harnest process stays queued/running with
`cancellation.state: "requested"`. The owner reconciles this durable intent on its next
heartbeat (10 seconds by default), aborts the adapter, and waits up to 5 seconds for the
adapter to settle. Only then does it report `cancelled` with an `acknowledged` cancellation.
If the adapter does not settle, the receipt becomes `partial` with
`cancel-unacknowledged`; inspect the originating harness before retrying because execution
may still be active. A dead owner's heartbeat instead recovers to `partial` after the
existing 60-second stale threshold. Completion racing a cancellation request can return
`completed` with `completed-before-cancel`; that is not a stop acknowledgement.

Local cancellation retains its immediate terminal-receipt contract and dispatches abort
without waiting for a stuck adapter. It does not prove OS process exit. Remote requests
use the acknowledgement path above. A worker that loses its lease also aborts on its
next heartbeat, even if it emits no progress.

Supplying a custom `JobStore` or `stateDir` places boards in `<store.root>/boards` by
default. Explicit `boards`/`boardDir` overrides win. The platform-default Harnest keeps
its existing production board directory.

## Per-target streaming behavior for one-shot and attached adapters

| Target | Live mechanism | Steering |
|---|---|---|
| OpenCode V2 | adapter progress events fold into the trace; live `steer`/`follow_up`/`reroute` apply at the next step/turn/model-request (host-attached graph nodes are owned by the scheduler, so controls there fail closed as `unsupported-control`) | `handoff_message` / `handoff_reroute` (`applied` = acknowledged) |
| Pi | JSONL RPC progress folds into the trace; live steer/reroute supported | `handoff_message` / `handoff_reroute` |
| Cursor | `cursor-agent --output-format stream-json --stream-partial-output` deltas fold into the trace as `cursor_delta` events, so trace polling IS live streaming | one-shot: controls fail closed; thinking rides in `route.model` (for example `claude-opus-5-thinking-high`); follow up by resuming with `execution.sessionId` |
| Claude | `claude -p --output-format stream-json --verbose` assistant deltas fold into the trace as `claude_delta` events (plus `claude_permission_denied` markers), so trace polling IS live streaming; terminal `result` envelope carries `session_id`, token usage, `total_cost_usd`, and `permission_denials` | one-shot: controls fail closed; `route.thinking` maps to `--effort` (`low`\|`medium`\|`high`\|`xhigh`\|`max`; `off`/`minimal` are dropped); follow up by resuming with `execution.sessionId` |
| Codex | `codex exec --json -o <file>` JSONL deltas fold into the trace as `codex_delta` events; the `-o` last-message file is authoritative for `finalText` | one-shot: controls fail closed; `route.thinking` maps to `model_reasoning_effort`; follow up by resuming with `execution.sessionId` |
| Amp | attached structured stream events fold into the trace; a successful native terminal result with nonempty final text is required; downstream execution requires explicit write approval on native Linux/macOS or with the entire MCP server running inside WSL | write-only prompt one-shot: read-only, live controls and `execution.transport=session` fail before spawn; follow up by resuming with `execution.sessionId`; detached orbs are outside scope |
| Generic ACP | negotiated `session/update` notifications fold into the bounded durable trace; the adapter requires a successful terminal prompt result and nonempty final text | write-only attached run selected by `route.agent`; live controls and `execution.transport=session` fail closed; follow up with the observed `execution.sessionId` when the negotiated agent supports resume/load |

## Codex-plugin parity notes

The Codex plugin for Claude Code buffers its app-server deltas into background job logs
and offers only `status`/`result`/`cancel` polling — it does not forward token deltas to
the lead. Harnest matches that contract (`status`/`trace`/`result`/`cancel`)
and goes one step further for Cursor, Claude, Codex, Amp, and generic ACP: streaming deltas enter the
trace while the run is still in flight, so a polling parent sees partial output, not
just a terminal dump.
True push streaming (server → lead `notifications/progress`) is not available on the pinned
`@modelcontextprotocol/server 2.0.0`: its tool-handler surface exposes no progress token or
send-notification hook, and the legacy Claude Code transport path must keep working. The poll
contract above is therefore the mechanism, not a fallback — and it is sufficient because traces
are monotonic, bounded, and resumable by sequence.

## Windows argv integrity (stability note)

One-shot adapters pass the handoff envelope without shell interpolation. On Windows,
`.ps1`/`.cmd` shims forward `$args` through PowerShell 5.1 native-command reconstruction, which strips
embedded quotes and can split long prompts (observed live: `diff --git` inside a prompt surfacing
as `unknown option '--git'`). Harnest therefore resolves Cursor to its versioned
`node.exe` + `index.js` and Codex to its npm `bin/codex.js` directly, bypassing the shim; a `.ps1`
remains as fallback when the layout is unrecognized. Prompts still never travel through a
command shell. Amp downstream launch rejects native Windows before inference; run the entire
MCP server inside WSL, or use native Linux or macOS for Amp-target work.

## Practical loop (pseudo)

```text
receipt = handoff_workflow { request: { ..., execution: { background: true } } }
after = 0
loop:
  page = handoff_trace { jobId: receipt.jobId, afterSequence: after }
  render page.events (bounded) + page.receipt.trace.progress
  after = page.nextSequence
  if handoff_status { jobId } is terminal: break
  sleep 1-2s
final = handoff_result { jobId }
verify final.requestId, final.contextDigest, final.route, session/workflow identity
```
