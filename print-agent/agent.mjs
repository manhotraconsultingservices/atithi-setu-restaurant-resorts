#!/usr/bin/env node
/**
 * Atithi-Setu — On-prem Thermal Print Agent
 * ------------------------------------------
 * Runs on the restaurant's billing PC (or a Raspberry Pi). Polls the server's
 * print-job queue and prints each job as raw ESC/POS. Two job kinds:
 *   • KOT     — Kitchen Order Ticket, auto-queued when an order is placed.
 *   • INVOICE — the customer bill, queued when staff press "Print Bill".
 *
 * Two printer connection types (per printer, from Settings → Kitchen Printers):
 *   • USB      — a printer installed on THIS Windows PC. We print raw ESC/POS
 *                through the Windows spooler by the printer's Windows name
 *                (stored in the printer's "host" field). No sharing needed.
 *   • NETWORK  — a LAN/Wi-Fi ESC/POS printer reachable at host:port (usually
 *                9100). We open a TCP socket and stream the bytes.
 *
 * Zero npm deps — Node 18+ (built-in fetch + net) plus, for USB, powershell.exe
 * (present on every Windows). Works both as `node agent.mjs` and bundled as a
 * single .exe (Node SEA / pkg) — path handling degrades gracefully either way.
 *
 * Config via environment variables (or a `.env` file next to this script/exe):
 *   BASE_URL       e.g. https://erp.atithi-setu.com   (your server origin)
 *   RESTAURANT_ID  e.g. RESTO-1003                     (your tenant id)
 *   AGENT_TOKEN    the "Print agent token" from Settings → Kitchen Printers
 *   POLL_MS        poll interval in ms (default 3000)
 */
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ── locate a folder we can read a .env / write temp files next to ────────────
// Under `node agent.mjs` this is the script dir; bundled as an .exe it's the
// folder the .exe lives in (process.execPath).
function baseDir() {
  try {
    // @ts-ignore — SEA sets this; when bundled import.meta.url is not a real file
    if (process.pkg || (process.execPath && /atithi.*print/i.test(path.basename(process.execPath)))) {
      return path.dirname(process.execPath);
    }
  } catch { /* ignore */ }
  try { return path.dirname(fileURLToPath(import.meta.url)); }
  catch { return process.cwd(); }
}
const BASE_DIR = baseDir();

// ── tiny .env loader (optional) ─────────────────────────────────────────────
try {
  const envPath = path.join(BASE_DIR, '.env');
  if (fs.existsSync(envPath)) {
    for (const raw of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const l = raw.trim(); if (!l || l.startsWith('#')) continue;
      const i = l.indexOf('='); if (i < 0) continue;
      const k = l.slice(0, i).trim(); let v = l.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (process.env[k] === undefined) process.env[k] = v;
    }
  }
} catch { /* ignore */ }

const BASE_URL = (process.env.BASE_URL || '').replace(/\/$/, '');
const RESTAURANT_ID = process.env.RESTAURANT_ID || '';
const AGENT_TOKEN = process.env.AGENT_TOKEN || '';
const POLL_MS = Math.max(1000, Number(process.env.POLL_MS) || 3000);

if (!BASE_URL || !RESTAURANT_ID || !AGENT_TOKEN) {
  console.error('Missing config. Set BASE_URL, RESTAURANT_ID and AGENT_TOKEN (env or .env next to the agent).');
  console.error('Looked for .env in:', BASE_DIR);
  process.exit(1);
}
const api = (p) => `${BASE_URL}/api/restaurant/${RESTAURANT_ID}${p}`;
const headers = { 'X-Print-Agent-Token': AGENT_TOKEN, 'Content-Type': 'application/json' };

// ── ESC/POS helpers ─────────────────────────────────────────────────────────
const ESC = '\x1B', GS = '\x1D';
const INIT = ESC + '@';
const BOLD_ON = ESC + 'E\x01', BOLD_OFF = ESC + 'E\x00';
const CENTER = ESC + 'a\x01', LEFT = ESC + 'a\x00', RIGHT = ESC + 'a\x02';
const BIG = GS + '!\x11', TALL = GS + '!\x01', NORMAL = GS + '!\x00';
const CUT = '\n\n\n' + GS + 'V\x42\x00';   // feed + partial cut

