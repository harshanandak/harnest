# OpenCode host integration

The host plugin uses OpenCode's `id/setup` contract. It registers `handoff_host_info` with a JSON Schema, validates launches through `event.input`, and observes completed tool calls through `event.result`. A failed tool transport is not a failed handoff receipt. Receipt states remain `completed`, `failed`, `partial`, and `cancelled`.

MCP text carries a bare receipt; MCP `structuredContent` wraps it in `{ receipt }`. Recovery records keep `jobId`, `requestId`, `contextDigest`, `sessionId`, `workflowRunId`, state, and the trace cursor in plugin-local storage. Compaction reads every stored page for the current session. Concurrent updates are serialized per recovery record, and trace cursors cannot move backwards.

## Install and restore

Run installers with Node:

```powershell
node scripts/install-opencode-integration.mjs
node scripts/install-opencode-integration.mjs --config-dir C:\disposable\opencode
```

The default directory is `$XDG_CONFIG_HOME/opencode`, or `~/.config/opencode`. Installation copies eight worker agents, the handoff skill, three commands, and the complete plugin package under `plugins/harnest/`. Its `index.js` entrypoint imports dependency-free modules. No host SDK dependency is installed.

The config uses `plugins` and `mcp.servers.harnest`, with `disabled` and the V2 timeout object. Existing V2 disablement, timeout settings, plugin options, and unrelated entries survive an upgrade. A legacy or mixed plugin or MCP layout is rejected before setup makes any changes. Migrate the configuration using the [OpenCode migration guide](https://opencode.ai/docs/migrate-v1/) first. JSONC is accepted; a changed document is formatted as JSON, with the original bytes backed up. If both config filenames exist, installation stops before changing assets so the operator can consolidate them.

The installer backs up each existing file it replaces and skips unchanged files. Writes use atomic replacement, and the installer prints a manifest path for reversal:

```powershell
node scripts/install-opencode-integration.mjs --restore "<printed-manifest-path>"
```

Restore checks every current file and backup before making changes. It refuses to overwrite edits made after installation, restores prior bytes, and removes newly created files. It leaves empty directories and backup manifests available for inspection. Repeating an unchanged install creates no new backup.

## Downstream launch

Harnest uses V2 when `route.harnessVersion` is omitted or is `v2`. Explicit V1 routes fail before dispatch, including stored routes used for new runs. Previously recorded receipts remain available.

Install the V2 CLI package `@opencode/cli`. To pin its executable, set `HARNEST_OPENCODE_V2` or `executables.opencode2` in `harnest.config.local.json`. Harnest checks the CLI major version before starting an OpenCode server or requesting model metadata.

Prompt handoffs can pass attachments and continue or fork a session when the installed CLI advertises the relevant run flags. Ordinary handoffs use a managed server or attach to `route.serverUrl`. Graph nodes without a server URL use the shared service to retain native session visibility. OpenCode applies the server's own tool permissions. Harnest requires explicit write authorization and rejects read-only requests before startup. Unrestricted inline Taskflow phases use the native agent by default. Explicit phase tool lists, restricted named agents, and nested definitions that cannot be checked before launch are rejected.

## Verification

```powershell
node --test test/opencode-plugin.test.mjs test/opencode-install.test.mjs
bun test test/opencode-plugin.test.mjs test/opencode-install.test.mjs
npm test
npm run smoke:mcp
bun run validate:plugin
```

The targeted tests import the real modules without SDK stubs or Bun skips. Installer tests use disposable config homes, validate repeated installs, and exercise reversal and subsequent-edit protection.

On 2026-09-12, a model-free private V2 server loaded the installed package from a directory with `index.js`. It rejected an explicit `.mjs` config entry because its configured plugin path had to be a directory. Use the directory layout even though newer documentation also shows file entries.

Private-host activation verifies plugin loading and setup. Model-triggered hook execution requires an end-to-end run.

Authoritative contracts:

- https://opencode.ai/v2/docs/build/plugins
- https://opencode.ai/v2/docs/plugins
- https://opencode.ai/v2/docs/config
- https://opencode.ai/v2/docs/mcp-servers
