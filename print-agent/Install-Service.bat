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

set "BASE_URL=https://erp.atithi-setu.com"
set /p BASE_URL=  Server URL [%BASE_URL%]:
:ask_rid
set "RESTAURANT_ID="
set /p RESTAURANT_ID=  Restaurant ID (e.g. RESTO-1003):
if "%RESTAURANT_ID%"=="" ( echo   ^> Restaurant ID is required. & goto ask_rid )
:ask_tok
set "AGENT_TOKEN="
set /p AGENT_TOKEN=  Print agent token (pat_...):
if "%AGENT_TOKEN%"=="" ( echo   ^> Token is required. & goto ask_tok )

> "%DIR%\.env" echo BASE_URL=%BASE_URL%
>>"%DIR%\.env" echo RESTAURANT_ID=%RESTAURANT_ID%
>>"%DIR%\.env" echo AGENT_TOKEN=%AGENT_TOKEN%
>>"%DIR%\.env" echo POLL_MS=3000
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