const money = (n) => Number(n || 0).toFixed(2);
// left/right justified within `w` columns (for a two-column price row)
function lr(left, right, w) {
  left = String(left ?? ''); right = String(right ?? '');
  const pad = w - left.length - right.length;
  if (pad >= 1) return left + ' '.repeat(pad) + right + '\n';
  // name too long → wrap: name on its own line, amount right-aligned below
  return left + '\n' + ' '.repeat(Math.max(0, w - right.length)) + right + '\n';
}

// ---- KOT (kitchen) ----------------------------------------------------------
function buildKotEscpos(job) {
  let c = {};
  try { c = JSON.parse(job.content || '{}'); } catch { c = {}; }
  const items = Array.isArray(c.items) ? c.items : [];
  const W = Number(c.width) || 32;
  const when = c.at ? new Date(c.at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '';
  const line = '-'.repeat(W) + '\n';
  let out = INIT + CENTER + BOLD_ON + BIG + 'KOT\n' + NORMAL + BOLD_OFF;
  out += CENTER + `${c.station || 'KITCHEN'}\n` + LEFT + line;
  out += `Order: ${c.order_id || ''}\n`;
  if (c.table) out += `Table: ${c.table}`;
  out += (c.round ? `   Round: ${c.round}` : '') + (when ? `   ${when}` : '') + '\n';
  if (c.customer) out += `Guest: ${c.customer}\n`;
  out += line + BOLD_ON + TALL;
  for (const it of items) {
    out += `${String(it.qty || 1).padStart(2, ' ')} x ${it.name || 'Item'}\n`;
    if (it.note) out += `     >> ${it.note}\n`;
  }
  out += NORMAL + BOLD_OFF + line + CUT;
  return Buffer.from(out, 'binary');
}

// ---- INVOICE (customer bill) ------------------------------------------------
function buildInvoiceEscpos(job) {
  let c = {};
  try { c = JSON.parse(job.content || '{}'); } catch { c = {}; }
  const W = Number(c.width) || 32;
  const line = '-'.repeat(W) + '\n';
  const r = c.restaurant || {};
  const items = Array.isArray(c.items) ? c.items : [];
  const taxes = Array.isArray(c.taxes) ? c.taxes : [];

  let out = INIT + CENTER + BOLD_ON + BIG + `${r.name || 'TAX INVOICE'}\n` + NORMAL + BOLD_OFF;
  if (r.address) out += CENTER + `${r.address}\n`;
  if (r.phone)   out += CENTER + `Ph: ${r.phone}\n`;
  if (r.gstin)   out += CENTER + `GSTIN: ${r.gstin}\n`;
  out += LEFT + line;
  if (c.invoice_no) out += `Bill: ${c.invoice_no}\n`;
  const when = c.date ? new Date(c.date) : new Date();
  out += `Date: ${when.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}\n`;
  if (c.table)    out += `Table: ${c.table}\n`;
  if (c.customer) out += `Guest: ${c.customer}\n`;
  if (c.served_by) out += `Served by: ${c.served_by}\n`;
  out += line;
  // column header
  out += BOLD_ON + lr('Item', 'Amount', W) + BOLD_OFF;
  for (const it of items) {
    const qty = Number(it.qty || 1);
    const price = Number(it.price || 0);
    const amt = it.amount != null ? Number(it.amount) : qty * price;
    out += lr(String(it.name || 'Item').slice(0, W - 9), money(amt), W);
    out += `   ${qty} x ${money(price)}\n`;
  }
  out += line;
  out += lr('Subtotal', money(c.subtotal), W);
  if (Number(c.discount)) out += lr('Discount', '-' + money(c.discount), W);
  if (Number(c.service_charge)) out += lr(`Service Chg${c.service_charge_pct ? ' ' + c.service_charge_pct + '%' : ''}`, money(c.service_charge), W);
  for (const t of taxes) if (Number(t.amount)) out += lr(t.label || 'Tax', money(t.amount), W);
  out += NORMAL + BOLD_ON + lr('TOTAL', 'Rs ' + money(c.total), W) + BOLD_OFF;
  out += line;
  if (c.payment_method) out += CENTER + `Paid via ${c.payment_method}\n` + LEFT;
  out += CENTER + `${c.footer || 'Thank you! Visit again.'}\n` + LEFT;
  out += CUT;
  return Buffer.from(out, 'binary');
}

function buildEscpos(job) {
  const kind = String(job.kind || 'KOT').toUpperCase();
  return kind === 'INVOICE' ? buildInvoiceEscpos(job) : buildKotEscpos(job);
}

// ── delivery: NETWORK (TCP 9100) ─────────────────────────────────────────────
// Open a TCP socket to the printer and stream the ESC/POS bytes.
//
// KEY: we treat the job as PRINTED once the bytes have flushed to the printer —
// we do NOT wait for the printer to close the connection. Many low-cost 9100 LAN
// printers (common as a kitchen/KDS unit) accept the data, print, and then just
// hold the socket open. The old code resolved only on 'close', so those printers
// tripped the inactivity timeout and every ticket was falsely marked FAILED — then
// retried (duplicate prints) and finally given up. Errors are mapped to a plain
// sentence so the health-check (Test button) tells the owner exactly what to fix.
function sendToNetwork(host, port, buf) {
  const p = Number(port) || 9100;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err) => {
      if (settled) return; settled = true;
      try { sock.destroy(); } catch {}
      err ? reject(err) : resolve();
    };
    const sock = net.createConnection({ host, port: p });
    // Inactivity guard — mainly bounds the CONNECT phase, since we settle ~200ms
    // after the write. A wrong IP / blocked subnet fails fast with a clear message.
    sock.setTimeout(8000);
    sock.on('connect', () => {
      sock.write(buf, (err) => {
        if (err) { finish(new Error('write to printer failed: ' + err.message)); return; }
        sock.end();                         // flush + half-close from our side
        setTimeout(() => finish(), 200);    // success once bytes are out the door
      });
    });
    sock.on('timeout', () => finish(new Error(`no response from ${host}:${p} — check the IP/port, that the printer is on the same LAN as the billing PC, and that port 9100 is open`)));
    sock.on('error', (e) => {
      const code = e && e.code;
      if (code === 'ECONNREFUSED')                      finish(new Error(`connection refused at ${host}:${p} — printer off, wrong port, or it is not a raw/9100 printer`));
      else if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') finish(new Error(`${host} is unreachable — the printer is on a different network than the billing PC`));
      else if (code === 'ETIMEDOUT')                    finish(new Error(`connect timed out to ${host}:${p} — wrong IP or a firewall is blocking it`));
      else finish(new Error((e && e.message) || 'network error'));
    });
    sock.on('close', () => finish());       // well-behaved printer closed first → success
  });
}

