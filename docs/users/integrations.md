# Optional host integrations

Run `bun run setup <host>` from the Harnest checkout. Keep the backup output and restart the host. Setup starts the shared daemon and registers it at login. Pass `--no-autostart` to skip login registration.

## Codex

Install the Harnest plugin, user MCP bridge, and native workers:

```powershell
bun run setup codex
```

The MCP config and native workers both use `CODEX_HOME` when it is set, otherwise `~/.codex`. Restart Codex and invoke the skill as `$handoff`. Its native workers cover the six external named targets plus the generic `acp_worker`. For Codex-to-Codex handoffs, call the MCP tool directly.

Setup skips identical worker files and prints a backup path for each customized or retired worker it replaces or removes. Restore any such backup using the single-file command below.

## Claude Code

Install the local marketplace and Harnest plugin:

```powershell
bun run setup claude
```

Add `--project "/absolute/path/to/project"` to migrate old workspace MCP, plugin, or marketplace registrations. Without it, setup checks the current directory for those registrations. Restart Claude Code so its bundled MCP configuration, commands, skill, and worker agents reload.

## OpenCode

Install the MCP entry, plugin, worker agents, handoff skill, and commands:

```powershell
bun run setup opencode
```

The installer backs up every changed file and prints a manifest-specific reverse command. Save it. Reversal has this form:

```powershell
node scripts/install-opencode-integration.mjs --restore "<printed-manifest-path>"
```

Restart OpenCode after install, update, or restore. The installer preserves the layout of an existing V1 MCP configuration. Use the installed MCP tools directly or the host's worker agents when a visible child session is useful.

## Pi

Install the native extension, its Pi settings entry, and the handoff skill:

```powershell
bun run setup pi
```

The installer creates timestamped `.bak-harnest-*` copies of files it replaces. Keep them for manual reversal. Start a new Pi session after installing or updating the integration.

## Cursor

Install the user-level MCP bridge and the selected project's skill, router rule, worker, commands, and references:

```powershell
bun run setup cursor --project "/absolute/path/to/project"
```

Omit `--project` to use the Harnest checkout. Setup backs up and updates the user MCP entry and any Harnest or Agent Companion registration in the selected project. Restart Cursor. Cursor cloud agents need MCP in their own environment.

## Gemini CLI as a lead client

Install the bridge in the user Gemini settings with `trust: false`:

```sh
bun run setup gemini
```

Restart Gemini CLI and verify the connection with `/mcp list`. This lead-client configuration is separate from the stricter Gemini downstream target contract.

## Amp as a lead client

Install the bridge in the user Amp settings:

```sh
bun run setup amp
```

When Amp reports `awaiting approval`, run:

```powershell
amp mcp approve harnest
amp mcp doctor
```

Amp can lead through MCP on a supported host. The downstream `amp` target runs on native Linux/macOS or when the entire Harnest MCP server runs inside WSL.

## Restore an Agent Companion migration

Setup prints the migrated registrations and timestamped backup paths. To restore a single configuration file, use:

```sh
node scripts/install-host-config.mjs --restore "/absolute/path/to/FILE.bak-harnest-..."
```

For OpenCode, use the installer manifest command printed during setup. For a Pi extension file or directory moved out of the auto-loaded extensions directory, move it back to its printed original path. If reverting the entire installation, uninstall the new plugin or remove the newly installed extension before restoring the old registration. Restart the host after restoring and keep backups private.

## ACP presets as lead clients

Run `bun run setup <host>` using the host ID below. For automatic setup, reload the CLI and run `bun run doctor --host <host>` to check the configured bridge and discover the Harnest tools. Each preset setup has CI fixture coverage only, with no live CLI testing.

`~` means the user's home on macOS and Linux and `%USERPROFILE%` on Windows. An override marked **none documented** means the linked CLI documentation specifies a default user path and describes no environment variable for changing it.

