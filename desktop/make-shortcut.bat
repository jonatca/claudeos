@echo off
REM ===== Create a ClaudeOS icon on your Windows Desktop =====
REM Double-click this once. It makes a "ClaudeOS" shortcut on your Desktop that
REM launches run-claudeos.bat with the ClaudeOS icon, in a minimized console window.

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ws = New-Object -ComObject WScript.Shell;" ^
  "$lnk = $ws.CreateShortcut([Environment]::GetFolderPath('Desktop') + '\ClaudeOS.lnk');" ^
  "$lnk.TargetPath = '%~dp0run-claudeos.bat';" ^
  "$lnk.WorkingDirectory = '%~dp0';" ^
  "$lnk.IconLocation = '%~dp0icon.ico';" ^
  "$lnk.WindowStyle = 7;" ^
  "$lnk.Description = 'ClaudeOS - what needs you next';" ^
  "$lnk.Save()"

echo [ClaudeOS] Created a "ClaudeOS" shortcut on your Desktop.
echo           Double-click it any time to open ClaudeOS.
pause
