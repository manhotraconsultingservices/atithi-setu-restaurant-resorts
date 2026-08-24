// ─────────────────────────────────────────────────────────────────────────────
// NPCI UPI deep-link builder — single source of truth (shared by server + SPA).
//
// This is the 0%-commission payment path: a direct `upi://pay?…` deep link + QR
// to the property's OWN VPA. Money settles straight into the property's bank
// account — no payment gateway, no aggregator, no MDR/commission. The UPI
// deep-link / QR spec (NPCI UPI Linking Specification) is open and free; there is
// nothing to "integrate" or sign up for. The only requirement is building the
// URI exactly to spec.
//
// CRITICAL correctness rule (the #1 reason a hand-built UPI link "doesn't work"):
//   The payee address `pa` MUST be the RAW vpa. Percent-encoding the '@'
//   (encodeURIComponent("a@okhdfcbank") → "a%40okhdfcbank") makes PhonePe, BHIM,
//   Paytm's stricter parser, and most QR scanners reject the link as an invalid
//   UPI ID. GPay is lenient and silently decodes %40 — which is why the bug
//   hides in testing ("works on my phone") and only surfaces for guests.
//
// Pure, dependency-free, browser- and Node-safe (no imports) so both the Express
// server and the Vite client can share it verbatim.
// ─────────────────────────────────────────────────────────────────────────────

// NPCI VPA grammar: <ident>@<handle>. `ident` allows alphanumerics plus . _ -;
// `handle` is the bank/PSP suffix (alphanumeric). Anything else is not a UPI ID.
const VPA_RE = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z0-9]{2,64}$/;

/** True when `s` is a syntactically valid UPI VPA (e.g. `vivekscafe@okhdfcbank`). */
export function isValidVpa(s: string | null | undefined): boolean {
  return VPA_RE.test(String(s || '').trim());
}

export interface UpiUriParams {
  pa: string;                       // payee VPA (required, kept RAW)
  pn?: string;                      // payee name (shown in the UPI app)
  am?: number | string | null;     // amount; omitted when <= 0 (BASIC "enter amount" QR)
  tn?: string;                      // transaction note
  tr?: string;                      // transaction reference (reconciliation id)
  cu?: string;                      // currency, defaults to INR
}

/**
 * Build a spec-correct `upi://pay?…` URI. Returns '' for a missing/invalid VPA
 * so callers never emit a dead link (the UI treats '' as "UPI not configured").
 *
 * - `pa`  : RAW vpa — never percent-encoded (see the CRITICAL note above).
 * - `pn`/`tn` : URL-encoded (free-text, may contain spaces/punctuation).
 * - `am`  : fixed to 2 decimals (`2400.00`); omitted when not > 0.
 * - `tr`  : sanitised to NPCI-allowed alphanumeric, capped at 35 chars.
 */
export function buildUpiUri(o: UpiUriParams): string {
  const pa = String(o.pa || '').trim();
  if (!VPA_RE.test(pa)) return '';
  const parts: string[] = [`pa=${pa}`];                    // RAW vpa — never encode the '@'
  const pn = String(o.pn || '').trim();
  if (pn) parts.push(`pn=${encodeURIComponent(pn)}`);
  const am = Number(o.am || 0);
  if (am > 0) parts.push(`am=${am.toFixed(2)}`);
  parts.push(`cu=${(o.cu || 'INR').toUpperCase()}`);
  const tn = String(o.tn || '').trim();
  if (tn) parts.push(`tn=${encodeURIComponent(tn.slice(0, 50))}`);
  const tr = String(o.tr || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 35);
  if (tr) parts.push(`tr=${tr}`);
  return `upi://pay?${parts.join('&')}`;
}
