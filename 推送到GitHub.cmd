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
rem
rem  WHY THIS RETRIES
rem  ----------------
rem  github.com from mainland China is often reachable for a while
rem  and then not for a few minutes. A single attempt therefore
rem  fails at random, and the failure takes ~21 seconds of silence
rem  first (git waits for the TCP connect to time out). That silence
rem  looks exactly like "the window is doing nothing", which is how
rem  this looked to the person who runs it. So:
rem    * say up front that it may take a while,
rem    * try up to 3 times,
rem    * and do NOT run the follow-up `git ls-remote` when the push
rem      already failed -- that is a second 21-second wait that
rem      cannot tell us anything new.
rem ============================================================

cd /d "%~dp0"
set LOG=tmp-push-log.txt
set MAXTRY=3

echo   ============================================
echo      Push to GitHub
echo   ============================================
echo.
echo   This can take up to a minute per attempt:
echo   when GitHub is unreachable, git waits about
echo   20 seconds before giving up. Please be patient.
echo.
echo   Up to %MAXTRY% attempts will be made automatically.
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

set ATTEMPT=0

:TRYAGAIN
set /a ATTEMPT+=1
echo   --------------------------------------------
echo      Attempt %ATTEMPT% of %MAXTRY% ... working, please wait
echo   --------------------------------------------
echo.
>> "%LOG%" echo.
>> "%LOG%" echo --- attempt %ATTEMPT% ---

git push -u origin main >> "%LOG%" 2>&1
set PUSHCODE=%ERRORLEVEL%
>> "%LOG%" echo --- attempt %ATTEMPT% exit code: %PUSHCODE% ---

if "%PUSHCODE%"=="0" goto PUSHOK

echo   [X] Attempt %ATTEMPT% failed (exit code %PUSHCODE%).
echo.
if %ATTEMPT% GEQ %MAXTRY% goto PUSHFAIL

echo   Waiting 5 seconds, then trying again...
echo.
timeout /t 5 /nobreak >nul
goto TRYAGAIN

:PUSHOK
>> "%LOG%" echo.
>> "%LOG%" echo --- remote branches after push ---
>> "%LOG%" git ls-remote --heads origin 2>&1
>> "%LOG%" echo.
>> "%LOG%" echo --- tracking status after push ---
>> "%LOG%" git status -sb 2>&1

echo.
echo   ============================================
echo      Done. Your code is on GitHub.
echo   ============================================
echo.
type "%LOG%"
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
>> "%LOG%" echo.
>> "%LOG%" echo --- all %MAXTRY% attempts failed ---
>> "%LOG%" echo.
>> "%LOG%" git status -sb 2>&1

echo   ============================================
echo      Push failed after %MAXTRY% attempts (exit code %PUSHCODE%)
echo   ============================================
echo.
echo   The log below says why. Common causes:
echo     - github.com was unreachable from this network
echo       (very common in mainland China, and usually
echo        temporary -- just run this file again later)
echo     - The GitHub sign-in window was closed
echo     - Wrong repository owner or name
echo     - No network connection at all
echo     - You do not have permission to push
echo.
echo   If it keeps failing, the log's "push output" section
echo   is the line that matters.
echo.
type "%LOG%"
echo.
pause
exit /b 1
