# Sync Upstream — GREEDO Fork Wake-Up Skill

Use this skill at the start of any session working on the T3 fork.
It reads the automation status and tells you what state you woke into,
so you spend time on merge decisions — not on infrastructure.

## What the automation already did (before you woke)

Windows Task Scheduler runs `.greedo/sync-fork.ps1` every 30 minutes.
By the time you wake, it has already:
- Fetched `upstream` (pingdotgg/t3code)
- Fast-forwarded `origin/main` to `upstream/main`
- Attempted a rebase of `greedo/claude-sync` onto `upstream/main`
- Written the result to `.greedo/sync-status.json`

The worktree for `greedo/claude-sync` lives at `C:\t3worktree\greedo`.

## Wake-up procedure

### Step 1 — Read the status file

```powershell
Get-Content C:\t3code\.greedo\sync-status.json | ConvertFrom-Json
```

Interpret the fields:
| Field | Meaning |
|---|---|
| `rebase_clean: true` + `pushed_feature: true` | Automation succeeded fully — worktree is current, pushed |
| `rebase_conflict: true` | Automation hit a conflict and aborted — YOU must resolve |
| `error` non-null + everything else false | Something broke at the infrastructure level |
| `timestamp` | When the last sync ran — if >60 min ago, run it manually |

### Step 2a — If clean (normal case)

Worktree is already rebased and pushed. Just open it and work:

```powershell
# Your feature branch, already on top of latest upstream
Set-Location C:\t3worktree\greedo
git log --oneline -5
```

### Step 2b — If rebase conflict

The automation aborted cleanly. You need to resolve manually:

```powershell
Set-Location C:\t3worktree\greedo

# See what upstream commit caused the conflict
git log --oneline upstream/main -3

# Start the rebase
git rebase upstream/main

# For each conflict: edit the file, then:
git add <file>
git rebase --continue

# When done, push
git push origin greedo/claude-sync --force-with-lease
```

The conflict will almost certainly be in `apps/server/scripts/import-claude-sessions.mjs`
or any new file added under `apps/server/scripts/`. Upstream does not own that file,
so conflicts only happen if upstream adds a file with the same name.

### Step 2c — If infrastructure error

Re-run the sync manually:

```powershell
& C:\t3code\.greedo\sync-fork.ps1
```

If the task is missing (e.g., after a system reinstall), re-install everything:

```powershell
& C:\t3code\.greedo\install.ps1
```

## Checking task health

```powershell
Get-ScheduledTask -TaskName "T3ForkSync" | Select-Object TaskName, State, LastRunTime, LastTaskResult
```

`LastTaskResult: 0` = success. Non-zero = check the sync-status.json error field.

## Branch topology (for reference)

```
upstream/main  ──── always current (auto-fetched every 30 min)
      │
origin/main    ──── mirror of upstream/main (auto fast-forwarded)
      │
greedo/claude-sync  ──── our work, rebased on top (auto-rebased if clean)
  C:\t3worktree\greedo  ← permanent worktree for this branch
```

## Key paths

| Purpose | Path |
|---|---|
| Main repo clone | `C:\t3code` |
| Feature worktree | `C:\t3worktree\greedo` |
| Sync script | `C:\t3code\.greedo\sync-fork.ps1` |
| Installer | `C:\t3code\.greedo\install.ps1` |
| Status file | `C:\t3code\.greedo\sync-status.json` |
| Scheduled task | `T3ForkSync` (Task Scheduler) |
