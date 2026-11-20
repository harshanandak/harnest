#!/bin/bash
# Codex plugins cannot bundle agents: only ~/.codex/agents (personal) and
# .codex/agents (project) are discovered. Run this after plugin install.
set -euo pipefail
SCRIPT="${BASH_SOURCE[0]}"
[[ "$SCRIPT" = /* ]] || SCRIPT="./$SCRIPT"
SCRIPT_DIR="${SCRIPT%/*}"
DEST="${1:-${CODEX_HOME:-$HOME/.codex}/agents}"
if [ "${PROJECT:-}" = "1" ]; then
  DEST="$(pwd)/.codex/agents"
fi
# Resolve Node using absolute PATH entries before handing it the installer.
remaining_path="${PATH:-}:"
while [[ "$remaining_path" == *:* ]]; do
  directory="${remaining_path%%:*}"
  remaining_path="${remaining_path#*:}"
  [[ "$directory" = /* ]] || continue
  node_path="${directory%/}/node"
  if [[ -f "$node_path" && -x "$node_path" ]]; then
    exec "$node_path" "$SCRIPT_DIR/install-native-agents.mjs" "$DEST"
  fi
done
printf '%s\n' 'Node.js was not found in absolute PATH directories. Add its installation directory to PATH.' >&2
exit 1
