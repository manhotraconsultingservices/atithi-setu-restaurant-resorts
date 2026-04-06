/**
 * deploy-webhook-listener.mjs
 * Host-side GitHub webhook receiver — port 5002
 * Zero npm dependencies: uses only Node.js built-ins
 *
 * Start: node deploy-webhook-listener.mjs
 * Register as Windows Task: powershell -File deploy-service-setup.ps1
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Config ------------------------------------------------------------------
const PORT         = 5002;
const BIND_ADDR    = '127.0.0.1';   // only nginx proxies to us
const DEPLOY_DIR   = __dirname;
const LOG_DIR      = 'C:\\atithi-setu\\deploy-logs';
const RATE_LIMIT_MS = 5 * 60 * 1000; // 5 minutes between deploys

// --- Load .env ---------------------------------------------------------------
function loadEnv(envPath) {
  try {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const m = line.match(/^\s*([^#][^=]+)=(.*)$/);
      if (m) {
        const key = m[1].trim();
        const val = m[2].trim().replace(/^["']|["']$/g, '');
        if (!process.env[key]) process.env[key] = val;
      }
    }
  } catch { /* .env optional */ }
}
loadEnv(path.join(DEPLOY_DIR, '.env'));

const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || '';
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN    || '';
const TELEGRAM_CHAT  = process.env.TELEGRAM_DEFAULT_CHAT_ID || '';

// --- Logging -----------------------------------------------------------------
fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, 'webhook-listener.log');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

// --- Telegram notify ---------------------------------------------------------
function notifyTelegram(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT) return;
  const body = JSON.stringify({ chat_id: TELEGRAM_CHAT, text, parse_mode: 'Markdown' });
  const req = http.request({
    hostname: 'api.telegram.org',
    port: 443,
    path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    // Use https module below
  });
  req.on('error', e => log(`Telegram notify error: ${e.message}`));
  req.end(body);
}

// Use https for Telegram (import dynamically to keep zero-dep feel for the server)
import https from 'node:https';
function notifyTelegramHttps(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT) return;
  try {
    const body = JSON.stringify({ chat_id: TELEGRAM_CHAT, text, parse_mode: 'Markdown' });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    });
    req.on('error', e => log(`Telegram error: ${e.message}`));
    req.write(body);
    req.end();
  } catch (e) { log(`Telegram error: ${e.message}`); }
}

// --- State -------------------------------------------------------------------
let isDeploying  = false;
let lastDeployAt = 0;

// --- HMAC validation ---------------------------------------------------------
function validateSignature(secret, payload, sigHeader) {
  if (!secret) return true; // skip if no secret configured (dev only)
  if (!sigHeader) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(payload).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(sigHeader), Buffer.from(expected));
  } catch {
    return false;
  }
}

// --- Spawn deploy pipeline ---------------------------------------------------
function runDeploy() {
  isDeploying  = true;
  lastDeployAt = Date.now();

  log('Spawning deploy-pipeline.ps1...');
  notifyTelegramHttps('🚀 *Deploy started* — pulling master & building...\nServer: dev\\-erp.atithi\\-setu.com');

  const ps = spawn('powershell.exe', [
    '-ExecutionPolicy', 'Bypass',
    '-File', path.join(DEPLOY_DIR, 'deploy-pipeline.ps1'),
  ], {
    cwd: DEPLOY_DIR,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(LOG_DIR, `webhook-deploy-${ts}.log`);
  const outStream = fs.createWriteStream(outFile, { flags: 'a' });

  ps.stdout.on('data', d => { process.stdout.write(d); outStream.write(d); });
  ps.stderr.on('data', d => { process.stderr.write(d); outStream.write(d); });

  ps.on('close', code => {
    isDeploying = false;
    outStream.end();
    log(`deploy-pipeline.ps1 exited with code ${code}`);
    if (code !== 0) {
      notifyTelegramHttps(`⚠️ *Webhook listener*: deploy-pipeline.ps1 exited with code ${code}. Check log: ${outFile}`);
    }
  });

  ps.unref();
}

// --- HTTP Server -------------------------------------------------------------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Health check for nginx
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', deploying: isDeploying }));
    return;
  }

  if (req.method !== 'POST' || url.pathname !== '/webhook/github') {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  // Collect body
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const payload = Buffer.concat(chunks);
    const sig     = req.headers['x-hub-signature-256'] || '';

    // Validate HMAC
    if (!validateSignature(WEBHOOK_SECRET, payload, sig)) {
      log(`REJECTED: invalid signature from ${req.socket.remoteAddress}`);
      res.writeHead(401);
      res.end('Unauthorized');
      return;
    }

    let event;
    try { event = JSON.parse(payload.toString('utf8')); }
    catch {
      res.writeHead(400);
      res.end('Bad JSON');
      return;
    }

    const ref    = event.ref || '';
    const pusher = event.pusher?.name || 'unknown';
    const sha    = (event.after || '').slice(0, 7);
    const msgHead = event.head_commit?.message?.split('\n')[0] || '';

    log(`Received push: ref=${ref} pusher=${pusher} sha=${sha} msg="${msgHead}"`);

    // Only deploy on master pushes
    if (ref !== 'refs/heads/master') {
      log(`Ignored: ref is "${ref}", not master`);
      res.writeHead(200);
      res.end('Ignored — not master');
      return;
    }

    // Rate limit
    const sinceLastDeploy = Date.now() - lastDeployAt;
    if (sinceLastDeploy < RATE_LIMIT_MS) {
      const wait = Math.ceil((RATE_LIMIT_MS - sinceLastDeploy) / 1000);
      log(`Rate limited: last deploy was ${Math.floor(sinceLastDeploy/1000)}s ago, wait ${wait}s`);
      res.writeHead(429);
      res.end(`Rate limited — wait ${wait}s`);
      return;
    }

    // Deploy lock
    if (isDeploying) {
      log('Deploy already in progress — ignoring');
      res.writeHead(409);
      res.end('Deploy already in progress');
      return;
    }

    // Acknowledge immediately, then deploy
    res.writeHead(202);
    res.end(`Deploy triggered for ${sha} — "${msgHead}"`);

    log(`Triggering deploy: ${sha} — "${msgHead}" by ${pusher}`);
    runDeploy();
  });

  req.on('error', e => {
    log(`Request error: ${e.message}`);
    res.writeHead(500);
    res.end('Internal error');
  });
});

server.listen(PORT, BIND_ADDR, () => {
  log(`Webhook listener started on ${BIND_ADDR}:${PORT}`);
  log(`Deploy dir: ${DEPLOY_DIR}`);
  log(`HMAC validation: ${WEBHOOK_SECRET ? 'ENABLED' : 'DISABLED (no GITHUB_WEBHOOK_SECRET set!)'}`);
});

server.on('error', e => {
  log(`Server error: ${e.message}`);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', () => { log('SIGTERM received, shutting down'); server.close(); });
process.on('SIGINT',  () => { log('SIGINT received, shutting down');  server.close(); });
