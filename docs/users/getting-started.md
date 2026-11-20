# Getting started

Clients share one local Harnest HTTP daemon. A small stdio bridge is available for clients that need it.

## Requirements

- Git.
- Bun and Node.js 22 or newer.
- An MCP client that supports Streamable HTTP or stdio.
- At least one [supported downstream agent](supported-agents.md), installed and authenticated through its native instructions.

Harnest does not accept a downstream provider key in a handoff request and does not forward the lead client's credentials. Each downstream agent uses its own native authentication.

## Install from GitHub

Install Harnest directly from GitHub and ensure Bun's global bin directory is on your `PATH`.

```sh
bun add -g github:harshanandak/harnest#v0.1.1
harnest --version
```

To install this release from a checkout:

```sh
git clone --branch v0.1.1 https://github.com/harshanandak/harnest.git
cd harnest
bun install --frozen-lockfile --omit optional
```

Use another release tag to check out an older version. For development, omit the branch option.

From the checkout, use the `bun run setup`, `bun run doctor`, `bun run daemon`, `bun run acp`, and `bun run routing:setup` aliases. Setup prints a reverse command you can paste from any directory.

## Add the MCP server

Connect the lead client. For example, this installs Codex's plugin, MCP config, and native workers.

```sh
harnest setup codex
```

Run `harnest setup --help` for supported names, including the [ACP preset lead hosts](integrations.md#acp-presets-as-lead-clients). Use `harnest setup cursor --project "/absolute/path/to/project"` to select a Cursor workspace. See the [host installation instructions](integrations.md) for paths, native approval, and restoring migration backups.

Run setup with the downstream CLIs on `PATH` and the intended `HARNEST_STATE_DIR` if customized. Pass `--no-autostart` to skip login registration. The bridge starts the daemon when the host connects and can restart it on connection failure.

For a stdio-only client, merge this entry into its configuration. Keep existing servers and replace the example with the absolute path to Harnest.

```json
{
  "mcpServers": {
    "harnest": {
      "command": "node",
      "args": ["/absolute/path/to/harnest/src/mcp-bridge.mjs"]
    }
  }
}
```

Run `harnest setup other` to print the stdio snippet with your installation path.

For an HTTP client, set the server URL to `http://127.0.0.1:41237/mcp` and the `Authorization` header to `Bearer <token>`. If the client uses an `mcpServers` JSON object, the installer reads the token file and writes the header directly to your private local config:

```sh
harnest setup other --http-config "/absolute/path/to/private/mcp.json"
```

The generated entry uses `{"type":"http","url":"http://127.0.0.1:41237/mcp","headers":{"Authorization":"Bearer <token>"}}`. For a client with a different schema, use its local file import or header helper to load the same value from the private token file. It's under `%LOCALAPPDATA%/harnest/daemon/token` on Windows, `~/Library/Application Support/harnest/daemon/token` on macOS, and `$XDG_STATE_HOME/harnest/daemon/token` on Linux, defaulting to `~/.local/state/harnest/daemon/token`. For custom `HARNEST_STATE_DIR`, look in the sibling `daemon/token`. Keep the client config, token, and any installer backups private. For HTTP-only clients, use `harnest daemon start` if the daemon is stopped.

Restart or reload the MCP client after changing its configuration.

## Verify the connection

Check the installed lead configuration and tool discovery.

```powershell
harnest doctor --host codex
```

Use the relevant host name. For a generic JSON config, use `harnest doctor --host other --config "/absolute/path/to/private/mcp.json"`. For Cursor, pass `--project` with the workspace path. Then confirm that the client discovers at least these tools.

- `handoff_workflow`
- `handoff_status`
- `handoff_trace`
- `handoff_result`
- `handoff_host_info`

This proves protocol startup and tool discovery without invoking a model. It does not prove downstream authentication, provider availability, quota, or a live handoff.

## Run a first handoff

Ask the MCP client to call `handoff_workflow` with a read-only task and an absolute working directory:

```json
{
  "request": {
    "requestId": "docs-first-read-001",
    "target": "codex",
    "task": "Inspect the repository and summarize how tests are organized. Do not edit files.",
    "cwd": "/absolute/path/to/project",
    "execution": { "background": true },
    "policy": { "write": false }
  }
}
```

The call returns a durable job reference. Poll `handoff_status`, read incremental progress with `handoff_trace`, and fetch the terminal receipt with `handoff_result`. See [MCP usage](mcp-usage.md) for the lifecycle and write-capable examples.

For client-specific installation and visible worker options, see [Optional host integrations](integrations.md).
