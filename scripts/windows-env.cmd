@echo off
chcp 65001 >nul
cd /d "%~dp0.."
if errorlevel 1 exit /b 1
if not exist "package.json" (
  echo Extract the entire ZIP first. The application package.json file is missing.
  exit /b 1
)
where node >nul 2>&1
if errorlevel 1 (
  echo Install Node.js 24 or newer first: https://nodejs.org/
  echo After installation, close this window and run the file again.
  exit /b 1
)
node -e "if (Number(process.versions.node.split('.')[0]) < 24) { console.error('Node.js 24 or newer is required.'); process.exit(1); }"
if errorlevel 1 exit /b 1
where npm >nul 2>&1
if errorlevel 1 (
  echo npm was not found. Reinstall Node.js with the default options.
  exit /b 1
)
exit /b 0
