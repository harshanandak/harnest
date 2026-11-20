# Devin CLI as a Harnest MCP client

Devin CLI can connect to Harnest through its documented stdio MCP client configuration. Separately, an operator may register the installed native CLI through Harnest's generic `target: "acp"` write path. Harnest does not add a dedicated `target: "devin"` or per-Devin worker, and configuring Devin as a lead client does not register its downstream executable.

## Connect

Install the Harnest checkout dependencies with `bun install --frozen-lockfile --omit optional`. Then use Devin's native local-scoped MCP command, replacing the example path with the checkout's absolute path:

```sh
devin mcp add --scope local harnest -- node "/absolute/path/to/harnest/src/mcp-bridge.mjs"
```

On Windows, use an absolute path such as `E:/tools/harnest/src/mcp-bridge.mjs`. The command writes Devin's gitignored `.devin/mcp_config.local.json`, keeping a machine-specific checkout path local. Alternatively, copy the shape in [the example](../examples/devin-mcp-config.json) into `.devin/mcp_config.local.json` and replace the path. Merge the `harnest` entry into an existing `mcpServers` object.

The bridge starts the shared daemon on demand. For an explicit standalone stdio instance with its own runtime, use `src/mcp-server.mjs` in place of `src/mcp-bridge.mjs`.

Use project scope and `.devin/mcp_config.json` only for a command/path that is valid for the whole team; that file is shared through version control.

Keep Devin's normal native authentication and workspace trust. Harnest does not need a Devin API key, cloud organization configuration, Forge, hooks or an additional plugin for this client connection. Restart Devin and run `devin mcp list`, then confirm discovery of the `handoff_*` tools in the session. Exact installation, authentication and tool discovery still need verification on the user's host; the example is documentation, not a completed host installation.

The configuration shape, local scope and commands follow [Devin's official MCP configuration reference](https://docs.devin.ai/cli/extensibility/mcp/configuration). Newer Devin versions keep MCP entries in dedicated `mcp_config.json` files; use the native command when migrating from older versions.

## Generic ACP downstream path

The official local CLI supports ACP over stdio, separately from Devin Cloud. Harnest's proposed adapter needs native session identity, streamed output, permission responses, cancellation, continuation and truthful usage. See [the native commands](https://docs.devin.ai/cli/reference/commands).

An earlier model-free startup probe reproduced configuration imports and MCP connection attempts despite redirected home/config environment variables. No model, session-creation or authentication request was sent. Safe pre-start isolation remains unproven: imported/native MCP servers, plugins and hooks must be controlled before initialization, while native authentication remains available. [Import defaults](https://docs.devin.ai/cli/reference/configuration/read-config-from) and [configuration precedence](https://docs.devin.ai/cli/reference/configuration/global-vs-local) explain the relevant layering.

After installing and authenticating Devin, run `harnest acp add devin` to inspect the documented `devin acp` launch and repeat with `--trust` to register it. Requests then use `target: "acp"`, `route.agent: "devin"`, and explicit write approval. `trusted: true` consents to Devin's native configuration imports; it does not establish containment. Set the registration's protocol version only from a known native command contract. See [registered ACP agents](acp-agents.md) for manual registration.

This generic path has model-free client tests but no authenticated native Devin live-run proof. Harnest therefore does not advertise Devin read-only execution or isolated startup, and it makes no claim that imported MCP, plugins, or hooks are inert. Devin Cloud API execution remains outside this integration.
