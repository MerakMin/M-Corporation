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
echo Open the address shown below in Whale.
echo Keep this window open while using the application. Press Ctrl+C to stop.
node src/server.js
if errorlevel 1 goto failed
exit /b 0
:failed
echo.
echo Startup failed. Please check the error message above.
pause
exit /b 1
