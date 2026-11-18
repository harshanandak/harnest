# Security

Harnest MCP launches locally installed coding agents. Review their native configuration and authenticate each agent through its own client. Keep provider credentials and executable paths out of requests.

Approve the scope of write work. Generic ACP registration is write-only. Setting `trusted: true` permits the executable to load its native configuration, hooks, plugins, and MCP servers. That executable runs with its local permissions. Unsupported policy controls fail explicitly. See [supported agents](docs/users/supported-agents.md).

The per-user daemon binds to `127.0.0.1` and requires a local bearer credential. It stores the credential in a private `token` file in its daemon directory. Host MCP settings and installer backups can also contain the credential. Protect these files with operating-system permissions. Code running as the same user can access them. See [daemon architecture and token locations](docs/architecture.md#shared-daemon).

Requests, task context, traces, receipts, and downstream output may be stored as plaintext in the local state directory. Keep secrets out of handoffs and protect the state directory. See [release limits](docs/users/limits.md) for the v0.1.0 verification boundary.

Report vulnerabilities privately to the repository maintainer through your existing access channel. Use the [private repository issue tracker](https://github.com/harshanandak/harnest/issues) for general installation and usage problems. Remove credentials, private source, transcripts, and machine-specific paths before reporting routine issues.
