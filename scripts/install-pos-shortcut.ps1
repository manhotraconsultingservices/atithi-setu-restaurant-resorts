<#
.SYNOPSIS
    Sets up the Atithi Setu POS in silent-print kiosk mode on a Windows machine.

.DESCRIPTION
    Creates a desktop shortcut that launches Chrome (or Edge) with the
    --kiosk-printing flag pointed at the restaurant's tenant URL. When the
    user clicks Print inside the POS, the browser sends the receipt straight
    to the Windows default printer (thermal printer) with no print dialog -
    matching the Petpooja / Posist silent-print experience.

    Optional switches can also:
      * add the shortcut to Startup so the POS opens on boot
      * disable Windows' "Let me manage my default printer" auto-flip

    Does NOT require admin rights. Does NOT install anything outside the
    user's profile.

.PARAMETER Url
    Full tenant URL, including any query string. Examples:
      https://dev-erp.atithi-setu.com/?tenant=rishu-kitchen
      http://localhost:5001/?tenant=viveks-kitchen

.PARAMETER ShortcutName
    Name of the desktop shortcut. Default: "Atithi Setu POS".

.PARAMETER AddToStartup
    If specified, also creates a copy of the shortcut in the Startup folder
    so the POS auto-launches when Windows boots.

.PARAMETER FixDefaultPrinter
    If specified, disables "Let Windows manage my default printer" so
    Windows stops flipping the default to whatever was last used.

.EXAMPLE
    .\install-pos-shortcut.ps1 -Url "https://dev-erp.atithi-setu.com/?tenant=rishu-kitchen"

.EXAMPLE
    .\install-pos-shortcut.ps1 -Url "https://demo.atithi-setu.com" -AddToStartup -FixDefaultPrinter
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, HelpMessage = "Tenant URL")]
    [ValidatePattern('^https?://')]
    [string]$Url,

    [string]$ShortcutName = "Atithi Setu POS",

    [switch]$AddToStartup,

    [switch]$FixDefaultPrinter
)

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  Atithi Setu POS - Kiosk Print Setup" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""

# ---1. Locate Chrome or Edge ----------------------------------------------
$browserCandidates = @(
    @{ Name = "Google Chrome"; Path = "${env:ProgramFiles}\Google\Chrome\Application\chrome.exe" },
    @{ Name = "Google Chrome"; Path = "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe" },
    @{ Name = "Google Chrome"; Path = "${env:LOCALAPPDATA}\Google\Chrome\Application\chrome.exe" },
    @{ Name = "Microsoft Edge"; Path = "${env:ProgramFiles}\Microsoft\Edge\Application\msedge.exe" },
    @{ Name = "Microsoft Edge"; Path = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe" }
)

$browser = $browserCandidates | Where-Object { Test-Path $_.Path } | Select-Object -First 1

if ($null -eq $browser) {
    Write-Host "  [X] No supported browser found." -ForegroundColor Red
    Write-Host ""
    Write-Host "  Please install Google Chrome from https://www.google.com/chrome/" -ForegroundColor Yellow
    Write-Host "  then run this script again."
    exit 1
}

Write-Host "  [OK] Browser detected:" -ForegroundColor Green
Write-Host "       $($browser.Name)"
Write-Host "       $($browser.Path)"
Write-Host ""

# ---2. Prepare isolated user-data profile ---------------------------------
# Keeps the kiosk session separate from the user's personal Chrome profile so
# extensions, bookmarks, and cached logins don't interfere.
$userDataDir = Join-Path $env:LOCALAPPDATA "AtithiSetuPOS"
if (-not (Test-Path $userDataDir)) {
    New-Item -ItemType Directory -Path $userDataDir -Force | Out-Null
    Write-Host "  [OK] Created isolated browser profile:" -ForegroundColor Green
} else {
    Write-Host "  [OK] Re-using existing browser profile:" -ForegroundColor Green
}
Write-Host "       $userDataDir"
Write-Host ""

# ---3. Create the desktop shortcut ----------------------------------------
$arguments = '--kiosk-printing --user-data-dir="{0}" --app="{1}"' -f $userDataDir, $Url
$desktopPath = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktopPath "$ShortcutName.lnk"

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath       = $browser.Path
$shortcut.Arguments        = $arguments
$shortcut.Description      = "Atithi Setu POS (silent-print kiosk mode)"
$shortcut.WorkingDirectory = Split-Path $browser.Path -Parent
$shortcut.IconLocation     = "$($browser.Path),0"
$shortcut.WindowStyle      = 1   # Normal window
$shortcut.Save()

# Release COM handles so subsequent runs don't error out
[Runtime.InteropServices.Marshal]::ReleaseComObject($shortcut) | Out-Null
[Runtime.InteropServices.Marshal]::ReleaseComObject($shell) | Out-Null

Write-Host "  [OK] Desktop shortcut created:" -ForegroundColor Green
Write-Host "       $shortcutPath"
Write-Host ""

# ---4. Optional: auto-launch on Windows boot ------------------------------
if ($AddToStartup) {
    $startupPath = [Environment]::GetFolderPath("Startup")
    $startupShortcut = Join-Path $startupPath "$ShortcutName.lnk"
    Copy-Item -Path $shortcutPath -Destination $startupShortcut -Force
    Write-Host "  [OK] Auto-start enabled (runs at Windows login):" -ForegroundColor Green
    Write-Host "       $startupShortcut"
    Write-Host ""
}

# ---5. Optional: fix "Let Windows manage default printer" -----------------
if ($FixDefaultPrinter) {
    try {
        $regPath = "HKCU:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Windows"
        if (-not (Test-Path $regPath)) {
            New-Item -Path $regPath -Force | Out-Null
        }
        # 1 = legacy mode (user sets default and Windows leaves it alone).
        Set-ItemProperty -Path $regPath -Name "LegacyDefaultPrinterMode" -Value 1 -Type DWord
        Write-Host "  [OK] Disabled 'Let Windows manage my default printer'." -ForegroundColor Green
        Write-Host "       Windows will no longer flip the default printer on you."
        Write-Host ""
    } catch {
        Write-Host "  [!] Could not update default-printer registry setting:" -ForegroundColor Yellow
        Write-Host "      $_"
        Write-Host "      You can toggle it manually in Settings -> Printers & scanners."
        Write-Host ""
    }
}

# ---6. Summary + next steps -----------------------------------------------
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  Setup complete!" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Next steps to finish configuration:" -ForegroundColor White
Write-Host ""
Write-Host "  1. Open Settings -> Bluetooth & devices -> Printers & scanners"
Write-Host "     Select your thermal printer -> 'Set as default'."
if (-not $FixDefaultPrinter) {
    Write-Host "     Uncheck 'Let Windows manage my default printer' at the top."
}
Write-Host ""
Write-Host "  2. Confirm the printer's paper size is 80mm roll (or 58mm,"
Write-Host "     whichever matches your printer)."
Write-Host ""
Write-Host "  3. Double-click '$ShortcutName' on your desktop to launch the POS."
Write-Host ""
Write-Host "  4. Log in, open any invoice, click Print - the receipt should"
Write-Host "     print instantly with NO dialog box." -ForegroundColor Green
Write-Host ""
Write-Host "  Note: When you click Print, the browser will not show a print"
Write-Host "  dialog. This is expected and intentional. If nothing prints,"
Write-Host "  check that the thermal printer is powered on, has paper, and"
Write-Host "  is set as the Windows default printer (step 1 above)."
Write-Host ""
