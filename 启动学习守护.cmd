@echo off
rem ============================================================
rem  Study Guardian - local launcher
rem
rem  IMPORTANT: keep this file pure ASCII.
rem  cmd.exe reads .cmd files using the console code page (GBK on
rem  a Chinese Windows), NOT UTF-8. Chinese text written here as
rem  UTF-8 gets mangled and cmd ends up trying to run the garbage
rem  as commands ("'...' is not recognized as an internal or
rem  external command").
rem
rem  So: every message the user sees comes from server.js instead,
rem  which prints UTF-8 Chinese correctly (version too low / port
rem  already in use / the startup banner).
rem ============================================================

cd /d "%~dp0"

rem ------------------------------------------------------------
rem  Ask before starting. Typing Y is deliberate, so a stray
rem  double-click cannot get past this -- which matters, because
rem  a second copy of this project is NOT harmless:
rem
rem    every copy has its own data/app.db AND its own reminder
rem    scheduler, so the same homework deadline gets pushed to
rem    your phone twice, and the two copies drift apart (the one
rem    you are looking at may not be the one sending).
rem
rem  That is the normal situation once the project runs on a
rem  server: this window is then not needed at all.
rem ------------------------------------------------------------
echo.
echo   ==================================================
echo      Start Study Guardian on THIS computer?
echo   ==================================================
echo.
echo   This opens a web page server in this window.
echo   Closing the window stops it.
echo.
echo   [!] Skip this if the project already runs somewhere
echo       else (a cloud server, or another computer).
echo.
echo   Start it?  (Y = yes / anything else = cancel)
set "ANSWER="
set /p "ANSWER=  > "
if /i not "%ANSWER%"=="Y" goto CANCELLED

where node >nul 2>nul
if errorlevel 1 goto NONODE

node server.js
echo.
pause
exit /b 0

:CANCELLED
echo.
echo   Cancelled - nothing was started.
echo   This window can be closed.
echo.
pause
exit /b 0

:NONODE
echo.
echo   [X] Node.js not found.
echo.
echo   This app needs Node.js 22.5 or newer.
echo   Download the LTS version from https://nodejs.org
echo   Then close this window and double-click this file again.
echo.
pause
exit /b 1
