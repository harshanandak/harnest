# Changelog

## Unreleased

- Install the `harnest` CLI from GitHub with Bun. Run setup, doctor, daemon, ACP registration, and routing setup from any directory.
- Host setup prints pasteable removal or restore commands, including native plugin removal for Claude and Codex and extension removal for Pi.

## 0.1.0 - 2026-11-19

Install from the public `harshanandak/harnest` GitHub repository at tag `v0.1.0`. The [install guide](docs/users/getting-started.md#install-from-github) covers the checkout, frozen Bun install, and daemon setup.

### Added

- `execution.addDirs` passes approved extra directories to Claude, Codex, and Cursor.
- `execution.attachments` sends bounded local images or files to targets with native input support.
- `execution.instructions` appends per-run system instructions in Claude and Pi.
- `execution.sessionAction` selects native resume or fork on supported targets.
- `execution.maxTurns` caps Claude print-mode agentic turns.

- Durable handoffs to OpenCode, Pi, Cursor, Claude Code, Codex, and Amp, plus a generic ACP route for approved write work with trusted local registrations.
- Dependency graphs and JavaScript workflows with durable status, bounded traces, cancellation, and recovery.
- A shared per-user daemon with loopback HTTP, a stdio bridge, and login startup on Windows, macOS, and Linux. The CI budget for the daemon plus 10 clients is ≤ 320 MiB. The shared-daemon measurements were 237 MiB on Ubuntu and 214 MiB on Windows.
- `bun run setup <host>` for Claude Code, Codex, OpenCode, Cursor, Pi, and Amp. Cursor setup accepts an explicit workspace.
- Twelve [ACP registration presets](docs/users/supported-agents.md#downstream-coverage), including Copilot CLI and Devin. `bun run acp add <preset-id>` shows the documented launch. With `--trust`, it saves and prints the absolute executable path, which also appears in `bun run acp list`. Each preset is unverified with Harnest.
- The `antigravity` ACP preset launches `agy acp`. Antigravity CLI uses [manual MCP configuration](docs/users/integrations.md#antigravity-cli-as-a-lead-client) when it leads a handoff.
- [ACP preset lead setup](docs/users/integrations.md#acp-presets-as-lead-clients) installs and checks the stdio bridge for nine CLIs. Goose and Mistral Vibe get manual configuration snippets. These setup commands have CI fixture coverage only.
- `bun run setup remove <host>` for the nine automatic ACP presets, Amp, and Cursor. It backs up the user config and removes only the Harnest MCP entry. Fresh setup prints this reverse path.
- Per-phase agent counts, reported token totals, and elapsed time for JavaScript workflows, plus a runnable bounded verification-loop example.
- Native service tier selection for Codex one-shot handoffs and fast mode for Claude one-shot handoffs.
- Model selection for registered ACP agents that advertise model choices.
- Session mode and validated config option selection for registered ACP agents.
- Native Codex config profile selection for one-shot handoffs.
- Named Claude Code agents for one-shot handoffs.
- Explicit tool allow and deny lists for Claude print and exact deny lists for Pi. OpenCode rejects nonempty tool lists.
- Cursor print can request read-only plan mode and enable the native shell sandbox independently of write approval.

### Changed

- The standard Bun install skips optional native binaries. Claude session transport uses the installed Claude Code CLI.
- OpenCode support requires OpenCode V2. The OpenCode V1 runtime and host integration are removed.
- Harnest does not choose models. The lead uses the model the user names in the prompt, then the user's routing preferences, then the downstream CLI's own default.
- Codex, Cursor, and the Devin example use the daemon-backed stdio bridge. Generic clients can generate a stdio snippet or write the local HTTP credential directly into private configuration.
- Doctor checks installed lead configuration and MCP discovery. CI also runs the bridge smoke against an isolated daemon.
- Pi shows the Harnest status name. OpenCode host info includes the routing tools. The live routing probe uses explicit model pins.
- Improved ACP initialization, prompt correlation, cancellation acknowledgement, native cleanup, and session identity through failures and resume.

### Removed

- Optional Taskflow execution and routing. Use Harnest dependency graphs or JavaScript workflows to coordinate handoffs.
- Native Gemini CLI handoffs and lead setup. Personal Google accounts can use the `antigravity` ACP preset.
- Migration of Agent Companion host registrations.
- The `readOnly` and `allowWrites` request aliases. Set `policy.write` directly.
- The npm lockfile and obsolete maintenance scripts and guides.

### Fixed

- Managed OpenCode V2 handoffs wait for `/global/health`, where OpenCode 2.2.1 serves health. Before this fix, they timed out with "OpenCode server did not become ready".
- Replacing an older daemon no longer misses its startup deadline. The client's proof, health, stop and port-release probes open a fresh connection each time instead of reusing a kept-alive socket to the stopping daemon.
- JavaScript workflows finalize pending controls when they settle or recover. Workers reject ambiguous unstamped controls when claiming a later attempt, and late acknowledgements can resolve controls whose delivery was in flight.
- JavaScript workflow controls stay with the attempt that accepted them. Resume finalizes pending controls before queuing the next attempt.
- Claude resolves its HTTP headers helper from the installed plugin root. Codex native workers honor `CODEX_HOME`, and Codex-to-Codex guidance uses the MCP tool directly.
- The stdio bridge restarts a disconnected daemon and retries only discovery or requests refused before delivery. Pi retries dynamic and routing tool discovery after a successful reconnect.
- HTTP installer configs and backups use user-only permissions. Codex worker setup preserves changed and retired workers for rollback, and stdio bridge setups retain the resolved state directories.
- On Windows, daemon startup restores and verifies user-only permissions on the daemon directory and existing token file before reusing the credential.

### Security

- The daemon binds to `127.0.0.1` and requires a bearer credential from a private local token file. Host configuration backups may also contain that credential.
- Updated MCP client dependencies for [the SDK OAuth security advisory](https://github.com/advisories/GHSA-6qxp-vccf-f47h).
- ACP v1 terminal callbacks require approved write access, launch with an allowlisted environment, and record executable names in the trace.
- Resolve native CLI names from absolute `PATH` entries for handoffs and diagnostic probes. On Windows, launch system tools from `System32`, unwrap the Codex npm shim for doctor, and reject ACP `.cmd` and `.bat` shims in favor of the native executable.
- Resolve daemon and Pi terminal utilities through absolute `PATH` entries. On Windows, use the Windows directory reported by the OS when available and run `taskkill /T /F` from `System32` for process tree cleanup. If `taskkill` is unavailable or fails while the root still runs, warn once that descendants may survive and try to stop the direct child. ([#10](https://github.com/harshanandak/harnest/pull/10))

### Known limitations

- Host installation was verified by CI fixtures. Live host installation was unverified.
- Native authentication and live-agent coverage vary by target. Authenticated Devin handoffs are unverified. Generic ACP trust permits native configuration imports without a read-only sandbox. Amp downstream execution requires Linux, macOS, or Harnest running inside WSL.
- Storage and workload affect throughput. See [release limits](docs/users/limits.md) and [supported agents](docs/users/supported-agents.md).
- Native Windows Codex setup can overflow the payload and block read-only shell execution. This is an upstream Codex limitation.
- [#1](https://github.com/harshanandak/harnest/issues/1) The Windows 1,000-call dynamic runner probe has missed its 120-second deadline.
- [#2](https://github.com/harshanandak/harnest/issues/2) Windows scale and recovery gates have shown variable timing.
