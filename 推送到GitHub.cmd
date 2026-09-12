@echo off
rem ============================================================
rem  Push local commits to GitHub, and record everything to a log.
rem
rem  Keep this file pure ASCII (the launcher .cmd explains why):
rem  cmd.exe reads .cmd files in the console code page, so UTF-8
rem  Chinese here would be mangled into stray commands.
rem
rem  Everything the push prints is written to tmp-push-log.txt
rem  (that name is already covered by .gitignore). If anything
rem  goes wrong, that file says exactly where.
rem ============================================================

cd /d "%~dp0"
set LOG=tmp-push-log.txt

echo   ============================================
echo      Push to GitHub
echo   ============================================
echo.
echo   Working log will be saved to: %LOG%
echo.

> "%LOG%" echo ==== push attempt ====
>> "%LOG%" echo.
>> "%LOG%" echo --- git version ---
>> "%LOG%" git --version 2>&1
>> "%LOG%" echo.
>> "%LOG%" echo --- remote ---
>> "%LOG%" git remote -v 2>&1
>> "%LOG%" echo.
>> "%LOG%" echo --- branch ---
>> "%LOG%" git branch --show-current 2>&1
>> "%LOG%" echo.
>> "%LOG%" echo --- unpushed commits ---
>> "%LOG%" git log --oneline 2>&1
>> "%LOG%" echo.
>> "%LOG%" echo --- push output (this is the important part) ---

where git >nul 2>nul
if errorlevel 1 goto NOGIT

echo   Signing in to GitHub may open a browser window.
echo   Please finish the sign-in there.
echo.

git push -u origin main >> "%LOG%" 2>&1
set PUSHCODE=%ERRORLEVEL%
>> "%LOG%" echo.
>> "%LOG%" echo --- push exit code: %PUSHCODE% ---
>> "%LOG%" echo.
>> "%LOG%" echo --- remote branches after push ---
>> "%LOG%" git ls-remote --heads origin 2>&1
>> "%LOG%" echo.
>> "%LOG%" echo --- tracking status after push ---
>> "%LOG%" git status -sb 2>&1

echo.
echo   ============================================
echo      Result
echo   ============================================
echo.
type "%LOG%"
echo.

if not "%PUSHCODE%"=="0" goto PUSHFAIL

echo   ============================================
echo      Done. Your code is on GitHub.
echo   ============================================
echo.
pause
exit /b 0

:NOGIT
>> "%LOG%" echo   [X] git not found on PATH.
echo   [X] git not found on PATH.
echo   Install Git for Windows from https://git-scm.com
echo.
pause
exit /b 1

:PUSHFAIL
echo   ============================================
echo      Push failed (exit code %PUSHCODE%)
echo   ============================================
echo.
echo   The log above says why. Common causes:
echo     - The GitHub sign-in window was closed
echo       (just run this file again)
echo     - Wrong repository owner or name
echo     - No network connection
echo     - You do not have permission to push
echo.
pause
exit /b 1
