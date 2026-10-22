@echo off
chcp 65001 >nul
cd /d "%~dp0.."
if errorlevel 1 exit /b 1
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js 24 이상을 먼저 설치하세요: https://nodejs.org/
  echo 설치 후 이 창을 닫고 파일을 다시 실행하세요.
  exit /b 1
)
node -e "if (Number(process.versions.node.split('.')[0]) < 24) { console.error('Node.js 24 이상이 필요합니다.'); process.exit(1); }"
if errorlevel 1 exit /b 1
exit /b 0
