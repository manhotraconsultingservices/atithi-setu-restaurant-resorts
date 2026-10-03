// Platform billing — PLM Pundits' own payment gateways. Razorpay, PhonePe and
// Paytm can each be switched on; several at once, one marked default. The
// tenant owner picks which one to pay with on the invoice page. Each gateway's
// fields come from its adapter (credentialFields), so a gateway added to
// paymentGatewayRegistry.ts appears here with no extra code.
//
// The Razorpay keys saved before this existed live on platform_billing_settings
// (rzp_*); they are read as a Razorpay config until one is saved here.

import type { Express, Request, Response } from 'express';
import { centralDb } from './db.ts';
import { sealSecret, openSecret, secretKeySource, needsReseal } from './paymentSecrets.ts';
import { getGateway, listGateways } from './paymentGatewayRegistry.ts';
import type { PaymentGateway, GatewayCredentials } from './paymentGateway.ts';

const json = (v: any): Record<string, any> => { try { return v ? (typeof v === 'string' ? JSON.parse(v) : v) : {}; } catch { return {}; } };

export interface PlatformGatewayConfig {
  gateway: PaymentGateway;
  row: any | null;
  creds: GatewayCredentials;
  enabled: boolean;
  isDefault: boolean;
  complete: boolean;
  legacy: boolean;
}

async function legacyRazorpay(): Promise<any | null> {
  const s: any = await centralDb.get('SELECT rzp_key_id, rzp_key_secret_sealed, rzp_webhook_secret_sealed, rzp_mode, verified_at FROM platform_billing_settings WHERE id = ?', ['DEFAULT']).catch(() => null);
  if (!s?.rzp_key_id || !s?.rzp_key_secret_sealed) return null;
  return {
    gateway: 'RAZORPAY', is_enabled: 1, is_default: 0, mode: s.rzp_mode,
    public_fields: JSON.stringify({ key_id: s.rzp_key_id }),
    secret_fields: JSON.stringify({ key_secret: s.rzp_key_secret_sealed, ...(s.rzp_webhook_secret_sealed ? { webhook_secret: s.rzp_webhook_secret_sealed } : {}) }),
    verified_at: s.verified_at, last_error: null, _legacy: true,
  };
}

export async function platformGatewayConfig(id: string): Promise<PlatformGatewayConfig | null> {
  const gw = getGateway(id);
  if (!gw) return null;
  let row: any = await centralDb.get('SELECT * FROM platform_gateway_configs WHERE gateway = ?', [gw.id]).catch(() => null);
  let legacy = false;
  if (!row && gw.id === 'RAZORPAY') { row = await legacyRazorpay(); legacy = !!row; }
  const creds: GatewayCredentials = { ...json(row?.public_fields) };
  for (const [k, v] of Object.entries(json(row?.secret_fields))) {
    try { const plain = openSecret(String(v)); if (plain) creds[k] = plain; } catch { /* unreadable secret = missing */ }
  }
  const complete = gw.credentialFields.filter(f => f.required).every(f => !!String(creds[f.key] || '').trim());
  return { gateway: gw, row, creds, enabled: Number(row?.is_enabled || 0) === 1 && complete, isDefault: Number(row?.is_default || 0) === 1, complete, legacy };
}

// Every gateway the owner can pay with right now, default first.
export async function enabledPlatformGateways(): Promise<PlatformGatewayConfig[]> {
  const out: PlatformGatewayConfig[] = [];
  for (const g of listGateways()) {
    const c = await platformGatewayConfig(g.id);
    if (c?.enabled) out.push(c);
  }
  return out.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
}

// The gateway for a new link: the one asked for when it is on, else the
// default, else the only one on. Null when none is on.
export async function pickPlatformGateway(requested?: string | null): Promise<PlatformGatewayConfig | null> {
  const on = await enabledPlatformGateways();
  if (!on.length) return null;
  if (requested) { const hit = on.find(c => c.gateway.id === String(requested).toUpperCase()); if (hit) return hit; }
  return on[0];
}

export const platformWebhookUrl = (origin: string, gatewayId: string) => `${origin}/api/public/platform-billing/webhook/${String(gatewayId).toLowerCase()}`;

