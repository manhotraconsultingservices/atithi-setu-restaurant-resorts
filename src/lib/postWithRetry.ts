// POST a guest submission so a brief server outage does not lose it.
//
// A deploy restart answers 502/503/504 for 10-20 seconds, and a phone on a weak
// network drops connections; the public enquiry and booking forms used to turn
// either into "Failed" and the guest walked away. This retries those two cases
// (after about 2 and 5 seconds) with ONE Idempotency-Key for the whole click, so
// if an attempt did reach the server and only its reply was lost, the server
// answers the retry with the same reply instead of making a second booking.
//
// Returns the final Response (which may still be a 4xx the caller should show),
// or null when every attempt failed to connect.
export async function postWithRetry(url: string, body: unknown, delaysMs: number[] = [2000, 5000]): Promise<Response | null> {
  const key = (typeof crypto !== 'undefined' && typeof (crypto as any).randomUUID === 'function')
    ? (crypto as any).randomUUID()
    : `k${Date.now()}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  const payload = JSON.stringify(body);
  let res: Response | null = null;
  for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
    try {
      res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: payload });
    } catch { res = null; }
    // A real answer (success, or a validation / availability refusal) ends it.
    if (res && res.status < 500) return res;
    if (attempt < delaysMs.length) await new Promise(r => setTimeout(r, delaysMs[attempt]));
  }
  return res;
}

// The reply body as JSON, or null when the server sent something else (a
// gateway error page is HTML), so callers never show "Unexpected token <".
export async function readJson(res: Response): Promise<any> {
  try { return await res.json(); } catch { return null; }
}
