#!/usr/bin/env bash
# Codex plugins cannot bundle agents: only ~/.codex/agents (personal) and
# .codex/agents (project) are discovered. Run this after plugin install.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${1:-${CODEX_HOME:-$HOME/.codex}/agents}"
if [ "${PROJECT:-}" = "1" ]; then
  DEST="$(pwd)/.codex/agents"
fi
exec node "$SCRIPT_DIR/install-native-agents.mjs" "$DEST"
