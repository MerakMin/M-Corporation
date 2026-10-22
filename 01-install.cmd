@echo off
setlocal EnableExtensions DisableDelayedExpansion
if not exist "%~dp0scripts\windows-env.cmd" (
  echo Extract the entire ZIP first. The scripts folder must be next to this file.
  goto failed
)
call "%~dp0scripts\windows-env.cmd"
if errorlevel 1 goto failed
echo Installing the application and its browser. Run this once before first use.
call npm ci
if errorlevel 1 goto failed
call npx --no-install playwright install chromium
if errorlevel 1 goto failed
echo.
echo Installation complete. Run 02-start.cmd to open the application.
pause
exit /b 0
:failed
echo.
echo Installation failed. Please check the error message above.
pause
exit /b 1
