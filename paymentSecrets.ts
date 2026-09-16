// ─────────────────────────────────────────────────────────────────────────────
// paymentSecrets.ts — AES-256-GCM sealing for payment gateway secrets.
//
// A gateway key secret can move a tenant's money (refunds, payouts) and a
// webhook secret lets a caller forge "paid". They are stored sealed, decrypted
// only in memory for the one call that needs them, and never sent to a browser.
//
// Key: ATITHI_CREDENTIAL_KEY (32 bytes, base64) when the deployment sets it —
// the same dedicated key the delivery-platform credentials use. Until it is set,
// a key derived from JWT_SECRET under a payments-only label, the approach HR
// sensitive data takes. Each sealed value names the key that sealed it, so
// turning the dedicated key on later leaves existing secrets readable, and the
// next save re-seals them under it.
//
// Format:  pg1:<C|J>:<iv b64>:<tag b64>:<ciphertext b64>
// ─────────────────────────────────────────────────────────────────────────────
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

export type SecretKeySource = 'CREDENTIAL_KEY' | 'JWT_DERIVED';

const PREFIX = 'pg1';
const TAG: Record<SecretKeySource, string> = { CREDENTIAL_KEY: 'C', JWT_DERIVED: 'J' };

function credentialKey(): Buffer | null {
  const raw = process.env.ATITHI_CREDENTIAL_KEY;
  if (!raw) return null;
  try {
    const buf = Buffer.from(raw, 'base64');
    return buf.length === 32 ? buf : null;
  } catch { return null; }
}

function jwtDerivedKey(): Buffer | null {
  const s = process.env.JWT_SECRET;
  if (!s) return null;
  return createHash('sha256').update(`atithi-payment-secrets-v1:${s}`).digest();
}

function keyFor(source: SecretKeySource): Buffer | null {
  return source === 'CREDENTIAL_KEY' ? credentialKey() : jwtDerivedKey();
}

/** Which key a new secret will be sealed with; null when the server has neither. */
export function secretKeySource(): SecretKeySource | null {
  if (credentialKey()) return 'CREDENTIAL_KEY';
  if (jwtDerivedKey()) return 'JWT_DERIVED';
  return null;
}

export function isSealed(v: unknown): boolean {
  return typeof v === 'string' && v.startsWith(`${PREFIX}:`);
}

export function sealSecret(plain: string): string {
  const source = secretKeySource();
  const key = source ? keyFor(source) : null;
  if (!source || !key) throw new Error('No encryption key: set ATITHI_CREDENTIAL_KEY (or JWT_SECRET) on the server.');
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return [PREFIX, TAG[source], iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

/** The plain secret; null when the value is not sealed, was tampered with, or its key is gone. */
export function openSecret(sealed: unknown): string | null {
  if (!isSealed(sealed)) return null;
  const parts = String(sealed).split(':');
  if (parts.length !== 5) return null;
  const source = (Object.keys(TAG) as SecretKeySource[]).find(s => TAG[s] === parts[1]);
  const key = source ? keyFor(source) : null;
  if (!key) return null;
  try {
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(parts[2], 'base64'));
    d.setAuthTag(Buffer.from(parts[3], 'base64'));
    return Buffer.concat([d.update(Buffer.from(parts[4], 'base64')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** True when a stored secret was sealed under a weaker key than the server now has. */
export function needsReseal(sealed: unknown): boolean {
  if (!isSealed(sealed)) return false;
  return String(sealed).split(':')[1] === TAG.JWT_DERIVED && !!credentialKey();
}
