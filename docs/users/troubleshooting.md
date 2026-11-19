# Troubleshooting

## The MCP client shows no Harnest tools

1. Run `bun run daemon status` to verify readiness. For stdio clients, check that the command uses Node and the absolute path to `src/mcp-bridge.mjs`.
2. Confirm Node.js is version 22 or newer.
3. Run `bun run smoke:mcp` from the Harnest checkout.
4. Restart or reload the MCP client after changing its configuration.
5. Use `harnest` as the MCP server key.

If the smoke passes but the client still shows no tools, inspect that client's MCP logs and configuration scope. The smoke proves the server can start; it does not prove the client loaded the edited configuration.

## Tools are present, but a downstream target will not start

Install and authenticate that target's CLI through its native instructions. Make sure the executable is on the MCP server process's `PATH`. A lead client's own login is not forwarded to another downstream harness.

Run `bun run doctor` for a broad machine profile, but interpret its individual checks. It can report optional hosts, workers, or registrations that a direct MCP installation does not use. For generic ACP, doctor reports registration metadata only; it does not run, initialize, authenticate, or version-probe the registered executable.

## The server appears stale after an update

After updating the checkout, refresh dependencies with `bun install --frozen-lockfile --omit optional`.

Call `handoff_host_info` and inspect `runtime.root`, `loadedFingerprint`, `diskFingerprint`, and `sourceStatus`. Let active jobs settle, then reload the MCP connection or restart the host. Editing files does not replace modules already loaded in a running server process.

## A write request is rejected before launch

Use one consistent policy representation. The preferred form is:

```json
{
  "policy": { "write": true },
  "metadata": {
    "harnest": { "writeApproved": true }
  }
}
```

The approval marker belongs only on work whose exact write scope the lead has confirmed. Amp and generic ACP are write-only; a read-only request to either target is expected to reject.

## A long foreground handoff returned a job instead of a result

Harnest converts foreground work beyond the safe MCP wait into a durable background job so the client does not abandon a still-running tool call. Poll `handoff_status`, page new events through `handoff_trace`, and call `handoff_result` after settlement. Prefer `execution.background: true` for substantial work.

## Amp downstream execution fails on Windows

Native Windows downstream launch is unsupported. Run the entire Harnest MCP server inside WSL, or use native Linux/macOS. An Amp client can still lead through MCP on another supported setup; lead-client connectivity and downstream Amp execution are separate paths.

## A generic ACP agent fails during initialization

Confirm that `route.agent` matches an explicitly trusted local registration and that the registered protocol major matches the executable's documented ACP command. Registration and doctor do not execute or authenticate the agent. Native configuration may load before initialization, and unsupported capabilities or callbacks fail explicitly.

Do not treat `trusted: true` as containment. The generic route is write-only, and this beta does not claim a safe read-only sandbox for registered agents.

## Discovery passes, but a live handoff fails

Model-free tests do not establish provider authentication, quota, model availability, network access, or paid inference behavior. Check the selected downstream CLI directly, then inspect `handoff_trace` and the terminal receipt for the failure classification.

Keep credentials and other secrets out of request text, context, tool output, and saved examples. Durable local job state can contain those fields in plaintext.
