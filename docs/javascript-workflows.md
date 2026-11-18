# JavaScript workflows

Harnest supplies its own multi-agent workflow environment across OpenCode, Pi, Claude Code, Codex, Cursor, Gemini CLI and Amp. Claude Dynamic Workflows is the reference experience; its workflow runtime is not required. JavaScript runs in an isolated QuickJS engine and owns branches, loops and parallel work. Each `agent()` call becomes a Harnest handoff with its own job and trace. Gemini and Amp remain prompt-only one-shot targets within a workflow; Amp accepts write-capable requests only. See [release limits](users/limits.md) for the current verification boundaries.

## Start and inspect

1. Call `handoff_dynamic_validate` with `{workflow: {requestId, cwd, source, args, target, policy}}`.
2. Call `handoff_dynamic_start` with that same specification. Keep the returned `runId`.
3. Use `handoff_dynamic_status` with `{runId, afterRevision, waitMs}`. `waitMs` may be up to 25,000. Use invocation job IDs with `handoff_trace` for intermediate output.
4. Read `handoff_dynamic_result` for final output and execution health. A useful script result does not erase failed agents.

`handoff_dynamic_inspect` pages every attempt for a selected invocation, including invalidated history. It returns the old job IDs so their output and usage remain inspectable after replay.

MCP and Pi starts use detached background execution. The engine is loaded only when a script runs. Ordinary handoffs and fixed graphs retain their entry points.

## Authoring

```js
export const meta = { name: "review-files", description: "Review supplied files" };
await phase("Review");
const findings = await pipeline(args.files, (file) => agent(`Review ${file}. Read only.`, {
  label: `Review ${file}`,
}));
return { findings };
```

`meta` must be a literal object, not computed code. `args` is JSON and read-only. A script can use top-level `await` and `return`.

| Helper | Behavior |
|---|---|
| `agent(prompt, options)` | Runs one agent. Options include label, target, route, context, cwd, narrower policy and an optional JSON Schema. A schema validates the JSON in `result.finalText`. The call returns the result envelope on success or `null` on failure. |
| `pipeline(items, callback)` | Bounded concurrent mapping; output preserves input order. |
| `parallel(tasks)` | Calls zero-argument functions with bounded concurrency; output preserves input order. |
| `phase(title)` | Records a phase. Await it before depending on its completion. |
| `log(message)` | Records a bounded log message. |

No guest filesystem, shell, network, module loader or environment access exists. Clock and random APIs are blocked so replay does not silently choose a different branch. Pass deterministic timestamps or seeds in `args` if needed. The engine bounds guest heap, stack, elapsed time, helper counts, queued callbacks and serialized input/output. An abandoned agent promise must settle before successful script completion.

The default uninterrupted guest CPU slice is 250 ms, independent of the run's wall deadline. Nested host validation shares that slice. Waiting for an agent, phase or log callback does not consume it.

Examples include [file review](../examples/dynamic-review.js), [risk-based verification](../examples/dynamic-verification.js), and a [bounded verification loop](../examples/dynamic-verify-loop.js).

To run the verification loop, pass the example file's contents as `source` and supply `args`, for example `{"task":"Draft a concise release note for the supplied changes","maxRounds":3}`. The draft agent writes an answer and the verifier returns a schema-checked verdict. The next draft receives the verifier's feedback. The loop stops on a pass or at `maxRounds`, which defaults to 3 and accepts integers from 1 to 500. The workflow's `execution.maxAgents` and deadline still apply. The result includes `verified`, `rounds`, the final draft, and a message such as `not verified after 3 rounds`.

`npm run smoke:dynamic:scale` measures the isolated engine with fake callbacks, including 4,096-item helpers. `npm run smoke:dynamic:runner-scale` measures 1,000 invocations through the real runner, Harnest and durable stores with fake adapters, concurrency six and a 120-second deadline. The latter records coordinator RSS, heap, handles, paged status sizes and retained disk bytes. Neither probe measures native-harness memory or subscription quota savings.

## Recovery and controls

`handoff_dynamic_control` requires `runId`, a stable `commandId`, and an action. Actions are pause, continue, stop, stop-agent, restart-agent, steer and reroute. Agent actions also require `invocationId`. Reusing a command ID with different content is a conflict.

Pause lets active work settle and prevents new launches. Stop requests cancellation; inspect the resulting state rather than treating acceptance as proof of termination. Resume uses `handoff_dynamic_resume`. Retrying writes requires explicit user approval.

Set `execution.providerWait: {maxRetries: 1}` to opt into a bounded provider-reset wait. Waiting requires a classified usage-limit error and a structured reset timestamp within the original run deadline. Unknown reset times and authentication failures do not trigger waiting. Each retry remains a separate accounted attempt; write-capable retries require recorded approval. Omit the option, or set `maxRetries: 0`, to disable automatic retry.

Script recovery reuses a matching successful **ordered prefix**. The first failed or changed invocation invalidates reuse of later calls. Those old receipts stay in history. Fixed DAG recovery instead preserves completed independent nodes. Choose a fixed graph when selective recovery of independent branches is the desired behavior.

## Save and rerun

Save, delete and revision-history operations default to project scope when `cwd` is supplied, otherwise user scope. Explicit project scope requires `cwd`.

`handoff_dynamic_save` takes `{name, source, scope, cwd, expectedRevision?}`. Project definitions live under `.harnest/workflows` in the chosen project; user definitions live under `~/.harnest/workflows`. Project definitions take precedence. Names contain lowercase letters, digits and hyphens and begin with a letter.

