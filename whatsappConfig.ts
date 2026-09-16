// Platform WhatsApp (Meta Cloud API) credentials — one sender shared by every
// tenant. The SuperAdmin saves them in the /internal portal (central table
// platform_whatsapp_config, secrets sealed); server.ts loads that row into this
// module at startup and after every save. Until a row is saved, the META_WA_*
// environment variables keep working exactly as before.
//
// Read synchronously on purpose: the WhatsApp webhook answers Meta inside a
// plain (req, res) handler, and a send must not wait on the database.

export interface WhatsAppPlatformRow {
  phoneNumberId?: string | null;
  accessToken?: string | null;
  businessAccountId?: string | null;
  appSecret?: string | null;
  verifyToken?: string | null;
}

export interface WhatsAppCreds {
  phoneNumberId: string | null;
  accessToken: string | null;
  businessAccountId: string | null;
  appSecret: string | null;
  verifyToken: string | null;
  // Where the sender (phone number id + token) came from.
  source: 'PLATFORM' | 'ENV' | null;
}

let platform: WhatsAppPlatformRow | null = null;

export function setWhatsAppPlatformConfig(row: WhatsAppPlatformRow | null): void {
  platform = row;
}

const clean = (v: unknown): string | null => {
  const s = v == null ? '' : String(v).trim();
  return s ? s : null;
};

export function whatsAppCreds(): WhatsAppCreds {
  const env = {
    phoneNumberId: clean(process.env.META_WA_PHONE_NUMBER_ID),
    accessToken: clean(process.env.META_WA_ACCESS_TOKEN),
    businessAccountId: clean(process.env.META_WA_BUSINESS_ACCOUNT_ID),
    appSecret: clean(process.env.META_WA_APP_SECRET),
    verifyToken: clean(process.env.META_WA_VERIFY_TOKEN),
  };
  const p = platform || {};
  // The number and its token are a pair: never send from a saved number with an
  // env token, or the other way round.
  const platformSender = !!(clean(p.phoneNumberId) && clean(p.accessToken));
  const sender = platformSender
    ? { phoneNumberId: clean(p.phoneNumberId), accessToken: clean(p.accessToken), source: 'PLATFORM' as const }
    : { phoneNumberId: env.phoneNumberId, accessToken: env.accessToken, source: (env.phoneNumberId && env.accessToken ? 'ENV' : null) as 'ENV' | null };
  return {
    ...sender,
    // The rest fall back field by field, so saving a sender never drops a
    // webhook secret that the server already verifies with.
    businessAccountId: clean(p.businessAccountId) || env.businessAccountId,
    appSecret: clean(p.appSecret) || env.appSecret,
    verifyToken: clean(p.verifyToken) || env.verifyToken,
  };
}
