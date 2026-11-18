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

## Devin CLI as a lead client

Devin can connect to the shared daemon through the stdio bridge:

```powershell
devin mcp add --scope local harnest -- node "/absolute/path/to/harnest/src/mcp-bridge.mjs"
```

Restart Devin and verify the entry with `devin mcp list`. Devin is not a named downstream target. A native Devin CLI may be registered through the generic, write-only ACP route, subject to the proof limits in [Devin CLI setup](../devin-cli.md).

## Registered ACP agents

Install and authenticate the agent using its native instructions. Use the metadata helper to discover and explicitly register a command you already trust:

```powershell
node scripts/acp-registry.mjs list
node scripts/acp-registry.mjs describe <registry-id>
node scripts/acp-registry.mjs register <registry-id> --command <native-executable> --arg <value> --protocol-version 1 --trust
```

Repeat `--arg` as needed and choose protocol version 1 or 2 from the native agent's documented command contract. Registration does not run the executable or authenticate it. See [Registered ACP agents](../acp-agents.md).
