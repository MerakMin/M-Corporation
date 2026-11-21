@echo off
setlocal EnableExtensions DisableDelayedExpansion
if not exist "%~dp0scripts\windows-env.cmd" (
  echo Extract the entire ZIP first. The scripts folder must be next to this file.
  goto failed
)
call "%~dp0scripts\windows-env.cmd"
if errorlevel 1 goto failed
node -e "require.resolve('playwright'); require.resolve('bcryptjs')" >nul 2>&1
if errorlevel 1 (
  echo Installing missing CS Desk dependencies...
  call npm ci
  if errorlevel 1 goto failed
  call npx --no-install playwright install chromium
  if errorlevel 1 goto failed
)
node %MCORP_NODE_ENV_FILE% src/server.js
if errorlevel 1 goto failed
pause
exit /b 0
:failed
echo.
echo Startup failed. Please check the error message above.
pause
exit /b 1
