# Contributing

Thanks for helping. Bug reports, fixes, docs, and new harness adapters are all welcome.

## The one rule

You must understand your change. Using a coding agent is fine, and expected for a project like this one. If you use one, run it from the repository root so it reads [AGENTS.md](AGENTS.md). But you must be able to explain what the change does and how it interacts with the rest of Harnest. Pull requests that nobody can explain will be closed.

## Before you start

- Open an issue first for anything larger than a small fix, so we can agree on the approach.
- Read [AGENTS.md](AGENTS.md) for the project invariants, and [docs/architecture.md](docs/architecture.md) before changing boundaries or persistence.
- Read [docs/adapter-contract.md](docs/adapter-contract.md) before changing or adding an adapter. A new target updates every hardcoded surface in the same pull request; AGENTS.md lists them.

## Set up

You need Git, Bun, and Node.js.

```sh
git clone https://github.com/harshanandak/harnest.git
cd harnest
bun install --frozen-lockfile
```

## Check your change

```sh
bun run check            # syntax check and the Node test suite
bun run smoke:mcp        # MCP server smoke test
bun run validate:plugin  # plugin manifest validator (needs Python)
```

GitHub CI runs these on Linux, Windows, and macOS for every pull request, and it is the gate for merging.

- Tests use fake harness processes. Live tests that call real CLIs or models (`smoke:live-control`, `scripts/live-*.mjs`) are opt-in and never run in CI.
- Fix the cause of a failing test. Do not lengthen timeouts, add retries, or skip tests to make CI pass.
- When you edit worker definitions, update `scripts/build-workers.mjs` and regenerate the checked-in files with `node scripts/build-workers.mjs`.

## Pull requests

- Keep each pull request to one change, and explain the problem, the fix, and how you verified it.
- Add a line for user-visible changes to [CHANGELOG.md](CHANGELOG.md), under an `Unreleased` heading at the top (create it if it is missing).
- Never include credentials, tokens, private source, session transcripts, or machine-specific paths in code, tests, logs, or descriptions.

## Security

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), not in public issues.

By contributing, you agree that your work is licensed under the [MIT License](LICENSE) and that you follow the [code of conduct](CODE_OF_CONDUCT.md).
