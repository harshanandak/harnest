# Supported agents and clients

The lead client is the application connected to Harnest through MCP. The downstream target is the agent that executes a handoff. They are independent choices: a Codex lead can hand work to Pi, for example.

## Per-run execution controls

| Target | Extra directories | Attachments | System instructions | Session fork | Turn limit |
| --- | --- | --- | --- | --- | --- |
| Claude | `--add-dir` | | `--append-system-prompt` | `--resume` and `--fork-session` | `--max-turns` |
| Codex | `--add-dir` with write policy | `-i` images | | `exec fork` | |
| Cursor | `--add-dir` | | | | |
| OpenCode V2 | | `--file` images and files | | `--session` and `--fork` | |
| Pi | | RPC `prompt.images` | `--append-system-prompt` | `--fork` with a session ID | |
| ACP | | Advertised image and embedded resource blocks | | | |
| Amp | | | | | |

Blank cells indicate unsupported controls. The [MCP usage guide](mcp-usage.md#native-execution-controls) describes validation, write approval, and transport requirements.

## Named downstream targets

| Target value | Agent | Supported shape | Main boundary |
|---|---|---|---|
| `opencode` | OpenCode V2 | Prompt handoffs and server-attached live controls | Requires approved write-capable work. The OpenCode server owns native tool permissions. |
| `pi` | Pi | Read or approved write prompt handoffs with attached live controls | Pi keeps native authentication. Its bounded status and trace are the portable operator view. |
| `cursor` | Cursor | Read or approved write handoffs, one-shot resume, and optional session transport | Cursor UI subagents do not automatically inherit UI MCP servers. |
| `claude` | Claude Code | Read or approved write handoffs, one-shot resume, and optional session transport | One-shot supports named agents and fast mode when the native CLI confirms it. Live message and reroute require session transport. |
| `codex` | Codex | Read-only sandbox or approved workspace-write handoffs, one-shot resume, and optional session transport | One-shot supports native config profiles and service tiers on CLI 0.170.0 or later. Write mode uses `workspace-write`. |
| `amp` | Amp | Approved write-only prompt handoffs with native-session follow-up | Downstream execution needs native Linux/macOS or the entire Harnest MCP server inside WSL. Native Windows downstream launch rejects before inference. Read-only, session transport, and live controls are unsupported. |

DeepSeek is a model choice through Pi or OpenCode, not a separate downstream target.

## Per-run policy controls

| Target | Controls and limits |
|---|---|
| Claude Code print | `policy.tools.allow` accepts `Read`, `Glob`, and `Grep`. Harnest restricts the available tools with `--tools` and uses `--allowedTools` for the selected read tools. `policy.tools.deny` passes exact native tool names to `--disallowedTools`. Print resumes and forks receive the same flags. Claude session transport rejects tool lists. |
| Pi | `policy.tools.deny` removes names from `read`, `grep`, `find`, `ls`, `bash`, `edit`, and `write`. Pi must expose `--exclude-tools`, `--no-tools`, `--no-extensions`, and `--no-mcp`. Filtered runs disable extensions and MCP. Resume and fork launches apply the same tool selection. |
| OpenCode V2 | The server owns native tool permissions. Harnest rejects read-only requests, nonempty tool lists, and explicit allow lists before launch. |
| Cursor print | `policy.mode: "plan"` uses `--mode plan`. `policy.sandbox: true` uses `--sandbox enabled` for shell commands. Both omit `--force`. Cursor rejects granular tools, sandbox disablement, and these controls on ACP session transport. |
| Codex, Amp, registered ACP | Granular tool policy is unsupported. |

Explicit `policy.mode` and `policy.sandbox` are available only on Cursor print. The legacy tool array keeps its existing target-specific behavior.

## Downstream coverage

“Tested with Harnest” refers to agent-specific downstream adapter tests. Those tests may use fixtures. ACP registration tests use a fake executable and do not establish compatibility with the real CLI.

| Agent | Downstream route | Tested with Harnest |
|---|---|---|
| Claude Code | Native adapter (`claude`) | Yes |
| Codex CLI | Native adapter (`codex`) | Yes |
| Antigravity CLI | ACP preset (`antigravity`) | No |
| Cursor CLI | Native adapter (`cursor`) | Yes |
| OpenCode | Native adapter (`opencode`) | Yes |
| Pi | Native adapter (`pi`) | Yes |
| Amp | Native adapter (`amp`) | Yes |
| Devin CLI | ACP preset (`devin`) | No |
| GitHub Copilot CLI | ACP preset (`github-copilot-cli`) | No |
| Goose | ACP preset (`goose`) | No |
| Aider | Not yet supported: needs a [native adapter](https://github.com/harshanandak/harnest/issues/6) | No |
| Qwen Code | ACP preset (`qwen-code`) | No |
| Kiro CLI | ACP preset (`kiro`) | No |
| Cline CLI | ACP preset (`cline`) | No |
| Roo Code | Not yet supported: needs a [native adapter](https://github.com/harshanandak/harnest/issues/3) | No |
| Kilo Code | ACP preset (`kilo`) | No |
| Augment Auggie | ACP preset (`auggie`) | No |
| Factory Droid | ACP preset (`factory-droid`) | No |
| Crush | Not yet supported: needs a [native adapter](https://github.com/harshanandak/harnest/issues/4) | No |
| Warp Agent CLI | Not yet supported: needs a [native adapter](https://github.com/harshanandak/harnest/issues/5) | No |
| Kimi CLI | ACP preset (`kimi`) | No |
| Mistral Vibe | ACP preset (`mistral-vibe`) | No |

## Generic ACP agents

The separate `acp` target calls a machine-local ACP executable that the operator has installed, authenticated, inspected, and explicitly trusted. A request must select the registration through `route.agent` and must be write-capable with explicit approval.

ACP model, mode, and config choices vary by agent. Use the IDs and values the native session advertises in `route.model`, `route.variant`, and `route.options`. See the [MCP route controls](mcp-usage.md#native-route-controls) for field limits and CLI version requirements.

`trusted: true` consents to that executable loading its native configuration. It does not create a read-only boundary or sandbox, and it does not establish that native hooks, plugins, or MCP servers are inert. Unsupported route controls, policy controls, negotiated capabilities, and callbacks fail explicitly.

Install and authenticate the CLI first. Run `bun run acp add <preset-id>` to inspect the executable and arguments, then repeat with `--trust` to save the local registration. Use the preset ID in `route.agent` and provide explicit write approval on each handoff.

For Antigravity CLI, run `bun run acp add antigravity` to preview `agy acp`. On Windows, the installer puts `agy.exe` in `%LOCALAPPDATA%\agy\bin` by default. Add that directory to `PATH` if Harnest cannot find `agy`. See [Google's Antigravity install guide](https://antigravity.google/docs/cli/tutorial/).

See [Registered ACP agents](../acp-agents.md) for registration and protocol details.

## Lead clients

A compatible client can lead a Harnest handoff through the HTTP daemon or the stdio bridge. The repository also supplies optional host experiences for Codex, Claude Code, OpenCode, Pi, and Cursor. Amp can connect through its MCP configuration.

GitHub Copilot CLI, Qwen Code, Kilo, Cline CLI, Kiro CLI, Factory Droid, Auggie, Kimi CLI, and Devin CLI have automatic user-level MCP setup. Harnest prints manual configuration for Goose and Mistral Vibe. Those setup commands have CI fixture coverage only. See the [lead configuration table](integrations.md#acp-presets-as-lead-clients) for paths and setup commands. Antigravity CLI uses [manual MCP configuration](integrations.md#antigravity-cli-as-a-lead-client) based on Google's docs.

Connecting a lead client does not install or authenticate a downstream agent. Configure each downstream CLI through its own supported install and login flow, then select it with the request's `target`.
