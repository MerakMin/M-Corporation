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
echo.
echo Stop the application server with Ctrl+C before logging in.
echo You can keep Whale open. Login is saved in a separate browser.
echo.
echo 1. Fashionplus
echo 2. Coupang
echo 3. Cafe24
echo 4. Hiver
echo 5. Ably
echo 6. Lookpin
echo 7. Naver Beyondmyself
echo 8. Naver Quarter
echo 9. Naver Pay Center
echo Q. Quit
choice /c 123456789Q /n /m "Choose a site number: "
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
echo Run this file again to log in to another site.
echo Run 02-start.cmd to restart the application.
pause
exit /b 0
:failed
echo.
echo Login did not finish. Please check the error message above.
pause
exit /b 1
