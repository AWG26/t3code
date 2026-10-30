<#
.SYNOPSIS
    Syncs AWG26/t3code fork with upstream pingdotgg/t3code.

.DESCRIPTION
    Layer 1-3 of the GREEDO fork automation stack:
      1. Fetch upstream (pingdotgg/t3code)
      2. Fast-forward origin/main to upstream/main
      3. Attempt clean rebase of greedo/claude-sync onto upstream/main
      4. Push results; write status file for agent wake-up

    Run automatically via Task Scheduler every 30 minutes.
    The install artifact is .greedo/install.ps1.

.PARAMETER RepoDir
    Root of the local t3code clone. Default: C:\t3code

.PARAMETER WorktreeDir
    Root of the greedo/claude-sync worktree. Default: C:\t3worktree\greedo

.PARAMETER StatusFile
    Path to write sync status JSON. Default: <RepoDir>\.greedo\sync-status.json
#>
param(
    [string]$RepoDir    = "C:\t3code",
    [string]$WorktreeDir = "C:\t3worktree\greedo",
    [string]$StatusFile  = ""
)

$ErrorActionPreference = "Stop"
if (-not $StatusFile) { $StatusFile = Join-Path $RepoDir ".greedo\sync-status.json" }

$logLine = { param($msg) Write-Host "$(Get-Date -Format 'HH:mm:ss') $msg" }

function Run-Git {
    param([string]$Dir, [string[]]$GitArgs)
    $result = & git -C $Dir @GitArgs 2>&1
    if ($LASTEXITCODE -ne 0) { throw "git $($GitArgs -join ' ') failed in $Dir :`n$result" }
    $result
}

$status = @{
    timestamp       = (Get-Date -Format "o")
    upstream_fetched = $false
    main_updated    = $false
    rebase_clean    = $false
    rebase_conflict = $false
    pushed_main     = $false
    pushed_feature  = $false
    error           = $null
    upstream_tip    = $null
    our_tip         = $null
}

try {
    # 1. Fetch upstream
    & $logLine "Fetching upstream (pingdotgg/t3code)..."
    Run-Git $RepoDir @("fetch", "upstream", "--quiet")
    $status.upstream_fetched = $true

    $upstreamTip = (Run-Git $RepoDir @("rev-parse", "upstream/main")).Trim()
    $status.upstream_tip = $upstreamTip

    # 2. Fast-forward origin/main to upstream/main
    & $logLine "Pushing upstream/main -> origin/main..."
    Run-Git $RepoDir @("push", "origin", "upstream/main:refs/heads/main", "--force-with-lease")
    $status.main_updated = $true
    $status.pushed_main  = $true

    # 3. Ensure worktree exists
    $worktreeList = & git -C $RepoDir worktree list 2>&1
    $worktreeExists = $worktreeList | Select-String ([regex]::Escape($WorktreeDir))
    if (-not $worktreeExists) {
        & $logLine "Creating worktree at $WorktreeDir..."
        # Ensure the branch exists locally first
        $branches = Run-Git $RepoDir @("branch", "--list", "greedo/claude-sync")
        if (-not $branches) {
            Run-Git $RepoDir @("fetch", "origin", "greedo/claude-sync:greedo/claude-sync")
        }
        Run-Git $RepoDir @("worktree", "add", $WorktreeDir, "greedo/claude-sync")
    }

    # 4. Rebase greedo/claude-sync onto upstream/main
    & $logLine "Rebasing greedo/claude-sync onto upstream/main..."
    try {
        Run-Git $WorktreeDir @("rebase", "upstream/main")
        $status.rebase_clean = $true
        & $logLine "Rebase clean."
    } catch {
        # Abort the rebase to leave a clean state for the agent
        & git -C $WorktreeDir rebase --abort 2>&1 | Out-Null
        $status.rebase_conflict = $true
        $status.error = "Rebase conflict on greedo/claude-sync — needs manual resolution. $($_.Exception.Message)"
        & $logLine "Rebase conflict — aborted. Agent must resolve."
    }

    # 5. Push feature branch if rebase was clean
    if ($status.rebase_clean) {
        & $logLine "Pushing greedo/claude-sync to origin..."
        Run-Git $WorktreeDir @("push", "origin", "greedo/claude-sync", "--force-with-lease")
        $status.pushed_feature = $true
        $ourTip = (Run-Git $WorktreeDir @("rev-parse", "HEAD")).Trim()
        $status.our_tip = $ourTip
    }

} catch {
    $status.error = $_.Exception.Message
    & $logLine "ERROR: $($_.Exception.Message)"
}

# Write status file
$status | ConvertTo-Json | Set-Content -Path $StatusFile -Encoding UTF8
& $logLine "Status written to $StatusFile"

if ($status.error -and -not $status.rebase_conflict) {
    exit 1
}
exit 0
