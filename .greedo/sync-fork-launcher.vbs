Dim shell
Set shell = CreateObject("WScript.Shell")
shell.Run "pwsh.exe -NonInteractive -ExecutionPolicy Bypass -File ""C:\t3worktree\greedo\.greedo\sync-fork.ps1""", 0, False
Set shell = Nothing
