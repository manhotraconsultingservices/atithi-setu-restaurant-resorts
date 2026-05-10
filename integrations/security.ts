/**
 * Atithi-Setu — Multi-platform delivery integration: security helpers
 * ════════════════════════════════════════════════════════════════════════
 *
 * AES-256-GCM credential encryption + HMAC signature verification helpers.
 *
 * Master key sourced from process.env.ATITHI_CREDENTIAL_KEY (32-byte base64).
 * Boot guard `assertCredentialKeyOrExit()` is called from server.ts at startup
 * — if the key is missing or wrong length, the server refuses to start with a
 * clear error rather than silently writing plaintext to disk.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'crypto';

// ─── Master-key bootstrap ────────────────────────────────────────────────

let CACHED_KEY: Buffer | null = null;

/**
 * Resolve the master key, validating size on first access. Subsequent calls
 * use the cached buffer so we don't re-decode on every encrypt/decrypt.
 */
function getMasterKey(): Buffer {
  if (CACHED_KEY) return CACHED_KEY;
  const raw = process.env.ATITHI_CREDENTIAL_KEY;
  if (!raw) {
    throw new Error(
      '[integrations/security] ATITHI_CREDENTIAL_KEY env var is not set. ' +
      'Generate one via `openssl rand -base64 32` and add it to your deploy environment.',
    );
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(raw, 'base64');
  } catch {
    throw new Error('[integrations/security] ATITHI_CREDENTIAL_KEY is not valid base64');
  }
  if (buf.length !== 32) {
    throw new Error(
      `[integrations/security] ATITHI_CREDENTIAL_KEY decodes to ${buf.length} bytes; ` +
      'expected exactly 32 (AES-256). Regenerate via `openssl rand -base64 32`.',
    );
  }
  CACHED_KEY = buf;
  return buf;
}

/**
 * Boot guard — call once from server.ts startup. Refuses to start the
 * server if the credential key is missing or invalid.
 *
 * In dev, when the integrations module isn't actually used, the key is
 * still required so we don't accidentally ship the credential storage path
 * without one configured.  Set to a dummy 32-byte key for local tests.
 */
export function assertCredentialKeyOrExit(): void {
  try {
    getMasterKey();
  } catch (err: any) {
    console.error(err?.message || err);
    process.exit(1);
  }
}

/**
 * Returns true if the env var is properly configured. Useful for soft-gating
 * features (e.g. don't show the credentials UI if the deploy can't decrypt).
 */
export function isCredentialKeyConfigured(): boolean {
  try {
    getMasterKey();
    return true;
  } catch {
    return false;
  }
}

// ─── AES-256-GCM credential encryption ───────────────────────────────────

export interface EncryptedCredential {
  ciphertext: string; // base64
  iv: string;         // base64
  authTag: string;    // base64
}

/**
 * Encrypt a credential string for at-rest storage in
 * integration_credentials.{ciphertext, iv, auth_tag}.
 */
export function encryptCredential(plaintext: string): EncryptedCredential {
  const key = getMasterKey();
  const iv = randomBytes(12); // GCM-recommended length
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  return {
    ciphertext: ct.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

/**
 * Reverse of encryptCredential. Throws if the auth tag fails — never
 * returns the bytes if integrity check fails.
 */
export function decryptCredential(row: {
  ciphertext: string;
  iv: string;
  authTag?: string;
  // accept the snake_case shape that comes straight from the DB row too
  auth_tag?: string;
}): string {
  const key = getMasterKey();
  const tag = row.authTag ?? row.auth_tag;
  if (!tag) throw new Error('[integrations/security] decryptCredential: missing auth tag');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(row.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(row.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

// ─── HMAC signature verification ─────────────────────────────────────────

/**
 * Verify an HMAC-SHA256 signature against the raw request body.
 *
 * Used by adapters whose platforms sign webhooks with a shared secret
 * (UrbanPiper, direct Swiggy, direct Zomato). For Ed25519-signed flows
 * (ONDC), the adapter implements its own verify path.
 *
 * @param rawBody       The bytes-exact request body (kept as a Buffer; do NOT
 *                      JSON.parse and re-stringify before verifying).
 * @param signatureHex  The hex-encoded signature from the header.
 * @param secret        The shared HMAC secret for this tenant + channel.
 * @param algorithm     Defaults to sha256.
 * @returns             true on a matching signature; false otherwise.
 */
export function verifyHmacSha256(
  rawBody: Buffer,
  signatureHex: string,
  secret: string,
  algorithm: 'sha256' | 'sha512' = 'sha256',
): boolean {
  if (!signatureHex || !secret) return false;
  let provided: Buffer;
  try {
    provided = Buffer.from(signatureHex.trim().toLowerCase(), 'hex');
  } catch {
    return false;
  }
  const expected = createHmac(algorithm, secret).update(rawBody).digest();
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

/**
 * Compute the idempotency key used to dedupe inbound webhooks.
 * Stored as the primary key of webhook_inbox.
 */
export function computeWebhookIdempotencyKey(
  channel: string,
  signatureHeader: string,
): string {
  return require('crypto')
    .createHash('sha256')
    .update(`${channel}:${signatureHeader}`)
    .digest('hex');
}

/**
 * Helper for adapters that need to reject stale webhooks (replay defence).
 * Returns true if the timestamp (parsed as ms since epoch) is within
 * `toleranceMs` of now. Defaults to ±5 minutes.
 */
export function isTimestampFresh(
  timestampMs: number,
  toleranceMs: number = 5 * 60 * 1000,
): boolean {
  if (!Number.isFinite(timestampMs)) return false;
  const skew = Math.abs(Date.now() - timestampMs);
  return skew <= toleranceMs;
}
