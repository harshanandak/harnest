# Security

Harnest MCP launches locally installed coding agents. Review their native configuration and authenticate each agent through its own client. Keep provider credentials and executable paths out of requests.

Approve the scope of write work. Generic ACP registration is write-only. Setting `trusted: true` permits the executable to load its native configuration, hooks, plugins, and MCP servers. That executable runs with its local permissions. Unsupported policy controls fail explicitly. See [supported agents](docs/users/supported-agents.md).

Approved ACP v1 agents can request terminal commands. Harnest launches them directly with PATH lookup for bare names. On Windows, Harnest searches only directories listed in PATH and skips empty entries. An agent can explicitly name a workspace executable by path.

The per-user daemon binds to `127.0.0.1` and requires a local bearer credential. It stores the credential in a private `token` file in its daemon directory. Host MCP settings and installer backups can also contain the credential. Protect these files with operating-system permissions. Code running as the same user can access them. See [daemon architecture and token locations](docs/architecture.md#shared-daemon).

Requests, task context, traces, receipts, and downstream output may be stored as plaintext in the local state directory. Keep secrets out of handoffs and protect the state directory. See [release limits](docs/users/limits.md) for the v0.1.0 verification boundary.

Report vulnerabilities privately through [GitHub private vulnerability reporting](https://github.com/harshanandak/harnest/security/advisories/new). Use the [issue tracker](https://github.com/harshanandak/harnest/issues) for general installation and usage problems. Remove credentials, private source, transcripts, and machine-specific paths before reporting routine issues.

## Official sources

Harnest is published only at [github.com/harshanandak/harnest](https://github.com/harshanandak/harnest), as source and GitHub releases. It has no npm package; a package named `harnest` on npm or any other registry is not from this project. Install from a release tag and check that the clone URL is exactly `https://github.com/harshanandak/harnest.git`.

The maintainer never asks you to sign in, authorize an app, or download a fix through a link in an issue, pull request, comment, or email. Treat such requests as phishing and report them.
