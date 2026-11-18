param([switch]$Project)
$ErrorActionPreference = "Stop"

# Codex plugins cannot bundle agents: only ~/.codex/agents (personal) and
# .codex/agents (project) are discovered. Run this after plugin install.
$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE ".codex" }
$destination = if ($Project) { Join-Path (Get-Location) ".codex/agents" } else { Join-Path $codexHome "agents" }

& node (Join-Path $PSScriptRoot "install-native-agents.mjs") $destination
exit $LASTEXITCODE
