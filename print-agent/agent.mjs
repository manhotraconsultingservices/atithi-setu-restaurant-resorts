#!/usr/bin/env node
/**
 * Atithi-Setu — On-prem Thermal Print Agent
 * ------------------------------------------
 * Runs on a PC / Raspberry Pi at the restaurant, on the same LAN as the thermal
 * printers. Polls the server's print-job queue and sends each Kitchen Order
 * Ticket (KOT) as raw ESC/POS to the target printer by IP:port. Zero npm deps —
 * just Node 18+ (built-in fetch + net).
 *
 * Configure via environment variables (or a .env file next to this script):
 *   BASE_URL       e.g. https://erp.atithi-setu.com   (your server origin)
 *   RESTAURANT_ID  e.g. RESTO-1003                     (your tenant id)
 *   AGENT_TOKEN    the "Print agent token" from Settings → Printers
 *   POLL_MS        poll interval in ms (default 3000)
 *
 * Run:   node agent.mjs        (or: BASE_URL=… RESTAURANT_ID=… AGENT_TOKEN=… node agent.mjs)
 */
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── tiny .env loader (optional) ─────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
try {
  const envPath = path.join(__dirname, '.env');
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
  console.error('Missing config. Set BASE_URL, RESTAURANT_ID and AGENT_TOKEN (env or .env).');
  process.exit(1);
}
const api = (p) => `${BASE_URL}/api/restaurant/${RESTAURANT_ID}${p}`;
const headers = { 'X-Print-Agent-Token': AGENT_TOKEN, 'Content-Type': 'application/json' };

// ── ESC/POS helpers ─────────────────────────────────────────────────────────
const ESC = '\x1B', GS = '\x1D';
const INIT = ESC + '@';
const BOLD_ON = ESC + 'E\x01', BOLD_OFF = ESC + 'E\x00';
const CENTER = ESC + 'a\x01', LEFT = ESC + 'a\x00';
const BIG = GS + '!\x11', NORMAL = GS + '!\x00';
const CUT = '\n\n\n' + GS + 'V\x42\x00';   // feed + partial cut

function buildKotEscpos(job) {
  let c = {};
  try { c = JSON.parse(job.content || '{}'); } catch { c = {}; }
  const items = Array.isArray(c.items) ? c.items : [];
  const when = c.at ? new Date(c.at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '';
  const line = '-'.repeat(32) + '\n';
  let out = INIT + CENTER + BOLD_ON + BIG + 'KOT\n' + NORMAL + BOLD_OFF;
  out += CENTER + `${c.station || 'KITCHEN'}\n` + LEFT + line;
  out += `Order: ${c.order_id || ''}\n`;
  if (c.table) out += `Table: ${c.table}`;
  out += (c.round ? `   Round: ${c.round}` : '') + (when ? `   ${when}` : '') + '\n';
  if (c.customer) out += `Guest: ${c.customer}\n`;
  out += line + BOLD_ON;
  for (const it of items) {
    out += `${String(it.qty || 1).padStart(2, ' ')} x ${it.name || 'Item'}\n`;
    if (it.note) out += `     >> ${it.note}\n`;
  }
  out += BOLD_OFF + line + CUT;
  return Buffer.from(out, 'binary');
}

function sendToPrinter(host, port, buf) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port: Number(port) || 9100 }, () => {
      sock.write(buf, () => sock.end());
    });
    sock.setTimeout(8000);
    sock.on('error', reject);
    sock.on('timeout', () => { sock.destroy(); reject(new Error('printer timeout')); });
    sock.on('close', () => resolve());
  });
}

async function ack(jobId, status, error) {
  try {
    await fetch(api(`/print-jobs/${jobId}/ack`), { method: 'POST', headers, body: JSON.stringify({ status, error: error || null }) });
  } catch (e) { console.error('ack failed:', e.message); }
}

async function tick() {
  let jobs = [];
  try {
    const r = await fetch(api('/print-jobs/pending'), { headers });
    if (r.status === 401 || r.status === 403) { console.error('AUTH FAILED — check AGENT_TOKEN / RESTAURANT_ID.'); return; }
    if (!r.ok) return;
    jobs = await r.json();
  } catch (e) { console.error('poll failed:', e.message); return; }
  for (const job of (Array.isArray(jobs) ? jobs : [])) {
    if (!job.host) { await ack(job.id, 'FAILED', 'printer has no host/IP configured'); continue; }
    try {
      const buf = buildKotEscpos(job);
      const copies = Math.max(1, Number(job.copies) || 1);
      for (let i = 0; i < copies; i++) await sendToPrinter(job.host, job.port, buf);
      await ack(job.id, 'PRINTED');
      console.log(`printed ${job.id} → ${job.printer_name || job.host}`);
    } catch (e) {
      await ack(job.id, 'FAILED', e.message);
      console.error(`print ${job.id} failed:`, e.message);
    }
  }
}

console.log(`Atithi-Setu print agent — ${BASE_URL} / ${RESTAURANT_ID}, polling every ${POLL_MS}ms`);
tick();
setInterval(tick, POLL_MS);
