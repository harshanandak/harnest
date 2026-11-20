param([switch]$Project)
$ErrorActionPreference = "Stop"

# Codex plugins cannot bundle agents: only ~/.codex/agents (personal) and
# .codex/agents (project) are discovered. Run this after plugin install.
$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE ".codex" }
$destination = if ($Project) { Join-Path (Get-Location) ".codex/agents" } else { Join-Path $codexHome "agents" }

# Resolve Node using fully qualified PATH entries before handing it the installer.
foreach ($entry in ($env:Path -split ';')) {
    $directory = $entry -replace '^"(.*)"$', '$1'
    if ($directory -notmatch '^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])') { continue }
    $nodePath = $directory.TrimEnd([char[]] '\/') + '\node.exe'
    if ([IO.File]::Exists($nodePath)) {
        & $nodePath (Join-Path $PSScriptRoot "install-native-agents.mjs") $destination
        exit $LASTEXITCODE
    }
}
throw 'Node.js was not found in absolute PATH directories. Add its installation directory to PATH.'
