@echo off
:: ═══════════════════════════════════════════════════════════════════════════
::  Atithi Setu — POS Shortcut Installer  (PowerShell wrapper)
:: ═══════════════════════════════════════════════════════════════════════════
::  Runs install-pos-shortcut.ps1 from the SAME folder as this .bat file,
::  bypassing the Windows execution-policy block that prevents unsigned
::  scripts from running.
::
::  USAGE — double-click, OR from a CMD/PowerShell window:
::
::    install-pos-shortcut.bat -Url "https://<restaurant>.atithi-setu.com/"
::
::  If no -Url argument is given the script will prompt or use its own
::  default (depends on what install-pos-shortcut.ps1 implements).
::
::  To use a specific restaurant URL without editing this file, run:
::    install-pos-shortcut.bat -Url "https://naini-corbett-restaurant.atithi-setu.com/"
:: ═══════════════════════════════════════════════════════════════════════════

title Atithi Setu -- POS Shortcut Installer

echo.
echo  ================================================================
echo    Atithi Setu  --  POS Shortcut Installer
echo  ================================================================
echo.

:: Locate the .ps1 in the same folder as this .bat
set "PS1=%~dp0install-pos-shortcut.ps1"

if not exist "%PS1%" (
    echo  [ERROR] Script not found: %PS1%
    echo.
    echo  Make sure install-pos-shortcut.ps1 is in the same folder
    echo  as this .bat file.
    echo.
    pause
    exit /b 1
)

echo  Running: %PS1%
echo  Arguments: %*
echo.

:: -ExecutionPolicy Bypass applies only to this single invocation.
:: It does NOT change the machine's global policy.
PowerShell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*

set EXIT_CODE=%errorlevel%

echo.
if %EXIT_CODE% equ 0 (
    echo  [  OK  ] Shortcut installed successfully.
) else (
    echo  [FAILED] Installer exited with code %EXIT_CODE%.
    echo           Check the output above for details.
)

echo.
pause
exit /b %EXIT_CODE%