List metadata with `handoff_dynamic_list`; read source with `handoff_dynamic_get`. Enumerate historical versions with `handoff_dynamic_revisions`, including after deletion. Replace or delete using the current `expectedRevision`. Deletion keeps historical source revisions and permits recreating the name. `handoff_dynamic_invoke` requires a reviewed revision, a fresh request ID and parameters, so an edited definition cannot silently replace the selected source.

## Views and session transports

Run `node scripts/dynamic-view.mjs [runId]`. `--once` prints a bounded frame; `--json` returns structured state; `--readonly` disables controls. Use arrows to select, Enter for details, Esc to return, and `?` for commands. Full child traces remain pageable through `handoff_trace`.

`handoff_dynamic_status` returns at most 200 agent rows by default. Use `invocationLimit` and the returned `invocationsNextCursor` as `invocationCursor` to read additional rows. `invocationsTotal` reports the full count; page boundaries do not discard history.

Status and result return 20 phase summaries by default. Pass `phasesNextCursor` as `phaseCursor` to read more phases, or set `phaseLimit` from 1 to 100. `phasesTotal` counts retained phases and `phasesOmitted` counts phases outside the current page.

Phase summaries cover all invocation pages. Each phase reports agent counts by current state, normalized usage from recorded attempts, and elapsed time from the first agent start to the last confirmed settlement. An unacknowledged cancellation leaves timing `unknown`. Active phases report `running` while they await settlement, and phases with no attempts report `not-started`. Usage fields with no report are `null`, and `partial` marks incomplete sums. Older runs can use only the latest recorded usage per invocation. Legacy OpenCode counters without reporting metadata remain unknown. `handoff_dynamic_inspect` returns the selected invocation's `phaseSummary` alongside its attempt page.

OpenCode's workflow switcher includes JavaScript runs. Their rows show observed invocation order, not inferred dependency edges. `/workflow-pause`, `/workflow-continue`, `/workflow-stop` and `/workflow-resume` act on the selected run. `/workflow-stop-agent`, `/workflow-restart-agent`, `/workflow-steer` and `/workflow-reroute` select an agent and use durable controls. `/workflow-session` opens OpenCode child sessions or shows another harness's native session identity. Native session following uses the recorded child session ID.

Pi's `/harnest_dynamic <runId>` watches compact state; `/harnest_dynamic follow` follows the current native session when it belongs to a workflow. `/harnest_dynamic off` stops the widget. `/harnest_dynamic_watch <runId>` opens the actionable viewer in a side terminal. Both hosts use the same runner and control API as MCP.

For Claude Code, Codex or Cursor without an embedded workflow view, run `node scripts/workflow-monitor.mjs --workflow <runId>` in the host's native background task or a supported read-only observer subagent. The CLI streams meaningful changes through piped stdout and exits when the selected run settles. It displays phases, agent activity, retries and control acknowledgements; unchanged polls remain quiet. A single observer represents the workflow while Harnest schedules its agents. Keep inspection and controls in the host through `handoff_dynamic_inspect`, `handoff_trace` and `handoff_dynamic_control`. Closing an observer leaves the workflow running. See [the observer contract](../skills/handoff/references/workflow-observer.md) for host task handling and custom store paths.

Select `execution.transport: "session"` on a handoff for Claude Agent SDK, Codex app-server or Cursor ACP. The one-shot transport remains available explicitly. Sessions retain native credentials and permission checks. Compatible explicit follow-ups can reuse an idle connection; independent requests receive independent context.

Claude SDK input delivery does not prove model consumption. Codex `turn/steer` has a protocol acknowledgement; queued next-turn work is reported separately. Cursor ACP negotiates resume and cancellation, and rejects unsupported mid-turn messages. Unknown usage remains unknown; interrupted totals are lower bounds. Cache-read counters do not prove subscription-quota savings. Claude SDK sessions do not inherit Claude's interactive subscription-reset waiting.

### Orphaned native sessions

`node scripts/session-leases.mjs [--state-dir <jobs-directory>]` lists native-session leases and coordinator liveness. A dead coordinator does not prove its native subprocess has stopped. Use normal Harnest shutdown for a live owner. For an orphan, inspect its native session/process and stop that owned work before releasing the lease.

For Claude, Codex and Cursor session adapters, a newly reported native session ID is leased before its progress is published. Workflow rows can link to that native session during the first turn. A different session ID on the same owned turn is rejected.

After verifying native termination, run `node scripts/session-leases.mjs --release <lease-id> --expected-token <lease-token> --native-stopped [--state-dir <jobs-directory>]`. This refuses live or unverifiable coordinators and a changed lease token. It archives the exact lock under `native-sessions/reconciled` and reports the backup path. The native-stop evidence is explicitly operator-confirmed, never inferred from coordinator death. To reverse before any new session is acquired, restore that archive to its original `<lease-id>.lock` path; never overwrite a new owner's lock.

### History retention

Inspect a named terminal run with `node scripts/dynamic-retention.mjs --root <dynamic-state-directory> --run <runId> --json`. Add `--before <ISO-timestamp> --apply` to compress its old journal prefix. The command refuses active runs or retained owner leases and processes at most 16 MiB of journal data. It verifies the archive before replacing the raw prefix.

The compressed prefix remains in `<runId>.journal.jsonl.gz`. Readers merge it with the live journal, so history and subsequent replay retain their events. Snapshots, saved script revisions, child receipts and native leases remain available. Run the same command with `--restore` to merge the archived prefix back into the raw journal; restoration also requires a terminal run. No history is erased automatically.
