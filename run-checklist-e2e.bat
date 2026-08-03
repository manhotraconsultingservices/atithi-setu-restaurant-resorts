@echo off
setlocal EnableExtensions
REM ============================================================================
REM  run-checklist-e2e.bat  —  Checklist trigger end-to-end walk-through
REM
REM  Walks a hotel-room booking AND an event-hall booking through their whole
REM  lifecycle on a LIVE tenant and prints, step by step, which checklist fires:
REM    ROOM:  create -> check-in -> daily cron -> check-out -> release
REM    HALL:  daily -> status board -> complete event -> gate next event -> release
REM
REM  Self-cleaning: it cancels/checks-out its throwaway bookings, closes the jobs
REM  it raises, deletes its templates, and restores any owner setting it toggled.
REM
REM  Credentials come from environment variables; if OWNER_EMAIL / OWNER_PASSWORD
REM  are not already set you are prompted for them (password entry is hidden).
REM  Nothing is written to disk. Defaults: RESTAURANT_ID=RESTO-1003,
REM  BASE_URL=https://erp.atithi-setu.com. Pre-set any of these to override.
REM
REM  Usage:  double-click, or from a terminal:  run-checklist-e2e.bat
REM ============================================================================

cd /d "%~dp0"

if not defined RESTAURANT_ID set "RESTAURANT_ID=RESTO-1003"
if not defined BASE_URL set "BASE_URL=https://erp.atithi-setu.com"

if not defined OWNER_EMAIL set /p "OWNER_EMAIL=Owner email or login ID: "

if not defined OWNER_PASSWORD (
  for /f "usebackq delims=" %%p in (`powershell -NoProfile -Command "$s=Read-Host 'Owner password' -AsSecureString; [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))"`) do set "OWNER_PASSWORD=%%p"
)

echo.
echo Running checklist trigger e2e against %BASE_URL% (tenant %RESTAURANT_ID%)...
echo.

node test-scripts\e2e_checklists.mjs
set "EXITCODE=%ERRORLEVEL%"

echo.
if "%EXITCODE%"=="0" (
  echo All executed checklist e2e checks passed.
) else (
  echo Checklist e2e reported failures ^(exit code %EXITCODE%^).
)

REM Do not leave the password lingering in this shell.
set "OWNER_PASSWORD="
endlocal ^& exit /b %EXITCODE%
