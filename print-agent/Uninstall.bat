@echo off
setlocal EnableExtensions
title Atithi-Setu Print Agent - Uninstall
echo(
echo  Stopping and removing the Atithi-Setu print agent...
schtasks /Delete /TN "AtithiSetuPrintAgent" /F >nul 2>&1
taskkill /IM AtithiSetuPrintAgent.exe /F >nul 2>&1
echo  Done. The agent will no longer start at logon.
echo  (Your printers stay configured in the app.)
echo(
pause
endlocal
