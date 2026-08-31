@echo off
setlocal EnableExtensions
title Atithi-Setu Print Agent - Setup
cd /d "%~dp0"

echo(
echo  ============================================================
echo    Atithi-Setu  -  Thermal Print Agent  Setup
echo  ============================================================
echo(
echo  This sets up automatic KOT (kitchen) + bill printing on THIS PC.
echo  First add your printers in the app:
echo     Restaurant  ^>  Kitchen Printers
echo  and copy the "Print agent token" shown there.
echo(

rem ---- read the EXISTING .env so a re-run KEEPS the current settings ----
rem  Press Enter at each prompt to keep the saved value; type only to change it.
set "CUR_BASE_URL="
set "CUR_RESTAURANT_ID="
set "CUR_AGENT_TOKEN="
set "CUR_POLL_MS="
if exist "%~dp0.env" (
  for /f "usebackq tokens=1,* delims==" %%A in ("%~dp0.env") do (
    if /I "%%A"=="BASE_URL"      set "CUR_BASE_URL=%%B"
    if /I "%%A"=="RESTAURANT_ID" set "CUR_RESTAURANT_ID=%%B"
    if /I "%%A"=="AGENT_TOKEN"   set "CUR_AGENT_TOKEN=%%B"
    if /I "%%A"=="POLL_MS"       set "CUR_POLL_MS=%%B"
  )
)
if not defined CUR_BASE_URL set "CUR_BASE_URL=https://erp.atithi-setu.com"
if not defined CUR_POLL_MS  set "CUR_POLL_MS=3000"

set "BASE_URL=%CUR_BASE_URL%"
set /p BASE_URL=  Server URL [%CUR_BASE_URL%]:

:ask_rid
set "RESTAURANT_ID=%CUR_RESTAURANT_ID%"
if defined CUR_RESTAURANT_ID goto rid_have
set /p RESTAURANT_ID=  Restaurant ID (e.g. RESTO-1003):
goto rid_check
:rid_have
set /p RESTAURANT_ID=  Restaurant ID [%CUR_RESTAURANT_ID%]:
:rid_check
if "%RESTAURANT_ID%"=="" ( echo   ^> Restaurant ID is required. & goto ask_rid )

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

> ".env" echo # Atithi-Setu Print Agent - written by Setup.bat
>>".env" echo BASE_URL=%BASE_URL%
>>".env" echo RESTAURANT_ID=%RESTAURANT_ID%
>>".env" echo AGENT_TOKEN=%AGENT_TOKEN%
>>".env" echo POLL_MS=%CUR_POLL_MS%

echo(
echo  Saved settings to .env
echo(

set "EXE=%~dp0AtithiSetuPrintAgent.exe"
if not exist "%EXE%" (
  echo  WARNING: AtithiSetuPrintAgent.exe not found next to this file.
  echo  Put Setup.bat in the SAME folder as the .exe and run again.
  echo(
  pause
  exit /b 1
)

echo  Installing the agent to start automatically when you log in...
schtasks /Create /TN "AtithiSetuPrintAgent" /TR "wscript.exe \"%~dp0run-hidden.vbs\"" /SC ONLOGON /RL LIMITED /F >nul 2>&1
if errorlevel 1 (
  echo  Could not register the startup task (need to run as your normal user).
) else (
  echo  Startup task installed.
)

echo  Starting the print agent now...
start "" wscript.exe "%~dp0run-hidden.vbs"

echo(
echo  ============================================================
echo    Done. The agent is running in the background.
echo    - Kitchen tickets print automatically when orders arrive.
echo    - Press "Print Bill" in the app to print a customer bill.
echo    It will start again by itself every time you log in.
echo(
echo    To stop / remove it, run  Uninstall.bat
echo  ============================================================
echo(
pause
endlocal
