<#
.SYNOPSIS
    Publish a fresh development revision of dsh-ai-curfew for a running DSH Host.

.DESCRIPTION
    A running DSH process caches plugin ES modules by resolved URL, so editing the
    source in place changes nothing until the process restarts: disabling and
    re-enabling a Loader entry re-runs `apply()` but does not re-import the module.

    This script copies the package to a new revision directory and points the
    profile's `dsh-ai-curfew` junction at it. The resolved realpath — and with it
    the module URL — is then one no process has loaded, so a single disable/enable
    toggle imports the new code. No DSH restart required.

    Development only. It leaves the profile manifest alone; the dependency still
    names the source directory and the junction is what redirects it. To undo:

        cmd /c rmdir "<profile>/node_modules/dsh-ai-curfew"
        dsh plugin --profile <profile> install

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
$nodeModules = Join-Path $profileDir 'node_modules'
$buildRoot = Join-Path $profileDir '.ai-curfew-dev'
$link = Join-Path $nodeModules 'dsh-ai-curfew'

if (-not (Test-Path $profileDir)) { throw "Profile not found: $profileDir" }
if (-not (Test-Path (Join-Path $Source 'package.json'))) { throw "Not a package directory: $Source" }

# -Encoding UTF8 matters: the default decodes as the system ANSI codepage and
# mangles the package's non-ASCII description into invalid JSON.
$manifest = Get-Content (Join-Path $Source 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$revision = Get-Date -Format 'yyyyMMdd-HHmmss'
# The directory name has to stay `dsh-ai-curfew`: Plugin Manager derives the
# package name from it when a path spec is installed.
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

# `rmdir` removes the junction link itself; Remove-Item -Recurse could follow it
# into the source tree on some PowerShell versions.
if (Test-Path $link) { cmd /c rmdir "$link" | Out-Null }
New-Item -ItemType Junction -Path $link -Target $target | Out-Null

# Prune older revisions, but never the one just published.
$current = Split-Path -Parent $target
Get-ChildItem $buildRoot -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -ne $current } |
    Sort-Object Name -Descending |
    Select-Object -Skip $Keep |
    ForEach-Object { Remove-Item $_.FullName -Recurse -Force }

Write-Output "revision : $revision"
Write-Output "files    : $($published.Count) ($($published -join ', '))"
Write-Output "junction : $link -> $target"
Write-Output ''
Write-Output 'Now toggle the plugin off and on to import this revision.'
