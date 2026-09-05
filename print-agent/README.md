# Atithi-Setu — Thermal Print Agent

Prints to your restaurant's thermal printers:

- **Kitchen Order Tickets (KOTs)** — print **automatically** the moment an order is
  placed (POS, waiter, or QR), so the chef gets the ticket without anyone pressing a button.
- **Customer bill / invoice** — prints when staff press **Print Bill** in the app.

One agent runs on your **billing PC** and drives **all** your printers. You can use
**one printer for everything**, or **two** (one for the kitchen, one for the bill) —
your choice.

---

## The easy way (Windows, one-click) — recommended

You get a folder with **`AtithiSetuPrintAgent.exe`** + **`Setup.bat`**. No need to
install Node.js or type any commands.

1. **Plug in your thermal printer(s)** and make sure Windows can print a test page to
   each (they show up in **Settings → Bluetooth & devices → Printers & scanners**).
   Note each printer's **exact name** (e.g. `POS-80`).
2. **In the app** (owner login): go to **Restaurant → Kitchen Printers** and add your
   printers:
   - **Kitchen printer** → Station **`KITCHEN`** (or **`ALL`**), Connection **USB**,
     Windows printer name = the kitchen printer's name.
   - **Invoice printer** → Station **`INVOICE`**, Connection **USB**, Windows printer
     name = the bill printer's name.
   - *(One printer only? Add it once with Station **`ALL`** and tick **Default** — it
     prints KOTs automatically and the bill on **Print Bill**.)*
   - Copy the **Print agent token** shown on that page.
3. **Double-click `Setup.bat`.** It asks for your **Restaurant ID** and the **token**,
   saves them, and installs the agent to **start automatically every time the PC turns
   on** (running quietly in the background — no window).
4. Done. Place a test order → the KOT prints at the kitchen printer. Open a table bill →
   **Print Bill** → the invoice prints at the invoice printer.

To stop/remove it later, double-click **`Uninstall.bat`** (your printer settings in the
app stay put).

---

## Which printer prints what?

Routing is by the printer's **Station**:

| Station | What prints there | When |
|---------|-------------------|------|
| `KITCHEN` | the food KOT | automatically, on every new order |
| `ALL` | the whole order KOT | automatically, on every new order |
| `INVOICE` | the customer bill | when staff press **Print Bill** |
| a menu category (`TANDOOR`, `BAR`, …) | only items in that category | automatically, on every new order |

The bill goes to the **`INVOICE`** printer; if you haven't set one, it goes to your
**Default** printer; if there's no default, to your first printer. So a single-printer
shop just works.

---

## Connection types

- **USB** *(most common)* — the printer is plugged into the billing PC and installed as a
  Windows printer. The agent prints raw ESC/POS straight through Windows **by the
  printer's name** (put that name in the printer's **host** field). No sharing needed.
- **Network** — a LAN/Wi-Fi ESC/POS printer with its own **IP address**, reachable on a
  port (usually **9100**). Use Connection = *Network* and enter the IP + port.

---

## The manual way (any OS: Windows / Linux / Raspberry Pi)

If you'd rather run it with Node.js instead of the .exe:

1. Install **Node.js 18+** (`node --version`).
2. Put `agent.mjs` in a folder with a `.env` (copy `.env.example`):
   ```
   BASE_URL=https://erp.atithi-setu.com
   RESTAURANT_ID=RESTO-1003
   AGENT_TOKEN=pat_xxxxxxxxxxxxxxxxxxxx
   POLL_MS=800
   ```
3. Run it: `node agent.mjs` → you'll see `polling every 800ms`.
   (A `POLL_MS` above 1000 is clamped back to 800 so tickets stay near-instant;
   set `POLL_ALLOW_SLOW=1` to keep a slower poll on a genuinely weak network.)

Keep it running: **Windows** — Task Scheduler at logon, or [NSSM](https://nssm.cc/) as a
service. **Linux/Pi** — a `systemd` unit or `pm2 start agent.mjs --name print-agent`.
*(USB printing needs Windows; on Linux/Pi use network printers.)*

---

## Building the .exe yourself

From this folder (needs Node 18+ and internet the first time):
```
npm run build:exe
```
This produces `dist/AtithiSetuPrintAgent.exe` (a self-contained Windows binary — bundles
its own Node runtime, ~57 MB). Ship that `.exe` together with `Setup.bat`, `run-hidden.vbs`
and `Uninstall.bat`.

---

## How it works

- Polls `GET /api/restaurant/<id>/print-jobs/pending` every `POLL_MS` (auth header
  `X-Print-Agent-Token`).
- For each job it builds the ESC/POS (KOT or invoice) and sends it: **USB** → Windows
  spooler by printer name; **Network** → TCP `host:port`. Then `POST …/print-jobs/<id>/ack`.
- On error it acks `FAILED`; the server retries a job up to 6 times, then marks it
  `FAILED` (visible in the queue) so a stuck printer can't loop forever.
- Nothing is stored on the PC; it only relays tickets.

## Troubleshooting

- **`AUTH FAILED`** → the `AGENT_TOKEN` / `RESTAURANT_ID` don't match. Re-copy the token
  from **Kitchen Printers** (you can **Rotate** it there if it leaked) and re-run `Setup.bat`.
- **`OpenPrinter failed … (err 1801)`** → the Windows printer **name** is wrong. Copy it
  exactly as it appears in *Printers & scanners* into the printer's **host** field.
- **`ECONNREFUSED` / `printer timeout`** *(network printers)* → wrong IP/port, printer off,
  or a firewall. `ping <printer-ip>` and confirm the port (9100 is typical).
- **Garbled output** → the printer isn't ESC/POS or needs a different codepage; tell us the
  model and we'll adjust the byte sequence.
- **USB-only printer with no Windows driver** → install the vendor driver first (so it shows
  in *Printers & scanners*), or use a cheap USB-to-Ethernet print server and switch it to
  Network mode.
