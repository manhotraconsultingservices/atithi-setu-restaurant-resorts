@echo off
setlocal EnableExtensions
REM ============================================================================
REM  run-access-audit.bat  —  ONE-SHOT access / RBAC validation
REM
REM  Run this BEFORE any client demo. It validates the whole access-control
REM  stack in one command and prints a single verdict:
REM    1. Nav visibility (headless)  — the EXACT tabs each role sees, incl. the
REM       derived/cross-permission leaks a pure API check can't catch (the class
REM       clients keep reporting, e.g. Events "Cleaning Checklist").
REM    2. RBAC isolation (server)    — staff can't reach modules they weren't
REM       granted; /my-permissions returns EXACTLY the granted tabs.
REM    3. (--full) Manager grants + Senior-review sweeps — every "granted role
REM       can do its job" check across all 11 historical bug areas.
REM
REM  Everything is self-cleaning (test roles/staff are deleted afterwards).
REM  Credentials come from env vars; if OWNER_EMAIL / OWNER_PASSWORD are not set
REM  you are prompted (password entry hidden). Nothing is written to disk.
REM  Defaults: RESTAURANT_ID=RESTO-1003, BASE_URL=https://erp.atithi-setu.com.
REM
REM  Usage:
REM    run-access-audit.bat                    (nav + isolation, default tenant)
REM    run-access-audit.bat --tenant=RESTO-1003
REM    run-access-audit.bat --full             (also manager + review sweeps)
REM    run-access-audit.bat --quick            (nav visibility only, no server)
REM ============================================================================

cd /d "%~dp0"

if not defined RESTAURANT_ID set "RESTAURANT_ID=RESTO-1003"
if not defined BASE_URL set "BASE_URL=https://erp.atithi-setu.com"

REM --quick needs no server/creds; skip the prompts in that case.
echo %* | find /i "--quick" >nul
if errorlevel 1 (
  if not defined OWNER_EMAIL set /p "OWNER_EMAIL=Owner email or login ID: "
  if not defined OWNER_PASSWORD (
    for /f "usebackq delims=" %%p in (`powershell -NoProfile -Command "$s=Read-Host 'Owner password' -AsSecureString; [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))"`) do set "OWNER_PASSWORD=%%p"
  )
)

node test-scripts\access_audit.mjs %*
set "EXITCODE=%ERRORLEVEL%"

REM Do not leave the password lingering in this shell.
set "OWNER_PASSWORD="
endlocal & exit /b %EXITCODE%
