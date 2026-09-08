<#
.SYNOPSIS
    Cut a release by tagging a commit that is ready to be one.

.DESCRIPTION
    Tagging is one command. The reason this is a script is everything that should be true
    before that command runs, and none of it is visible at the moment you type the tag:
    whether the tree is clean, whether the version in the tag matches the version in the
    three files that carry it, whether CI passed on the exact commit being tagged.

    The release workflow checks the version too, but it checks it after a twelve-minute
    build. Failing here costs a second.

    Nothing is pushed until every check has passed and you have said yes. A tag that is
    already pushed can be deleted, but not before somebody has seen it.

.PARAMETER Version
    The version to cut, with or without a leading v. Defaults to whatever package.json
    already says, which is almost always what you want: the version is bumped in a normal
    commit, and this only marks it.

.PARAMETER DryRun
    Run every check and stop before creating anything.

.EXAMPLE
    .\scripts\release.ps1 -DryRun
    Checks whether main is in a releasable state, and changes nothing.

.EXAMPLE
    .\scripts\release.ps1
    Cuts the version package.json already carries.
#>
[CmdletBinding()]
param(
    [string] $Version,
    [switch] $DryRun
)

$ErrorActionPreference = 'Stop'

# The repo, not wherever the shell happens to be.
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$problems = New-Object System.Collections.Generic.List[string]

function Test-Step {
    param([string] $Name, [bool] $Ok, [string] $Detail)
    if ($Ok) {
        Write-Host "  [ ok ] $Name" -ForegroundColor Green
    }
    else {
        Write-Host "  [fail] $Name" -ForegroundColor Red
        if ($Detail) { Write-Host "         $Detail" -ForegroundColor DarkGray }
        $problems.Add($Name)
    }
    if ($Detail -and $Ok) { Write-Host "         $Detail" -ForegroundColor DarkGray }
}

Write-Host ''
Write-Host 'RimDoc+ release' -ForegroundColor Cyan
Write-Host ''

# --- The version the three files agree on -------------------------------------------------
$pkg = (Get-Content 'package.json' -Raw | ConvertFrom-Json).version
$conf = (Get-Content 'src-tauri/tauri.conf.json' -Raw | ConvertFrom-Json).version
$cargoLine = Select-String -Path 'src-tauri/Cargo.toml' -Pattern '^version\s*=\s*"(.+)"' | Select-Object -First 1
$cargo = $cargoLine.Matches[0].Groups[1].Value

if (-not $Version) { $Version = $pkg }
$Version = $Version -replace '^v', ''
$tag = "v$Version"

$agree = ($pkg -eq $conf) -and ($pkg -eq $cargo) -and ($pkg -eq $Version)
Test-Step 'The version is the same everywhere' $agree "package.json $pkg, tauri.conf.json $conf, Cargo.toml $cargo, tagging $Version"

# --- The tree ----------------------------------------------------------------------------
$branch = (git rev-parse --abbrev-ref HEAD).Trim()
Test-Step 'On main' ($branch -eq 'main') "on $branch"

$dirty = git status --porcelain
Test-Step 'Nothing uncommitted' ([string]::IsNullOrWhiteSpace($dirty)) $(if ($dirty) { "$(($dirty -split "`n").Count) file(s) changed" } else { 'clean' })

git fetch --quiet origin main 2>&1 | Out-Null
$local = (git rev-parse HEAD).Trim()
$remote = (git rev-parse origin/main).Trim()
Test-Step 'Up to date with origin' ($local -eq $remote) "local $($local.Substring(0,7)), origin $($remote.Substring(0,7))"

# --- The tag ------------------------------------------------------------------------------
$existing = git tag --list $tag
Test-Step "$tag does not exist yet" ([string]::IsNullOrWhiteSpace($existing)) $(if ($existing) { 'delete it first, or pick another version' } else { '' })

# --- CI, on this exact commit -------------------------------------------------------------
# Not "main is green": main moves. A tag points at one commit and that is the one that has
# to have passed.
$gh = Get-Command gh -ErrorAction SilentlyContinue
if ($gh) {
    $conclusion = ''
    try {
        # Quoted: unquoted, PowerShell splits on the commas and gh sees three arguments.
        #
        # Indexed rather than piped into Select-Object -First. That cmdlet stops the
        # pipeline by throwing, and inside a try with ErrorActionPreference Stop the catch
        # below swallows it: the check reported "no finished run for this commit yet" while
        # a green run for exactly that commit sat first in the list.
        #
        # Ten rather than one, so a run that finished after a newer commit was pushed is
        # still found.
        $runs = gh run list --branch main --limit 10 --json 'headSha,conclusion,status' | ConvertFrom-Json
        $mine = @($runs | Where-Object { $_.headSha -eq $local })
        if ($mine.Count -gt 0) { $conclusion = $mine[0].conclusion }
    }
    catch {
        $conclusion = ''
    }
    Test-Step 'CI passed on this commit' ($conclusion -eq 'success') $(if ($conclusion) { "conclusion: $conclusion" } else { 'no finished run for this commit yet' })
}
else {
    Write-Host '  [ ?? ] CI not checked, gh is not installed' -ForegroundColor Yellow
}

Write-Host ''

if ($problems.Count -gt 0) {
    Write-Host "Not releasable: $($problems.Count) check(s) failed." -ForegroundColor Red
    Write-Host ''
    exit 1
}

if ($DryRun) {
    Write-Host "Everything passes. $tag was not created, because this was a dry run." -ForegroundColor Cyan
    Write-Host ''
    exit 0
}

# --- Ask, then do -------------------------------------------------------------------------
Write-Host "About to tag $($local.Substring(0,7)) as $tag and push it." -ForegroundColor Yellow
Write-Host 'That starts a build of about twelve minutes and opens a DRAFT release.' -ForegroundColor DarkGray
Write-Host 'Nothing is public until you publish the draft yourself.' -ForegroundColor DarkGray
$answer = Read-Host 'Type the tag to confirm'

if ($answer -ne $tag) {
    Write-Host 'Stopped. Nothing was created.' -ForegroundColor DarkGray
    exit 1
}

git tag -a $tag -m "RimDoc+ $Version"
if (-not $?) { throw "Could not create $tag" }

git push origin $tag
if (-not $?) {
    git tag -d $tag | Out-Null
    throw "Could not push $tag. The local tag has been removed so this can be run again."
}

Write-Host ''
Write-Host "$tag pushed." -ForegroundColor Green
Write-Host 'The build is running. When it finishes there will be a draft release with the' -ForegroundColor DarkGray
Write-Host 'installer attached, to check and then publish:' -ForegroundColor DarkGray
Write-Host '  https://github.com/w1ck3ds0d4/RimDocPlus/releases' -ForegroundColor Cyan
Write-Host ''