| Host ID | Setup | User config and overrides | Format and key | Official sources |
| --- | --- | --- | --- | --- |
| `github-copilot-cli` | Automatic | `~/.copilot/mcp-config.json` or `$COPILOT_HOME/mcp-config.json` | JSON · `mcpServers` | [Path override](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/configure-copilot-cli#editing-trusted-directories), [MCP file and stdio fields](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers#editing-the-configuration-file) |
| `qwen-code` | Automatic | `~/.qwen/settings.json` or `$QWEN_HOME/settings.json`. Export `QWEN_HOME` before setup if Qwen normally sets it through its own environment loader. | JSON with comments · `mcpServers` | [MCP scope and fields](https://qwenlm.github.io/qwen-code-docs/en/users/features/mcp/), [settings reader](https://github.com/QwenLM/qwen-code/blob/main/packages/cli/src/config/settings.ts), [path resolution](https://github.com/QwenLM/qwen-code/blob/main/packages/core/src/config/storage.ts) |
| `kilo` | Automatic | `~/.config/kilo/kilo.json` on all three platforms. Uses `XDG_CONFIG_HOME` when set and prefers an existing `kilo.jsonc`. `KILO_CONFIG` selects a file explicitly. `KILO_CONFIG_DIR` and `KILO_CONFIG_CONTENT` are additional overlays. | JSON or JSONC · `mcp` | [Config and MCP fields](https://kilo.ai/docs/automate/mcp/using-in-cli), [global path](https://github.com/Kilo-Org/kilocode/blob/main/packages/core/src/global.ts), [XDG resolution](https://github.com/sindresorhus/xdg-basedir/blob/main/index.js), [overlay precedence](https://kilo.ai/docs/contributing/architecture/cli-runtime#config-precedence) |
| `cline` | Automatic | `~/.cline/data/settings/cline_mcp_settings.json`. `CLINE_DIR` replaces `~/.cline`, `CLINE_DATA_DIR` replaces the resulting `data` directory, and `CLINE_MCP_SETTINGS_PATH` replaces the full path. | JSON · `mcpServers` | [Paths and overrides](https://github.com/cline/cline/blob/main/docs/cli/cli-reference.mdx#configuration-files), [stdio registration](https://github.com/cline/cline/blob/main/apps/cli/src/wizards/mcp/settings.ts) |
| `goose` | Manual | Linux `$XDG_CONFIG_HOME/goose/config.yaml` or `~/.config/goose/config.yaml`. macOS `~/Library/Application Support/Block/goose/config.yaml`. Windows `%APPDATA%\Block\goose\config\config.yaml`. An absolute `GOOSE_PATH_ROOT` selects `$GOOSE_PATH_ROOT/config/config.yaml`. | YAML · `extensions` | [Path resolution](https://github.com/block/goose/blob/main/crates/goose/src/config/paths.rs), [config filename](https://github.com/block/goose/blob/main/crates/goose/src/config/base.rs), [stdio fields](https://github.com/block/goose/blob/main/crates/goose/src/config/extensions.rs) |
| `kiro` | Automatic | `~/.kiro/settings/mcp.json` or `$KIRO_HOME/settings/mcp.json` with a valid absolute `KIRO_HOME`. | JSON · `mcpServers` | [MCP path and stdio fields](https://kiro.dev/docs/mcp/configuration/), [override and path rules](https://kiro.dev/docs/reference/settings/#environment-variables), [override scope](https://kiro.dev/docs/reference/cli-commands/#log-files) |
| `factory-droid` | Automatic | `~/.factory/mcp.json`. Override none documented. | JSON · `mcpServers` | [Path and stdio fields](https://docs.factory.com/harness/mcp#configuration-file) |
| `auggie` | Automatic | `~/.augment/settings.json`. Override none documented. | JSONC · `mcpServers` | [Paths and format](https://docs.augmentcode.com/cli/settings#settings-files), [stdio fields](https://docs.augmentcode.com/cli/integrations#mcp-overrides) |
| `kimi` | Automatic | `~/.kimi/mcp.json` or `$KIMI_SHARE_DIR/mcp.json` for the `kimi` executable. | JSON · `mcpServers` | [Paths and override](https://moonshotai.github.io/kimi-cli/en/configuration/data-locations.html), [stdio fields](https://moonshotai.github.io/kimi-cli/en/customization/mcp.html) |
| `mistral-vibe` | Manual | `~/.vibe/config.toml` or `$VIBE_HOME/config.toml`. | TOML · `[[mcp_servers]]` | [Path and override](https://github.com/mistralai/mistral-vibe#custom-vibe-home-directory), [stdio fields](https://docs.mistral.ai/vibe/code/cli/mcp-servers) |
| `devin` | Automatic | `~/.config/devin/mcp_config.json` on macOS and Linux, `%APPDATA%\devin\mcp_config.json` on Windows. Requires Devin v3000.3 or newer. Override none documented. | JSON with comments · `mcpServers` | [Paths and stdio fields](https://docs.devin.ai/cli/extensibility/mcp/configuration#via-config-file), [comment support](https://docs.devin.ai/cli/reference/configuration/config-file#json-with-comments) |

For Goose and Mistral Vibe, setup prints the resolved path and a ready-to-merge snippet with the bridge command, arguments, and state directories. Make a copy of the configuration before editing. Verify Goose with `goose info -v` and Vibe with `/mcp harnest` in a new Vibe session.

For Kiro, open `/mcp` to check that Harnest loaded. If a custom agent omits global MCP configuration, set `includeMcpJson` to `true` in that agent's configuration. [Kiro custom agent configuration](https://kiro.dev/docs/cli/v3/agent-config/#includemcpjson-field)

## Registered ACP agents

Install and authenticate the agent using its native instructions. Use the metadata helper to discover and explicitly register a command you already trust:

```powershell
node scripts/acp-registry.mjs list
node scripts/acp-registry.mjs describe <registry-id>
node scripts/acp-registry.mjs register <registry-id> --command <native-executable> --arg <value> --protocol-version 1 --trust
```

Repeat `--arg` as needed and choose protocol version 1 or 2 from the native agent's documented command contract. Registration does not run the executable or authenticate it. See [Registered ACP agents](../acp-agents.md).
