/**
 * Raw request bodies for signed webhooks.
 *
 * A webhook sender signs the EXACT bytes it sends, so the signature can only be
 * checked against those bytes, never against JSON parsed and serialised again.
 * The global body parsers in server.ts run before every route, and a later
 * route-level parser is skipped for a body that has already been read, so the
 * bytes have to be kept by the global parser or they are gone.
 *
 * keepWebhookRawBody is the parsers' verify callback. It keeps a copy in
 * req.rawBody (a Buffer) ONLY for the signed webhook paths below, not for every
 * request. A new signed webhook route has to be added here, or its signature
 * check sees an empty body and rejects every genuine call.
 *
 * No imports, so the smoke suite can load this file directly.
 */

const SIGNED_WEBHOOK_PATHS: RegExp[] = [
  /^\/api\/public\/payments\/webhook\//i,                            // payment gateways (Razorpay)
  /^\/api\/webhooks\/whatsapp\/?$/i,                                 // Meta WhatsApp Cloud API
  /^\/api\/public\/restaurant\/[^/]+\/channel-webhook\/[^/]+\/?$/i,  // OTA channels
  /^\/api\/integrations\/[^/]+\/webhook\/[^/]+\/?$/i,                // delivery aggregators
];

/** True when the request path (query string ignored) is a signed webhook. */
export function isSignedWebhookPath(url: string | undefined | null): boolean {
  const path = String(url || '').split('?')[0];
  return SIGNED_WEBHOOK_PATHS.some((re) => re.test(path));
}

/** body-parser `verify` callback: keep the raw bytes for signed webhook paths only. */
export function keepWebhookRawBody(req: any, _res: unknown, buf: Buffer): void {
  if (isSignedWebhookPath(req.originalUrl || req.url)) req.rawBody = Buffer.from(buf);
}