function view(c: PlatformGatewayConfig, origin: string) {
  const pub = json(c.row?.public_fields), sec = json(c.row?.secret_fields);
  const url = platformWebhookUrl(origin, c.gateway.id);
  return {
    id: c.gateway.id, label: c.gateway.label,
    enabled: c.enabled, is_default: c.isDefault && c.enabled, complete: c.complete, legacy: c.legacy,
    mode: c.gateway.modeOf(c.creds), verified_at: c.row?.verified_at || null, last_error: c.row?.last_error || null,
    requires_customer_phone: c.gateway.requiresCustomerPhone,
    webhook_url: url,
    setup_steps: c.gateway.setupSteps.map(s => s.replace('{webhookUrl}', url)),
    // Secrets are write-only: the page learns only whether one is saved.
    fields: c.gateway.credentialFields.map(f => ({
      key: f.key, label: f.label, secret: f.secret, required: f.required, help: f.help || null, options: f.options || null,
      value: f.secret ? '' : String(pub[f.key] ?? ''), saved: f.secret ? !!sec[f.key] : !!pub[f.key],
    })),
  };
}

type Mw = (req: any, res: Response, next: any) => any;
export function registerPlatformGatewayRoutes(app: Express, deps: { authenticate: Mw; isAdmin: Mw; isAdminOrCto: Mw; appOriginFromReq: (req: Request) => string }) {
  const { authenticate, isAdmin, isAdminOrCto, appOriginFromReq } = deps;

  app.get('/api/admin/platform-billing/gateways', authenticate, isAdminOrCto, async (req: any, res: Response) => {
    try {
      const origin = appOriginFromReq(req);
      const out = [];
      for (const g of listGateways()) { const c = await platformGatewayConfig(g.id); if (c) out.push(view(c, origin)); }
      res.json({ gateways: out, encryption_ready: !!secretKeySource() });
    } catch (e: any) { res.status(500).json({ error: e?.message || 'Failed to load gateways' }); }
  });

  // Save fields and/or switch on/off and/or make default. Switching on runs the
  // gateway's own connection test first; a failed test leaves it off with the reason.
  app.put('/api/admin/platform-billing/gateways/:gateway', authenticate, isAdmin, async (req: any, res: Response) => {
    try {
      const before = await platformGatewayConfig(req.params.gateway);
      if (!before) return res.status(404).json({ error: 'Unknown payment gateway.' });
      if (!secretKeySource()) return res.status(503).json({ error: 'The server has no encryption key, so gateway secrets cannot be stored safely. Set ATITHI_CREDENTIAL_KEY.' });
      const gw = before.gateway;
      const incoming = (req.body && typeof req.body.fields === 'object' && req.body.fields) || {};
      const pub: Record<string, any> = { ...json(before.row?.public_fields) };
      const sec: Record<string, any> = { ...json(before.row?.secret_fields) };
      const changed: string[] = [];
      for (const f of gw.credentialFields) {
        if (!(f.key in incoming)) continue;
        const v = String(incoming[f.key] ?? '').trim();
        if (v.length > 512) return res.status(400).json({ error: `${f.label} is too long.` });
        if (f.options && v && !f.options.some(o => o.value === v)) return res.status(400).json({ error: `${f.label} must be one of ${f.options.map(o => o.label).join(', ')}.` });
        if (f.secret) { if (!v) continue; sec[f.key] = sealSecret(v); changed.push(f.key); }
        else if (v !== String(pub[f.key] || '')) { pub[f.key] = v; changed.push(f.key); }
      }
      for (const k of Object.keys(sec)) { if (needsReseal(sec[k])) { const plain = openSecret(sec[k]); if (plain) sec[k] = sealSecret(plain); } }
      const creds: GatewayCredentials = { ...pub };
      for (const [k, v] of Object.entries(sec)) { const plain = openSecret(String(v)); if (plain) creds[k] = plain; }
      const missing = gw.credentialFields.filter(f => f.required && !creds[f.key]);
      const wasEnabled = Number(before.row?.is_enabled || 0) === 1 && !before.legacy;
      const wantEnabled = req.body?.is_enabled === undefined ? (wasEnabled || before.legacy) : !!req.body.is_enabled;
      let enabled = wantEnabled;
      let verifiedAt: any = changed.length ? null : (before.row?.verified_at || null);
      let lastError: string | null = changed.length ? null : (before.row?.last_error || null);
      let detail: string | null = null;
      if (wantEnabled) {
        if (missing.length) { enabled = false; lastError = `Enter ${missing.map(f => f.label).join(', ')} before switching ${gw.label} on.`; }
        else if (changed.length || !wasEnabled || !verifiedAt) {
          try { detail = (await gw.testConnection(creds)).detail; verifiedAt = new Date().toISOString(); lastError = null; }
          catch (e: any) { enabled = false; lastError = e?.message || String(e); }
        }
      }
      const actor = String(req.user?.email || req.user?.name || 'admin');
      await centralDb.run(
        `INSERT INTO platform_gateway_configs (gateway, is_enabled, mode, public_fields, secret_fields, verified_at, last_error, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT (gateway) DO UPDATE SET is_enabled = EXCLUDED.is_enabled, mode = EXCLUDED.mode, public_fields = EXCLUDED.public_fields,
           secret_fields = EXCLUDED.secret_fields, verified_at = EXCLUDED.verified_at, last_error = EXCLUDED.last_error,
           updated_by = EXCLUDED.updated_by, updated_at = CURRENT_TIMESTAMP`,
        [gw.id, enabled ? 1 : 0, gw.modeOf(creds), JSON.stringify(pub), JSON.stringify(sec), verifiedAt, lastError, actor]);
      // Default: asked for explicitly, or the first gateway switched on.
      if (enabled && req.body?.is_default) await centralDb.run('UPDATE platform_gateway_configs SET is_default = CASE WHEN gateway = ? THEN 1 ELSE 0 END', [gw.id]);
      else if (enabled) {
        const hasDefault: any = await centralDb.get('SELECT gateway FROM platform_gateway_configs WHERE is_enabled = 1 AND is_default = 1 LIMIT 1');
        if (!hasDefault) await centralDb.run('UPDATE platform_gateway_configs SET is_default = CASE WHEN gateway = ? THEN 1 ELSE 0 END', [gw.id]);
      } else if (!enabled && Number(before.row?.is_default || 0) === 1) {
        // The default was switched off: hand the role to another gateway that is on.
        await centralDb.run('UPDATE platform_gateway_configs SET is_default = 0 WHERE gateway = ?', [gw.id]);
        const next: any = await centralDb.get('SELECT gateway FROM platform_gateway_configs WHERE is_enabled = 1 ORDER BY updated_at LIMIT 1');
        if (next) await centralDb.run('UPDATE platform_gateway_configs SET is_default = 1 WHERE gateway = ?', [next.gateway]);
      }
      const after = await platformGatewayConfig(gw.id);
      const v = view(after as PlatformGatewayConfig, appOriginFromReq(req));
      if (wantEnabled && !enabled) return res.status(400).json({ error: lastError || `${gw.label} could not be switched on.`, gateway: v });
      res.json({ gateway: v, detail });
    } catch (e: any) { res.status(500).json({ error: e?.message || 'Failed to save the gateway' }); }
  });

  app.post('/api/admin/platform-billing/gateways/:gateway/test', authenticate, isAdmin, async (req: any, res: Response) => {
    try {
      const c = await platformGatewayConfig(req.params.gateway);
      if (!c) return res.status(404).json({ error: 'Unknown payment gateway.' });
      if (!c.complete) return res.status(400).json({ error: `Enter every required ${c.gateway.label} field first.` });
      try {
        const r = await c.gateway.testConnection(c.creds);
        if (!c.legacy) await centralDb.run('UPDATE platform_gateway_configs SET verified_at = CURRENT_TIMESTAMP, last_error = NULL WHERE gateway = ?', [c.gateway.id]);
        res.json({ ok: true, mode: r.mode, detail: r.detail });
      } catch (e: any) {
        if (!c.legacy) await centralDb.run('UPDATE platform_gateway_configs SET verified_at = NULL, last_error = ? WHERE gateway = ?', [String(e?.message || 'Failed').slice(0, 300), c.gateway.id]).catch(() => {});
        res.status(400).json({ ok: false, error: e?.message || `${c.gateway.label} rejected the credentials` });
      }
    } catch (e: any) { res.status(500).json({ error: e?.message || 'Test failed' }); }
  });
}
