# Dynamic workflow implementation contract

This contract fixes integration seams for isolated implementation streams. Draft APIs below are implementation targets, not shipped capability claims.

## Ownership

- Lead: integration, MCP/Pi entry points, schemas/docs/examples, shared registry, package/lock, validation and demo.
- Engine worker: `src/dynamic-engine.mjs`, `test/dynamic-engine.test.mjs`, engine fixtures under `scripts/fixtures/` only.
- Runner worker: `src/dynamic-{protocol,store,runner,worker}.mjs`, corresponding tests and fixtures only. No engine, adapter, graph, Harnest or installer edits.
- Claude worker: `src/adapters/claude-session.mjs`, session tests/fixtures only.
- Codex worker: `src/adapters/codex-session.mjs`, session tests/fixtures only.
- Cursor worker: `src/adapters/cursor-session.mjs`, session tests/fixtures only.
- UI integration follows the agreed runner contract after the first runtime checkpoint.

## Engine

Export `validateScript(source)` (syntax/metadata validation without execution; returns `{meta, body}`) and `runScript({source,args,onAgent,onPhase,onLog,signal,limits})` returning the JSON-compatible final script value. Engine callbacks: `onAgent(prompt, options)` resolves to a JSON-compatible result or null; `onPhase(title)` and `onLog(message)` may return promises. Helpers exposed to the guest: agent, pipeline, parallel, phase, log, args. pipeline takes `(items, callback)`; parallel takes an array of zero-argument task functions; both return input-ordered arrays and reject oversized collections before invoking callbacks. Runtime replay belongs to the runner, not the engine.

Use QuickJS WASM, not Node vm or evaluation in the host. Pin `quickjs-emscripten-core` and `@jitl/quickjs-wasmfile-release-sync`; Acorn parses the literal metadata and disallows imports before any guest code executes. No guest access to host objects, ambient IO, modules, wall clock or randomness. Bound CPU slice, heap, stack, serialized callback bytes, outstanding helper calls, logs and final output. Abort/timeout errors expose `details.kind`; no unhandled rejections or leaked WASM handles on failure. Use awaited/bounded pending-job pumping. A script cannot report completion while an unawaited agent callback is still running.

## Runner

Export `DynamicWorkflowRunner` accepting `{companion?,stateDir?,workflowDir?,engine?,detachBackground?}`. Default store lives beneath Harnest's state directory. Accept dependency injection for fake adapters, clock/engine where necessary, but requests cannot nominate executable modules.

Methods: `validate(spec)`, `start(spec)`, `status({runId,afterRevision?,waitMs?,invocationLimit?,invocationCursor?,phaseLimit?,phaseCursor?})`, `result({runId,invocationLimit?,invocationCursor?,phaseLimit?,phaseCursor?})`, `history({limit?,cursor?,state?})`, `control({runId,commandId,action,invocationId?,message?,route?})`, `resume({runId,commandId,source?,approveWrites?})`. Control actions are pause, continue, stop, stop-agent, restart-agent, steer and reroute. Commands are durable and idempotent. Reusing an ID with different content conflicts. Saved definitions live outside this runner.

Spec: `{requestId,name?,source,args?,cwd,target?,route?,policy?,context?,metadata?,execution?}`. Execution supports `{background?,timeoutMs?,maxConcurrency?,maxAgents?,prefixStaggerMs?}`. Default background; enforce existing per-host concurrency restrictions, at most 1000 counted child launches per run and 4096 items per helper. Agent options may narrow root policy and supply `{label,target,route,cwd,context,metadata,schema,execution}`. No implicit permission widening. One absolute deadline per execution attempt; explicit resume has its own recorded attempt window, preserving prior spend. Pausing does not reset the deadline.

The status shape is `{runId,requestId,name,state,revision,createdAt,updatedAt,startedAt,completedAt,attempt,scriptDigest,argsDigest,phases,phasesTotal,phasesOmitted,phasesNextCursor?,invocations,invocationsTotal,invocationsNextCursor?,usageTotals,progress,error,controls,resumeOf?}`. Invocations expose `{id,ordinal,label,phase,state,target,route,jobId,sessionId,attempts,usageSummary,progress,error}`. Status excludes source, raw prompts and full child results. Result exposes a bounded final `output` plus status. Use the job trace and result APIs for detailed child data. History returns `{runs,nextCursor}` with compact run summaries. All runs and invocations remain individually discoverable.

