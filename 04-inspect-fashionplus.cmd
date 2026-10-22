@echo off
setlocal EnableExtensions DisableDelayedExpansion
if not exist "%~dp0scripts\windows-env.cmd" (
  echo Extract the entire ZIP first. The scripts folder must be next to this file.
  goto failed
)
call "%~dp0scripts\windows-env.cmd"
if errorlevel 1 goto failed
if not exist "node_modules\playwright\package.json" (
  echo Run 01-install.cmd first.
  goto failed
)
echo Stop the server and close the previous login browser before continuing.
echo This tool saves page structure only. It does not submit replies.
node scripts/inspect-fashionplus.js
if errorlevel 1 goto failed
pause
exit /b 0
:failed
echo Inspection did not finish. Please check the message above.
pause
exit /b 1
