@echo off
setlocal
call "%~dp0scripts\windows-env.cmd"
if errorlevel 1 goto failed
if not exist "node_modules\playwright\package.json" (
  echo 먼저 01-install.cmd를 실행하세요.
  goto failed
)
echo 아래에 표시되는 주소를 웨일 주소창에 입력하세요.
echo 사용하는 동안 이 창을 열어 두세요. 종료하려면 Ctrl+C를 누르세요.
node src/server.js
if errorlevel 1 goto failed
exit /b 0
:failed
echo.
echo 실행하지 못했습니다. 위 오류 메시지를 확인하세요.
pause
exit /b 1
