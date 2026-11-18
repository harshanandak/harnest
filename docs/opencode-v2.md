# OpenCode host integration

The host plugin uses OpenCode's `id/setup` contract. It registers `handoff_host_info` with a JSON Schema, validates launches through `event.input`, and observes completed tool calls through `event.result`. A failed tool transport is not a failed handoff receipt. Receipt states remain `completed`, `failed`, `partial`, and `cancelled`.

MCP text carries a bare receipt; MCP `structuredContent` wraps it in `{ receipt }`. Recovery records keep `jobId`, `requestId`, `contextDigest`, `sessionId`, `workflowRunId`, state, and the trace cursor in plugin-local storage. Compaction reads every stored page for the current session. Concurrent updates are serialized per recovery record, and trace cursors cannot move backwards.

`server()` retains a separate legacy implementation using the V1 `output.args` and compaction hooks. The current plugin never relies on those hooks. V1 runtime compatibility still needs a V1-host smoke test; the unit suite exercises its returned callbacks.

## Install and restore

Run installers with Node:

```powershell
node scripts/install-opencode-integration.mjs
node scripts/install-opencode-integration.mjs --config-dir C:\disposable\opencode
```

The default directory is `$XDG_CONFIG_HOME/opencode`, or `~/.config/opencode`. Installation copies eight worker agents, the handoff skill, three commands, and the complete plugin package under `plugins/harnest/`. Its `index.js` entrypoint imports dependency-free modules. No host SDK dependency is installed.

The config uses `plugins` and `mcp.servers.harnest`, with `disabled` and the V2 timeout object. Existing routing environment values, disablement, and unrelated settings survive an upgrade. JSONC is accepted; a changed document is formatted as JSON, with the original bytes backed up. If both config filenames exist, installation stops before changing assets so the operator can consolidate them.

The installer backs up each existing file it replaces and skips unchanged files. Writes use atomic replacement, and the installer prints a manifest path for reversal:

```powershell
node scripts/install-opencode-integration.mjs --restore "<printed-manifest-path>"
```

Restore checks every current file and backup before making changes. It refuses to overwrite edits made after installation, restores prior bytes, and removes newly created files. It leaves empty directories and backup manifests available for inspection. Repeating an unchanged install creates no new backup.

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

Private-host activation proves loading and setup, not end-to-end model-triggered hook execution. The current full suite also contains two V1 source-text assertions in `test/opencode-integration.test.mjs`; those need migration to V2 behavioral assertions by that file's owner.

Authoritative contracts:

- https://opencode.ai/v2/docs/build/plugins
- https://opencode.ai/v2/docs/build/plugins/migrate-v1
- https://opencode.ai/v2/docs/plugins
- https://opencode.ai/v2/docs/config
- https://opencode.ai/v2/docs/mcp-servers
