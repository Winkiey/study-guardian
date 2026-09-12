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

where node >nul 2>nul
if errorlevel 1 goto NONODE

node server.js
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
