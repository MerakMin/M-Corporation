@echo off
setlocal
call "%~dp0scripts\windows-env.cmd"
if errorlevel 1 goto failed
echo 프로그램과 전용 브라우저를 설치합니다. 처음 한 번 실행하세요.
call npm ci
if errorlevel 1 goto failed
call npx --no-install playwright install chromium
if errorlevel 1 goto failed
echo.
echo 설치가 끝났습니다. 02-start.cmd로 프로그램을 실행하세요.
pause
exit /b 0
:failed
echo.
echo 설치를 완료하지 못했습니다. 위 오류 메시지를 확인하세요.
pause
exit /b 1
