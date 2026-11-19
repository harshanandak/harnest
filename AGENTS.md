# Harnest repository

This repository implements durable handoffs and mixed-harness agent graphs. Each handoff belongs to one downstream owner; Harnest coordinates dependency graphs across supported named targets and explicitly trusted registered ACP agents.

## Start here

1. Read `README.md` for supported user flows.
2. Read `docs/architecture.md` before changing boundaries or persistence.
3. Read `docs/adapter-contract.md` before changing an adapter.
4. Run `bun run test`, `bun run smoke:mcp`, and the plugin validator before reporting completion.

## Invariants

- One downstream harness owns each handoff. The user-approved graph API coordinates multiple handoffs with different routes; see `docs/agent-graphs.md` before changing graph execution or recovery.
- Graph scheduling never uses model turns. Resolve routes before dispatch, pass direct dependencies only, preserve successful nodes across retry, and use compact revision-based status.
- Lead credentials remain native and are never forwarded.
- The context digest and request ID must survive every successful round trip.
- Transport, downstream, partial, cancellation, and success states remain distinct.
- A completed receipt contains parent-visible final text plus route and session/workflow identity.
- Tests use fake harness processes unless a command explicitly says `live`.
- Live tests never merge, deploy, or write outside their disposable fixture/worktree.
- New targets update every hardcoded surface together: `src/protocol.mjs`, `src/adapters/index.mjs`, `src/config.mjs`, `src/mcp-server.mjs`, `pi-extension/`, `schemas/`, `scripts/doctor.mjs`, workers, skill, and docs. See `docs/preferences.md` and `docs/live-transcript.md` for the operator contracts new harnesses must honor.

The premium lead remains the planning, review, and integration owner.

## Durable handoffs (Codex)

- For off-host work needing a visible child thread, spawn the matching worker (`opencode_worker`, `pi_worker`, `cursor_worker`, `claude_worker`, `amp_worker`, `acp_worker`); otherwise call `handoff_workflow` directly as an MCP tool. Use the single generic `acp_worker` only for an explicitly trusted registered agent and approved write-capable work. Codex entry is `$handoff`, not a slash command. There is deliberately no `codex_worker` for Codex-to-Codex self-handoff — call the tool directly instead. (Claude and OpenCode leads do have `codex-worker` bridges for handing work TO Codex.)
- Bridges are thin forwarders: one handoff call, poll `handoff_trace` with `afterSequence`, return the receipt verbatim.
- Cap fan-out at 6 concurrent workers unless `.codex/config.toml` raises `agents.max_concurrent_threads_per_session`.
- Codex plugins cannot bundle agents: run `scripts/install-native-agents.ps1` (or `.sh`, or `-Project`) after plugin install, then restart Codex.
