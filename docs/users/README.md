# Harnest MCP user documentation

Harnest MCP connects an MCP lead client to coding agents through durable jobs and receipts. Start with the shared HTTP daemon or use its stdio bridge. Add a host plugin, skill, command, or visible worker only when you want that host-specific experience.

Install the `harnest` CLI from the public GitHub repository, then connect a host. See the [install guide](getting-started.md#install-from-github).

## Start here

1. [Install and connect Harnest MCP](getting-started.md).
2. [Choose a downstream agent](supported-agents.md).
3. [Run a handoff or agent graph](mcp-usage.md).
4. Optionally [install a host integration](integrations.md).

Use [Troubleshooting](troubleshooting.md) when the MCP server, a downstream CLI, or a durable job does not behave as expected. Read [Release limits](limits.md) before using write-capable routes or relying on a model-free verification result.

## Detailed references

- [Agent graphs](../agent-graphs.md)
- [JavaScript workflows and session transports](../javascript-workflows.md)
- [Routing preferences](../preferences.md) and [routing policy](../routing.md)
- [Live transcript behavior](../live-transcript.md)
- [Registered ACP agents](../acp-agents.md)
- [Devin CLI setup](../devin-cli.md)