// ── delivery: USB / Windows spooler (raw ESC/POS by printer name) ────────────
// Streams raw bytes straight to the named Windows printer via winspool.drv
// (OpenPrinter/StartDocPrinter/WritePrinter). No printer sharing required.
const PS_RAWPRINT = `
$ErrorActionPreference='Stop'
$name=$env:ATITHI_PRN; $file=$env:ATITHI_BIN
Add-Type -Language CSharp -TypeDefinition @"
using System; using System.IO; using System.Runtime.InteropServices;
public class AtithiRaw {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public class DOCINFO { [MarshalAs(UnmanagedType.LPWStr)] public string pDocName; [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile; [MarshalAs(UnmanagedType.LPWStr)] public string pDataType; }
  [DllImport("winspool.Drv", EntryPoint="OpenPrinterW", SetLastError=true, CharSet=CharSet.Unicode)] public static extern bool OpenPrinter(string s, out IntPtr h, IntPtr d);
  [DllImport("winspool.Drv", EntryPoint="ClosePrinter")] public static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.Drv", EntryPoint="StartDocPrinterW", CharSet=CharSet.Unicode)] public static extern bool StartDocPrinter(IntPtr h, int lvl, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFO di);
  [DllImport("winspool.Drv", EntryPoint="EndDocPrinter")] public static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.Drv", EntryPoint="StartPagePrinter")] public static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.Drv", EntryPoint="EndPagePrinter")] public static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.Drv", EntryPoint="WritePrinter")] public static extern bool WritePrinter(IntPtr h, IntPtr buf, int n, out int written);
  public static void Send(string printer, byte[] bytes) {
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero)) throw new Exception("OpenPrinter failed for '" + printer + "' (err " + Marshal.GetLastWin32Error() + ")");
    try {
      var di = new DOCINFO(); di.pDocName = "Atithi-Setu"; di.pDataType = "RAW";
      if (!StartDocPrinter(h, 1, di)) throw new Exception("StartDocPrinter failed");
      StartPagePrinter(h);
      IntPtr p = Marshal.AllocCoTaskMem(bytes.Length);
      try { Marshal.Copy(bytes, 0, p, bytes.Length); int w; WritePrinter(h, p, bytes.Length, out w); }
      finally { Marshal.FreeCoTaskMem(p); }
      EndPagePrinter(h); EndDocPrinter(h);
    } finally { ClosePrinter(h); }
  }
}
"@
[AtithiRaw]::Send($name, [IO.File]::ReadAllBytes($file))
`;

