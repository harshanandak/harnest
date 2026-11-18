# Live trace loop (condensed)

Full contract: `docs/live-transcript.md`.

1. `handoff_workflow` with `execution.background: true` returns `{ jobId, requestId, contextDigest }` immediately.
2. Poll `handoff_trace { jobId, afterSequence: <previous nextSequence> }` every 1-2s; render only new events plus `trace.progress` (`phase`, `current`, `recent`, `lastMeaningfulAt`).
3. Heartbeat-only activity is stalled, not progress. Never paste the unbounded transcript into the parent.
4. Cursor/Claude/Codex stream-json deltas arrive as trace events while running — polling IS live streaming there.
5. At terminal state, `handoff_result { jobId }`; verify `requestId`, `contextDigest`, route, session/workflow identity, `finalText`.
6. Lost the first response? Recover with `handoff_status { requestId }`.
