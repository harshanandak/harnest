# Release limits

Harnest `v0.1.0` is distributed as a tagged source checkout from the public `harshanandak/harnest` GitHub repository.

## Distribution and verification

- Follow the [tagged install instructions](getting-started.md#install-from-github) for `bun install --frozen-lockfile` and daemon setup.
- CI verifies host installation with fixtures. Live host installation is unverified. `bun run smoke:mcp`, tool discovery, plugin validation, and fake-harness tests are model-free and leave provider login, quota, model behavior, and paid end-to-end handoffs unverified.
- Native installation and authentication remain the operator's responsibility for every downstream CLI. Harnest does not copy or forward lead credentials.

## Target boundaries

- The seven named downstream targets are OpenCode, Pi, Cursor, Claude Code, Codex, Gemini CLI, and Amp.
- Generic ACP is a separate, opt-in, write-only route. `route.agent` must select an explicitly trusted local registration. Trust permits native configuration imports; it is not a read-only guarantee or sandbox.
- Devin is supported as an MCP lead client and may be registered through generic ACP. Authenticated native Devin execution, safe isolated startup, and read-only execution remain unverified.
- Amp downstream work is write-only and requires explicit approval. It supports native Linux/macOS or the entire Harnest MCP server running inside WSL. Native Windows downstream launch is unsupported.
- Native Windows Codex setup can overflow its payload and block read-only shell execution. This is an upstream Codex limitation.
- The legacy `gemini` target requires Gemini CLI v0.62.0. Its temporary policy narrows tools, but inherited include directories mean the working directory is not a filesystem sandbox boundary. See [supported agents](supported-agents.md#named-downstream-targets) for account requirements.
- Live message, reroute, cancellation, and session resume capabilities vary by target and transport. Unsupported controls reject instead of silently changing execution mode.

## Workflow boundaries

- The default frozen Bun install includes optional Taskflow compatibility. Use `bun install --frozen-lockfile --omit optional` for plain prompt handoffs and Harnest agent graphs without Taskflow.
- The default installation needs Node.js 22.19 or newer because of its optional Taskflow packages. The lean installation supports Node.js 20 or newer; CI runs the Node test suite on Node.js 22 and memory checks on Node.js 24.
- Durable throughput depends on storage and workload. The release has no throughput, CPU or RAM improvement, or token savings guarantee.
- Taskflow compatibility applies to explicit structured Pi and OpenCode requests. Cross-agent dependency graphs use `handoff_graph_*`.
- Harnest does not create, merge, or delete worktrees. Supply separate existing working directories for concurrent writers.

## Local data

Requests, task context, traces, receipts, and downstream tool output can be stored in plaintext local state. Keep secrets out of handoffs and protect the state directory with operating-system permissions.

Read [Supported agents](supported-agents.md) for per-target behavior and [Troubleshooting](troubleshooting.md) for the difference between discovery, installation, and live execution evidence.
