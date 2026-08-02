@echo off
setlocal EnableExtensions
REM ============================================================================
REM  run-tests.bat  —  Atithi-Setu technical test suite runner
REM
REM  Part of the definition of done: after adding ANY new feature, endpoint or
REM  role, run this and confirm 0 failures before shipping. The suite is
REM  self-cleaning (its test bookings/journals are cancelled or reversed).
REM
REM  Credentials come from environment variables; if OWNER_EMAIL / OWNER_PASSWORD
REM  are not already set you are prompted for them (password entry is hidden).
REM  Nothing is written to disk. Defaults: RESTAURANT_ID=RESTO-1003,
REM  BASE_URL=https://erp.atithi-setu.com. Pre-set any of these to override.
REM
REM  Usage:  double-click, or from a terminal:  run-tests.bat
REM ============================================================================

cd /d "%~dp0"

if not defined RESTAURANT_ID set "RESTAURANT_ID=RESTO-1003"
if not defined BASE_URL set "BASE_URL=https://erp.atithi-setu.com"

if not defined OWNER_EMAIL set /p "OWNER_EMAIL=Owner email or login ID: "

if not defined OWNER_PASSWORD (
  for /f "usebackq delims=" %%p in (`powershell -NoProfile -Command "$s=Read-Host 'Owner password' -AsSecureString; [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))"`) do set "OWNER_PASSWORD=%%p"
)

echo.
echo Running technical test suite against %BASE_URL% (tenant %RESTAURANT_ID%)...
echo.

node test-scripts\run_technical_tests.mjs
set "EXITCODE=%ERRORLEVEL%"

echo.
if "%EXITCODE%"=="0" (
  echo All executed tests passed.
) else (
  echo Test run reported failures ^(exit code %EXITCODE%^). See test-scripts\TEST_EXECUTION_REPORT.md
)

REM Do not leave the password lingering in this shell.
set "OWNER_PASSWORD="
endlocal & exit /b %EXITCODE%