Status and result return 20 phase summaries by default, ordered by first appearance across resumes. Set `phaseLimit` from 1 to 100 and pass the response's `phasesNextCursor` as `phaseCursor` to read the next page. For status pagination, omit `afterRevision` to read another page at the same run revision. `phasesTotal` counts all retained phases. `phasesOmitted` counts phases outside the current page, including earlier pages. Phase and invocation pagination are independent. Invocation inspect includes `phaseSummary` for the selected invocation's current phase, even when it is outside the first page.

Each phase exposes `{title,ordinal,firstAt,counts,usageTotals,elapsed}`. Agent counts use current invocation states. Usage sums recorded attempts in their original phase, including retries, and uses `null` for unreported metrics. A phase-only edit invalidates invocation reuse, so current counts follow the new attempt. Elapsed time spans the first start to the last confirmed settlement when all attempt times are known. An attempt with unproven settlement, including unacknowledged cancellation, makes its phase's elapsed state `unknown` with `ms: null`. Active work reports `running` when settlement is still expected. A phase with no agent attempts reports `not-started`.

Use a separate workflow store and detached worker with atomic/fenced writes, immutable spec revisions, append-only lifecycle/replay events and compact snapshots. Persist intent before dispatch; deterministic child request IDs deduplicate crash recovery. Children can run inside the detached workflow owner; no MCP process owns the workflow's lifetime. Unknown children or unacknowledged cancellation prevent retry. Preserve all prior attempts and usage. Script replay reuses a successful ordered prefix; the failed/changed call and subsequent calls run again. Reconcile all live invalidated suffix children before dispatch. Preserve recorded completion-delivery ordering so concurrent scripts replay deterministically. Never delete historical suffix receipts. Write retries need explicit approval, including retrying a completed invalidated suffix writer.

Run pause drains in-flight work without new dispatch. Stop requests child cancellation and reaches terminal only after truthful reconciliation. Steer/reroute forwards to existing Harnest controls; unsupported targets stay explicit. restart-agent must stop/reconcile the old attempt before replay. Never turn accepted into applied without adapter evidence.

## Session adapters

Each file exports its named class `ClaudeSessionAdapter`, `CodexSessionAdapter`, or `CursorSessionAdapter`, plus a default export. Keep `run(request,{signal,onProgress})` and `control(command)` compatible with existing adapters and preserve result/sessionId/route/usage contracts. Mode is selected by trusted configuration/validated request `execution.transport: "session"`; normal one-shot behavior remains available. The lead wires adapter selection and public validation.

Use official Claude SDK streaming input, Codex app-server JSON-RPC and Cursor ACP respectively. Constructor seams allow fake SDK/query or spawn/protocol transport; never make tests call a paid model. Cap bytes/frames/queues, await onProgress, use the request's deadline for startup and controls, bound teardown, and retain native auth and working-directory/permission enforcement. No implicit unsafe-mode flags. If the protocol cannot enforce a requested policy, fail before sending a prompt.

Control commands use existing adapter shapes (inspect current Pi/OpenCode implementations). Distinguish accepted/sent/acknowledged; a queued SDK message alone does not prove the model consumed it. Support native resume and model changes only where documented/negotiated. Do not silently fall back to a new session on resume failure. A session can remain available for explicit follow-ups under an idle budget; independent requests must not share conversation state. Return truthful usage including cancelled/failed turns. One-shot-only assumptions in core/policy will be reconciled by the lead.

## Verification and checkpoints

Workers commit only their owned files, report commands/results and limitations, and do not push, install globally or run full suites/paid probes. Every concurrent writer has its own worktree. Lead integrates and runs the full gates. Engine/compiler fixtures belong outside default test discovery. No timeout/assertion exemptions. Github is currently unreachable for this repo; the local approved plan carries the work authority until issue updates can be restored.
