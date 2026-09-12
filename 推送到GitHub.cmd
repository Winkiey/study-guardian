@echo off
rem ============================================================
rem  Push local commits to GitHub.
rem
rem  Keep this file pure ASCII (see 启动学习守护.cmd for why):
rem  cmd.exe reads .cmd files in the console code page, so UTF-8
rem  Chinese here would be mangled into stray commands.
rem
rem  The FIRST run opens a browser window asking you to sign in
rem  to GitHub. After that the credential is remembered by
rem  Windows and later runs just work.
rem ============================================================

cd /d "%~dp0"

echo.
echo   ============================================
echo      Push to GitHub
echo   ============================================
echo.

where git >nul 2>nul
if errorlevel 1 goto NOGIT

echo   Uploading local commits to:
git remote get-url origin
echo.
echo   (First time you will be asked to sign in to GitHub
echo    in a browser window. That is expected.)
echo.

git push -u origin main
if errorlevel 1 goto PUSHFAIL

echo.
echo   ============================================
echo      Done. Your code is on GitHub.
echo   ============================================
echo.
pause
exit /b 0

:NOGIT
echo   [X] git not found.
echo   Install Git for Windows from https://git-scm.com
echo.
pause
exit /b 1

:PUSHFAIL
echo.
echo   ============================================
echo      Push failed.
echo   ============================================
echo.
echo   Common causes:
echo     - You closed the GitHub sign-in window
echo       (just run this file again)
echo     - The repository name or owner is wrong
echo     - No network connection
echo.
pause
exit /b 1
