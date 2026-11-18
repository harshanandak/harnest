param(
    [Parameter(Mandatory = $true)]
    [string]$ResolverPath
)

$ErrorActionPreference = "Stop"

$resolved = (Resolve-Path -LiteralPath $ResolverPath).Path
if ([IO.Path]::GetExtension($resolved) -ne ".mjs") {
    throw "Harnest routing resolver must be an .mjs file."
}

[Environment]::SetEnvironmentVariable("HARNEST_ROUTER", $resolved, "User")
$stored = [Environment]::GetEnvironmentVariable("HARNEST_ROUTER", "User")
if ($stored -ne $resolved) {
    throw "Harnest routing resolver was not persisted."
}

Write-Output "Harnest routing resolver installed for future Claude and Codex processes."
Write-Output "Restart existing host sessions so their MCP process inherits the stable resolver."