function sendToUsb(printerName, buf) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') { reject(new Error('USB printing needs Windows')); return; }
    if (!printerName) { reject(new Error('USB printer: no Windows printer name set (put it in the printer\'s "host" field)')); return; }
    let tmp;
    try {
      tmp = path.join(os.tmpdir(), `atithi-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.bin`);
      fs.writeFileSync(tmp, buf);
    } catch (e) { reject(e); return; }
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_RAWPRINT], {
      env: { ...process.env, ATITHI_PRN: printerName, ATITHI_BIN: tmp },
      windowsHide: true,
    });
    let err = '';
    ps.stderr.on('data', (d) => { err += d.toString(); });
    ps.on('error', (e) => { try { fs.unlinkSync(tmp); } catch {} reject(e); });
    ps.on('close', (code) => {
      try { fs.unlinkSync(tmp); } catch {}
      if (code === 0) { resolve(); return; }
      // Surface the meaningful line (the .NET exception message — e.g. "OpenPrinter
      // failed for 'X' (err 1801)") rather than PowerShell's trailing "+ ...ErrorId".
      const lines = err.trim().split('\n').map(s => s.trim()).filter(Boolean);
      const msg = lines.find(l => /OpenPrinter|WritePrinter|StartDoc|Exception calling/i.test(l))
        || lines.find(l => !l.startsWith('+') && !l.startsWith('At ') && !/^~+$/.test(l))
        || lines[0] || `powershell exit ${code}`;
      reject(new Error(msg.replace(/^Exception calling "\w+" with "\d+" argument\(s\):\s*/i, '').replace(/^"|"$/g, '').slice(0, 200)));
    });
  });
}

function sendJob(job, buf) {
  const conn = String(job.conn_type || 'NETWORK').toUpperCase();
  if (conn === 'USB') return sendToUsb(job.host, buf);   // host = Windows printer name
  return sendToNetwork(job.host, job.port, buf);
}

async function ack(jobId, status, error) {
  try {
    await fetch(api(`/print-jobs/${jobId}/ack`), { method: 'POST', headers, body: JSON.stringify({ status, error: error || null }) });
  } catch (e) { console.error('ack failed:', e.message); }
}

// Re-entrancy guard: a USB print (Add-Type compile + spooler write) can take a
// few seconds — longer than POLL_MS. Without this, the next interval would fire
// while the first tick is still awaiting a print, both would fetch the SAME
// still-PENDING job, and it would print twice. Skip a tick while one is running.
let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    let jobs = [];
    try {
      const r = await fetch(api('/print-jobs/pending'), { headers });
      if (r.status === 401 || r.status === 403) { console.error('AUTH FAILED — check AGENT_TOKEN / RESTAURANT_ID.'); return; }
      if (!r.ok) return;
      jobs = await r.json();
    } catch (e) { console.error('poll failed:', e.message); return; }
    for (const job of (Array.isArray(jobs) ? jobs : [])) {
      const conn = String(job.conn_type || 'NETWORK').toUpperCase();
      if (conn !== 'USB' && !job.host) { await ack(job.id, 'FAILED', 'printer has no host/IP configured'); continue; }
      try {
        const buf = buildEscpos(job);
        const copies = Math.max(1, Number(job.copies) || 1);
        for (let i = 0; i < copies; i++) await sendJob(job, buf);
        await ack(job.id, 'PRINTED');
        console.log(`printed ${job.id} [${job.kind || 'KOT'}] → ${job.printer_name || job.host}`);
      } catch (e) {
        await ack(job.id, 'FAILED', e.message);
        console.error(`print ${job.id} failed:`, e.message);
      }
    }
  } finally {
    ticking = false;
  }
}

console.log(`Atithi-Setu print agent — ${BASE_URL} / ${RESTAURANT_ID}, polling every ${POLL_MS}ms`);
tick();
setInterval(tick, POLL_MS);
