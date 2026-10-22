@echo off
setlocal
call "%~dp0scripts\windows-env.cmd"
if errorlevel 1 goto failed
if not exist "node_modules\playwright\package.json" (
  echo 먼저 01-install.cmd를 실행하세요.
  goto failed
)
echo.
echo 먼저 프로그램 실행 창에서 Ctrl+C를 눌러 서버를 종료하세요.
echo 웨일은 그대로 두어도 됩니다. 로그인은 별도 브라우저에 저장됩니다.
echo.
echo 1. 패션플러스
echo 2. 쿠팡
echo 3. 카페24 자사몰
echo 4. 하이버
echo 5. 에이블리
echo 6. 룩핀
echo 7. 네이버 비욘드
echo 8. 네이버 쿼터
echo 9. 네이버 페이센터
echo Q. 종료
choice /c 123456789Q /n /m "로그인할 사이트 번호를 누르세요: "
set "selection=%errorlevel%"
set "channel="
if "%selection%"=="10" exit /b 0
if "%selection%"=="1" set "channel=fashionplus"
if "%selection%"=="2" set "channel=coupang"
if "%selection%"=="3" set "channel=cafe24"
if "%selection%"=="4" set "channel=hiver"
if "%selection%"=="5" set "channel=ably"
if "%selection%"=="6" set "channel=lookpin"
if "%selection%"=="7" set "channel=smartstore"
if "%selection%"=="8" set "channel=smartstore_quarter"
if "%selection%"=="9" set "channel=naverpay"
if not defined channel goto failed
node scripts/login.js %channel%
if errorlevel 1 goto failed
echo.
echo 다른 사이트 로그인은 이 파일을 다시 실행하세요.
echo 프로그램을 다시 실행하려면 02-start.cmd를 여세요.
pause
exit /b 0
:failed
echo.
echo 로그인을 완료하지 못했습니다. 위 오류 메시지를 확인하세요.
pause
exit /b 1
