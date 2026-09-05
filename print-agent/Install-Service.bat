@echo off
setlocal EnableExtensions
title Atithi-Setu Print Agent - Install as Windows Service

rem ---- self-elevate: installing a Windows service needs administrator ----
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Requesting administrator rights...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

cd /d "%~dp0"
set "DIR=%~dp0"
if "%DIR:~-1%"=="\" set "DIR=%DIR:~0,-1%"
set "EXE=%DIR%\AtithiSetuPrintAgent.exe"
set "NSSM=%DIR%\nssm.exe"
set "SVC=AtithiSetuPrintAgent"

if not exist "%EXE%"  ( echo ERROR: AtithiSetuPrintAgent.exe not found next to this file. & pause & exit /b 1 )
if not exist "%NSSM%" ( echo ERROR: nssm.exe not found next to this file.               & pause & exit /b 1 )

echo(
echo  ============================================================
echo    Atithi-Setu Print Agent  -  Install as Windows Service
echo  ============================================================
echo  First add your printers in the app:  Restaurant ^> Kitchen Printers
echo  and copy the "Print agent token" shown there.
echo(

rem ---- read the EXISTING .env so a re-run KEEPS the current settings ----
rem  On a re-install just press Enter at each prompt to keep the saved value;
rem  type something only to CHANGE it. This is what makes "your .env is
rem  preserved" actually true when you re-run this installer (an earlier build
rem  blanked these and forced re-entry, which knocked printers offline if the
rem  token was retyped wrong).
set "CUR_BASE_URL="
set "CUR_RESTAURANT_ID="
set "CUR_AGENT_TOKEN="
set "CUR_POLL_MS="
if exist "%DIR%\.env" (
  for /f "usebackq tokens=1,* delims==" %%A in ("%DIR%\.env") do (
    if /I "%%A"=="BASE_URL"      set "CUR_BASE_URL=%%B"
    if /I "%%A"=="RESTAURANT_ID" set "CUR_RESTAURANT_ID=%%B"
    if /I "%%A"=="AGENT_TOKEN"   set "CUR_AGENT_TOKEN=%%B"
    if /I "%%A"=="POLL_MS"       set "CUR_POLL_MS=%%B"
  )
)
if not defined CUR_BASE_URL set "CUR_BASE_URL=https://erp.atithi-setu.com"
if not defined CUR_POLL_MS  set "CUR_POLL_MS=800"

rem ---- Server URL (Enter = keep the shown value) ----
set "BASE_URL=%CUR_BASE_URL%"
set /p BASE_URL=  Server URL [%CUR_BASE_URL%]:

rem ---- Restaurant ID (required; Enter keeps current when one is saved) ----
:ask_rid
set "RESTAURANT_ID=%CUR_RESTAURANT_ID%"
if defined CUR_RESTAURANT_ID goto rid_have
set /p RESTAURANT_ID=  Restaurant ID (e.g. RESTO-1003):
goto rid_check
:rid_have
set /p RESTAURANT_ID=  Restaurant ID [%CUR_RESTAURANT_ID%]:
:rid_check
if "%RESTAURANT_ID%"=="" ( echo   ^> Restaurant ID is required. & goto ask_rid )

rem ---- Print agent token (required; Enter keeps current when one is saved) ----
if defined CUR_AGENT_TOKEN ( set "TOKMASK=%CUR_AGENT_TOKEN:~0,8%..." ) else ( set "TOKMASK=" )
:ask_tok
set "AGENT_TOKEN=%CUR_AGENT_TOKEN%"
if defined CUR_AGENT_TOKEN goto tok_have
set /p AGENT_TOKEN=  Print agent token (pat_...):
goto tok_check
:tok_have
set /p AGENT_TOKEN=  Print agent token [keep current %TOKMASK%]:
:tok_check
if "%AGENT_TOKEN%"=="" ( echo   ^> Token is required. & goto ask_tok )

> "%DIR%\.env" echo BASE_URL=%BASE_URL%
>>"%DIR%\.env" echo RESTAURANT_ID=%RESTAURANT_ID%
>>"%DIR%\.env" echo AGENT_TOKEN=%AGENT_TOKEN%
>>"%DIR%\.env" echo POLL_MS=%CUR_POLL_MS%
echo(
echo  Saved settings to .env
echo  Installing the Windows service...

rem ---- (re)install cleanly ----
"%NSSM%" stop   %SVC%          >nul 2>&1
"%NSSM%" remove %SVC% confirm  >nul 2>&1
"%NSSM%" install %SVC% "%EXE%"                                             >nul
"%NSSM%" set %SVC% AppDirectory "%DIR%"                                    >nul
"%NSSM%" set %SVC% DisplayName "Atithi-Setu Print Agent"                   >nul
"%NSSM%" set %SVC% Description "Prints kitchen tickets (KOT) and customer bills for Atithi-Setu." >nul
"%NSSM%" set %SVC% Start SERVICE_AUTO_START                               >nul
"%NSSM%" set %SVC% AppStdout "%DIR%\agent.log"                             >nul
"%NSSM%" set %SVC% AppStderr "%DIR%\agent.log"                             >nul
"%NSSM%" set %SVC% AppRotateFiles 1                                        >nul
"%NSSM%" set %SVC% AppRotateBytes 1048576                                  >nul
"%NSSM%" set %SVC% AppExit Default Restart                                 >nul
"%NSSM%" set %SVC% AppRestartDelay 3000                                    >nul
"%NSSM%" start %SVC%                                                        >nul 2>&1

rem ---- report ----
sc query %SVC% | find "RUNNING" >nul 2>&1
if %errorlevel%==0 ( set "STATE=RUNNING" ) else ( set "STATE=NOT running - check %DIR%\agent.log" )

echo(
echo  ============================================================
echo    Service installed.  Status: %STATE%
echo    - Starts automatically at every boot (before anyone logs in).
echo    - Restarts itself if it ever stops.
echo    - Log file:  %DIR%\agent.log
echo(
echo    Now test:  place an order (kitchen ticket prints) and press
echo    "Print Bill" on a table (invoice prints).
echo(
echo    To remove it later:  run  Uninstall-Service.bat
echo  ============================================================
echo(
pause
endlocal
