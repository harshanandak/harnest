# Registered ACP agents

Harnest MCP can run an explicitly registered machine-local [Agent Client Protocol (ACP)](https://agentclientprotocol.com/) executable through `target: "acp"`. The request selects the registration with `route.agent`; requests, prompts, and registry metadata cannot supply executable commands, arguments, modules, or environment-secret values.

This route is intentionally write-only. Set `policy.write: true` and `metadata.harnest.writeApproved: true` after the operator approves the work. `trusted: true` records consent for that native executable to load its normal configuration. It is not a read-only guarantee, filesystem sandbox, or statement that native hooks, plugins, and MCP servers are inert. Native configuration can execute before ACP initialization, so register only an executable and arguments the operator already trusts.

## Install and authenticate the native agent

Install the ACP agent through its own supported distribution path and complete its native authentication yourself. Harnest does not install an agent, run registry installation commands, initialize it during registration, or read/copy its credentials.

## Register from a preset

Harnest ships local launch recipes for the [ACP presets in the coverage table](users/supported-agents.md#downstream-coverage). Each recipe has a documented native command and remains unverified with Harnest. Registration works offline.

```sh
bun run acp add github-copilot-cli
bun run acp add github-copilot-cli --trust
```

The first command prints the preset command and arguments, then exits with a `--trust` requirement without writing the config. Repeat with `--trust` after reviewing the launch. Registration searches only absolute `PATH` entries and saves and prints the resolved executable path. Use `--command <absolute-path>` if the CLI executable is outside `PATH`, including when an installation only puts a shell shim on `PATH`. Supply the path to an executable Harnest can launch directly. If you need different arguments, use manual registration below.

The ID you add is the `route.agent` value for `target: "acp"`. Each handoff still requires both `policy.write: true` and `metadata.harnest.writeApproved: true`.

An ACP session can advertise model and mode IDs and typed config options. Use `route.model`, `route.variant`, and `route.options` to select from those choices. Harnest validates the session's advertisements and requires the agent to acknowledge the requested changes before prompting.

## Register manually

The metadata helper reads the official registry for discovery only:

```powershell
node scripts/acp-registry.mjs list
node scripts/acp-registry.mjs describe <registry-id>
```

`list` and `describe` return the registry id, name, version, and description. They ignore distribution commands and environment entries. `list` also shows local registrations and their stored command paths under `configuredAgents`. To register an executable you installed and inspected, supply an absolute path or a command on an absolute `PATH` entry, followed by each argument explicitly:

```powershell
node scripts/acp-registry.mjs register <registry-id> --command <native-executable> --arg <value> --protocol-version 1 --trust
```

Repeat `--arg` for multiple arguments. Set `--protocol-version 1` to select the legacy v1 client profile and its filesystem/terminal facilities, or `--protocol-version 2` for the v2 profile. The registry package version and the agent's numeric wire-version reply do not identify its protocol generation; Harnest checks the initialization response shape. When the field is omitted Harnest sends v2 initialization and can follow a supported v1 response on the same process without advertising v1 client facilities. It never restarts the native process to try another profile. Registration updates the ignored `harnest.config.local.json`; it never executes the command and does not print the stored command or arguments. The equivalent configuration shape for a known v1 command is:

```json
{
  "acp": {
    "agents": {
      "registry-agent-id": {
        "command": "/absolute/path/to/native-agent",
        "args": ["acp"],
        "trusted": true,
        "registryId": "registry-agent-id",
        "version": "observed-registry-version",
        "protocolVersion": 1
      }
    }
  }
}
```

Keep machine-specific commands in the ignored local configuration. Harnest launches the command directly without a shell. The optional registry id and version are provenance, not proof that the local executable matches that version.

`npm run doctor` reports configured registration ids, trust flags, and provenance metadata only. It deliberately does not run `initialize`, `login`, `help`, `version`, or another executable health check. Use the native agent's own documentation for installation and authentication checks.

## Start a handoff

Direct MCP consumers need only the Harnest MCP server and a registered native agent. Forge, T3, host plugins, and bridge workers are not runtime requirements.

```json
{
  "request": {
    "requestId": "caller-owned-id",
    "target": "acp",
    "task": "Implement and test the approved change.",
    "cwd": "/absolute/path/to/repository",
    "context": {
      "goal": "Complete the approved change",
      "acceptanceCriteria": ["Focused tests pass"],
      "requiredResultFields": ["finalText"]
    },
    "route": {
      "agent": "registry-agent-id"
    },
    "execution": {
      "background": true,
      "timeoutMs": 3600000
    },
    "policy": {
      "write": true
    },
    "metadata": {
      "harnest": {
        "writeApproved": true
      }
    }
  }
}
```

Follow-ups pass the observed receipt `sessionId` back as `execution.sessionId`. Harnest fails rather than silently creating a new session when the registered agent cannot resume it.

The generic route implements baseline ACP session creation, streamed updates, terminal prompt handling, cancellation, cleanup, and version-aware resume/load when the agent advertises the required capability. Harnest's bounded standard filesystem and terminal client services are available only to an explicitly selected v1 registration; arbitrary custom callbacks are not advertised. Unsupported route and policy controls reject before launch. Unsupported negotiated capabilities or client callbacks fail explicitly when discovered or requested. Unknown permission requests reject; Harnest never selects a persistent allow option or bypasses native approvals. Unknown usage, token, cache, and cost values remain unknown rather than being estimated.

## Devin status

Devin CLI may be registered through this generic write path after the operator installs and authenticates its native executable. Harnest has no authenticated native Devin live-run proof yet. Earlier model-free probing observed native configuration imports and MCP connection attempts before a safe isolation boundary was established. Read-only execution and isolated startup therefore remain pending; `trusted: true` is the operator's consent to those native configuration imports, not evidence that they are contained.
