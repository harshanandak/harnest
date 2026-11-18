# Changelog

## Unreleased

### Added

- Per-phase agent counts, reported token totals, and elapsed time for JavaScript workflows, plus a runnable bounded verification-loop example.
- Eleven [ACP registration presets](docs/users/supported-agents.md#downstream-coverage), including Copilot CLI and Devin. `bun run acp add <preset-id>` shows the documented launch. With `--trust`, it saves and prints the absolute executable path, which also appears in `bun run acp list`. Each preset is unverified with Harnest.

### Changed

- Added `bun run setup <host>` for Claude Code, Codex, OpenCode, Cursor, Pi, Gemini CLI, and Amp. Setup migrates older Agent Companion registrations with timestamped backups and accepts an explicit Cursor workspace.
- Codex, Cursor, and the Devin example use the daemon-backed stdio bridge. Generic clients can generate a stdio snippet or write the local HTTP credential directly into private configuration.
- Doctor checks installed lead configuration and MCP discovery. CI also runs the bridge smoke against an isolated daemon.
- Pi shows the Harnest status name. OpenCode host info includes the routing tools. The live routing probe uses the current Sol and Terra model defaults.

### Fixed

- JavaScript workflow controls stay with the attempt that accepted them. Resume finalizes pending controls before queuing the next attempt.
- Claude resolves its HTTP headers helper from the installed plugin root. Codex native workers honor `CODEX_HOME`, and Codex-to-Codex guidance uses the MCP tool directly.
- The stdio bridge restarts a disconnected daemon and retries only discovery or requests refused before delivery. Pi retries dynamic and routing tool discovery after a successful reconnect.
- HTTP installer configs and backups use user-only permissions. Codex worker setup preserves changed and retired workers for rollback, and stdio bridge setups retain the resolved state directories.
- On Windows, daemon startup restores and verifies user-only permissions on the daemon directory and existing token file before reusing the credential.

### Security

- Resolve daemon and Pi terminal utilities through absolute `PATH` entries. On Windows, use the Windows directory reported by the OS when available and run `taskkill /T /F` from `System32` for process tree cleanup. If `taskkill` is unavailable or fails, or the root has already exited, warn once that descendants may survive and try to stop the direct child if it is still running. ([#58](https://github.com/harshanandak/harnest/issues/58))

- Resolve native CLI names from absolute `PATH` entries for handoffs and diagnostic probes. On Windows, launch system tools from `System32`, unwrap the Codex npm shim for doctor, and reject ACP `.cmd` and `.bat` shims in favor of the native executable. ([#51](https://github.com/harshanandak/harnest/issues/51))

## 0.1.0 - 2026-11-18

Install from the private `harshanandak/harnest` GitHub repository at tag `v0.1.0`. The [install guide](docs/users/getting-started.md#install-from-github) covers the checkout, frozen Bun install, and daemon setup.

### Added

- Durable handoffs to OpenCode, Pi, Cursor, Claude Code, Codex, Gemini CLI, and Amp, plus a generic ACP route for approved write work with trusted local registrations.
- Dependency graphs and JavaScript workflows with durable status, bounded traces, cancellation, and recovery.
- A shared per-user daemon with loopback HTTP, a stdio bridge, and login startup on Windows, macOS, and Linux. The CI budget for the daemon plus 10 clients is ≤ 320 MiB. The shared-daemon measurements were 237 MiB on Ubuntu and 214 MiB on Windows.

### Changed

- Renamed Agent Companion to Harnest and standardized installation on the tagged private GitHub checkout.
- Codex leaf defaults use `gpt-6.2-sol` for writing code, `gpt-6.1-sol` for reviews and investigations, and `gpt-6.1-terra` for read-only non-code work, all at high reasoning.
- Improved ACP initialization, prompt correlation, cancellation acknowledgement, native cleanup, and session identity through failures and resume.

### Security

- The daemon binds to `127.0.0.1` and requires a bearer credential from a private local token file. Host configuration backups may also contain that credential.
- Updated MCP client dependencies for [the SDK OAuth security advisory](https://github.com/advisories/GHSA-6qxp-vccf-f47h).
- ACP v1 terminal callbacks require approved write access, launch with an allowlisted environment, and record executable names in the trace. ([#39](https://github.com/harshanandak/harnest/issues/39))

### Known limitations

- Host installation was verified by CI fixtures. Live host installation was unverified.
- Native authentication and live-agent coverage vary by target. Authenticated Devin handoffs are unverified. Generic ACP trust permits native configuration imports without a read-only sandbox. Amp downstream execution requires Linux, macOS, or Harnest running inside WSL.
- Storage and workload affect throughput. See [release limits](docs/users/limits.md) and [supported agents](docs/users/supported-agents.md).
- [#12](https://github.com/harshanandak/harnest/issues/12) Native Windows Codex setup can overflow the payload and block read-only shell execution.
- [#17](https://github.com/harshanandak/harnest/issues/17) The Windows 1,000-call dynamic runner probe has missed its 120-second deadline.
- [#21](https://github.com/harshanandak/harnest/issues/21) Windows scale and recovery gates have shown variable timing.
