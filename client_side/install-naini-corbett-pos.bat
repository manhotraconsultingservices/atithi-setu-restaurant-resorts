@echo off
:: ═══════════════════════════════════════════════════════════════════════════
::  Atithi Setu — POS Shortcut Installer for Naini Corbett Restaurant
:: ═══════════════════════════════════════════════════════════════════════════
::  One-click installer. Double-click this file — no arguments needed.
::  Creates a desktop shortcut that opens the Naini Corbett POS in the browser.
::
::  What it does:
::    Runs install-pos-shortcut.ps1 (must be in the same folder) with
::    -ExecutionPolicy Bypass so unsigned scripts are allowed on this PC.
::
::  Requirements:
::    - install-pos-shortcut.ps1  (must be in the same folder as this .bat)
::    - Windows 7 or later with PowerShell 3+
::    - Internet connection (optional — shortcut just opens a URL)
:: ═══════════════════════════════════════════════════════════════════════════

title Atithi Setu -- Naini Corbett POS Installer

echo.
echo  ================================================================
echo    Atithi Setu  --  Naini Corbett Restaurant
echo    POS Shortcut Installer
echo  ================================================================
echo.
echo  This will create a desktop shortcut to the Naini Corbett
echo  Restaurant POS system.
echo.
echo  URL: https://naini-corbett-restaurant.atithi-setu.com/
echo.

:: Locate the .ps1 in the same folder as this .bat
set "PS1=%~dp0install-pos-shortcut.ps1"

if not exist "%PS1%" (
    echo  [ERROR] Script not found:
    echo    %PS1%
    echo.
    echo  Please make sure both files are in the same folder:
    echo    install-pos-shortcut.ps1
    echo    install-naini-corbett-pos.bat
    echo.
    pause
    exit /b 1
)

echo  Starting installation ...
echo.

PowerShell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -Url "https://naini-corbett-restaurant.atithi-setu.com/"

set EXIT_CODE=%errorlevel%

echo.
if %EXIT_CODE% equ 0 (
    echo  ================================================================
    echo   SUCCESS!  Shortcut has been installed on the Desktop.
    echo  ================================================================
    echo.
    echo  You can now open the POS by double-clicking the
    echo  "Naini Corbett Restaurant" shortcut on your Desktop.
    echo.
) else (
    echo  ================================================================
    echo   INSTALLATION FAILED  (exit code: %EXIT_CODE%^)
    echo  ================================================================
    echo.
    echo  Please share this window with your Atithi Setu support contact.
    echo.
)

pause
exit /b %EXIT_CODE%
