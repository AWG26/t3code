<#
.SYNOPSIS
    Installs the GREEDO fork automation stack on this machine.

.DESCRIPTION
    DMAIC Control artifact — re-running this script fully restores the
    automation from scratch (idempotent). What it sets up:

      1. Git worktree at C:\t3worktree\greedo (greedo/claude-sync branch)
      2. Windows Scheduled Task: "T3ForkSync" — runs sync-fork.ps1 every 30 min
      3. Adds upstream remote if missing
      4. Runs one immediate sync

    To verify the setup after install:
        Get-ScheduledTask -TaskName "T3ForkSync"
        git -C C:\t3code worktree list
        cat C:\t3code\.greedo\sync-status.json

.PARAMETER RepoDir
    Local t3code clone. Default: C:\t3code

.PARAMETER WorktreeDir
    Worktree path for greedo/claude-sync. Default: C:\t3worktree\greedo

.PARAMETER TaskName
    Scheduled task name. Default: T3ForkSync
#>
param(
    [string]$RepoDir     = "C:\t3code",
    [string]$WorktreeDir = "C:\t3worktree\greedo",
    [string]$TaskName    = "T3ForkSync"
)

$ErrorActionPreference = "Stop"
$SyncScript = Join-Path $RepoDir ".greedo\sync-fork.ps1"

Write-Host "=== GREEDO fork automation installer ==="
Write-Host "RepoDir    : $RepoDir"
Write-Host "WorktreeDir: $WorktreeDir"
Write-Host "TaskName   : $TaskName"
Write-Host ""

# 1. Verify repo exists
if (-not (Test-Path (Join-Path $RepoDir ".git"))) {
    Write-Error "No git repo at $RepoDir. Clone AWG26/t3code there first."
    exit 1
}

# 2. Ensure upstream remote exists
$remotes = & git -C $RepoDir remote 2>&1
if ($remotes -notcontains "upstream") {
    Write-Host "Adding upstream remote (pingdotgg/t3code)..."
    & git -C $RepoDir remote add upstream https://github.com/pingdotgg/t3code.git
} else {
    Write-Host "upstream remote already present."
}

# 3. Create worktree if missing
$worktreeList = & git -C $RepoDir worktree list 2>&1
if (-not ($worktreeList | Select-String ([regex]::Escape($WorktreeDir)))) {
    Write-Host "Creating worktree at $WorktreeDir..."
    New-Item -ItemType Directory -Force -Path (Split-Path $WorktreeDir) | Out-Null

    # Ensure branch exists locally
    $branches = & git -C $RepoDir branch --list "greedo/claude-sync" 2>&1
    if (-not $branches) {
        Write-Host "Fetching greedo/claude-sync from origin..."
        & git -C $RepoDir fetch origin "greedo/claude-sync:greedo/claude-sync"
    }

    # A branch can't be in two worktrees. If main repo is on greedo/claude-sync, switch it to main.
    $currentBranch = (& git -C $RepoDir rev-parse --abbrev-ref HEAD 2>&1).Trim()
    if ($currentBranch -eq "greedo/claude-sync") {
        Write-Host "Main repo is on greedo/claude-sync; switching it to main first..."
        & git -C $RepoDir checkout main
    }

    & git -C $RepoDir worktree add $WorktreeDir "greedo/claude-sync"
    Write-Host "Worktree created."
} else {
    Write-Host "Worktree already exists at $WorktreeDir."
}

# 4. Register Scheduled Task (idempotent — unregister first if exists)
$existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existingTask) {
    Write-Host "Removing existing task '$TaskName'..."
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Write-Host "Registering scheduled task '$TaskName' (every 30 minutes)..."

$action = New-ScheduledTaskAction `
    -Execute "pwsh.exe" `
    -Argument "-NonInteractive -WindowStyle Hidden -File `"$SyncScript`" -RepoDir `"$RepoDir`" -WorktreeDir `"$WorktreeDir`""

# Repeat every 30 minutes indefinitely
$trigger = New-ScheduledTaskTrigger -RepetitionInterval (New-TimeSpan -Minutes 30) -Once -At (Get-Date)

$settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action   $action `
    -Trigger  $trigger `
    -Settings $settings `
    -Description "Syncs AWG26/t3code fork with pingdotgg/t3code upstream every 30 minutes. Source: $SyncScript" `
    -RunLevel Limited | Out-Null

Write-Host "Task registered."

# 5. Run an immediate sync
Write-Host ""
Write-Host "Running initial sync..."
& pwsh.exe -NonInteractive -File $SyncScript -RepoDir $RepoDir -WorktreeDir $WorktreeDir

$statusFile = Join-Path $RepoDir ".greedo\sync-status.json"
if (Test-Path $statusFile) {
    Write-Host ""
    Write-Host "=== Sync status ==="
    Get-Content $statusFile | ConvertFrom-Json | Format-List
}

Write-Host ""
Write-Host "=== Installation complete ==="
Write-Host "Verify with:"
Write-Host "  Get-ScheduledTask -TaskName '$TaskName' | Select-Object TaskName, State"
Write-Host "  git -C '$RepoDir' worktree list"
