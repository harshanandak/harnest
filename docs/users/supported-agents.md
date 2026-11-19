# Supported agents and clients

The lead client is the application connected to Harnest through MCP. The downstream target is the agent that executes a handoff. They are independent choices: a Codex lead can hand work to Pi, for example.

## Per-run execution controls

| Target | Extra directories | Attachments | System instructions | Session fork | Turn limit |
| --- | --- | --- | --- | --- | --- |
| Claude | `--add-dir` | | `--append-system-prompt` | `--resume` and `--fork-session` | `--max-turns` |
| Codex | `--add-dir` with write policy | `-i` images | | `exec fork` | |
| Cursor | `--add-dir` | | | | |
| Gemini | `--include-directories` | | | | |
| OpenCode | | `--file` images and files | | `--session` and `--fork` | |
| Pi | | RPC `prompt.images` | `--append-system-prompt` | `--fork` with a session ID | |
| ACP | | Advertised image and embedded resource blocks | | | |
| Amp | | | | | |

Blank cells indicate unsupported controls. The [MCP usage guide](mcp-usage.md#native-execution-controls) describes validation, write approval, and transport requirements.

## Named downstream targets

| Target value | Agent | Supported shape | Main boundary |
|---|---|---|---|
| `opencode` | OpenCode | Read or approved write prompt handoffs; optional Taskflow; attached live controls | Taskflow needs the optional dependencies. OpenCode V2 is required for current live steer and reroute behavior. |
| `pi` | Pi | Read or approved write prompt handoffs; optional Taskflow; attached live controls | Pi keeps native authentication. Its bounded status and trace are the portable operator view. |
| `cursor` | Cursor | Read or approved write handoffs, one-shot resume, and optional session transport | Cursor UI subagents do not automatically inherit UI MCP servers. |
| `claude` | Claude Code | Read or approved write handoffs, one-shot resume, and optional session transport | One-shot supports named agents and fast mode when the native CLI confirms it. Live message and reroute require session transport. |
| `codex` | Codex | Read-only sandbox or approved workspace-write handoffs, one-shot resume, and optional session transport | One-shot supports native config profiles and service tiers on CLI 0.170.0 or later. Write mode uses `workspace-write`. |
| `gemini` | Gemini CLI | Prompt-only read or approved write handoffs with native-session follow-up | This target requires Gemini CLI v0.62.0. Inherited include directories mean its read policy is not a filesystem sandbox. Session transport and live controls are unsupported. |
| `amp` | Amp | Approved write-only prompt handoffs with native-session follow-up | Downstream execution needs native Linux/macOS or the entire Harnest MCP server inside WSL. Native Windows downstream launch rejects before inference. Read-only, session transport, and live controls are unsupported. |

DeepSeek is a model choice through Pi or OpenCode, not a separate downstream target.

## Downstream coverage

“Tested with Harnest” refers to agent-specific downstream adapter tests. Those tests may use fixtures. ACP registration tests use a fake executable and do not establish compatibility with the real CLI.

| Agent | Downstream route | Tested with Harnest |
|---|---|---|
| Claude Code | Native adapter (`claude`) | Yes |
| Codex CLI | Native adapter (`codex`) | Yes |
| Gemini CLI | Native adapter (`gemini`) | Yes |
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

See [Registered ACP agents](../acp-agents.md) for registration and protocol details.

## Lead clients

A compatible client can lead a Harnest handoff through the HTTP daemon or the stdio bridge. The repository also supplies optional host experiences for Codex, Claude Code, OpenCode, Pi, and Cursor. Gemini CLI and Amp can connect through their MCP configuration.

GitHub Copilot CLI, Qwen Code, Kilo, Cline CLI, Kiro CLI, Factory Droid, Auggie, Kimi CLI, and Devin CLI have automatic user-level MCP setup. Goose and Mistral Vibe have manual setup instructions. Each preset setup has CI fixture coverage only, with no live CLI testing. See the [lead configuration table](integrations.md#acp-presets-as-lead-clients) for paths and setup commands.

Connecting a lead client does not install or authenticate a downstream agent. Configure each downstream CLI through its own supported install and login flow, then select it with the request's `target`.
