# Harnest MCP

Harnest gives an MCP lead client durable handoffs to native coding agents. The lead chooses which downstream agent runs a task, follows its progress, and retrieves a validated receipt. Harnest can also run dependency graphs across agents. The v0.1.0 release is distributed as a tagged source checkout from the private GitHub repository.

## Quick start

Use Git with authenticated access to the private repository, Bun, and Node.js 22.19 or newer for the default install with optional Taskflow packages. Install and authenticate each downstream CLI through its native setup.

From a shell with the downstream CLIs on `PATH`, clone to a directory you can keep in place. This example configures Codex as the lead client and installs the shared daemon.

```sh
git clone https://github.com/harshanandak/harnest.git
cd harnest
bun install --frozen-lockfile
bun run setup codex
bun run doctor --host codex
```

Restart Codex and confirm it discovers `handoff_workflow`, `handoff_status`, `handoff_trace`, and `handoff_result`. Then try [your first handoff](#your-first-handoff).

Use `bun run setup <host>` with `claude`, `codex`, `opencode`, `cursor`, `pi`, `gemini`, or `amp`. For Cursor, add `--project "/absolute/path/to/project"` to install its workspace files. For other clients, `bun run setup other` prints a stdio bridge snippet. See the [HTTP setup and verification instructions](docs/users/getting-started.md#add-the-mcp-server).

## Supported clients and downstream agents

A lead client connects to Harnest through MCP. The downstream agent executes the task and uses its own native authentication. Direct MCP use requires only the connection and downstream CLI.

| Agent or client | Lead connection | Downstream target and limits |
| --- | --- | --- |
| Claude Code | Daemon HTTP via the plugin's header helper | `claude` supports read and approved write, session resume, and live controls on session transport. |
| Codex | Stdio bridge via the host installer | `codex` supports read-only and approved workspace-write, session resume, and live controls on session transport. See the [Windows setup limitation](https://github.com/harshanandak/harnest/issues/12). |
| OpenCode | Daemon HTTP via the integration installer | `opencode` supports read and approved write, optional Taskflow, and live steer and reroute on V2. |
| Pi | Daemon HTTP via the extension | `pi` supports read and approved write, optional Taskflow, and live steer and reroute. |
| Cursor | Stdio bridge via the integration installer | `cursor` supports read and approved write, session resume, and optional session transport. UI subagents need their own MCP registration. |
| Gemini CLI | MCP configuration | `gemini` requires CLI v0.62.0. Read and approved write are available with native-session follow-up. Inherited include directories limit filesystem containment. |
| Amp | MCP configuration | `amp` supports approved write only, with native-session follow-up. Run Harnest on Linux, macOS, or inside WSL. |
| Registered ACP agent | Depends on the client's MCP support | `acp` supports approved writes with an explicitly trusted local registration. Register with `bun run acp add <preset-id> --trust` or [supply your own command](docs/acp-agents.md#register-manually). The eleven presets are unverified against the real agents. |

Gemini, Amp, and generic ACP use native-session follow-up and reject session transport and live controls. See [supported agents](docs/users/supported-agents.md) for the full control and platform boundaries.

## Choose a connection

- **Shared daemon HTTP.** Use `http://127.0.0.1:41237/mcp` with the daemon's local bearer credential. The [HTTP setup instructions](docs/users/getting-started.md#add-the-mcp-server) show how to write the header directly into a private client config. URL-only clients need a running daemon. Use `bun run daemon start` for manual startup.
- **Stdio bridge.** Configure `node /absolute/path/to/harnest/src/mcp-bridge.mjs` for clients that require stdio. The bridge starts the daemon on demand and forwards requests to it.
- **Standalone stdio.** Configure `node /absolute/path/to/harnest/src/mcp-server.mjs` to give each invocation its own runtime.

Host installers register a login item by default using Windows Task Scheduler, a macOS LaunchAgent, or a systemd user unit. Run the installer with the intended `HARNEST_STATE_DIR` if customized and the downstream CLIs on `PATH`. The login item captures `PATH`, the resolved job and daemon directories, and supported non-secret Harnest runtime settings. Pass `--no-autostart` to skip login registration. The daemon uses its startup environment and machine-local configuration. See [daemon lifecycle](docs/architecture.md#shared-daemon) and [host setup and restore](docs/users/integrations.md).

## Your first handoff

With Codex installed and authenticated downstream, call `handoff_workflow` with this input. Replace `cwd` with the absolute path to a Git checkout.

```json
{
  "request": {
    "requestId": "first-read-001",
    "target": "codex",
    "task": "Summarize how tests are organized in this repository. Include file paths.",
    "cwd": "/absolute/path/to/project",
    "route": { "model": "gpt-6.1-terra", "thinking": "high" },
    "metadata": { "routing": { "modelVersion": "pin" } },
    "execution": { "background": true },
    "policy": { "write": false }
  }
}
```

Use the returned `jobId` with `handoff_status`. Call `handoff_trace` with that ID and pass the previous response's `nextSequence` as `afterSequence` to fetch only new progress. After the job settles, fetch the route, session identity, and final text with `handoff_result`. To cancel, call `handoff_cancel` with `{ "jobId": "<returned job ID>" }` and poll status for acknowledgement. See [tool inputs and examples](docs/users/mcp-usage.md).

### Workflows and graphs

- Use a single background handoff for a bounded task you want to recover by job or request ID.
- Use [a dependency graph](examples/agent-graph.json) for parallel reviews followed by synthesis. Each node receives results only from its direct dependencies. A retry preserves completed nodes. See the [graph contract](docs/agent-graphs.md).
- Use [a JavaScript workflow](docs/javascript-workflows.md) for loops, branches, or fan-out decided at runtime.

## Routing and model defaults

For new Codex leaf routes, use `gpt-6.2-sol` for code writing, `gpt-6.1-sol` for reviews and investigations, and `gpt-6.1-terra` for read-only non-code research, lookups, and audits. All three use `high` reasoning. The native Codex worker bridges also use Terra at high effort to forward requests. Their downstream routes are chosen independently.

Explicit model and effort pins take precedence. Set `metadata.routing.modelVersion` to `pin` to keep the selected version. For other provider routes, check the native catalog and select a model that provider exposes. Use `handoff_routing_preview` to inspect the selected route and its catalog freshness before dispatch. An omitted model can leave the choice to the downstream client's configuration. See [routing preferences and precedence](docs/preferences.md).

## Safety, data, and limits

- Approve write scope before dispatch. Generic ACP trust allows the registered executable to load native configuration and extensions. Requests, task context, traces, receipts, and downstream output can be stored locally as plaintext. Keep credentials out of handoffs and protect the state directory.
- The daemon binds to loopback. Its private `token` file lives under `%LOCALAPPDATA%/harnest/daemon/` on Windows, `~/Library/Application Support/harnest/daemon/` on macOS, and `$XDG_STATE_HOME/harnest/daemon/` on Linux (default `~/.local/state/harnest/daemon/`). With `HARNEST_STATE_DIR` set, `daemon/` is a sibling of the jobs directory. Host settings and installer backups may contain the local credential. Keep them private.
- CI host-installation fixtures cover configuration and reversal. Live host installation and authenticated downstream coverage vary. See the [release limits](docs/users/limits.md) for the verification boundary, unsupported controls, and platform constraints.

## Update or remove

For an update, fetch tags, check out the desired release tag, run `bun install --frozen-lockfile`, rerun the integration installer, and restart the host. Keep the installer backups. To roll back, repeat with the previous tag, or follow the [host restore instructions](docs/users/integrations.md) for configuration changes.

To remove the daemon login item, run these commands from the checkout with the same state settings used at install. If stop reports `busy`, wait for active work to finish and run stop again before removing autostart.

```sh
bun run daemon stop
bun run daemon uninstall-autostart
```

Run uninstall as the installing user. On Linux, use the same `XDG_CONFIG_HOME` if you customized it. This preserves durable jobs and host configurations. To disconnect a host, remove its Harnest MCP entry or restore its installer backup, then restart it.

## Documentation index

- [Getting started](docs/users/getting-started.md), [host integrations](docs/users/integrations.md), and [troubleshooting](docs/users/troubleshooting.md)
- [MCP tool inputs](docs/users/mcp-usage.md), [agent graphs](docs/agent-graphs.md), and [JavaScript workflows](docs/javascript-workflows.md)
- [Routing preferences](docs/preferences.md), [live transcript behavior](docs/live-transcript.md), and [registered ACP agents](docs/acp-agents.md)
- [Architecture](docs/architecture.md) and the [adapter contract](docs/adapter-contract.md)

## Development and releases

GitHub CI runs the Node test suite through `bun run check`, then runs `bun run smoke:mcp`, `bun run validate:plugin`, and the memory gates. When editing worker definitions, update `scripts/build-workers.mjs` and regenerate the checked-in files with `node scripts/build-workers.mjs`.

See the [changelog](CHANGELOG.md) and [release process](RELEASING.md) for the private GitHub source releases.

## Support, security, and license

Report installation and usage problems in [GitHub Issues](https://github.com/harshanandak/harnest/issues) with the tag, host, downstream CLI, OS, and sanitized reproduction details. Follow the [security policy](SECURITY.md) for sensitive reports. Harnest is licensed under the [MIT License](LICENSE).
