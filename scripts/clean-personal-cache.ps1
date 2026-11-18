# clean-personal-cache.ps1 - detect and (optionally) clear pinned empty dirs under
# ~/.codex/plugins/cache/personal/. A kernel filter driver can pin these dirs
# (os error 32, ERROR_SHARING_VIOLATION) even with all codex processes dead; that
# state is reported as "reboot required" instead of failing silently.
#
# Exit codes: 0 = nothing pending or all removed, 1 = pinned/errors remain,
#             2 = dry-run found work pending.
#
# Usage:
#   powershell -File scripts/clean-personal-cache.ps1            # dry-run (default)
#   powershell -File scripts/clean-personal-cache.ps1 -Apply     # actually delete

param(
    [switch]$Apply
)

$ErrorActionPreference = "Continue"
$target = Join-Path $env:USERPROFILE ".codex\plugins\cache\personal"

if (-not (Test-Path $target)) {
    Write-Output "CLEAN_PERSONAL_CACHE_OK target-absent $target"
    exit 0
}

$children = Get-ChildItem -Force -LiteralPath $target -ErrorAction SilentlyContinue
if (-not $children) {
    Write-Output "CLEAN_PERSONAL_CACHE_OK empty $target"
    if ($Apply) { Remove-Item -Force -Recurse -LiteralPath $target -ErrorAction SilentlyContinue }
    exit 0
}

$pinned = 0
$errors = 0
foreach ($child in $children) {
    # Reparse points (junctions/symlinks) must never be recursed into: Windows
    # PowerShell 5.1 Remove-Item -Recurse follows them outside the cache tree.
    if ($child.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        if ($Apply) {
            try {
                [IO.Directory]::Delete($child.FullName, $false)
                Write-Output "removed-reparse $($child.FullName)"
            } catch {
                Write-Output "ERROR reparse $($child.FullName) - $($_.Exception.Message)"
                $errors++
            }
        } else {
            Write-Output "DRYRUN would-unlink-reparse $($child.FullName)"
        }
        continue
    }
    if ($Apply) {
        try {
            Remove-Item -Force -Recurse -LiteralPath $child.FullName -ErrorAction Stop
            Write-Output "removed $($child.FullName)"
        } catch {
            $hr = $_.Exception.HResult -band 0xFFFF
            if ($hr -eq 32 -or $_.Exception.Message -match "being used by another process|os error 32") {
                Write-Output "PINNED_FILTER_DRIVER $($child.FullName) - os error 32; reboot required, not retried"
                $pinned++
            } else {
                Write-Output "ERROR $($child.FullName) - $($_.Exception.Message)"
                $errors++
            }
        }
    } else {
        Write-Output "DRYRUN would-remove $($child.FullName)"
    }
}

if ($Apply) {
    Remove-Item -Force -Recurse -LiteralPath $target -ErrorAction SilentlyContinue
}

$mode = if ($Apply) { "apply" } else { "dry-run" }
Write-Output "CLEAN_PERSONAL_CACHE_DONE mode=$mode pinned=$pinned errors=$errors"
if (-not $Apply) { exit 2 }
if ($pinned -gt 0 -or $errors -gt 0) { exit 1 } else { exit 0 }
