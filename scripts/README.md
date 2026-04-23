# POS Kiosk Setup

Installer scripts for Atithi Setu client machines.

## `install-pos-shortcut.ps1`

Sets up **silent thermal-printer printing** on a Windows POS machine by launching the Atithi Setu POS in a dedicated Chrome window with the `--kiosk-printing` flag. When configured, clicking **Print** inside the POS sends the receipt straight to the default printer with **no print dialog** — matching how Petpooja, Posist, and other leading restaurant POS apps behave.

### What it does

1. Detects Chrome (or Edge as fallback)
2. Creates an isolated browser profile at `%LOCALAPPDATA%\AtithiSetuPOS` (doesn't interfere with the user's personal Chrome)
3. Puts a desktop shortcut that launches Chrome with:
   - `--kiosk-printing` — silent print to default printer
   - `--app=<url>` — standalone window, no tabs or URL bar
   - `--user-data-dir=...` — isolated profile
4. Optionally adds the shortcut to Startup (auto-launch on login)
5. Optionally disables "Let Windows manage my default printer" (stops Windows flipping the default)

**Does not require admin rights. Does not install any software. Can be re-run safely.**

### Usage (on the client's POS machine)

Open **PowerShell** (any regular, non-admin window) and run:

```powershell
# Basic — just create the desktop shortcut
.\install-pos-shortcut.ps1 -Url "https://dev-erp.atithi-setu.com/?tenant=rishu-kitchen"

# Also auto-launch at Windows boot + lock the default printer setting
.\install-pos-shortcut.ps1 `
    -Url "https://dev-erp.atithi-setu.com/?tenant=rishu-kitchen" `
    -AddToStartup `
    -FixDefaultPrinter
```

If PowerShell refuses to run the script with an execution-policy error, bypass it just for this one run:

```powershell
powershell -ExecutionPolicy Bypass -File .\install-pos-shortcut.ps1 -Url "https://..."
```

### After running the script — one manual step

Open **Settings → Bluetooth & devices → Printers & scanners**, select the thermal printer, and click **Set as default**.

Then double-click **Atithi Setu POS** on the desktop — invoices now print silently.

### Parameters

| Parameter | Required | Description |
|---|---|---|
| `-Url` | Yes | Tenant URL, including any `?tenant=` query string |
| `-ShortcutName` | No | Shortcut label (default: `"Atithi Setu POS"`) |
| `-AddToStartup` | No (switch) | Auto-launch POS at Windows login |
| `-FixDefaultPrinter` | No (switch) | Disables Windows' default-printer auto-manage (registry: `HKCU\...\Windows\LegacyDefaultPrinterMode = 1`) |

### Distribution

Two good ways to get the script to a client:

- **Email** the `.ps1` file. Client opens PowerShell, navigates to where they saved it, runs the command above.
- **Host it** on your site or S3. Client runs `irm https://.../install-pos-shortcut.ps1 | iex` — but this requires them to pass `-Url` via environment or a wrapper, since `iex` doesn't let you pass parameters cleanly.

Easier option: bundle the script with a tiny `setup.bat` that prompts for the URL and calls the PS1.

### Troubleshooting

**"Print button still shows a dialog"** — the client launched the POS in a normal Chrome tab, not via the kiosk shortcut. The flag only takes effect when Chrome is started with the shortcut.

**"Nothing prints at all"** — the default printer isn't the thermal printer, or the driver isn't installed. Check Settings → Printers & scanners. Run a Windows test print from the printer's context menu to confirm the printer works at all.

**"Prints to PDF file instead of paper"** — default printer is set to "Microsoft Print to PDF" or "Save as PDF". Change the default and uncheck "Let Windows manage my default printer".

**"Paper comes out blank"** — the thermal print head or ribbon is worn; this is a hardware issue, not a software one.
