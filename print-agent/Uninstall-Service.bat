@echo off
setlocal EnableExtensions
title Atithi-Setu Print Agent - Uninstall Service

rem ---- self-elevate: removing a service needs administrator ----
net session >nul 2>&1
if %errorlevel% neq 0 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

set "NSSM=%~dp0nssm.exe"
set "SVC=AtithiSetuPrintAgent"

echo(
echo  Stopping and removing the Atithi-Setu print service...
"%NSSM%" stop   %SVC%         2>nul
"%NSSM%" remove %SVC% confirm 2>nul
echo  Done. The service is removed. (Your printers stay configured in the app.)
echo(
pause
endlocal
