# Optional host integrations

Run `harnest setup <host>`. Keep the backup output and restart the host. Automatic setup starts the shared daemon and registers it at login. Pass `--no-autostart` to skip login registration.

## Codex

Install the Harnest plugin, user MCP bridge, and native workers:

```powershell
harnest setup codex
```

The MCP config and native workers both use `CODEX_HOME` when it is set, otherwise `~/.codex`. Restart Codex and invoke the skill as `$handoff`. Its native workers cover the five external named targets plus the generic `acp_worker`. For Codex-to-Codex handoffs, call the MCP tool directly.

Setup skips identical worker files and prints a backup path for each customized or retired worker it replaces or removes. Restore any such backup using the single-file command below.

## Claude Code

Install the local marketplace and Harnest plugin:

```powershell
harnest setup claude
```

Restart Claude Code so its bundled MCP configuration, commands, skill, and worker agents reload.

## OpenCode

Install the MCP entry, plugin, worker agents, handoff skill, and commands:

```powershell
harnest setup opencode
```

The installer backs up every changed file and prints a manifest-specific reverse command. Save it. Reversal has this form:

```powershell
harnest setup opencode --restore "<printed-manifest-path>"
```

Restart OpenCode after install, update, or restore. Use OpenCode V2. Migrate an existing flat MCP or singular plugin configuration before running the installer. It rejects those layouts before changing files. See the [OpenCode migration guide](https://opencode.ai/docs/migrate-v1/). Use the installed MCP tools directly or the host's worker agents when a visible child session is useful.

## Pi

Install the native extension, its Pi settings entry, and the handoff skill:

```powershell
harnest setup pi
```

The installer creates timestamped `.bak-harnest-*` copies of files it replaces. To disconnect, run `harnest setup remove pi` to remove the extension and its settings entry. Start a new Pi session after installing, updating, or removing the integration.

## Cursor

Install the user-level MCP bridge and the selected project's skill, router rule, worker, commands, and references:

```powershell
harnest setup cursor --project "/absolute/path/to/project"
```

Omit `--project` to use the current directory. Setup prints the absolute project path and requires an explicit `--project` when the current directory is your home directory or a filesystem root. Setup backs up and updates the user MCP entry and any Harnest registration in the selected project. Restart Cursor. Cursor cloud agents need MCP in their own environment.

## Amp as a lead client

Install the bridge in the user Amp settings:

```sh
harnest setup amp
```

When Amp reports `awaiting approval`, run:

```powershell
amp mcp approve harnest
amp mcp doctor
```

Amp can lead through MCP on a supported host. The downstream `amp` target runs on native Linux/macOS or when the entire Harnest MCP server runs inside WSL.

## Restore a host configuration

Setup prints the backup path for changed configurations. To restore a single configuration file, use:

```sh
harnest setup --restore "/absolute/path/to/FILE.bak-harnest-..."
```

On Windows, copy the printed command for PowerShell or cmd.exe. For OpenCode, use the manifest command printed during setup. Restart the host after restoring and keep backups private.

## Remove an MCP registration

Paste the reverse command printed by setup. A checkout prints a command with the absolute checkout path. Cursor's command includes `--project` to remove the project MCP entry managed by setup and reverse the installed project files. It preserves unrelated files and later edits. Without `--project`, Cursor removal uses the current directory if setup recorded it as a workspace. Run from your home directory to remove just the user MCP entry. Use the same config path environment variables you used for setup.

Claude and Codex removal use the native plugin CLI to uninstall Harnest and remove its local marketplace. Codex also removes its MCP table and matching copies of the bundled workers. Pi removes the auto-loaded extension, unregisters it in settings, and removes matching copies of the bundled skill. MCP config removal saves a private backup and keeps other registrations. For a Cursor project's migrated MCP entry, use the printed backup command. For a manual setup, remove the entry you added. Restart the host afterward.

## ACP presets as lead clients

For automatic setup, run `harnest setup <host>` using the host ID below. Reload the CLI and run `harnest doctor --host <host>` to check the configured bridge and discover the Harnest tools. Harnest's preset setup commands have CI fixture coverage only.

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
| `antigravity` | [Manual](#antigravity-cli-as-a-lead-client) | `~/.gemini/config/mcp_config.json` | JSON · `mcpServers` | [MCP path and stdio fields](https://antigravity.google/docs/mcp?tab=cli) |

For Goose and Mistral Vibe, run `harnest setup goose` or `harnest setup mistral-vibe` to print the resolved path and a ready-to-merge snippet with the bridge command, arguments, and state directories. Make a copy of the configuration before editing. Verify Goose with `goose info -v` and Vibe with `/mcp harnest` in a new Vibe session.

For Kiro, open `/mcp` to check that Harnest loaded. If a custom agent omits global MCP configuration, set `includeMcpJson` to `true` in that agent's configuration. [Kiro custom agent configuration](https://kiro.dev/docs/cli/v3/agent-config/#includemcpjson-field)

### Antigravity CLI as a lead client

Add a stdio server to `~/.gemini/config/mcp_config.json`. A minimal configuration for the default state directories looks like this.

```json
{
  "mcpServers": {
    "harnest": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/harnest/src/mcp-bridge.mjs"]
    }
  }
}
```

From the Harnest checkout, print the snippet with the paths for your installation.

```sh
harnest setup other
```

Merge the printed `mcpServers.harnest` entry into your config. If the file does not exist, use the whole printed JSON object. Restart `agy` and run `/mcp` to check the connection. Harnest has not verified this setup against the real CLI. See [Google's MCP configuration docs](https://antigravity.google/docs/mcp?tab=cli).

## Registered ACP agents

Install and authenticate the agent using its native instructions. Use the metadata helper to discover and explicitly register a command you already trust:

```powershell
node scripts/acp-registry.mjs list
node scripts/acp-registry.mjs describe <registry-id>
node scripts/acp-registry.mjs register <registry-id> --command <native-executable> --arg <value> --protocol-version 1 --trust
```

Repeat `--arg` as needed and choose protocol version 1 or 2 from the native agent's documented command contract. Registration does not run the executable or authenticate it. See [Registered ACP agents](../acp-agents.md).
