/**
 * Atithi Setu — Cloudflare Tunnel + DNS auto-provisioning
 *
 * When a new tenant registers with slug `xyz`, this module:
 *   1. Adds a "Public Hostname" rule on the configured tunnel so
 *      xyz.atithi-setu.com is routed to http://node_app:5001
 *   2. Creates a DNS CNAME record xyz → <tunnel-id>.cfargotunnel.com
 *      (proxied through Cloudflare for SSL + DDoS protection)
 *
 * Required env vars (set in .env):
 *   CF_API_TOKEN   — Cloudflare API Token with permissions:
 *                    Zone:DNS:Edit  +  Account:Cloudflare Tunnel:Edit
 *   CF_ZONE_ID     — Zone ID for atithi-setu.com
 *                    (Cloudflare dashboard → Overview → API → Zone ID)
 *   CF_ACCOUNT_ID  — Cloudflare account ID
 *                    (dashboard → right-side Account details)
 *   CF_TUNNEL_ID   — Tunnel ID (UUID) we're adding hostnames to
 *                    e.g. 6cec8055-6c21-4203-b2c1-34f2309be13f
 *   CF_APEX_DOMAIN — "atithi-setu.com"
 *   CF_SERVICE_URL — Internal URL cloudflared routes traffic to,
 *                    e.g. "http://node_app:5001"
 *
 * Graceful-degrade behaviour: if ANY of these env vars are missing,
 * functions log a warning and return { skipped: true }. The
 * registration flow continues — the operator can add DNS manually.
 */

const CF_API = 'https://api.cloudflare.com/client/v4';

function cfConfigured(): boolean {
  return !!(
    process.env.CF_API_TOKEN &&
    process.env.CF_ZONE_ID &&
    process.env.CF_ACCOUNT_ID &&
    process.env.CF_TUNNEL_ID &&
    process.env.CF_APEX_DOMAIN
  );
}

async function cfFetch(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${CF_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${process.env.CF_API_TOKEN}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || (body && body.success === false)) {
    const err = body?.errors?.[0]?.message || body?.error || `HTTP ${res.status}`;
    throw new Error(`Cloudflare API: ${err}`);
  }
  return body;
}

export interface ProvisionResult {
  skipped?: boolean;            // true when CF not configured
  dns_record_id?: string;
  tunnel_config_updated?: boolean;
  already_exists?: boolean;
  hostname?: string;
  error?: string;
}

/**
 * Look up an existing DNS record for exact hostname.
 */
async function findDnsRecord(hostname: string): Promise<any | null> {
  const zone = process.env.CF_ZONE_ID!;
  const res = await cfFetch(
    `/zones/${zone}/dns_records?type=CNAME&name=${encodeURIComponent(hostname)}&per_page=1`
  );
  return (res.result && res.result.length > 0) ? res.result[0] : null;
}

/**
 * Fetch the tunnel's current ingress config from Cloudflare.
 * Returns { config: { ingress: [...] } } or an empty config for new tunnels.
 */
async function getTunnelConfig(): Promise<any> {
  const account = process.env.CF_ACCOUNT_ID!;
  const tunnel  = process.env.CF_TUNNEL_ID!;
  try {
    const res = await cfFetch(`/accounts/${account}/cfd_tunnel/${tunnel}/configurations`);
    return res.result || { config: { ingress: [] } };
  } catch (err) {
    // Older / remotely-managed tunnels may 404 on this — return empty
    return { config: { ingress: [] } };
  }
}

/**
 * Push a new ingress config to the tunnel (replaces existing).
 */
async function putTunnelConfig(config: any): Promise<void> {
  const account = process.env.CF_ACCOUNT_ID!;
  const tunnel  = process.env.CF_TUNNEL_ID!;
  await cfFetch(`/accounts/${account}/cfd_tunnel/${tunnel}/configurations`, {
    method: 'PUT',
    body: JSON.stringify({ config }),
  });
}

/**
 * Create both the DNS CNAME and add a Public Hostname rule to the tunnel.
 * Idempotent: if either already exists, it's left in place.
 */
