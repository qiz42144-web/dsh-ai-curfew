<#
.SYNOPSIS
    Publish a fresh development revision of dsh-ai-curfew for a running DSH Host.

.DESCRIPTION
    A running DSH process caches plugin ES modules by resolved URL, so editing the
    source in place changes nothing until the process restarts: disabling and
    re-enabling a Loader entry re-runs `apply()` but does not re-import the module.

    This script copies the package to a new revision directory and prints the
    install spec to hand to Plugin Manager:

        <profile>/.ai-curfew-dev/<revision>/dsh-ai-curfew

    Installing that path links it into the profile's node_modules and re-enables
    the bundle, which imports a URL that has never been loaded before — so the
    new code runs without restarting DSH. The directory must be named exactly
    `dsh-ai-curfew`, because the installer derives the package name from it.

    Development only. Switch back to the source tree at any time with:

        dsh plugin --profile <profile> add link:<source>

.PARAMETER Profile
    Profile name under $DSH_HOME/profiles. Defaults to `desktop`.

.PARAMETER Source
    The plugin package directory. Defaults to the parent of this script.

.PARAMETER Keep
    How many previous revisions to keep. Defaults to 3.

.EXAMPLE
    pwsh -File scripts/dev-reload.ps1
#>
[CmdletBinding()]
param(
    [string]$Profile = 'desktop',
    [string]$Source = (Split-Path -Parent $PSScriptRoot),
    [int]$Keep = 3
)

$ErrorActionPreference = 'Stop'

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$profileDir = Join-Path $dshHome "profiles/$Profile"
$buildRoot = Join-Path $profileDir '.ai-curfew-dev'

if (-not (Test-Path $profileDir)) { throw "Profile not found: $profileDir" }
if (-not (Test-Path (Join-Path $Source 'package.json'))) { throw "Not a package directory: $Source" }

# -Encoding UTF8 matters: the default decodes as the system ANSI codepage and
# mangles the package's non-ASCII description into invalid JSON.
$manifest = Get-Content (Join-Path $Source 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$revision = Get-Date -Format 'yyyyMMdd-HHmmss'
$target = Join-Path (Join-Path $buildRoot $revision) 'dsh-ai-curfew'

# Copy exactly what the manifest would publish, so the running revision cannot
# diverge from the shipped file list.
New-Item -ItemType Directory -Force -Path $target | Out-Null
$published = @()
foreach ($pattern in $manifest.files) {
    foreach ($item in Get-ChildItem -Path (Join-Path $Source $pattern) -File -ErrorAction SilentlyContinue) {
        # Windows PowerShell 5.1 has no [IO.Path]::GetRelativePath.
        $relative = $item.FullName.Substring($Source.Length).TrimStart('\', '/')
        $destination = Join-Path $target $relative
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
        Copy-Item $item.FullName $destination -Force
        $published += $relative
    }
}

# Prune older revisions, newest first.
Get-ChildItem $buildRoot -Directory -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending |
    Select-Object -Skip $Keep |
    ForEach-Object { Remove-Item $_.FullName -Recurse -Force }

Write-Output "revision : $revision"
Write-Output "files    : $($published.Count) ($($published -join ', '))"
Write-Output ''
Write-Output 'Now install this spec through Plugin Manager (install_bundle):'
Write-Output ''
Write-Output "  link:$target"
