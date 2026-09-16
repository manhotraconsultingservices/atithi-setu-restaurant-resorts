// ─────────────────────────────────────────────────────────────────────────────
// Tenant subdomain rules — single source of truth (shared by server + SPA).
//
// A tenant signs in at <slug>.atithi-setu.com. Every first label that belongs to
// the PLATFORM rather than a tenant must be reserved here. If it is not, the SPA
// reads it as a tenant slug, /api/tenant/by-slug answers 404, and the visitor
// gets "Restaurant Not Found" instead of the page they were sent to.
//
// That is how password reset broke (Sep 2026): FRONTEND_URL pointed reset emails
// at dev-erp.atithi-setu.com — the same backend as erp.atithi-setu.com — and
// "dev-erp" was not reserved, so every owner who tapped the link was told their
// restaurant did not exist.
//
// The server and the SPA used to keep two copies of this list. Both now import
// it, so a host reserved for the SPA can never be handed out as a tenant slug.
//
// Pure, dependency-free, browser- and Node-safe (no imports).
// ─────────────────────────────────────────────────────────────────────────────

export const RESERVED_SUBDOMAINS: ReadonlySet<string> = new Set([
  'www', 'api', 'admin', 'app', 'demo', 'internal', 'support',
  'mail', 'ftp', 'blog', 'cdn', 'static', 'help', 'docs', 'auth',
  'login', 'signup', 'register', 'test', 'staging', 'dev', 'erp',
  // Platform environment hosts. dev-erp.* is a live alias of erp.*;
  // prod-erp.* is the documented name for a second server (DEPLOY_OTHER_SERVER.md).
  'dev-erp', 'prod-erp',
]);

// Returns the tenant slug a hostname addresses, or null for a platform host.
//   atithi-setu.com                       → null (apex)
//   erp.atithi-setu.com, dev-erp.…        → null (reserved)
//   manhotra-kitchen.atithi-setu.com      → "manhotra-kitchen"
//   manhotra-kitchen.demo.atithi-setu.com → "manhotra-kitchen" (demo env)
//   localhost / 127.0.0.1 / bare IPv4     → the ?tenant= value, for testing without DNS
export function tenantSlugFromHost(hostname: string, tenantParam?: string | null): string | null {
  const host = String(hostname || '').toLowerCase();

  if (host === 'localhost' || host === '127.0.0.1' || /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const qp = String(tenantParam || '').toLowerCase();
    return qp && !RESERVED_SUBDOMAINS.has(qp) ? qp : null;
  }

  const parts = host.split('.');
  if (parts.length < 3) return null;               // apex or single-label

  const first = parts[0];
  return RESERVED_SUBDOMAINS.has(first) ? null : first;
}