export async function provisionTenantSubdomain(slug: string): Promise<ProvisionResult> {
  if (!cfConfigured()) {
    console.warn('[cloudflare] not configured — skipping auto-provision for slug:', slug);
    return { skipped: true };
  }

  const apex     = process.env.CF_APEX_DOMAIN!;
  const hostname = `${slug}.${apex}`;
  const tunnelTarget = `${process.env.CF_TUNNEL_ID}.cfargotunnel.com`;
  const serviceUrl   = process.env.CF_SERVICE_URL || 'http://node_app:5001';

  try {
    // ── Step 1: Ensure DNS CNAME exists ─────────────────────────────
    const existingDns = await findDnsRecord(hostname);
    let dnsRecordId = existingDns?.id;
    let dnsAlreadyExists = false;

    if (existingDns) {
      dnsAlreadyExists = true;
      // Update target if pointing elsewhere
      if (existingDns.content !== tunnelTarget) {
        await cfFetch(`/zones/${process.env.CF_ZONE_ID}/dns_records/${existingDns.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ content: tunnelTarget, proxied: true }),
        });
      }
    } else {
      const create = await cfFetch(`/zones/${process.env.CF_ZONE_ID}/dns_records`, {
        method: 'POST',
        body: JSON.stringify({
          type: 'CNAME',
          name: hostname,
          content: tunnelTarget,
          proxied: true,
          ttl: 1,             // 1 = Auto
          comment: 'Atithi Setu auto-provisioned tenant subdomain',
        }),
      });
      dnsRecordId = create.result?.id;
    }

    // ── Step 2: Ensure tunnel ingress rule exists ───────────────────
    let tunnelUpdated = false;
    try {
      const cur = await getTunnelConfig();
      const ingress = Array.isArray(cur?.config?.ingress) ? [...cur.config.ingress] : [];

      const existsInIngress = ingress.some((r: any) => r && r.hostname === hostname);
      if (!existsInIngress) {
        // Build new ingress list: put specific hostname entry BEFORE the
        // catch-all (service: http_status:404 must always be last)
        const specificRules = ingress.filter((r: any) => r && r.hostname);
        const catchAllRules = ingress.filter((r: any) => r && !r.hostname);

        specificRules.push({
          hostname,
          service: serviceUrl,
          originRequest: {},
        });

        // Ensure catch-all exists at the end
        if (catchAllRules.length === 0) {
          catchAllRules.push({ service: 'http_status:404' });
        }

        const newIngress = [...specificRules, ...catchAllRules];
        await putTunnelConfig({ ingress: newIngress });
        tunnelUpdated = true;
      }
    } catch (err: any) {
      // Tunnel config API sometimes fails on token-managed (remote) tunnels.
      // In that case the operator has set up a catch-all Public Hostname
      // via dashboard ("Domain: atithi-setu.com, Subdomain: *"). We won't
      // fail the whole registration — DNS is what matters most.
      console.warn(`[cloudflare] tunnel ingress update failed for ${hostname}:`, err.message);
    }

    return {
      hostname,
      dns_record_id: dnsRecordId,
      tunnel_config_updated: tunnelUpdated,
      already_exists: dnsAlreadyExists,
    };
  } catch (err: any) {
    console.error(`[cloudflare] provision failed for slug=${slug}:`, err);
    return { error: err.message || 'Unknown error', hostname };
  }
}

/**
 * Remove DNS + tunnel rule for a slug. Safe to call if records don't exist.
 */
export async function deprovisionTenantSubdomain(slug: string): Promise<ProvisionResult> {
  if (!cfConfigured()) return { skipped: true };

  const apex     = process.env.CF_APEX_DOMAIN!;
  const hostname = `${slug}.${apex}`;

  try {
    // Delete DNS record
    const existing = await findDnsRecord(hostname);
    if (existing) {
      await cfFetch(`/zones/${process.env.CF_ZONE_ID}/dns_records/${existing.id}`, {
        method: 'DELETE',
      });
    }

    // Remove tunnel ingress rule (best-effort)
    try {
      const cur = await getTunnelConfig();
      const ingress = Array.isArray(cur?.config?.ingress) ? cur.config.ingress : [];
      const filtered = ingress.filter((r: any) => r && r.hostname !== hostname);
      if (filtered.length !== ingress.length) {
        await putTunnelConfig({ ingress: filtered });
      }
    } catch { /* ignore */ }

    return { hostname };
  } catch (err: any) {
    console.error(`[cloudflare] deprovision failed for slug=${slug}:`, err);
    return { error: err.message };
  }
}

export function cloudflareIsConfigured(): boolean {
  return cfConfigured();
}
